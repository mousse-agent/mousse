/**
 * The real OpenCode for single-request tests (`opencode:sealed`), with nothing of the person's own: every folder it
 * reads or writes is a throwaway one, its only model is an OpenAI-compatible stub on loopback that keeps every request,
 * and any other address goes to a closed port. No sign-in; dummy keys only. An account sign-in is a fake one: a plugin
 * (`stubAccountPlugin`) gives the stub provider an OAuth method whose renewal asks the stub's own token endpoint.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DriverRuntime } from '../../src/mms/harness/driver'
import { opencodeDriver, type OpencodeDriverOptions } from '../../src/mms/harness/drivers/opencode'
import { instanceEnv, resolveCommand } from '../../src/mms/harness/env'
import type { OneShotEvents, OneShotWireRequest } from '../../src/mms/harness/oneShot/route'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

/** The OpenCode executable: `MOUSSE_OPENCODE_BINARY`, the one on PATH, or OpenCode's own installer's. */
export function opencodeBinary(): string | undefined {
  const named = process.env.MOUSSE_OPENCODE_BINARY
  if (named) return existsSync(named) ? named : undefined
  const found = resolveCommand('opencode', { env: process.env, searchPath: [] })
  if (found) return found.path
  const standalone = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  return existsSync(standalone) ? standalone : undefined
}

export interface StubRequest {
  url: string
  authorization: string | undefined
  body: Record<string, unknown>
  tools: string[]
  text: string
}

export interface ModelStub {
  url: string
  requests: StubRequest[]
  /** Each request takes the next status (an error reply); with none left, it answers `answer`. */
  statuses: number[]
  answer: string
  /** When set, every answer is a call of this tool instead of text. */
  toolCall?: { name: string; arguments: Record<string, unknown> }
  /** The refresh tokens presented to the token endpoint (`/oauth/token`), in order. */
  renewals: string[]
  /** What the token endpoint answers: a new access and refresh token. */
  renewed: { access: string; refresh: string }
  /** Runs when the token endpoint is asked, before it answers. */
  onRenewal?: () => void
  close(): void
}

/** An OpenAI-compatible chat completions stand-in on loopback. */
export async function modelStub(answer = 'Fix login bug'): Promise<ModelStub> {
  const stub: ModelStub = { url: '', requests: [], statuses: [], answer, renewals: [], renewed: { access: 'access-2', refresh: 'refresh-2' }, close: () => server.close() }
  const server: Server = createServer((request, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { text += chunk })
    request.on('end', () => {
      if (request.url === '/oauth/token') {
        stub.renewals.push(new URLSearchParams(text).get('refresh_token') ?? '')
        stub.onRenewal?.()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ access_token: stub.renewed.access, refresh_token: stub.renewed.refresh, expires_in: 3600 }))
        return
      }
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
      const tools = Array.isArray(body.tools) ? body.tools.map((tool: { function?: { name?: unknown } }) => String(tool?.function?.name ?? '')) : []
      stub.requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body, tools, text })
      const status = stub.statuses.shift()
      if (status) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: status === 429 ? 'Rate limit reached for requests' : 'The server is overloaded', type: status === 429 ? 'rate_limit_error' : 'server_error' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' }
      if (stub.toolCall) {
        const call = { index: 0, id: 'call_1', type: 'function', function: { name: stub.toolCall.name, arguments: JSON.stringify(stub.toolCall.arguments) } }
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: stub.answer } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  return stub
}

/**
 * The stub as an OpenCode provider (`stub` by default) with model `stub-model`: its key comes from `apiKey`, else a
 * sign-in. `plugins` are loaded with it (`stubAccountPlugin`).
 */
export function stubProviderConfig(stub: ModelStub, apiKey?: string, provider = 'stub', model = 'stub-model', plugins?: string[]): string {
  return JSON.stringify({ ...(plugins ? { plugins } : {}), providers: { [provider]: { name: 'Stub', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: stub.url, ...(apiKey ? { apiKey } : {}) }, models: { [model]: { name: 'Stub model' } } } } })
}

/** The fake account sign-in's method on the stub provider. */
export const STUB_ACCOUNT_METHOD = 'stub-login'

/**
 * A plugin (in `dir`) that gives the `stub` integration an OAuth method, `stub-login`, standing in for OpenCode's own
 * account sign-ins: OpenCode renews it when it is about to expire, and its renewal asks the stub's token endpoint.
 * Returns the plugin's URL for a config's `plugins`.
 */
export function stubAccountPlugin(dir: string, stub: ModelStub): string {
  mkdirSync(dir, { recursive: true })
  const token = stub.url.replace(/\/v1$/, '/oauth/token')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-stub-account', type: 'module' }))
  writeFileSync(join(dir, 'index.js'), `export default {
  id: 'test.stub-account',
  setup: async (ctx) => {
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: 'stub',
        method: { id: ${JSON.stringify(STUB_ACCOUNT_METHOD)}, type: 'oauth', label: 'Stub account' },
        authorize: async () => { throw new Error('no sign-in here') },
        refresh: async (credential) => {
          const response = await fetch(${JSON.stringify(token)}, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh }) })
          const tokens = await response.json()
          return { ...credential, access: tokens.access_token, refresh: tokens.refresh_token, expires: Date.now() + tokens.expires_in * 1000 }
        }
      })
    })
  }
}
`)
  return pathToFileURL(dir).href
}

/** An account sign-in on the stub: expired (`expires` 1) unless `expires` is given, so the next use renews it. */
export function stubAccount(expires = 1, tokens = { access: 'access-1', refresh: 'refresh-1' }): Record<string, unknown> {
  return { type: 'oauth', methodID: STUB_ACCOUNT_METHOD, refresh: tokens.refresh, access: tokens.access, expires }
}

/**
 * Signs the throwaway person in the way OpenCode does: their own OpenCode (`env`) stores `value` for `integrationID`
 * through its API, in their real database. Resolves once that OpenCode has ended.
 */
export async function signInWithOpencode(binary: string, env: Record<string, string>, cwd: string, integrationID: string, value: Record<string, unknown>): Promise<void> {
  const password = 'sign-in'
  const child = spawn(binary, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PASSWORD: password },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        const newline = out.indexOf('\n')
        if (newline >= 0) resolve((JSON.parse(out.slice(0, newline)) as { url: string }).url)
      })
      child.once('exit', (code) => reject(new Error(`OpenCode exited (${code}) before it was ready.`)))
    })
    const response = await fetch(`${url}/api/credential`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrationID, value })
    })
    if (!response.ok) throw new Error(`OpenCode did not store the sign-in: ${response.status} ${await response.text()}`)
  } finally {
    child.kill()
    await exited
  }
}

/** A throwaway person: a home with OpenCode's config, data and temporary folders, as their environment names them. */
export function throwawayUser(prefix = 'mousse-opencode-one-shot-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMPDIR: join(root, 'tmp'),
    // Nothing leaves this computer: the stub is on loopback, everything else goes to a closed port.
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost'
  }
  for (const dir of [home, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_STATE_HOME!, env.XDG_CACHE_HOME!, env.APPDATA!, env.LOCALAPPDATA!, env.TMP!]) mkdirSync(dir, { recursive: true })
  /** Mousse's profile, under the person's home as it is on a real computer: the places are below it. */
  const profile = join(home, 'Mousse')
  mkdirSync(profile, { recursive: true })
  return { root, home, env, profile, remove: () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* a server still closing */ } } }
}

/** The OpenCode runtime of one entry on the real executable, with `base` as the environment Mousse runs it in. */
export function opencodeRuntime(binary: string, base: Record<string, string>, profile: string, options: OpencodeDriverOptions = {}, entryEnv?: Record<string, string>): DriverRuntime {
  const env = instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, COMSPEC: process.env.COMSPEC, ...base } })
  const driver = opencodeDriver(options)
  return driver.create({
    instanceId: 'opencode:opencode',
    builtIn: false,
    config: driver.decodeConfig({ binaryPath: binary, ...(entryEnv ? { env: entryEnv } : {}) }),
    env,
    profileHome: profile,
    installationHome: profile,
    stateDir: join(profile, 'state'),
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {},
    signedOut: () => false,
    saveLaunch: async () => {}
  })
}

/** What the runner would see of one request. */
export function recordingEvents() {
  const seen = { activity: 0, text: [] as string[], tools: [] as string[], launched: [] as string[], sent: 0 }
  const events: OneShotEvents = {
    activity: () => { seen.activity += 1 },
    text: (chunk) => { seen.text.push(chunk) },
    tool: (what) => { seen.tools.push(what) },
    launching: (executable) => { seen.launched.push(executable) },
    sending: () => { seen.sent += 1 }
  }
  return { seen, events }
}

export const WIRE: OneShotWireRequest = { model: 'stub/stub-model', system: 'You name chats in a few words.', prompt: 'The login page loops after OAuth.' }

/** One request through the runtime's `opencode:sealed` transport. */
export function sendOnce(runtime: DriverRuntime, model = 'stub/stub-model', signal = AbortSignal.timeout(60_000)) {
  const { seen, events } = recordingEvents()
  const sent = runtime.oneShotTransport!({ model }).send({ ...WIRE, model }, events, signal)
  return { seen, sent }
}

/** The places and ledger records left under a profile. */
export function placesLeft(profile: string): string[] {
  return ['one-shot', 'one-shot-ledger'].flatMap((dir) => (existsSync(join(profile, dir)) ? readdirSync(join(profile, dir)) : []))
}
