import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { harnessAppError } from '../../../shared/harness/types'
import type { LlmModelOption } from '../../../shared/settings'
import { sealedEnv } from '../oneShot/launch'
import { releasePlace, reservePlace, spawnInPlace, type PlaceProcess } from '../oneShot/places'
import type { OneShotRouteDecision, OneShotTransport } from '../oneShot/route'
import { OPENCODE_CONSOLE_FACTS, OPENCODE_FREE_FACTS, OPENCODE_SEALED_FACTS } from '../oneShot/routes'
import { OpencodeApiError, OpencodeClient } from './client'
import { oneShotRules } from './rules'
import { readServerUrl } from './server'
import { isOpencodeFreeModel, parseModel } from './sessions'

/**
 * OpenCode's single requests (`opencode:sealed`, docs/plans/one-shots-every-provider.md): a server of their own, started
 * for the request in its place and ended with it, never the user's.
 *
 * What the F6 spike showed on OpenCode 2.0.20 (`tests/opencodeOneShotEffects.test.ts` keeps it):
 * - Config, plugins and MCP servers load from OpenCode's config folder (`$XDG_CONFIG_HOME/opencode`, `OPENCODE_CONFIG_DIR`),
 *   from `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT`, and from every folder above the working one (`opencode.json`,
 *   `.opencode/` with its `plugins/`, `.claude/`, `.agents/`), all the way up. The sealed launch points the config
 *   folders into the place and keeps every `OPENCODE_*` variable of the entry out; the folders above the place (the
 *   user's home among them) are skipped only with `OPENCODE_DISABLE_PROJECT_CONFIG`: without it their plugins run and
 *   their MCP servers start.
 * - A session whose rules deny everything declares no tool. Its prompt runs OpenCode's session runner, which retries a
 *   failed model request itself (up to ten times, from about 2 s apart); stopping it at the first retry it announces is
 *   a race. `POST /api/session/:id/generate` makes one model request from the session's context with no runner and
 *   no retry: one request on the wire on 429 and 503. It runs no tool either: a call the model makes ends the request
 *   with no text, even on a session that allows everything. `/api/experimental/generate` skips the session, but answers
 *   "Model unavailable" until the server's plugins have loaded the providers, so it is not used.
 * - Sign-ins live in OpenCode's database (`credential` rows; `auth.json` is only read once, to import), with its sessions
 *   and everything else. A server on the user's database would add a project for every place to it; one on a copy
 *   would write a refreshed OAuth token where the user's OpenCode never sees it. So the sealed server gets its own
 *   database in the place, and a key goes into it through its API: an API key read from the user's database at the
 *   time of the request (it cannot rotate, and a replaced key is read the next time), or the variable OpenCode itself
 *   reported as the provider's connection. A provider signed in with an account (OAuth) is refused, with its reason.
 * - OpenCode's own provider (`opencode`, its Console) loads the organisation's config from the Console with its key: on
 *   that provider only the environment is held (`env_only`). Its free models take no key, but refuse a request with no
 *   tool, so they are offered `read` (never run: `generate` runs no tool) and are best-effort.
 */

export const OPENCODE_ONE_SHOT_ROUTE = 'opencode:sealed' as const

/** The variables every sealed server gets: no folder above the place is read, nothing is fetched, nothing updates. */
export const OPENCODE_SEALED_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_FILEWATCHER: '1'
})

/** How one provider was connected when OpenCode was last checked (`GET /api/integration`). */
export type OpencodeSignIn = { kind: 'key' } | { kind: 'oauth' } | { kind: 'env'; names: string[] }

/** What the last check read that a route depends on: each provider's connection, and OpenCode's free models. */
export interface OpencodeOneShotCache {
  signIns?: Readonly<Record<string, OpencodeSignIn>>
  free?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Each integration's connection, from OpenCode's integration listing: an OAuth or key credential first, else its variables. */
export function opencodeSignIns(data: unknown): Record<string, OpencodeSignIn> {
  const out: Record<string, OpencodeSignIn> = {}
  for (const integration of Array.isArray(data) ? data.filter(isRecord) : []) {
    const id = typeof integration.id === 'string' ? integration.id : undefined
    const connections = Array.isArray(integration.connections) ? integration.connections.filter(isRecord) : []
    if (!id || !connections.length) continue
    const credential = connections.find((connection) => connection.type === 'credential')
    if (credential) out[id] = { kind: credential.method === 'oauth' ? 'oauth' : 'key' }
    else {
      const names = connections.flatMap((connection) => (connection.type === 'env' && typeof connection.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(connection.name) ? [connection.name] : []))
      if (names.length) out[id] = { kind: 'env', names }
    }
  }
  return out
}

const route = (facts: typeof OPENCODE_SEALED_FACTS): OneShotRouteDecision => Object.freeze({ route: Object.freeze({ id: OPENCODE_ONE_SHOT_ROUTE, facts }) })
const SEALED = route(OPENCODE_SEALED_FACTS)
const CONSOLE = route(OPENCODE_CONSOLE_FACTS)
const FREE = route(OPENCODE_FREE_FACTS)

/** Whether `provider/id` is one of OpenCode's own free models, as its name or the last listing says. */
function freeModel(provider: string, id: string, cache: OpencodeOneShotCache | undefined): boolean {
  return isOpencodeFreeModel(undefined, { providerID: provider, id }) || (provider === 'opencode' && Boolean(cache?.free?.includes(`${provider}/${id}`)))
}

/** The route of one model, from what the last check read only. */
export function opencodeOneShotRoute(model: string, cache: OpencodeOneShotCache | undefined): OneShotRouteDecision {
  const slash = model.indexOf('/')
  if (slash <= 0) return { refused: 'OpenCode names threads only with a model picked from its list.' }
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1).replace(/:[^:/]*$/, '')
  if (freeModel(provider, id, cache)) return FREE
  if (cache?.signIns?.[provider]?.kind === 'oauth') return { refused: oauthRefusal(provider) }
  return provider === 'opencode' ? CONSOLE : SEALED
}

function oauthRefusal(provider: string): string {
  return `OpenCode signs in to ${provider} with an account. A single request runs on a sealed OpenCode that could not hand a renewed sign-in back to yours, so it does not use it. Connect an API key for ${provider} in OpenCode to name threads with it.`
}

/**
 * OpenCode's database, as its server finds it (2.0 `cli/src/database-path.ts`): `OPENCODE_DB` (relative to the data
 * folder), else `opencode.db` in `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`. Undefined for an in-memory one.
 */
export function opencodeDatabasePath(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | undefined {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')
  const file = env.OPENCODE_DB || 'opencode.db'
  return file === ':memory:' ? undefined : resolve(data, file)
}

/** The sign-in of `integrationID` a request may use, read from OpenCode's database now. */
export type StoredSignIn = { kind: 'key'; key: string } | { kind: 'oauth' } | undefined

/**
 * Reads the active credential of `integrationID` from OpenCode's database, read-only (the row its server picks: the
 * active one, else the newest). Only an API key's value leaves here; an OAuth grant is reported by its kind alone.
 */
export async function readOpencodeSignIn(database: string | undefined, integrationID: string): Promise<StoredSignIn> {
  if (!database || !existsSync(database)) return undefined
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1').get(integrationID) as { value?: unknown } | undefined
    if (!row || typeof row.value !== 'string') return undefined
    const value = JSON.parse(row.value) as unknown
    if (!isRecord(value)) return undefined
    if (value.type === 'oauth') return { kind: 'oauth' }
    return value.type === 'key' && typeof value.key === 'string' && value.key ? { kind: 'key', key: value.key } : undefined
  } finally {
    db.close()
  }
}

/** The entry's own variables a sealed server keeps: none of OpenCode's, which say where config, data and models come from. */
export function sealedEntryEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !/^OPENCODE_/i.test(name)))
}

/** The program a sealed server runs: the entry's executable as it resolves now, with its own launch variables. */
export interface OpencodeProgram {
  command: string
  args: string[]
  path: string
  env: Record<string, string>
}

export interface SealedOpencodeOptions {
  label: string
  instanceId: string
  profileHome: string
  /** The program as it resolves now; throws when there is none. */
  program(): OpencodeProgram
  /** Runs before the program starts (a managed copy's file check), and marks it running until the returned call. */
  beforeLaunch(signal: AbortSignal): Promise<(() => void) | void>
  /** Mousse's environment for the entry (read through the sealed launch's allowlist only). */
  baseEnv: NodeJS.ProcessEnv
  /** The entry's own variables. */
  entryEnv?: Readonly<Record<string, string>>
  /** Mousse's variables enforced on every process of the entry. */
  enforcedEnv?: Readonly<Record<string, string>>
  /** The models the entry lists, to read a variant off a model id. */
  models(): readonly LlmModelOption[]
  cache(): OpencodeOneShotCache | undefined
  /** OpenCode's database, where an API key is read from at the time of the request. */
  database(): string | undefined
  /** Test seam: config the sealed server gets (`OPENCODE_CONFIG_CONTENT`), as a loopback stub provider. */
  configContent?: string
}

/** The working folder of the server in its place, and the folder its reserved roots point into. */
const WORK = 'work'
const ROOT = 'root'

/** OpenCode's error reply as a Mousse error the runner classifies. */
function generateError(label: string, error: unknown, instanceId: string): Error {
  if (!(error instanceof OpencodeApiError)) return error instanceof Error ? error : new Error(String(error))
  const message = `${label}: ${error.message}`
  if (error.status === 400) return harnessAppError({ code: 'model_unavailable', message, instanceId })
  if (/credential|unauthori[sz]ed|api key|401|403/i.test(error.message)) return harnessAppError({ code: 'signed_out', message: `${message} Sign in with \`opencode auth login\`.`, instanceId })
  if (/rate.?limit|too many requests|quota/i.test(error.message)) return harnessAppError({ code: 'rate_limited', message, instanceId })
  return harnessAppError({ code: 'service_unavailable', message, instanceId })
}

/**
 * The transport of `opencode:sealed`: the request's place (its record first, then its folder), a fresh `opencode serve`
 * in it on the sealed launch (reserved roots, no entry `OPENCODE_*` variable and none of the entry's arguments, the
 * folders above skipped), the key the request may use, a session that denies every tool, and one `generate` on it.
 * The place is removed once its process tree has gone, with proof; anything written in its working folder fails the
 * request. A server per request costs about half a second to start (OpenCode 2.0.20 on Windows; about a second to an
 * answer from a loopback model); one kept across requests would outlive its place, so none is.
 */
export function sealedOpencodeTransport(options: SealedOpencodeOptions, spec: { model: string }): OneShotTransport {
  const { label, instanceId } = options
  return {
    send: async (wire, events, signal) => {
      signal.throwIfAborted()
      const ref = parseModel(spec.model, options.models())
      if (!ref) throw harnessAppError({ code: 'model_unavailable', message: `${label} names threads only with a model picked from its list.`, instanceId })
      const cache = options.cache()
      const free = freeModel(ref.providerID, ref.id, cache)
      // The key the request may use, read now: an API key from OpenCode's own store, else the variables OpenCode
      // reported as the provider's connection. An account sign-in is never handed to a sealed server.
      const preset: Record<string, string> = {}
      let key: string | undefined
      if (!free) {
        const stored = await readOpencodeSignIn(options.database(), ref.providerID).catch((error: unknown) => {
          throw harnessAppError({ code: 'service_unavailable', message: `${label}: Mousse could not read OpenCode's sign-ins (${error instanceof Error ? error.message : String(error)}).`, instanceId })
        })
        if (stored?.kind === 'oauth') throw harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: oauthRefusal(ref.providerID), instanceId })
        if (stored?.kind === 'key') key = stored.key
        else {
          const signIn = cache?.signIns?.[ref.providerID]
          for (const name of signIn?.kind === 'env' ? signIn.names : []) {
            const value = options.entryEnv?.[name] ?? options.baseEnv[name]
            if (value && !/^OPENCODE_/i.test(name)) preset[name] = value
          }
        }
      }
      signal.throwIfAborted()
      const program = options.program()
      const untrack = await options.beforeLaunch(signal)
      const place = reservePlace(options.profileHome, { route: OPENCODE_ONE_SHOT_ROUTE, instanceId })
      const work = join(place.dir, WORK)
      let proc: PlaceProcess | undefined
      let text = ''
      let failure: unknown
      try {
        mkdirSync(work, { recursive: true, mode: 0o700 })
        events.launching(program.path)
        const password = randomBytes(24).toString('base64url')
        const env = sealedEnv({
          base: options.baseEnv,
          entry: { ...sealedEntryEnv(program.env), ...sealedEntryEnv(options.entryEnv) },
          preset: {
            ...(options.enforcedEnv ?? {}),
            ...preset,
            ...OPENCODE_SEALED_ENV,
            ...(options.configContent !== undefined ? { OPENCODE_CONFIG_CONTENT: options.configContent } : {}),
            OPENCODE_PASSWORD: password
          },
          root: join(place.dir, ROOT)
        })
        // None of the entry's arguments: the server's are Mousse's own.
        proc = spawnInPlace(place, { command: program.command, args: [...program.args, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], env, purpose: 'opencode-one_shot', instanceId, cwd: work })
        proc.child.stdin.on('error', () => { /* the server already ended */ })
        proc.child.stdout.on('error', () => {})
        const url = await readServerUrl(proc.child, signal)
        events.activity()
        const client = new OpencodeClient({ url, password })
        if (key) await client.request('POST', '/api/credential', { body: { integrationID: ref.providerID, value: { type: 'key', key } }, signal })
        const created = await client.data('POST', '/api/session', {
          body: { location: { directory: work }, model: { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }, permissions: oneShotRules(free), title: 'Mousse one-shot' },
          signal
        })
        const sessionId = isRecord(created) && typeof created.id === 'string' ? created.id : undefined
        if (!sessionId) throw new Error(`${label} did not open a session.`)
        events.activity()
        const prompt = [wire.instruction, wire.system, wire.prompt].filter((part): part is string => Boolean(part?.trim())).join('\n\n')
        events.sending()
        const answer = await client.data('POST', `/api/session/${encodeURIComponent(sessionId)}/generate`, { body: { prompt }, signal })
          .catch((error: unknown) => { throw generateError(label, error, instanceId) })
        text = isRecord(answer) && typeof answer.text === 'string' ? answer.text : ''
        events.text(text)
      } catch (error) {
        failure = error
      } finally {
        untrack?.()
      }
      const released = await releasePlace(place, proc, [], { written: WORK })
      if (failure) throw failure
      if (!released.reaped) throw harnessAppError({ code: 'protocol', message: `The ${label} server did not end after its request.`, instanceId })
      if (released.written)
        throw harnessAppError({ code: 'one_shot_tool_refused', reason: 'tool_detected', message: `${label} left ${released.written} in the empty folder of a request that runs no tools, so Mousse did not use its answer.`, instanceId })
      return text.trim()
    }
  }
}
