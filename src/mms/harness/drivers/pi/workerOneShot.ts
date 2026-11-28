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
import type { PiWorkerMessage, PiWorkerRequest } from '../../pi/workerProtocol'
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
 *   time): a bearer token, or static keys and the region, from the entry's sign-in, the environment, or the one profile
 *   it names. A profile that signs in another way (SSO, a credential process, a role, web identity, `aws login`) would
 *   need more of the person's setup (caches, programs, other profiles): its requests are refused with the reason.
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

/** A profile key that signs in some other way than static keys, and what it is called. */
const OTHER_SIGN_INS: ReadonlyArray<[string, string]> = [
  ['sso_session', 'IAM Identity Center (SSO)'],
  ['sso_start_url', 'IAM Identity Center (SSO)'],
  ['credential_process', 'a credential process'],
  ['role_arn', 'an assumed role'],
  ['source_profile', 'an assumed role'],
  ['credential_source', 'an assumed role'],
  ['web_identity_token_file', 'web identity'],
  ['login_session', '`aws login`']
]

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

/** A refusal before anything is sent: the request does not count as an attempt. */
export class BedrockInputRefused extends Error {}

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
 * The static keys and region of the one profile `name`, read from the person's files now: the config file's
 * `[profile name]` (`[default]`), with the credentials file's `[name]` over it. Nothing else of the files is kept.
 */
async function profileInputs(name: string, env: NodeJS.ProcessEnv, region: string | undefined): Promise<BedrockInputs> {
  const home = awsHome(env)
  const configFile = lookup(env, 'AWS_CONFIG_FILE') ?? join(home, '.aws', 'config')
  const credentialsFile = lookup(env, 'AWS_SHARED_CREDENTIALS_FILE') ?? join(home, '.aws', 'credentials')
  const [config, credentials] = await Promise.all([readIni(configFile), readIni(credentialsFile)])
  const fromConfig = name === 'default' ? { ...config.get('default'), ...config.get('profile default') } : config.get(`profile ${name}`)
  const fromCredentials = credentials.get(name)
  if (!fromConfig && !fromCredentials) throw harnessAppError({ code: 'signed_out', message: `The AWS profile "${name}" is not in ${credentialsFile} or ${configFile}.` })
  const profile = { ...fromConfig, ...fromCredentials }
  const other = OTHER_SIGN_INS.find(([key]) => profile[key])
  if (other)
    throw new BedrockInputRefused(`The AWS profile "${name}" signs in with ${other[1]}, which needs more of the AWS setup than a single request is given.`)
  const id = profile.aws_access_key_id
  const secret = profile.aws_secret_access_key
  if (!id || !secret) throw harnessAppError({ code: 'signed_out', message: `The AWS profile "${name}" has no access key.` })
  const out: Record<string, string> = { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret }
  if (profile.aws_session_token) out.AWS_SESSION_TOKEN = profile.aws_session_token
  const where = region ?? profile.region
  if (where) out.AWS_REGION = where
  return { env: out, source: `profile ${name}` }
}

/**
 * What a request signs with, read now, in pi-ai's order: a bearer token (the entry's stored key, else
 * `AWS_BEARER_TOKEN_BEDROCK`); the profile the sign-in stored; static keys in the environment; `AWS_PROFILE`; else the
 * default profile. Web identity and container roles are refused. `env` is the entry's environment as Mousse runs it.
 */
export async function bedrockInputs(stored: StoredBedrockCredential | undefined, ambient: NodeJS.ProcessEnv): Promise<BedrockInputs> {
  const env: NodeJS.ProcessEnv = { ...ambient, ...(stored?.env ?? {}) }
  const region = lookup(env, 'AWS_REGION') ?? lookup(env, 'AWS_DEFAULT_REGION')
  const regionEnv: Record<string, string> = region ? { AWS_REGION: region } : {}
  const key = stored?.key && stored.key !== PI_AMBIENT_MARKER ? stored.key : undefined
  const bearer = key ?? lookup(env, 'AWS_BEARER_TOKEN_BEDROCK')
  if (bearer) return { bearerToken: bearer, env: regionEnv, source: key ? 'the stored bearer token' : 'AWS_BEARER_TOKEN_BEDROCK' }
  const storedProfile = stored?.env?.AWS_PROFILE
  if (storedProfile) return profileInputs(storedProfile, env, region)
  const id = lookup(env, 'AWS_ACCESS_KEY_ID')
  const secret = lookup(env, 'AWS_SECRET_ACCESS_KEY')
  if (id && secret) {
    const token = lookup(env, 'AWS_SESSION_TOKEN')
    return { env: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, ...(token ? { AWS_SESSION_TOKEN: token } : {}), ...regionEnv }, source: 'AWS access keys' }
  }
  const profile = lookup(env, 'AWS_PROFILE')
  if (profile) return profileInputs(profile, env, region)
  if (lookup(env, 'AWS_WEB_IDENTITY_TOKEN_FILE') || lookup(env, 'AWS_ROLE_ARN'))
    throw new BedrockInputRefused('AWS signs in here with web identity, which needs more of the AWS setup than a single request is given.')
  if (lookup(env, 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI') || lookup(env, 'AWS_CONTAINER_CREDENTIALS_FULL_URI'))
    throw new BedrockInputRefused("AWS signs in here with a container's role, which needs more of the AWS setup than a single request is given.")
  return profileInputs('default', env, region)
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
      let inputs: BedrockInputs
      try {
        inputs = await bedrockInputs(options.credential(), options.baseEnv)
      } catch (error) {
        if (error instanceof BedrockInputRefused)
          throw harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: `${label}: ${error.message} Mousse did not send the request.`, instanceId })
        throw error
      }
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
