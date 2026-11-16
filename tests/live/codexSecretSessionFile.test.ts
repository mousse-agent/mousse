/**
 * Live check (#595): Codex keeps its own commands' output in its session files (`$CODEX_HOME/sessions`), unmasked, so a
 * thread whose turn runs on Codex gets no readable copy of its secrets: the turn starts with them removed
 * (`SecretVault.allowCopies(thread, false)`; tests/secrets/secretRequestNoLeak.test.ts checks that the orchestrator does
 * this as a turn starts) and its agent uses secret_run, whose output Mousse masks. Here the real `codex exec`, in a
 * throwaway CODEX_HOME against a fake Responses endpoint in this process, is made to read the copy's path anyway; its
 * session files and the model's requests must not hold the value. The control, with the copy left in place, shows they
 * would. Needs no sign-in. Runs only with MOUSSE_LIVE_CODEX=1; MOUSSE_CODEX_BINARY may name the executable.
 */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { SecretVault } from '../../src/mms/secrets/SecretVault'

const live = process.env.MOUSSE_LIVE_CODEX === '1'
const binary = process.env.MOUSSE_CODEX_BINARY || 'codex'
const SECRET = 'ghp_CodexLiveSecretValue0123456789ab'

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe.skipIf(!live)("a secret's copy on a thread whose turn runs on Codex", () => {
  let root: string
  let server: Server
  let port = 0
  /** The file the fake model makes Codex read, and every request body it was sent. */
  let target = ''
  const bodies: string[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-codex-secret-'))
    server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return }
        bodies.push(text)
        const body = JSON.parse(text) as { input?: Array<{ type?: string }> }
        const answered = (body.input ?? []).some((item) => item?.type === 'custom_tool_call_output' || item?.type === 'function_call_output')
        // Codex's code mode: one `exec` script that runs a command and returns its output.
        const script = `const r = await tools.exec_command({ cmd: ${JSON.stringify(`cat "${target}"`)} }); text(r)`
        const item = answered
          ? { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }
          : { type: 'custom_tool_call', id: 'c1', call_id: `call_${bodies.length}`, name: 'exec', input: script }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        send('response.output_item.done', { item })
        send('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }, 30_000)

  afterAll(() => {
    server?.close()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  /** One `codex exec` turn that reads `file`; returns its CODEX_HOME and the requests it sent. */
  async function codexReads(label: string, file: string): Promise<{ home: string; sent: string[] }> {
    const home = join(root, label, 'codex-home')
    const work = join(root, label, 'work')
    mkdirSync(home, { recursive: true })
    mkdirSync(work, { recursive: true })
    writeFileSync(join(home, 'config.toml'), ['model = "gpt-6.1-sol"', 'model_provider = "probe"', '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'env_key = "PROBE_KEY"', ''].join('\n'))
    target = file
    const before = bodies.length
    await new Promise<void>((resolve, reject) => {
      const child = execFile(binary, ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'UseTheToken'], { cwd: work, env: { ...process.env, CODEX_HOME: home, PROBE_KEY: 'probe' }, timeout: 120_000, windowsHide: true, shell: process.platform === 'win32' }, (error) => (error ? reject(error) : resolve()))
      child.stdin?.end()
    })
    return { home, sent: bodies.slice(before) }
  }

  /** A profile whose thread was given the secret, with its copies allowed or not, and the copy's path. */
  async function profile(label: string, copies: boolean): Promise<string> {
    const profileRoot = join(root, label, 'profile')
    mkdirSync(profileRoot, { recursive: true })
    const vault = new SecretVault({ profileRoot, threadAlive: () => true })
    const requests = new SecretRequests(vault)
    vault.allowCopies('t1', true)
    const asked = requests.request('t1', { label: 'GitHub token', reason: 'To publish.', name: 'GH_TOKEN' })
    requests.answer('t1', requests.list('t1')[0]!.requestId, SECRET, 'day')
    await asked
    // What a turn on Codex starts with: its thread's copies removed.
    if (!copies) vault.allowCopies('t1', false)
    requests.dispose()
    return join(profileRoot, 'secrets', 'threads', 't1', 'GH_TOKEN')
  }

  it('leaves the value in neither the model requests nor any file of CODEX_HOME, even when Codex is made to read the path', async () => {
    const copy = await profile('codex-turn', false)
    const { home, sent } = await codexReads('codex-turn', copy.replace(/\\/g, '/'))
    expect(sent.length).toBeGreaterThanOrEqual(2)
    for (const body of sent) expect(body).not.toContain(SECRET)
    const sessions = filesUnder(join(home, 'sessions')).filter((path) => path.endsWith('.jsonl'))
    expect(sessions.length).toBeGreaterThan(0)
    for (const path of filesUnder(home)) expect({ path, leaked: readFileSync(path, 'latin1').includes(SECRET) }).toEqual({ path, leaked: false })
  }, 180_000)

  it('control, with the copy left in place: Codex sends the value to the model and keeps it in its session file', async () => {
    const copy = await profile('control', true)
    const { home, sent } = await codexReads('control', copy.replace(/\\/g, '/'))
    expect(sent.some((body) => body.includes(SECRET))).toBe(true)
    const sessions = filesUnder(join(home, 'sessions')).filter((path) => path.endsWith('.jsonl'))
    expect(sessions.some((path) => readFileSync(path, 'utf8').includes(SECRET))).toBe(true)
  }, 180_000)
})
