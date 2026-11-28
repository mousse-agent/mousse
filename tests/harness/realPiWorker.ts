/**
 * Pi's single-request worker (`pi:worker`) for tests, never Bedrock itself: the worker entry bundled as the app bundles
 * it, run by the real Pi driver's runtime, a catalogue Bedrock model whose endpoint is a loopback HTTP/2 stub of
 * Bedrock's runtime (as an entry's endpoint setting gives it), made-up keys, and a throwaway person whose home holds the
 * setup a request must not load. Everything else goes to the person's closed proxy, so nothing reaches AWS.
 */
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { AMAZON_BEDROCK_MODELS } from '@earendil-works/pi-ai/providers/amazon-bedrock.models'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { crashChild } from '../support/build'
import { recordingEvents, throwawayUser } from './realOpencode'

/** The worker entry, bundled with pi-ai and the AWS SDK in it (the app loads them from its node_modules). */
export function piWorkerScript(): Promise<string> {
  return crashChild('src/mms/harness/pi/worker.ts', {
    format: 'esm',
    name: 'pi-worker',
    banner: { js: "import { createRequire as __mousseRequire } from 'node:module'; const require = __mousseRequire(import.meta.url);" }
  })
}

/** A catalogue Bedrock model, its endpoint the stub's. */
export const BEDROCK_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0'

/** pi-ai's catalogue definition of `BEDROCK_MODEL`, at `baseUrl` when given. */
export function bedrockModel(baseUrl?: string) {
  const model = (AMAZON_BEDROCK_MODELS as unknown as Record<string, Record<string, unknown> & { id: string; api: string; provider: string }>)[BEDROCK_MODEL]!
  return baseUrl ? { ...model, baseUrl } : model
}

export const ENTRY_KEY_ID = 'AKIAENTRYKEY0000001'
export const ENTRY_SECRET = 'entry-secret-0000000000000000000000001'

export interface StubRequest {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

/** How the stub answers each request: an AWS error status, or a stream with this text (or a tool call). */
export type StubAnswer = { status: 429 | 503 } | { text: string } | { tool: string }

export interface BedrockStub {
  url: string
  requests: StubRequest[]
  /** The access key id each request was signed with, or `bearer` for a bearer token. */
  signers(): string[]
  close(): Promise<void>
}

const ERRORS = {
  429: { type: 'ThrottlingException', message: 'Too many requests, please wait before trying again.' },
  503: { type: 'ServiceUnavailableException', message: 'Service unavailable' }
} as const

/** One AWS event-stream message: an `event` of `type` with a JSON payload. */
function eventMessage(type: string, payload: unknown): Buffer {
  const header = (name: string, value: string) => {
    const n = Buffer.from(name)
    const v = Buffer.from(value)
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length)
    out.writeUInt8(n.length, 0)
    n.copy(out, 1)
    out.writeUInt8(7, 1 + n.length)
    out.writeUInt16BE(v.length, 2 + n.length)
    v.copy(out, 4 + n.length)
    return out
  }
  const headers = Buffer.concat([header(':event-type', type), header(':content-type', 'application/json'), header(':message-type', 'event')])
  const body = Buffer.from(JSON.stringify(payload))
  const total = 12 + headers.length + body.length + 4
  const prelude = Buffer.alloc(8)
  prelude.writeUInt32BE(total, 0)
  prelude.writeUInt32BE(headers.length, 4)
  const preludeCrc = Buffer.alloc(4)
  preludeCrc.writeUInt32BE(crc32(prelude) >>> 0, 0)
  const head = Buffer.concat([prelude, preludeCrc, headers, body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(head) >>> 0, 0)
  return Buffer.concat([head, crc])
}

function streamBody(answer: { text: string } | { tool: string }): Buffer {
  const events = [eventMessage('messageStart', { role: 'assistant' })]
  if ('text' in answer) {
    events.push(eventMessage('contentBlockDelta', { contentBlockIndex: 0, delta: { text: answer.text } }), eventMessage('contentBlockStop', { contentBlockIndex: 0 }))
    events.push(eventMessage('messageStop', { stopReason: 'end_turn' }))
  } else {
    events.push(eventMessage('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tool-1', name: answer.tool } } }))
    events.push(eventMessage('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } }), eventMessage('contentBlockStop', { contentBlockIndex: 0 }))
    events.push(eventMessage('messageStop', { stopReason: 'tool_use' }))
  }
  events.push(eventMessage('metadata', { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } }))
  return Buffer.concat(events)
}

/** Bedrock's runtime over cleartext HTTP/2, as the SDK's default handler speaks it: every request recorded. */
export async function bedrockStub(answer: StubAnswer): Promise<BedrockStub> {
  const requests: StubRequest[] = []
  const server: Http2Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      if ('status' in answer) {
        const error = ERRORS[answer.status]
        res.writeHead(answer.status, { 'content-type': 'application/json', 'x-amzn-errortype': error.type })
        return res.end(JSON.stringify({ message: error.message }))
      }
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      res.end(streamBody(answer))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    signers: () => requests.map((request) => {
      const auth = String(request.headers.authorization ?? '')
      return /^Bearer /i.test(auth) ? 'bearer' : (/Credential=([^/]+)\//.exec(auth)?.[1] ?? 'none')
    }),
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}

/** A throwaway person with Mousse's profile in their home, as on a real computer. */
export function piPerson() {
  return throwawayUser('mousse-pi-worker-')
}

/** The stored Bedrock credential, as pi-ai's store keeps it. */
export type StoredCredential = { type: 'api_key'; key: string; env?: Record<string, string> }

/**
 * The real Pi driver's runtime for an `amazon-bedrock` entry of that person: the catalogue's Bedrock models, the stored
 * credential `stored`, Mousse's environment `ambient` (over the person's), and the worker pointed at the stub.
 */
export function piWorkerRuntime(input: { person: ReturnType<typeof piPerson>; script: string; stub: BedrockStub; stored?: () => StoredCredential | undefined; ambient?: Record<string, string> }): DriverRuntime {
  const { person } = input
  const stateDir = join(person.profile, 'harness', 'pi-amazon-bedrock')
  mkdirSync(stateDir, { recursive: true })
  const model = bedrockModel(input.stub.url)
  const models = { getModel: (provider: string, id: string) => (provider === 'amazon-bedrock' && id === BEDROCK_MODEL ? model : undefined), getModels: () => [model] }
  const credentials = () => ({
    models: models as never,
    credentials: { get: () => input.stored?.() } as never,
    getProviderDisplayName: () => 'Amazon Bedrock'
  })
  const base = { ...process.env, ...person.env, ...(input.ambient ?? {}) }
  const context: DriverContext = {
    instanceId: 'pi:amazon-bedrock',
    builtIn: false,
    config: { home: 'default', displayName: 'Amazon Bedrock' },
    env: instanceEnv({ instanceId: 'pi:amazon-bedrock', driver: 'pi', configRevision: 0, searchPath: [], base }),
    profileHome: person.profile,
    installationHome: person.profile,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  return piDriver({ credentials, worker: { script: input.script } }).create(context)
}

export const PROMPT_LINE = 'PROMPT_LINE_5b1e'

/** One title request through the runtime's `pi:worker` transport. */
export function sendWorkerOnce(runtime: DriverRuntime, signal = AbortSignal.timeout(60_000)) {
  const { seen, events } = recordingEvents()
  const sent = runtime.oneShotTransport!({ model: BEDROCK_MODEL }).send({ model: BEDROCK_MODEL, system: 'You name chats in a few words.', prompt: `${PROMPT_LINE}: the login page loops after OAuth.` }, events, signal)
  return { seen, sent }
}

/**
 * The bundled worker run by hand with `env` exactly (no sealed launch): the request goes in, the events come out. For
 * the controls, which show what the launch keeps out.
 */
export async function runWorkerDirect(script: string, env: NodeJS.ProcessEnv, request: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events: Array<Record<string, unknown>> = []
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line) as Record<string, unknown>
    events.push(event)
    if (event.event === 'ready') child.stdin.write(`${JSON.stringify(request)}
`)
  })
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  if (!events.some((event) => event.event === 'end')) throw new Error(`the worker ended with no answer: ${stderr.slice(-1500)}`)
  return events
}

/** The request the transport sends for `BEDROCK_MODEL` at the stub, with `env` as its credentials. */
export function workerRequest(stub: BedrockStub, env: Record<string, string>): Record<string, unknown> {
  return { model: bedrockModel(stub.url), system: 'You name chats in a few words.', prompt: `${PROMPT_LINE}: control.`, env }
}

/** What the AWS sign-in stub hands out: each sign-in's own made-up temporary keys. */
export const SIGNED_IN = {
  sso: { id: 'ASIASSOSIGNIN000001', token: 'SSO_SESSION_TOKEN_7d2a' },
  role: { id: 'ASIAROLESIGNIN00001', token: 'ROLE_SESSION_TOKEN_7d2a' },
  webIdentity: { id: 'ASIAWEBIDSIGNIN0001', token: 'WEBID_SESSION_TOKEN_7d2a' },
  container: { id: 'ASIACONTAINER000001', token: 'CONTAINER_SESSION_TOKEN_7d2a' }
} as const

export interface AwsSignInStub {
  url: string
  /** `METHOD path body` of each request, and the SSO bearer token it carried. */
  requests: Array<{ line: string; ssoToken?: string }>
  close(): Promise<void>
}

/**
 * The AWS services a sign-in calls, never AWS itself: STS (`AssumeRole`, `AssumeRoleWithWebIdentity`), the SSO portal's
 * role credentials, and a container's credential endpoint (`/creds`), at a loopback HTTP/1.1 server reached through
 * `AWS_ENDPOINT_URL_STS`/`AWS_ENDPOINT_URL_SSO` and `AWS_CONTAINER_CREDENTIALS_FULL_URI`. `status` answers every
 * request with that error instead.
 */
export async function awsSignInStub(input: { status?: 503 } = {}): Promise<AwsSignInStub> {
  const { createServer: createHttpServer } = await import('node:http')
  const requests: AwsSignInStub['requests'] = []
  const expiration = () => new Date(Date.now() + 3_600_000)
  const server = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const token = req.headers['x-amz-sso_bearer_token']
      requests.push({ line: `${req.method} ${req.url} ${body}`, ...(typeof token === 'string' ? { ssoToken: token } : {}) })
      if (input.status) {
        res.writeHead(input.status, { 'content-type': 'text/xml' })
        return res.end('<ErrorResponse><Error><Type>Receiver</Type><Code>ServiceUnavailable</Code><Message>unavailable</Message></Error></ErrorResponse>')
      }
      if (req.url?.startsWith('/federation/credentials')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ roleCredentials: { accessKeyId: SIGNED_IN.sso.id, secretAccessKey: 'sso-secret', sessionToken: SIGNED_IN.sso.token, expiration: expiration().getTime() } }))
      }
      if (req.url?.startsWith('/creds')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ AccessKeyId: SIGNED_IN.container.id, SecretAccessKey: 'container-secret', Token: SIGNED_IN.container.token, Expiration: expiration().toISOString() }))
      }
      const action = /Action=(\w+)/.exec(body)?.[1] ?? 'AssumeRole'
      const keys = action === 'AssumeRoleWithWebIdentity' ? SIGNED_IN.webIdentity : SIGNED_IN.role
      res.writeHead(200, { 'content-type': 'text/xml' })
      res.end(`<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result><Credentials><AccessKeyId>${keys.id}</AccessKeyId><SecretAccessKey>role-secret</SecretAccessKey><SessionToken>${keys.token}</SessionToken><Expiration>${expiration().toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::111111111111:assumed-role/r/s</Arn><AssumedRoleId>AROA0000:s</AssumedRoleId></AssumedRoleUser></${action}Result></${action}Response>`)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}
