/**
 * The real `@cursor/sdk` for single-request tests, never Cursor itself: the bundled host entry run by the real driver,
 * the SDK pointed at a loopback stub (`CURSOR_BACKEND_URL`), a made-up key, and a throwaway person whose home holds
 * the config a request must not load.
 */
import { createRequire } from 'node:module'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import { InstanceVault } from '../../src/mms/harness/vault'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { crashChild } from '../support/build'
import { recordingEvents, throwawayUser } from './realOpencode'

/** The SDK's CommonJS entry, which the host loads by path (`MOUSSE_CURSOR_SDK_MODULE`). */
export function cursorSdkEntry(): string {
  return createRequire(__filename).resolve('@cursor/sdk')
}

/** The host entry, bundled as the app bundles it (`out/main/cursorHost.js`). */
export function cursorHostScript(): Promise<string> {
  return crashChild('src/mms/harness/hosts/cursorHost.ts', { format: 'esm', external: ['@cursor/sdk'], name: 'cursor-host' })
}

export const DUMMY_KEY = 'key_dummy0000000000000000'

export interface StubRequest {
  url: string
  headers: IncomingHttpHeaders
  /** The body as text, with any hex-encoded message decoded after it. */
  text: string
}

/** How the stub fails a run. */
export type RunFailure = 'http503' | 'http429' | 'stream_unavailable' | 'stream_resource_exhausted'

export interface CursorStub {
  url: string
  requests: StubRequest[]
  count(path: string): number
  close(): Promise<void>
}

/** A Connect end-of-stream frame carrying an error. */
function endStream(code: string): Buffer {
  const json = Buffer.from(JSON.stringify({ error: { code, message: `stub ${code}` } }))
  const head = Buffer.alloc(5)
  head[0] = 2
  head.writeUInt32BE(json.length, 1)
  return Buffer.concat([head, json])
}

function bodyText(raw: Buffer): string {
  let body = raw
  try {
    body = gunzipSync(raw)
  } catch {
    // Not compressed.
  }
  let text = body.toString('latin1')
  for (const hex of text.match(/[0-9a-f]{40,}/g) ?? []) text += `\n${Buffer.from(hex, 'hex').toString('latin1')}`
  return text
}

/** The Cursor backend as far as the SDK reaches before a run: sign-in exchange, models, settings, then `failure`. */
export function cursorStub(failure: RunFailure): Promise<CursorStub> {
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      requests.push({ url, headers: req.headers, text: bodyText(Buffer.concat(chunks)) })
      if (url.startsWith('/auth/exchange_user_api_key')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ accessToken: 'tok_dummy' }))
      }
      if (url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ items: [{ id: 'default' }] }))
      }
      if (url.endsWith('/RunSSE')) {
        if (failure === 'http503' || failure === 'http429') {
          res.writeHead(failure === 'http503' ? 503 : 429, { 'content-type': 'application/json', 'retry-after': '0' })
          return res.end('{}')
        }
        res.writeHead(200, { 'content-type': 'application/connect+proto' })
        return res.end(endStream(failure === 'stream_unavailable' ? 'unavailable' : 'resource_exhausted'))
      }
      res.writeHead(200, { 'content-type': 'application/proto' })
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    count: (path) => requests.filter((request) => request.url.endsWith(path)).length,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  })))
}

/**
 * Cursor's config in `dir`, tagged `tag`: an always-applied rule, `AGENTS.md`, `CLAUDE.md` and `.cursorrules` lines, a
 * skill, an MCP server and hooks for every phase of a run, each hook and server writing `markers/<kind>-<tag>`.
 */
export function cursorConfig(dir: string, markers: string, tag: string): string[] {
  const cursor = join(dir, '.cursor')
  mkdirSync(join(cursor, 'rules'), { recursive: true })
  mkdirSync(join(cursor, 'skills', `skill-${tag}`), { recursive: true })
  const strings = [`RULE_${tag}_LINE`, `AGENTSMD_${tag}_LINE`, `CLAUDEMD_${tag}_LINE`, `CURSORRULES_${tag}_LINE`, `SKILL_${tag}_LINE`]
  writeFileSync(join(cursor, 'rules', 'always.mdc'), `---\nalwaysApply: true\n---\n${strings[0]}\n`)
  writeFileSync(join(dir, 'AGENTS.md'), `${strings[1]}\n`)
  writeFileSync(join(dir, 'CLAUDE.md'), `${strings[2]}\n`)
  writeFileSync(join(dir, '.cursorrules'), `${strings[3]}\n`)
  writeFileSync(join(cursor, 'skills', `skill-${tag}`, 'SKILL.md'), `---\nname: skill-${tag}\ndescription: ${strings[4]}\n---\nBody.\n`)
  const writer = (name: string) => {
    const script = join(dir, `${name}.cjs`)
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(join(markers, name))}, 'x'); process.stdout.write('{}'); setTimeout(() => {}, 3000)\n`)
    return script
  }
  const hooks: Record<string, Array<{ command: string }>> = {}
  for (const phase of ['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop']) hooks[phase] = [{ command: `"${process.execPath}" "${writer(`hook-${phase}-${tag}`)}"` }]
  writeFileSync(join(cursor, 'hooks.json'), JSON.stringify({ version: 1, hooks }))
  writeFileSync(join(cursor, 'mcp.json'), JSON.stringify({ mcpServers: { [`mcp-${tag}`]: { command: process.execPath, args: [writer(`mcp-${tag}`)] } } }))
  return strings
}

/** A throwaway person with Mousse's profile in their home, as on a real computer. */
export function cursorPerson() {
  return throwawayUser('mousse-cursor-one-shot-')
}

/** The real Cursor driver's runtime for that person, its key saved, its host pointed at the stub. */
export function cursorRuntime(input: { person: ReturnType<typeof cursorPerson>; hostScript: string; stub: CursorStub; entryEnv?: Record<string, string> }): DriverRuntime {
  const { person } = input
  const stateDir = join(person.profile, 'harness', 'cursor-work')
  mkdirSync(stateDir, { recursive: true })
  new InstanceVault(join(stateDir, 'secrets.json')).set('apiKey', DUMMY_KEY)
  const context: DriverContext = {
    instanceId: 'cursor:work',
    builtIn: false,
    config: { home: 'default', displayName: 'Cursor', ...(input.entryEnv ? { env: input.entryEnv } : {}) },
    env: instanceEnv({ instanceId: 'cursor:work', driver: 'cursor', configRevision: 0, searchPath: [], base: { ...process.env, ...person.env, CURSOR_API_KEY: 'ambient-key' } }),
    profileHome: person.profile,
    installationHome: person.profile,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  return cursorDriver({ hostScript: input.hostScript, hostEnv: { MOUSSE_CURSOR_SDK_MODULE: cursorSdkEntry(), CURSOR_BACKEND_URL: input.stub.url } }).create(context)
}

/** One title request through the runtime's `cursor:sdk` transport. */
export function sendCursorOnce(runtime: DriverRuntime, signal = AbortSignal.timeout(60_000)) {
  const { seen, events } = recordingEvents()
  const sent = runtime.oneShotTransport!({ model: 'default' }).send({ model: 'default', system: 'You name chats in a few words.', prompt: 'PROMPT_LINE_7f3a: the login page loops after OAuth.' }, events, signal)
  return { seen, sent }
}
