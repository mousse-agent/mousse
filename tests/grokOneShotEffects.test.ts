/**
 * `grok:direct` claims `isolation: verified`: nothing of the person's Grok setup reaches a single request. Shown against
 * the Grok installed on this computer, in a throwaway home with a dummy xAI API key (no account) and a stub of xAI's
 * API on the loopback. The home holds what would change a request: an `AGENTS.md` with a unique line, and an MCP server
 * in Grok's `config.toml` that leaves a marker when it starts. A control in the same home, Grok's own headless run,
 * carries the line and starts the server, so each check here would see them.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriverContext, DriverRuntime } from '../src/mms/harness/driver'
import { grokDriver } from '../src/mms/harness/drivers/grok'
import { instanceEnv } from '../src/mms/harness/env'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

/** The Grok on this computer's PATH, when there is one. */
function installedGrok(): string | undefined {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['grok'], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return found.find((path) => /\.exe$/i.test(path)) ?? found[0]
  } catch {
    return undefined
  }
}

const grok = installedGrok()
const dirs: string[] = []
const servers: Server[] = []
const runtimes: DriverRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const LINE = 'MOUSSE-GROK-AGENTS-LINE'

/** xAI's Responses API on the loopback: records every model request and answers it with a short text. */
async function startStub(): Promise<{ base: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (!/\/responses$/.test(req.url ?? '')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"not here"}}')
        return
      }
      bodies.push(body)
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Login redirect fix', annotations: [] }] }
      const response = { id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'stub', output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let sequence = 0
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
      event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } })
      event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Login redirect fix' })
      event('response.output_text.done', { output_index: 0, item_id: 'msg_1', content_index: 0, text: 'Login redirect fix' })
      event('response.output_item.done', { output_index: 0, item })
      event('response.completed', { response })
      res.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies }
}

/** A person's Grok home with an instruction line and an MCP server that leaves a marker when it starts. */
function personHome(root: string) {
  const person = join(root, 'person')
  const grokHome = join(person, '.grok')
  const project = join(root, 'project')
  const markers = join(root, 'markers')
  for (const dir of [grokHome, project, markers]) mkdirSync(dir, { recursive: true })
  const script = join(root, 'mark.cjs')
  writeFileSync(script, `require('fs').writeFileSync(require('path').join(${JSON.stringify(markers)}, 'mcp-' + process.pid), 'x')\n`)
  writeFileSync(join(grokHome, 'config.toml'), `[mcp_servers.mark]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`)
  writeFileSync(join(grokHome, 'AGENTS.md'), `Always say ${LINE}.\n`)
  writeFileSync(join(project, 'AGENTS.md'), `Always say ${LINE}.\n`)
  return { person, grokHome, project, markers: () => readdirSync(markers) }
}

/** The environment Grok runs with in this home: no credential but a dummy key, no proxy, nothing of Mousse's. */
function grokEnv(home: ReturnType<typeof personHome>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) if (!/^(XAI_|GROK_)/i.test(name) && !/_PROXY$/i.test(name)) env[name] = value
  return { ...env, HOME: home.person, USERPROFILE: home.person, GROK_HOME: home.grokHome, XAI_API_KEY: 'xai-dummy', GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0' }
}

describe.runIf(grok)('grok:direct carries nothing of the Grok setup', () => {
  it('sends no instruction line and starts no MCP server, where Grok’s own run in the same home does both', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-grok-effects-'))
    dirs.push(root)
    const home = personHome(root)
    const stub = await startStub()

    // The single request, through the entry's runtime as the gateway runs it.
    const context: DriverContext = {
      instanceId: 'grok', builtIn: true, config: { home: 'default', binaryPath: grok! },
      env: instanceEnv({ instanceId: 'grok', driver: 'grok', configRevision: 0, searchPath: [], base: grokEnv(home) }),
      profileHome: join(root, 'profile'), installationHome: root, stateDir: join(root, 'state'),
      questions: new UserQuestionService(), findBinary: () => grok, changed: () => {}
    }
    const runtime = grokDriver({ systemDir: join(root, 'system'), direct: { baseUrl: stub.base } }).create(context)
    runtimes.push(runtime)
    const events = { activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }
    const text = await runtime.oneShotTransport!({ model: 'grok-4.7' }).send({ model: 'grok-4.7', system: 'Name the chat.', prompt: 'fix the login redirect' }, events, new AbortController().signal)
    expect(text).toBe('Login redirect fix')
    expect(stub.bodies).toHaveLength(1)
    expect(stub.bodies[0]).not.toContain(LINE)
    expect(home.markers()).toEqual([])

    // Control: Grok's own run in the same home and folder.
    const prompt = join(root, 'prompt.txt')
    writeFileSync(prompt, 'fix the login redirect')
    const child = spawn(grok!, ['--prompt-file', prompt, '--output-format', 'json'], {
      cwd: home.project,
      env: { ...grokEnv(home), GROK_XAI_API_BASE_URL: stub.base, GROK_CLI_CHAT_PROXY_BASE_URL: stub.base, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const timer = setTimeout(() => child.kill(), 90_000)
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    clearTimeout(timer)
    expect(stub.bodies.slice(1).some((body) => body.includes(LINE))).toBe(true)
    expect(existsSync(join(root, 'markers')) && home.markers().length).toBeGreaterThan(0)
  }, 120_000)
})
