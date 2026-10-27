/**
 * PR 6 §3 evidence, real CLI (items 1–5 and 7 as far as this platform's pinned binary runs them): a
 * bot turn on a locked Claude Code entry, through Mousse's own service, against a localhost
 * Messages API mock with a fake key and a temporary home. Nothing signs in and nothing leaves the
 * machine. Shell items (8–12, 16, 17) need Claude Code's sandbox and run only where it is available;
 * no record is written from here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'

const BINARY = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const hasBinary = process.platform === 'win32' && existsSync(BINARY)

type Json = Record<string, unknown>

/** The Messages API, scripted by turn: a Read outside the roots, a Read inside, then "done". */
async function anthropicMock(steps: Json[]) {
  const sockets = new Set<Socket>()
  const requests: Array<{ tools: string[]; results: string[] }> = []
  let ids = 0
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const path = (req.url ?? '').split('?')[0]
      if (path.endsWith('/count_tokens')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
      if (req.method !== 'POST' || path !== '/v1/messages') return void res.writeHead(404).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> }
      const results: string[] = []
      let calls = 0
      for (const message of body.messages)
        if (Array.isArray(message.content))
          for (const block of message.content as Json[]) {
            if (block.type === 'tool_use') calls += 1
            if (block.type === 'tool_result') results.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
          }
      requests.push({ tools: (body.tools ?? []).map((tool) => tool.name), results })
      // Side requests (titles, summaries) carry no tools: they get plain text.
      const block: Json = body.tools?.length && calls < steps.length ? { type: 'tool_use', id: `toolu_${++ids}`, ...steps[calls] } : { type: 'text', text: 'done' }
      const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
      const message = { id: `msg_${++ids}`, type: 'message', role: 'assistant', model: body.model, content: [] as Json[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
      if (!body.stream) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event: string, data: Json) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      send('message_start', { message })
      if (block.type === 'tool_use') {
        send('content_block_start', { index: 0, content_block: { ...block, input: {} } })
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } })
      }
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
      send('message_stop', {})
      res.end()
    })().catch((error) => res.writeHead(500).end(String(error)))
  })
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}

interface LockedRun {
  base: string
  root: string
  scratch: string
  outside: string
  userHome: string
  results: string
  toolRequests: Array<{ tools: string[] }>
  rows: Array<{ name: string; status: string; idempotent?: boolean }>
  charge: ReturnType<typeof vi.fn>
  pids: number[]
  text: string
}

describe('locked Claude Code against the real pinned CLI', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  })

  /**
   * One locked bot turn through Mousse's service: a bot granted `read` and `search` on one read-only
   * root, its scratch folder as the working folder, and the scripted tool calls `steps(paths)`.
   */
  async function lockedRun(steps: (paths: { root: string; scratch: string; outside: string; userHome: string }) => Json[], options: { charge?: () => unknown } = {}): Promise<LockedRun & { marker: (name: string) => string }> {
    const base = mkdtempSync(join(tmpdir(), 'mousse-claude-locked-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const root = join(base, 'root')
    const scratch = join(base, 'scratch')
    const outside = join(base, 'outside')
    const instanceHome = join(base, 'instance-home')
    const userHome = join(base, 'user-home')
    for (const dir of [root, scratch, join(scratch, 'tmp'), outside, instanceHome, userHome, join(scratch, '.claude')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'inside text')
    writeFileSync(join(scratch, 'scratch-note.txt'), 'SCRATCH-NOTE-VALUE')
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-VALUE')
    // Claude Code expands `~` to the home folder itself (review M1): a search there must stay walled.
    writeFileSync(join(userHome, 'home-secret.txt'), 'HOME-SECRET-VALUE')
    // A hook, an MCP server and allow rules in the entry's home and in the working folder: none may apply (items 2 and 3).
    const marker = (name: string) => join(base, `${name}.marker`)
    const hook = (name: string) => ({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync(process.argv[1], 'x')" "${marker(name).replace(/\\/g, '/')}"` }] }] } })
    const settings = (name: string) => JSON.stringify({ ...hook(name), permissions: { allow: ['Read', 'Bash', `Edit(${outside.replace(/\\/g, '/')}/**)`] }, mcpServers: { planted: { command: 'node', args: ['-e', ''] } } })
    writeFileSync(join(instanceHome, 'settings.json'), settings('user'))
    writeFileSync(join(scratch, '.claude', 'settings.json'), settings('project'))
    writeFileSync(join(scratch, '.mcp.json'), JSON.stringify({ mcpServers: { planted_project: { command: 'node', args: ['-e', ''] } } }))

    const anthropic = await anthropicMock(steps({ root, scratch, outside, userHome }))
    cleanups.push(() => anthropic.close())

    const state = mkdtempSync(join(base, 'state-'))
    mkdirSync(join(state, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(state, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const service = new ClaudeSubscriptionProviderService(state, new UserQuestionService(), {
      live: false,
      // No `claude auth status`: the entry runs on a fake key that only the local mock sees.
      probe: () => ({ kind: 'signed_in', account: { label: 'API key', credential: 'api_key' } }),
      launchConfig: () => ({ binaryPath: BINARY, args: ['--dangerously-skip-permissions'], env: { USER_VARIABLE: 'x' } }),
      lockedEnv: (cwd) => lockedEnv({
        platform: process.platform,
        base: { ...process.env, USERPROFILE: userHome, HOME: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local') },
        driver: 'claude', credential: 'api_key', home: instanceHome, scratch: cwd
      }),
      finalEnv: (env) => ({
        ...env,
        ANTHROPIC_BASE_URL: anthropic.url,
        ANTHROPIC_API_KEY: 'sk-ant-api03-fake-local',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_MAX_RETRIES: '0'
      })
    })
    cleanups.push(() => service.stop())

    const rows: LockedRun['rows'] = []
    const ledger: ToolLedger = {
      start: (call, opts) => {
        rows.push({ name: call.name, status: 'started', ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}) })
        return String(rows.length - 1)
      },
      commit: (id) => { rows[Number(id)].status = 'committed' },
      failed: (id) => { rows[Number(id)].status = 'failed' }
    }
    const charge = vi.fn(options.charge ?? (() => ({ ok: true as const, count: 1 })))
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read', 'search'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'read', scratch } },
      waiting: () => false, counters: { charge: charge as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const pids: number[] = []
    const locked: ClaudeLockedTurn = { authority, ledger, cwd: scratch, shellContained: false, temps: [], systemPrompt: 'You are a test bot.', onProcess: (pid) => pids.push(pid) }
    const text = await service.chat({ threadId: 'bot-thread', cwd: scratch, model: 'claude-sonnet-4-5', prompt: 'Read the files.', permissionMode: 'full', locked, onText: () => undefined })
    return {
      base, root, scratch, outside, userHome, rows, charge, pids, text, marker,
      results: anthropic.requests.at(-1)!.results.join('\n'),
      toolRequests: anthropic.requests.filter((request) => request.tools.length)
    }
  }

  it.skipIf(!hasBinary)('ignores user and project settings, offers only the granted tools, and the gate keeps every path inside the roots', async () => {
    const run = await lockedRun(({ root, outside }) => [
      { name: 'Read', input: { file_path: join(outside, 'secret.txt') } },
      { name: 'Grep', input: { pattern: 'HOME-SECRET', path: '~', output_mode: 'content' } },
      { name: 'Glob', input: { pattern: '*', path: '~' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: outside, output_mode: 'content' } },
      { name: 'Read', input: { file_path: join(root, 'a.txt') } }
    ])
    expect(run.text).toContain('done')
    // Our own spawn ran the CLI (item 1).
    expect(run.pids.length).toBe(1)
    // Item 4: the request offers exactly the granted built-ins; nothing planted adds a tool.
    expect(run.toolRequests.length).toBeGreaterThan(0)
    for (const request of run.toolRequests) expect(request.tools.sort()).toEqual(['Glob', 'Grep', 'Read'])
    // Item 5: the outside Read, the `~` searches and the outside Grep were denied by the gate and
    // nothing outside was read; the inside Read ran.
    expect(run.results).not.toContain('TOP-SECRET-VALUE')
    expect(run.results).not.toContain('HOME-SECRET-VALUE')
    expect(run.results).not.toContain('home-secret.txt')
    expect(run.results).toContain('inside text')
    expect(run.rows).toEqual([{ name: 'Read', status: 'committed', idempotent: true }])
    expect(run.charge).toHaveBeenCalledTimes(1)
    // Items 2 and 3: no settings hook ran.
    expect(existsSync(run.marker('user'))).toBe(false)
    expect(existsSync(run.marker('project'))).toBe(false)
    expect(readFileSync(join(run.outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET-VALUE')
  }, 120_000)

  it.skipIf(!hasBinary)('a path padded with whitespace or ending in a space or dot never leaves the folders (review r2: Claude Code trims paths)', async () => {
    const run = await lockedRun(({ root, outside, userHome }) => [
      { name: 'Grep', input: { pattern: 'SECRET', path: ` ${outside}`, output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: join(root, '.. '), output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: '.. ', output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: '..\n', output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: `\n${outside}\n`, output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: ' ../outside', output_mode: 'content' } },
      { name: 'Grep', input: { pattern: 'SECRET', path: '\t../outside', output_mode: 'content' } },
      { name: 'Glob', input: { pattern: '*', path: ` ${userHome}` } },
      { name: 'Glob', input: { pattern: '*.txt', path: ' ../outside' } },
      { name: 'Glob', input: { pattern: '*.txt', path: '\t../outside' } },
      { name: 'Glob', input: { pattern: '*', path: join(root, '.. ') } },
      { name: 'Read', input: { file_path: join(root, 'a.txt') } }
    ])
    expect(run.text).toContain('done')
    expect(run.results).not.toContain('TOP-SECRET-VALUE')
    expect(run.results).not.toContain('HOME-SECRET-VALUE')
    expect(run.results).not.toContain('secret.txt')
    expect(run.results).toContain('inside text')
    // Only the inside Read ran.
    expect(run.rows).toEqual([{ name: 'Read', status: 'committed', idempotent: true }])
  }, 120_000)

  it.skipIf(!hasBinary)('a gate that throws denies the call: nothing runs, even a read Claude Code would allow in its working folder', async () => {
    const run = await lockedRun(({ scratch }) => [
      { name: 'Read', input: { file_path: join(scratch, 'scratch-note.txt') } },
      { name: 'Glob', input: { pattern: '*.txt', path: scratch } }
    ], { charge: () => { throw new Error('database is locked') } })
    expect(run.text).toContain('done')
    expect(run.results).not.toContain('SCRATCH-NOTE-VALUE')
    expect(run.results).not.toContain('scratch-note.txt')
    expect(run.results).toContain('could not be checked')
    expect(run.rows).toEqual([])
  }, 120_000)
})
