/**
 * Live check (#595): an agent that opens a secret's private file with Claude Code's own tools must not leave the value
 * in Claude Code's session file, nor send it to the model. The real `claude` runs through the Agent SDK with Mousse's
 * `PostToolUse` masking (`claudeMaskedToolOutput`), in a throwaway `CLAUDE_CONFIG_DIR` against a fake Messages endpoint
 * in this process: it asks for one tool call that reads the file, then records what the tool result sent to the model
 * held. Needs no sign-in. Runs only with MOUSSE_LIVE_CLAUDE=1; MOUSSE_CLAUDE_BINARY may name the executable.
 *
 * Inputs: the Read tool and the Bash tool (`cat`) on the file; with Mousse's masking, and without it as the control
 * that shows the session file would keep the value.
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeMaskedToolOutput } from '../../src/mms/harness/vendors/claude/secretOutput'
import { secretMasker } from '../../src/mms/secrets/secretMasking'

const live = process.env.MOUSSE_LIVE_CLAUDE === '1'
const binary = process.env.MOUSSE_CLAUDE_BINARY || join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
const SECRET = 'ghp_LiveCheckSecretValue0123456789abcd'

type Block = { type: string; content?: unknown; text?: string }
type Message = { role: string; content: string | Block[] }

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe.skipIf(!live)("a secret's file read by Claude Code's own tools", () => {
  let root: string
  let server: Server
  let port = 0
  /** The tool call the fake model asks for next, and what each tool result it was sent held. */
  let nextCall: { name: string; input: Record<string, unknown> } = { name: 'Read', input: {} }
  const toolResults: string[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-claude-secret-'))
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return }
        const body = JSON.parse(raw) as { model: string; messages: Message[]; tools?: unknown[] }
        const last = body.messages.at(-1)
        const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === 'tool_result') : undefined
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        if (body.tools?.length && !result) {
          // The agent opens the file.
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: nextCall.name, input: {} } })
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(nextCall.input) } })
          send('content_block_stop', { index: 0 })
          send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
        } else {
          if (result) toolResults.push(JSON.stringify(result.content))
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } })
          send('content_block_stop', { index: 0 })
          send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        }
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

  /** One turn of the real Claude Code that makes `call`; returns its config folder (where its session file is). */
  async function turn(label: string, call: (file: string) => { name: string; input: Record<string, unknown> }, masked: boolean): Promise<string> {
    const home = join(root, label, 'home')
    const work = join(root, label, 'work')
    mkdirSync(home, { recursive: true })
    mkdirSync(work, { recursive: true })
    const file = join(work, 'GH_TOKEN')
    writeFileSync(file, `${SECRET}\n`)
    nextCall = call(file)
    const mask = secretMasker([{ name: 'GH_TOKEN', value: SECRET }])
    // Mousse's hook, as the Claude service runs it: the result replaced before the model sees it and before it is saved.
    const hook: HookCallback = async (event) => {
      if (event.hook_event_name !== 'PostToolUse') return {}
      const out = claudeMaskedToolOutput(event.tool_response, mask)
      return out === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out } }
    }
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-live-check', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    const run = query({
      prompt: 'Use the token in GH_TOKEN.',
      options: {
        cwd: work,
        env,
        model: 'claude-sonnet-5-5',
        pathToClaudeCodeExecutable: binary,
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(masked ? { hooks: { PostToolUse: [{ hooks: [hook] }] } } : {})
      }
    })
    for await (const message of run) if (message.type === 'result') break
    return home
  }

  // [the tool, the call it makes on the file]
  const TOOLS: Array<[string, (file: string) => { name: string; input: Record<string, unknown> }]> = [
    ['Read', (file) => ({ name: 'Read', input: { file_path: file } })],
    ['Bash', (file) => ({ name: 'Bash', input: { command: `cat "${file.replace(/\\/g, '/')}"`, description: 'Show the token' } })]
  ]

  it.each(TOOLS)('with %s: the value never reaches the model or the session file', async (tool, call) => {
    const before = toolResults.length
    const home = await turn(`${tool}-masked`, call, true)
    expect(toolResults.length).toBe(before + 1)
    expect(toolResults.at(-1)).toContain('[secret GH_TOKEN hidden]')
    expect(toolResults.at(-1)).not.toContain(SECRET)
    const sessions = filesUnder(join(home, 'projects')).filter((path) => path.endsWith('.jsonl'))
    expect(sessions.length).toBeGreaterThan(0)
    for (const path of filesUnder(home)) expect({ path, leaked: readFileSync(path, 'latin1').includes(SECRET) }).toEqual({ path, leaked: false })
    expect(sessions.some((path) => readFileSync(path, 'utf8').includes('[secret GH_TOKEN hidden]'))).toBe(true)
  }, 180_000)

  it.each(TOOLS)('control, with %s and no masking: the session file would keep the value', async (tool, call) => {
    const home = await turn(`${tool}-control`, call, false)
    const sessions = filesUnder(join(home, 'projects')).filter((path) => path.endsWith('.jsonl'))
    expect(sessions.some((path) => readFileSync(path, 'utf8').includes(SECRET))).toBe(true)
  }, 180_000)
})
