import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Api, Model } from '@earendil-works/pi-ai'
import { harnessAppError } from '../../../../shared/harness/types'
import { sealedEnv } from '../../oneShot/launch'
import { releasePlace, reservePlace, spawnInPlace, type PlaceProcess } from '../../oneShot/places'
import type { OneShotRouteDecision, OneShotTransport } from '../../oneShot/route'
import { PI_WORKER_FACTS } from '../../oneShot/routes'
import { PI_AMBIENT_MARKER } from '../../pi/envKeys'
import { recordHarnessSpawn } from '../../spawn'
import { PI_AWS_CREDENTIALS_ARG, type PiAwsCredentialsRequest, type PiAwsCredentialsResult, type PiWorkerMessage, type PiWorkerRequest } from '../../pi/workerProtocol'
import { assertAssistantResponseSucceeded } from './stream'

/**
 * Pi's single requests on Bedrock (`pi:worker`, docs/plans/one-shots-every-provider.md): one pi-ai request in a worker
 * process of its own (`harness/pi/worker.ts`), started in the request's place and ended with it.
 *
 * What the spike showed on pi-ai 1.4.0 and its AWS SDK (`tests/piWorkerOneShotEffects.test.ts` keeps it, at a loopback
 * stub with made-up keys):
 * - pi-ai makes its `BedrockRuntimeClient` with no `maxAttempts`, so the SDK takes `AWS_MAX_ATTEMPTS` and
 *   `AWS_RETRY_MODE` from the environment, else from the profile's `max_attempts`/`retry_mode`, else three attempts.
 *   The worker's launch sets `AWS_MAX_ATTEMPTS=1` (and `standard` mode): a request that fails with 429 or 503 is sent
 *   once. Without it the same request is sent three times.
 * - The SDK reads its config and credentials files from `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`, else the home
 *   folder, for every client setting (attempts, retry mode, endpoints, region) and for a profile's credentials. The
 *   sealed launch keeps those variables out and puts the home in the place, so none of the person's files load.
 * - The request carries the only credentials it may use, read now (so a replaced credentials file is read the next
 *   time): a bearer token, or keys and the region, from the entry's sign-in, the environment, or the one profile it
 *   names. Static keys are read here. Every other sign-in (SSO, a credential process, an assumed role, web identity,
 *   `aws login`, a container's role) is resolved on Mousse's side by the AWS SDK's own credential chain, in the
 *   entry's environment as Pi's turns have it, in a short sign-in process (`resolveAwsSignIn`) with one attempt for
 *   each STS or SSO call. The worker gets only the temporary keys: never the files, the SSO cache or the program.
 */

export const PI_WORKER_ROUTE = 'pi:worker' as const

const WORKER_ROUTE: OneShotRouteDecision = Object.freeze({ route: Object.freeze({ id: PI_WORKER_ROUTE, facts: PI_WORKER_FACTS }) })

/** A Bedrock model's single requests run in the worker. */
export function piWorkerRoute(): OneShotRouteDecision {
  return WORKER_ROUTE
}

/** Set in the worker's environment before pi-ai makes its AWS client: the SDK sends a failed request once. */
export const PI_WORKER_AWS_ENV: Readonly<Record<string, string>> = Object.freeze({ AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' })

/** Where the request goes, when the entry sets it: an endpoint, and pi-ai's own Bedrock switches. Never a credential. */
const ENDPOINT_ENV = ['AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_ENDPOINT_URL', 'AWS_USE_FIPS_ENDPOINT', 'AWS_USE_DUALSTACK_ENDPOINT', 'AWS_BEDROCK_FORCE_HTTP1', 'AWS_BEDROCK_SKIP_AUTH', 'AWS_BEDROCK_FORCE_CACHE']

/** Profile keys of a sign-in other than static keys (the SDK's `fromIni` cases): the AWS SDK resolves those. */
const SDK_SIGN_INS = ['sso_session', 'sso_start_url', 'sso_account_id', 'sso_region', 'sso_role_name', 'credential_process', 'role_arn', 'source_profile', 'credential_source', 'web_identity_token_file', 'login_session']

/** What the worker is given to sign the request with. */
export interface BedrockInputs {
  bearerToken?: string
  /** pi-ai's scoped variables: static keys and the region. */
  env: Record<string, string>
  /** Where they came from, for a refusal or a log. */
  source: string
}

/** The stored credential of the entry, as pi-ai's store keeps it. */
export interface StoredBedrockCredential {
  key?: string
  env?: Record<string, string>
}

/** Keys the AWS SDK's sign-in gave. */
export interface AwsKeys {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

/**
 * The AWS SDK's sign-in for `profile` (else its own order: the default profile, web identity, a container's role, the
 * instance's), with `region` for its STS or SSO call: the temporary keys it gave.
 */
export type AwsSignIn = (profile: string | undefined, region: string | undefined) => Promise<AwsKeys>

function keysEnv(keys: AwsKeys, region: string | undefined): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    ...(keys.sessionToken ? { AWS_SESSION_TOKEN: keys.sessionToken } : {}),
    ...(region ? { AWS_REGION: region } : {})
  }
}

function lookup(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper && value) return value
  return undefined
}

/** The AWS SDK's home folder (`@smithy/shared-ini-file-loader` `getHomeDir`). */
function awsHome(env: NodeJS.ProcessEnv): string {
  const drive = lookup(env, 'HOMEDRIVE')
  const path = lookup(env, 'HOMEPATH')
  return lookup(env, 'HOME') ?? lookup(env, 'USERPROFILE') ?? (drive && path ? `${drive}${path}` : homedir())
}

/** The sections of an AWS shared file: `[name]` headers, `key = value` lines; indented sub-keys and comments skipped. */
export function parseAwsIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw) || !raw.trim()) continue
    const header = /^\s*\[([^\]]+)\]/.exec(raw)
    if (header) {
      const name = header[1]!.trim().replace(/\s+/g, ' ')
      current = sections.get(name) ?? {}
      sections.set(name, current)
      continue
    }
    if (!current || /^\s/.test(raw)) continue
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    current[raw.slice(0, eq).trim().toLowerCase()] = raw.slice(eq + 1).trim()
  }
  return sections
}

async function readIni(path: string): Promise<Map<string, Record<string, string>>> {
  try {
    return parseAwsIni(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
}

/**
 * The keys and region of the one profile `name`, read now: the config file's `[profile name]` (`[default]`), with the
 * credentials file's `[name]` over it. Static keys are read here; any other sign-in is the AWS SDK's (`signIn`). Nothing
 * else of the files is kept. `name` undefined is the SDK's own order: the default profile when it holds static keys,
 * else whatever the SDK's chain finds (web identity, a container's role, the instance's).
 */
async function profileInputs(name: string | undefined, env: NodeJS.ProcessEnv, region: string | undefined, signIn: AwsSignIn): Promise<BedrockInputs> {
  const home = awsHome(env)
  const configFile = lookup(env, 'AWS_CONFIG_FILE') ?? join(home, '.aws', 'config')
  const credentialsFile = lookup(env, 'AWS_SHARED_CREDENTIALS_FILE') ?? join(home, '.aws', 'credentials')
  const [config, credentials] = await Promise.all([readIni(configFile), readIni(credentialsFile)])
  const section = name ?? 'default'
  const fromConfig = section === 'default' ? { ...config.get('default'), ...config.get('profile default') } : config.get(`profile ${section}`)
  const fromCredentials = credentials.get(section)
  const profile: Record<string, string> = { ...fromConfig, ...fromCredentials }
  const where = region ?? profile.region
  const sdk = SDK_SIGN_INS.some((key) => profile[key])
  const id = profile.aws_access_key_id
  const secret = profile.aws_secret_access_key
  if (!sdk && id && secret)
    return { env: keysEnv({ accessKeyId: id, secretAccessKey: secret, ...(profile.aws_session_token ? { sessionToken: profile.aws_session_token } : {}) }, where), source: `profile ${section}` }
  if (name !== undefined && !sdk) {
    if (!fromConfig && !fromCredentials) throw harnessAppError({ code: 'signed_out', message: `The AWS profile "${name}" is not in ${credentialsFile} or ${configFile}.` })
    throw harnessAppError({ code: 'signed_out', message: `The AWS profile "${name}" has no access key.` })
  }
  return { env: keysEnv(await signIn(name, where), where), source: name ? `profile ${name}, signed in by the AWS SDK` : 'the AWS SDK\'s sign-in' }
}

/**
 * What a request signs with, read now, in pi-ai's order: a bearer token (the entry's stored key, else
 * `AWS_BEARER_TOKEN_BEDROCK`); the profile the sign-in stored; static keys in the environment; `AWS_PROFILE`; else the
 * SDK's own order (the default profile, web identity, a container's role, the instance's). `env` is the entry's
 * environment as Mousse runs it; `signIn` resolves every sign-in but static keys.
 */
export async function bedrockInputs(stored: StoredBedrockCredential | undefined, ambient: NodeJS.ProcessEnv, signIn: AwsSignIn): Promise<BedrockInputs> {
  const env: NodeJS.ProcessEnv = { ...ambient, ...(stored?.env ?? {}) }
  const region = lookup(env, 'AWS_REGION') ?? lookup(env, 'AWS_DEFAULT_REGION')
  const regionEnv: Record<string, string> = region ? { AWS_REGION: region } : {}
  const key = stored?.key && stored.key !== PI_AMBIENT_MARKER ? stored.key : undefined
  const bearer = key ?? lookup(env, 'AWS_BEARER_TOKEN_BEDROCK')
  if (bearer) return { bearerToken: bearer, env: regionEnv, source: key ? 'the stored bearer token' : 'AWS_BEARER_TOKEN_BEDROCK' }
  const storedProfile = stored?.env?.AWS_PROFILE
  if (storedProfile) return profileInputs(storedProfile, env, region, signIn)
  const id = lookup(env, 'AWS_ACCESS_KEY_ID')
  const secret = lookup(env, 'AWS_SECRET_ACCESS_KEY')
  if (id && secret) {
    const token = lookup(env, 'AWS_SESSION_TOKEN')
    return { env: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, ...(token ? { AWS_SESSION_TOKEN: token } : {}), ...regionEnv }, source: 'AWS access keys' }
  }
  return profileInputs(lookup(env, 'AWS_PROFILE'), env, region, signIn)
}

/** How long the AWS sign-in may take before the request fails. */
const SIGN_IN_TIMEOUT_MS = 60_000

/**
 * The AWS SDK's sign-in for a request, on Mousse's side: the worker entry started with `PI_AWS_CREDENTIALS_ARG` in the
 * entry's environment (`env`), as Pi's turns have it, so the SDK finds the person's files, SSO cache and credential
 * program where it always does, without changing Mousse's own environment. `AWS_MAX_ATTEMPTS=1` is added, so no STS or
 * SSO call is retried. It writes back only the keys, which stay in memory for this request.
 */
export function resolveAwsSignIn(input: { execPath: string; script: string; env: NodeJS.ProcessEnv; label: string; instanceId: string; signal: AbortSignal }): AwsSignIn {
  return (profile, region) => new Promise((resolve, reject) => {
    input.signal.throwIfAborted()
    const env: NodeJS.ProcessEnv = { ...input.env, ELECTRON_RUN_AS_NODE: '1', ...PI_WORKER_AWS_ENV }
    recordHarnessSpawn({ instanceId: input.instanceId, purpose: 'pi-aws-sign-in', command: input.execPath, args: [input.script, PI_AWS_CREDENTIALS_ARG], env })
    const child = spawn(input.execPath, [input.script, PI_AWS_CREDENTIALS_ARG], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let stderrTail = ''
    let done = false
    const finish = (error: unknown, keys?: AwsKeys) => {
      if (done) return
      done = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', aborted)
      if (child.exitCode === null) child.kill()
      if (keys) resolve(keys)
      else reject(error)
    }
    const failed = (why: string) => harnessAppError({ code: 'signed_out', message: `${input.label}: AWS did not sign in (${why}). Mousse did not send the request.`, instanceId: input.instanceId })
    const aborted = () => finish(input.signal.reason ?? new DOMException('Aborted', 'AbortError'))
    input.signal.addEventListener('abort', aborted, { once: true })
    const timer = setTimeout(() => finish(failed(`no answer in ${SIGN_IN_TIMEOUT_MS / 1000} s`)), SIGN_IN_TIMEOUT_MS)
    child.on('error', (error) => finish(failed(error.message)))
    child.stdin.on('error', () => { /* the sign-in already ended */ })
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1_000) })
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('close', (code) => {
      let result: PiAwsCredentialsResult | undefined
      try {
        result = JSON.parse(out.trim().split('\n').at(-1) ?? '') as PiAwsCredentialsResult
      } catch {
        result = undefined
      }
      if (result && 'accessKeyId' in result && result.accessKeyId && result.secretAccessKey)
        return finish(undefined, { accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey, ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}) })
      const tail = stderrTail.trim().split('\n').slice(-2).join(' ').slice(0, 300)
      finish(failed(result && 'error' in result ? result.error : `exit code ${code}${tail ? `: ${tail}` : ''}`))
    })
    const request: PiAwsCredentialsRequest = { ...(profile ? { profile } : {}), ...(region ? { region } : {}) }
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

/** The built worker entry beside the bundle that runs this code (`out/main/piWorker.js`). */
export function defaultPiWorkerScript(): string | undefined {
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..')]) {
    const script = join(dir, 'piWorker.js')
    if (existsSync(script)) return script
  }
  return undefined
}

export interface PiWorkerOptions {
  label: string
  instanceId: string
  profileHome: string
  /** The built worker entry; undefined in a build without one. */
  script: string | undefined
  /** The program that runs the worker as Node (Electron as Node, or Node). */
  execPath: string
  /** Mousse's environment for the entry: the sealed launch's allowlist, and the named AWS inputs read from it. */
  baseEnv: NodeJS.ProcessEnv
  /** The entry's stored credential, read at the time of the request. */
  credential(): StoredBedrockCredential | undefined
  /** Test seam: variables for the worker (none of them a credential). */
  workerEnv?: Readonly<Record<string, string>>
}

/** What the transport sends: the model resolved now, and the request's text and options. */
export interface PiWorkerSpec {
  model: Model<Api>
  reasoning?: string
  sessionId?: string
}

/** The working folder of the worker in its place, and the folder its reserved roots point into. */
const WORK = 'work'
const ROOT = 'root'

/**
 * The transport of `pi:worker`: the credential inputs read now, the request's place (its record first, then its
 * folder), the worker in it on the sealed launch (reserved roots in the place, `AWS_MAX_ATTEMPTS=1`, no other AWS
 * variable but the entry's endpoint), and once it says `ready`, the one request on its stdin with the credentials in
 * it. Its text streams back until one `end`. The place is removed once its process tree has gone, with proof; anything
 * written in its working folder fails the request.
 */
export function piWorkerTransport(options: PiWorkerOptions, spec: () => PiWorkerSpec): OneShotTransport {
  const { label, instanceId } = options
  return {
    send: async (wire, events, signal) => {
      signal.throwIfAborted()
      if (!options.script) throw harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: `${label} cannot run a single request: this build of Mousse has no Pi worker.`, instanceId })
      const { model, reasoning, sessionId } = spec()
      const stored = options.credential()
      const signIn = resolveAwsSignIn({ execPath: options.execPath, script: options.script, env: { ...options.baseEnv, ...(stored?.env ?? {}) }, label, instanceId, signal })
      const inputs = await bedrockInputs(stored, options.baseEnv, signIn)
      signal.throwIfAborted()
      const endpoint: Record<string, string> = {}
      for (const name of ENDPOINT_ENV) {
        const value = lookup(options.baseEnv, name)
        if (value) endpoint[name] = value
      }
      const place = reservePlace(options.profileHome, { route: PI_WORKER_ROUTE, instanceId })
      const work = join(place.dir, WORK)
      let proc: PlaceProcess | undefined
      let text = ''
      let failure: unknown
      try {
        mkdirSync(work, { recursive: true, mode: 0o700 })
        events.launching(options.execPath)
        const env = sealedEnv({
          base: options.baseEnv,
          preset: { ...(options.workerEnv ?? {}), ...endpoint, ELECTRON_RUN_AS_NODE: '1', ...PI_WORKER_AWS_ENV },
          root: join(place.dir, ROOT)
        })
        proc = spawnInPlace(place, { command: options.execPath, args: [options.script], env, purpose: 'pi-one_shot', instanceId, cwd: work })
        const child = proc.child
        child.stdin.on('error', () => { /* the worker already ended */ })
        let stderrTail = ''
        child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000) })
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
        const request: PiWorkerRequest = {
          model: model as unknown as Record<string, unknown>,
          system: wire.system,
          prompt: wire.prompt,
          ...(reasoning ? { reasoning } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(inputs.bearerToken ? { bearerToken: inputs.bearerToken } : {}),
          env: inputs.env
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
            const tail = stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 300)
            stop(harnessAppError({ code: 'service_unavailable', message: `The ${label} worker stopped before it answered (exit code ${code})${tail ? `: ${tail}` : ''}.`, instanceId }))
          })
          lines.on('line', (line) => {
            let message: PiWorkerMessage
            try {
              message = JSON.parse(line) as PiWorkerMessage
            } catch {
              return
            }
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
            if (message.event === 'text') {
              answer += message.text
              return events.text(message.text)
            }
            if (message.event === 'tool') return events.tool(message.name)
            if (message.event === 'activity') return events.activity()
            if (message.event === 'end') {
              signal.removeEventListener('abort', aborted)
              if (!message.error) return resolve(answer || message.text)
              try {
                assertAssistantResponseSucceeded({ errorMessage: message.error, stopReason: 'error', provider: message.provider ?? model.provider } as Parameters<typeof assertAssistantResponseSucceeded>[0])
              } catch (error) {
                return reject(error)
              }
            }
          })
        })
      } catch (error) {
        failure = error
      }
      const released = await releasePlace(place, proc, [], { written: WORK })
      if (failure) throw failure
      if (!released.reaped) throw harnessAppError({ code: 'protocol', message: `The ${label} worker did not end after its request.`, instanceId })
      if (released.written)
        throw harnessAppError({ code: 'one_shot_tool_refused', reason: 'tool_detected', message: `${label} left ${released.written} in the empty folder of a request that runs no tools, so Mousse did not use its answer.`, instanceId })
      return text.trim()
    }
  }
}
