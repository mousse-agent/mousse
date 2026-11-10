/**
 * Live check: Stop kills a Claude Code process that has not exited 1 s after it was closed, which can cut the record it
 * was writing to its session transcript. The real `claude` resumes such a session: the half-written record is skipped
 * and the conversation goes on. It needs no sign-in: Claude Code runs in a throwaway `CLAUDE_CONFIG_DIR` against a fake
 * Messages endpoint in this process, which records the history each request carries. Runs only with
 * MOUSSE_LIVE_CLAUDE=1; MOUSSE_CLAUDE_BINARY may name the executable.
 */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const live = process.env.MOUSSE_LIVE_CLAUDE === '1'
const binary = process.env.MOUSSE_CLAUDE_BINARY || join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')

type Message = { role: string; content: unknown }
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part?.text ?? '').join(' ') : ''

describe.skipIf(!live)('a Claude Code session whose transcript was cut mid-record by a kill', () => {
  let root: string
  let server: Server
  let port = 0
  /** The person's and the assistant's messages each request carried, system reminders left out. */
  const histories: string[][] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-claude-cut-'))
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return }
        const body = JSON.parse(raw) as { model: string; messages: Message[]; tools?: unknown[] }
        if (body.tools?.length) histories.push(body.messages.map((m) => `${m.role}:${textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()}`).filter((line) => !/^user:$/.test(line)))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `reply ${histories.length}` } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        send('message_stop', {})
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }, 30_000)

  afterAll(() => {
    server?.close()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const claude = (home: string, work: string, args: string[]): Promise<{ session_id: string; is_error: boolean; result: string }> => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-live-check', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    return new Promise((resolve, reject) => {
      execFile(binary, ['-p', ...args, '--model', 'claude-sonnet-5-5', '--output-format', 'json'], { cwd: work, env, timeout: 90_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error)
        else resolve(JSON.parse(stdout))
      })
    })
  }

  it.each(['the last record', 'the last reply, with what followed it'])('resumes after a kill cut %s in half', async (cut) => {
    const home = join(root, cut.length.toString(), 'home')
    const work = join(root, cut.length.toString(), 'work')
    mkdirSync(home, { recursive: true })
    mkdirSync(work, { recursive: true })
    const first = await claude(home, work, ['first message'])
    await claude(home, work, ['second message', '--resume', first.session_id])
    const projects = join(home, 'projects')
    const file = join(projects, readdirSync(projects)[0]!, `${first.session_id}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const at = cut === 'the last record' ? lines.length - 1 : lines.map((line) => JSON.parse(line) as { type?: string }).findLastIndex((entry) => entry.type === 'assistant')
    // What a kill during the write leaves: the record cut in the middle, nothing after it, no newline.
    writeFileSync(file, [...lines.slice(0, at), lines[at]!.slice(0, Math.floor(lines[at]!.length / 2))].join('\n'))

    const third = await claude(home, work, ['third message', '--resume', first.session_id])
    expect(third.is_error).toBe(false)
    expect(third.session_id).toBe(first.session_id)
    const sent = histories.at(-1)!
    expect(sent.filter((line) => line.startsWith('user:'))).toEqual(['user:first message', 'user:second message', 'user:third message'])
    // A later turn still sees the turn after the cut: Claude Code wrote it after the cut line.
    await claude(home, work, ['fourth message', '--resume', first.session_id])
    expect(histories.at(-1)!.filter((line) => line.startsWith('user:'))).toEqual(['user:first message', 'user:second message', 'user:third message', 'user:fourth message'])
  }, 300_000)
})
