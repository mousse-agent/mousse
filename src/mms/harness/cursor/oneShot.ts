import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { harnessAppError } from '../../../shared/harness/types'
import { CURSOR_ONE_SHOT_HOST, isCursorAuthFailure, redactCursorText, type CursorHostError, type CursorHostMessage, type CursorOneShotRequest } from '../hosts/cursorProtocol'
import { sealedEnv } from '../oneShot/launch'
import { releasePlace, reservePlace, spawnInPlace, type PlaceProcess } from '../oneShot/places'
import type { OneShotRouteDecision, OneShotTransport } from '../oneShot/route'
import { CURSOR_SDK_FACTS } from '../oneShot/routes'
import { CURSOR_DEFAULT_MODEL } from './session'

/**
 * Cursor's single requests (`cursor:sdk`, docs/plans/one-shots-every-provider.md): a host process of their own, started
 * for the request in its place and ended with it, never the host that runs the entry's turns.
 *
 * What the spike showed on `@cursor/sdk` 1.0.35 (`tests/cursorOneShotEffects.test.ts` keeps it, at a loopback stub the
 * SDK reaches through `CURSOR_BACKEND_URL`, with a made-up key):
 * - `tools: []` offers the model no built-in tool: the run and its first message carry an empty
 *   `x-cursor-agent-allowed-tools`, which is absent otherwise. Cursor's servers apply it; a stub cannot show they do,
 *   so a tool the run still reports ends the request (`OneShotEvents.tool`).
 * - With `enableAgentRetries: false` a run that fails with 503 or 429 (as the HTTP status, or as the stream's own error)
 *   is sent once: one `RunSSE` and one `BidiAppend`. With the SDK's default (`true`) the same run is sent four times.
 * - With `settingSources: []` nothing of the user's or a project's setup loads: no rule, skill, hook or MCP server from
 *   the home folder, the working folder or any folder above it. With every source on, hooks run, MCP servers start and
 *   rules load from the home and working folders. The host's home and working folders are in the place anyway.
 * - The SDK keeps its agent store where it is told, here in the place; nothing is written in the working folder.
 */

export const CURSOR_ONE_SHOT_ROUTE = 'cursor:sdk' as const

const SDK_ROUTE: OneShotRouteDecision = Object.freeze({ route: Object.freeze({ id: CURSOR_ONE_SHOT_ROUTE, facts: CURSOR_SDK_FACTS }) })

/** Every Cursor model, Auto among them, runs a single request the same way. */
export function cursorOneShotRoute(): OneShotRouteDecision {
  return SDK_ROUTE
}

export interface CursorOneShotOptions {
  label: string
  instanceId: string
  profileHome: string
  /** The built host entry; undefined in a build without one. */
  hostScript: string | undefined
  /** The program that runs the host entry as Node (Electron as Node, or Node). */
  execPath: string
  /** The instance's key, read at the time of the request. */
  apiKey(): string | undefined
  /** Mousse's environment for the entry, read through the sealed launch's allowlist only. */
  baseEnv: NodeJS.ProcessEnv
  /** The entry's own variables. */
  entryEnv?: Readonly<Record<string, string>>
  /** Test seam: variables for the host (a fake SDK module, a stub's address). */
  hostEnv?: Readonly<Record<string, string>>
}

/** The working folder of the host in its place, the agent store's folder, and the folder its reserved roots point into. */
const WORK = 'work'
const STORE = 'store'
const ROOT = 'root'

/** The entry's own variables a single-request host keeps: none of Cursor's or of the host's own. */
export function cursorEntryEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !/^(CURSOR_|MOUSSE_CURSOR_|ELECTRON_)/i.test(name)))
}

/** What the host reported a run failed with, as a Mousse error the runner classifies. */
export function cursorRunError(label: string, instanceId: string, error: CursorHostError | undefined): Error {
  const detail = redactCursorText(error?.message ?? 'The run failed.')
  const message = `${label}: ${detail}`
  if (error && (error.auth || isCursorAuthFailure(error))) return harnessAppError({ code: 'signed_out', message: `${message} Sign in to ${label} again.`, instanceId })
  const code = error?.code?.toLowerCase()
  if (code === 'resource_exhausted' || error?.status === 429 || /rate.?limit|too many requests|resource_exhausted|HTTP 429/i.test(detail)) return harnessAppError({ code: 'rate_limited', message, instanceId })
  return harnessAppError({ code: 'service_unavailable', message, instanceId })
}

/** A run update that is a tool call (started, partial or done), with what it names. */
export function cursorToolUpdate(update: Record<string, unknown>): string | undefined {
  const type = typeof update.type === 'string' ? update.type : ''
  if (!/tool/i.test(type)) return undefined
  const call = update.toolCall as { type?: unknown } | undefined
  return typeof call?.type === 'string' ? call.type : type
}

/**
 * The transport of `cursor:sdk`: the request's place (its record first, then its folder), the host entry in it on the
 * sealed launch (reserved roots in the place, no Cursor variable of the entry's, the working folder in the place), and
 * once it says `ready`, the one request. Its text streams back as `delta` events until one `run_end`. The place is
 * removed once its process tree has gone, with proof; anything written in its working folder fails the request.
 */
export function cursorOneShotTransport(options: CursorOneShotOptions, spec: { model: string }): OneShotTransport {
  const { label, instanceId } = options
  return {
    send: async (wire, events, signal) => {
      signal.throwIfAborted()
      if (!options.hostScript) throw harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: `${label} cannot run a single request: this build of Mousse has no Cursor host.`, instanceId })
      const apiKey = options.apiKey()
      if (!apiKey) throw harnessAppError({ code: 'signed_out', message: `${label} is signed out.`, instanceId })
      const place = reservePlace(options.profileHome, { route: CURSOR_ONE_SHOT_ROUTE, instanceId })
      const work = join(place.dir, WORK)
      let proc: PlaceProcess | undefined
      let text = ''
      let failure: unknown
      try {
        mkdirSync(work, { recursive: true, mode: 0o700 })
        events.launching(options.execPath)
        const env = sealedEnv({
          base: options.baseEnv,
          entry: cursorEntryEnv(options.entryEnv),
          preset: { ...(options.hostEnv ?? {}), ELECTRON_RUN_AS_NODE: '1', MOUSSE_CURSOR_HOST: CURSOR_ONE_SHOT_HOST },
          root: join(place.dir, ROOT)
        })
        proc = spawnInPlace(place, { command: options.execPath, args: [options.hostScript], env, purpose: 'cursor-one_shot', instanceId, cwd: work })
        const child = proc.child
        child.stdin.on('error', () => { /* the host already ended */ })
        let stderrTail = ''
        child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000) })
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
        const request: CursorOneShotRequest = {
          apiKey,
          model: { id: spec.model || CURSOR_DEFAULT_MODEL },
          text: [wire.instruction, wire.system, wire.prompt].filter((part): part is string => Boolean(part?.trim())).join('\n\n'),
          cwd: work,
          storeDir: join(place.dir, STORE)
        }
        text = await new Promise<string>((resolve, reject) => {
          let answer = ''
          let sent = false
          const stop = (error: unknown) => {
            signal.removeEventListener('abort', aborted)
            reject(error)
          }
          const aborted = () => stop(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', aborted, { once: true })
          child.once('close', (code) => {
            const tail = redactCursorText(stderrTail.trim().split('\n').slice(-3).join(' ')).slice(0, 300)
            stop(harnessAppError({ code: 'service_unavailable', message: `The ${label} host stopped before it answered (exit code ${code})${tail ? `: ${tail}` : ''}.`, instanceId }))
          })
          lines.on('line', (line) => {
            let message: CursorHostMessage
            try {
              message = JSON.parse(line) as CursorHostMessage
            } catch {
              return
            }
            if (!('event' in message)) return
            if (message.event === 'ready') {
              if (sent) return
              events.activity()
              try {
                events.sending()
              } catch (error) {
                return stop(error)
              }
              sent = true
              child.stdin.write(`${JSON.stringify(request)}\n`)
              return
            }
            if (message.event === 'delta') {
              const tool = cursorToolUpdate(message.update)
              if (tool) return events.tool(tool)
              if (message.update.type === 'text-delta' && typeof message.update.text === 'string') {
                answer += message.update.text
                events.text(message.update.text)
              } else events.activity()
              return
            }
            if (message.event === 'run_end') {
              signal.removeEventListener('abort', aborted)
              if (message.status === 'finished' && !message.transportFailure) return resolve(answer)
              if (message.status === 'cancelled') return reject(harnessAppError({ code: 'cancelled', message: `${label} stopped the request.`, instanceId }))
              return reject(cursorRunError(label, instanceId, message.error ?? (message.transportFailure ? { message: message.transportFailure } : undefined)))
            }
          })
        })
      } catch (error) {
        failure = error
      }
      const released = await releasePlace(place, proc, [], { written: WORK })
      if (failure) throw failure
      if (!released.reaped) throw harnessAppError({ code: 'protocol', message: `The ${label} host did not end after its request.`, instanceId })
      if (released.written)
        throw harnessAppError({ code: 'one_shot_tool_refused', reason: 'tool_detected', message: `${label} left ${released.written} in the empty folder of a request that runs no tools, so Mousse did not use its answer.`, instanceId })
      return text.trim()
    }
  }
}
