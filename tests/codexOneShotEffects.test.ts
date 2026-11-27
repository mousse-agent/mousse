/**
 * `codex:direct` claims `isolation: verified`: nothing of the user's Codex setup reaches a single request. Shown on the
 * Codex installed on this computer, run by the service as it runs it, in a throwaway home: a made-up ChatGPT sign-in
 * (no real one) and every URL Codex knows pointed at a loopback stub. The home holds what would change a request:
 * `AGENTS.md` and developer instructions with unique lines, and an MCP server that leaves a marker when it starts.
 * A control in the same home, Codex's own turn (`codex exec`), carries both lines and starts the server, so each
 * check here would see them.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexProviderService } from '../src/mms/harness/vendors/codex/CodexProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

/** The Codex on this computer's PATH, when there is one. */
function installedCodex(): string | undefined {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return found.find((path) => /\.exe$/i.test(path)) ?? found[0]
  } catch {
    return undefined
  }
}

const codex = installedCodex()
const homes: string[] = []
const servers: Server[] = []
const services: CodexProviderService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const server of servers.splice(0)) server.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.unstubAllEnvs()
})

describe.runIf(codex)('codex:direct carries nothing of the Codex setup', () => {
  it('sends no AGENTS.md, developer instructions or tool, and starts no MCP server for the request', async () => {
    const direct: string[] = []
    /** The bodies of Codex's own model requests (the control below). */
    const turns: string[] = []
    const stub = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        // pi-ai compresses the request (zstd): read as the backend reads it, so a line in it is found.
        const raw = Buffer.concat(chunks)
        const body = (request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(raw) : raw).toString('utf8')
        if (request.url === '/codex/responses') {
          direct.push(body)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Login redirect fix', annotations: [] }] }
          const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
          send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } })
          send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
          send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'Login redirect fix' })
          send({ type: 'response.output_item.done', output_index: 0, item })
          send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 } } })
          response.end()
          return
        }
        if ((request.url ?? '').endsWith('/responses')) turns.push(body)
        // Whatever else Codex asks for (its account, models, plugins) gets nothing.
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    servers.push(stub)
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`

    const home = mkdtempSync(join(tmpdir(), 'codex-one-shot-effects-'))
    homes.push(home)
    const codexHome = join(home, 'codex-home')
    mkdirSync(codexHome)
    // A made-up ChatGPT sign-in: a token that only the stub ever sees.
    const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
    const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-1' }, email: 'stub@example.com', exp: 4102444800 }
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwt(claims), access_token: jwt(claims), refresh_token: 'stub-refresh', account_id: 'acct-1' }, last_refresh: new Date().toISOString() }))
    const markers = join(home, 'markers')
    mkdirSync(markers)
    writeFileSync(join(home, 'mcp.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(markers, 'mcp'))}, 'ran'); setInterval(() => {}, 1000)\n`)
    writeFileSync(join(codexHome, 'config.toml'), [
      `chatgpt_base_url = "${base}/backend-api/"`,
      `openai_base_url = "${base}/v1"`,
      'developer_instructions = "Always mention DEV-INSTRUCTIONS-55aa."',
      '[mcp_servers.marker]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(join(home, 'mcp.js'))}]`
    ].join('\n'))
    writeFileSync(join(codexHome, 'AGENTS.md'), 'Always mention USER-AGENTS-9c1d.\n')
    vi.stubEnv('CODEX_HOME', codexHome)

    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: codex }))
    const service = new CodexProviderService(home, new UserQuestionService(), { directBaseUrl: base }, {
      launch: () => ({ binaryPath: codex! }),
      signedOut: () => false,
      // Codex's own account check asks a ChatGPT endpoint the stub can't answer: the sign-in is read as checked.
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, subject: 'chatgpt:stub' }) }
    })
    services.push(service)
    await service.status()
    expect(service.configured()).toBe(true)
    const markersBefore = readdirSync(markers)
    const text = await service.oneShotTransport({ model: 'default', task: 'pull_request' })
      .send({ model: 'default', system: 'You write pull request drafts.', prompt: 'Draft it.' }, { activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }, AbortSignal.timeout(60_000))
    expect(text).toBe('Login redirect fix')

    expect(direct).toHaveLength(1)
    const body = direct[0]!
    // The request as sent: the system text and the prompt are in it, as a check that it was read.
    expect(body).toContain('You write pull request drafts.')
    for (const line of ['USER-AGENTS-9c1d', 'DEV-INSTRUCTIONS-55aa']) expect(body).not.toContain(line)
    expect((JSON.parse(body) as { tools?: unknown[] }).tools ?? []).toEqual([])
    // The request started nothing of the home's (its check, before it, had started the entry's Codex).
    expect(readdirSync(markers)).toEqual(markersBefore)
    expect(existsSync(join(markers, 'mcp'))).toBe(false)

    // The control: Codex's own turn in the same home carries both lines and starts the MCP server, so the checks
    // above would have seen them.
    const control = spawn(codex!, ['exec', '--skip-git-repo-check', 'hello'], { cwd: home, env: { ...process.env, CODEX_HOME: codexHome }, stdio: 'ignore', windowsHide: true })
    try {
      await vi.waitFor(() => {
        expect(turns.some((turn) => turn.includes('USER-AGENTS-9c1d') && turn.includes('DEV-INSTRUCTIONS-55aa'))).toBe(true)
        expect(existsSync(join(markers, 'mcp'))).toBe(true)
      }, { timeout: 45_000, interval: 200 })
    } finally {
      control.kill()
    }
  }, 120_000)
})
