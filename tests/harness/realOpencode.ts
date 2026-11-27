/**
 * The real OpenCode for single-request tests (`opencode:sealed`), with nothing of the person's own: every folder it
 * reads or writes is a throwaway one, its only model is an OpenAI-compatible stub on loopback that keeps every request,
 * and any other address goes to a closed port. No sign-in; dummy keys only.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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
  close(): void
}

/** An OpenAI-compatible chat completions stand-in on loopback. */
export async function modelStub(answer = 'Fix login bug'): Promise<ModelStub> {
  const stub: ModelStub = { url: '', requests: [], statuses: [], answer, close: () => server.close() }
  const server: Server = createServer((request, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { text += chunk })
    request.on('end', () => {
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

/** The stub as an OpenCode provider (`stub` by default) with model `stub-model`: its key comes from `apiKey`, else a sign-in. */
export function stubProviderConfig(stub: ModelStub, apiKey?: string, provider = 'stub', model = 'stub-model'): string {
  return JSON.stringify({ providers: { [provider]: { name: 'Stub', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: stub.url, ...(apiKey ? { apiKey } : {}) }, models: { [model]: { name: 'Stub model' } } } } })
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
