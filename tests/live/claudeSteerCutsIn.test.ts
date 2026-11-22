/**
 * Live check: a person's steer on the real Claude Code cuts into what the turn is doing (a long command, a long
 * reply), reaches the model promptly, shows once, and the turn goes on with it to an answer. The real `claude` runs
 * through the Agent SDK under a real orchestrator, run engine and Claude adapter, with a throwaway `CLAUDE_CONFIG_DIR`,
 * against a fake Messages endpoint in this process (fake key, no sign-in). Runs only with MOUSSE_LIVE_CLAUDE=1;
 * MOUSSE_CLAUDE_BINARY may name the executable (default: the Agent SDK's own).
 *
 * Inputs: the steer's entry (the composer's Steer, a queued message's Send now) x what the turn does when it lands
 * (a foreground Bash that sleeps, a reply that streams for a long time).
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { CLAUDE, phase6Daemon, waitFor } from '../run/phase6Fixture'

const live = process.env.MOUSSE_LIVE_CLAUDE === '1'
const binary = process.env.MOUSSE_CLAUDE_BINARY ||
  join(process.cwd(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude')

type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string; is_error?: boolean }
type Message = { role: string; content: string | Block[] }

const STEER = 'STEER-use-pnpm'
const textOf = (message: Message): string => (typeof message.content === 'string' ? message.content : message.content.map((block) => block.text ?? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''))).join('\n'))

describe.skipIf(!live || !existsSync(binary))("a person's steer on the real Claude Code", () => {
  let root: string
  let server: Server
  let port = 0
  /** What the first request of the turn does: run a long command, or write a long reply. */
  let scenario: 'tool' | 'reply' = 'tool'
  /** The case running now: a request from an earlier case's process (a command that ended late) is answered and ignored. */
  let label = ''
  /** Main-loop requests, when they arrived, and whether they carried the steer. */
  const requests: Array<{ at: number; steer: boolean; interruptedTool: boolean }> = []
  const open = new Set<ServerResponse>()

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-claude-steer-'))
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return }
        const body = JSON.parse(raw) as { model: string; messages: Message[]; tools?: unknown[]; stream?: boolean }
        const all = body.messages.filter((message) => message.role === 'user').map(textOf).join('\n')
        const steer = all.includes(STEER)
        const last = body.messages.at(-1)
        const toolResult = Array.isArray(last?.content) ? last.content.find((block) => block.type === 'tool_result') : undefined
        const main = Boolean(body.tools?.length) && all.includes(`start ${label}`)
        if (main) requests.push({ at: Date.now(), steer, interruptedTool: Boolean(toolResult?.is_error) })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        open.add(res)
        res.on('close', () => open.delete(res))
        const send = (type: string, data: object) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`) }
        const end = (stop: string) => {
          send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
          send('message_stop', {})
          res.end()
        }
        send('message_start', { message: { id: `m${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        const text = (words: string) => {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: words } })
          send('content_block_stop', { index: 0 })
          end('end_turn')
        }
        if (!main) return text('ok')
        if (steer) return text(`ACK ${STEER}`)
        if (toolResult) return text('The command finished.')
        if (scenario === 'tool') {
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: 'Bash', input: {} } })
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 40 && echo slept', description: 'Wait' }) } })
          send('content_block_stop', { index: 0 })
          return end('tool_use')
        }
        // A long reply: a word every 100 ms for 40 s.
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        let n = 0
        const timer = setInterval(() => {
          if (res.destroyed || ++n > 400) {
            clearInterval(timer)
            if (!res.destroyed) { send('content_block_stop', { index: 0 }); end('end_turn') }
            return
          }
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `word${n} ` } })
        }, 100)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }, 30_000)

  afterAll(() => {
    for (const res of open) res.destroy()
    server?.close()
    // A command a steer stopped may still hold its folder for a moment on Windows.
    try { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* left in the temporary folder */ }
  })

  const stops: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    vi.unstubAllEnvs()
  })

  async function running(label: string) {
    const home = join(root, label)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    const work = join(home, 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    vi.stubEnv('MOUSSE_HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude-config'))
    let service!: ClaudeSubscriptionProviderService
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude-config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-live-steer', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    service = new ClaudeSubscriptionProviderService(home, d.questions, {
      launchConfig: () => ({ binaryPath: binary }),
      baseEnv: () => env,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    stops.push(d.stop)
    const thread = d.store.createThread(label)
    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    d.orch.setThreadPermissionMode(thread.id, 'full')
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    return { d, thread, send }
  }

  // [entry, what the turn does when the steer lands, how long after it began]. A command younger than about 3 s has no
  // task Claude Code named yet, so it is stopped with an interrupt; an older one by its task.
  const CASES: Array<['composer' | 'send-now', 'tool' | 'reply', number]> = [
    ['composer', 'tool', 1_000],
    ['composer', 'tool', 5_000],
    ['send-now', 'tool', 1_000],
    ['send-now', 'tool', 5_000],
    ['composer', 'reply', 3_000],
    ['send-now', 'reply', 3_000]
  ]

  it.each(CASES)('steered from the %s during a long %s, %i ms in: read at once, shown once, and the turn answers it', async (entry, what, after) => {
    scenario = what
    requests.length = 0
    label = `${entry}-${what}-${after}`
    const w = await running(label)
    const first = w.send(`start ${label}`)
    first.catch(() => undefined)
    // The command runs (Claude Code reports it), or the reply is streaming.
    await waitFor(() => requests.length === 1, 'the first request', 60_000)
    await new Promise((resolve) => setTimeout(resolve, after))
    const queueSeen: string[] = []
    const watch = setInterval(() => { for (const item of w.d.orch.listQueue(w.thread.id)) queueSeen.push(`${item.state}`) }, 50)
    const steeredAt = Date.now()
    if (entry === 'composer') expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, STEER)).toMatchObject({ steered: true })
    else {
      const queued = await w.send(STEER)
      expect(w.d.orch.promoteQueueItem(w.thread.id, queued.queueItem!.id)).toMatchObject({ ok: true })
    }
    await waitFor(() => requests.some((request) => request.steer), 'the model to get the steer', 60_000)
    const latency = requests.find((request) => request.steer)!.at - steeredAt
    await waitFor(() => !w.d.engine.getActiveRun(w.thread.id), 'the turn to end', 60_000)
    clearInterval(watch)
    const messages = w.d.orch.getMessages(w.thread.id)
    const visible = messages.filter((message: { hidden?: boolean }) => !message.hidden)
    const steerRows = visible.filter((message: { role: string; content: string }) => message.role === 'user' && message.content.includes(STEER))
    const answer = visible.filter((message: { role: string; content: string }) => message.role === 'assistant' && message.content.includes(`ACK ${STEER}`))
    const runs = w.d.engine.store.listRuns(w.thread.id)
    appendFileSync(join(tmpdir(), 'mousse-live-claude-steer.log'), `${new Date().toISOString()} ${entry}/${what}/${after}ms latency=${latency}ms runs=${JSON.stringify(runs.map((run: { status: string; source?: string }) => `${run.source}:${run.status}`))} requests=${JSON.stringify(requests.map((r) => ({ dt: r.at - steeredAt, steer: r.steer, interruptedTool: r.interruptedTool })))} queueStates=${[...new Set(queueSeen)].join(',')} steerRows=${steerRows.length} answers=${answer.length}
`)
    expect(queueSeen.filter((state) => state === 'pending')).toEqual([])
    expect(steerRows).toHaveLength(1)
    expect(answer).toHaveLength(1)
    expect(latency).toBeLessThan(5_000)
  }, 180_000)
})
