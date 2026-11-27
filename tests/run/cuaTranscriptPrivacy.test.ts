// @vitest-environment jsdom
/**
 * A computer use call, in each of the six runtimes, directly or through a bot's `use_tool`: nothing it typed, ran or
 * got back reaches a saved row (checked after every event the transcript takes, and in the event itself, which the live
 * window gets), and the window shows what it did in words, one detail, and only the kept arguments and outcome, when
 * the row is opened too. A call of another tool through `use_tool` is shown as before.
 *
 * Each runtime runs its real event mapping into the real transcript assembler: Claude Code's frame reader and adapter,
 * Codex's item mapping and adapter, ACP's session with the mapper its adapter wraps it in, Cursor's driver through the
 * harness, OpenCode's driver against a hand-authored server (its Mousse tools named `mousse_<12 hex>_<tool>`, as OpenCode
 * 2.0.20 names an MCP server's tools), and Pi's engine fed the RPC events of its process (hand-authored, no model).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterHost, TurnControl, TurnInput, TurnSink, TurnSpec } from '../../src/mms/harness/adapter'
import { AcpSessions } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { withClosure } from '../../src/mms/harness/drivers/acp/adapter'
import { ClaudeSubscriptionAdapter, type ClaudeSubscriptionClient } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { CodexAdapter, type CodexClient } from '../../src/mms/harness/drivers/codex/adapter'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { opencodeDriver } from '../../src/mms/harness/drivers/opencode'
import { instanceEnv } from '../../src/mms/harness/env'
import { mousseServerName } from '../../src/mms/harness/opencode/rules'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import type { Harness } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { ClaudeSubscriptionChatInput } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeMetricsCollector } from '../../src/mms/harness/vendors/claude/metrics'
import { TurnFrames } from '../../src/mms/harness/vendors/claude/turnFrames'
import type { CodexChatInput } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { closeEvent, codexToolEvent } from '../../src/mms/harness/vendors/codex/codexActivity'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { createRuntimeToolMapper } from '../../src/mms/run/transcript/promptRuntime'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { ToolRenderer } from '../../src/renderer/chat/components/agent-elements/tools/tool-renderer'
import { callTitle } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import type { ProviderToolEvent } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'
import { FakeCursorHost } from '../harness/fakeCursorHost'
import { fakeOpencodeServer } from '../harness/fakeOpencodeServer'
import { transcriptSink } from '../support/transcriptSink'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'hunter2-SECRET-7f3a'
/** A computer use call that types the secret into Notes; through a bot's use_tool, one that runs a script with it. */
const TYPE = { tool: 'type_text', arguments: { text: SECRET, app: 'Notes' } }
const BOT_SCRIPT = { tool: 'computer_use', arguments: { tool: 'run_script', arguments: { script: SECRET } } }

/** A transcript that records, after every tool event it takes, the event and every row as saved. */
function watchedTranscript() {
  const transcript = transcriptSink()
  const seen: string[] = []
  const tool = transcript.sink.tool
  transcript.sink.tool = (event) => {
    seen.push(JSON.stringify(event))
    tool(event)
    seen.push(JSON.stringify(transcript.messages))
  }
  return { ...transcript, seen, saved: () => JSON.parse(JSON.stringify(transcript.messages)) as ChatMessage[] }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'run-1', attemptId: 'attempt-1', threadId: 'thread-1', cwd: '/work', instanceId: 'claude-subscription', model: 'sonnet',
    llmProvider: 'claude-subscription', modelPinned: false, mode: 'agent', prompt: 'Fill the note', messages: [],
    nativeHistory: '', signal: new AbortController().signal, ...overrides
  } as TurnInput
}
const host = (): AdapterHost => ({
  tools: {},
  bridge: { mcp: null, turnToken: 'turn-1', sessionInstructions: '', turnPreamble: '', userMcp: 'native' },
  context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text: string) => text }
} as unknown as AdapterHost)
const control = (): TurnControl => ({ drainSteer: () => undefined, heartbeat: () => {} })

async function claudeRows() {
  const transcript = watchedTranscript()
  const client = {
    chat: vi.fn(async (chat: ClaudeSubscriptionChatInput) => {
      const frames = new TurnFrames(chat, new ClaudeMetricsCollector())
      const observe = (message: Record<string, unknown>) => frames.observe({ parent_tool_use_id: null, session_id: 's1', ...message } as unknown as SDKMessage)
      const call = (id: string, name: string, input: unknown, result: string, isError = false) => {
        // The stream opens the call with no arguments; the assistant message that holds it has them all (a second start).
        observe({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } })
        observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
        observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } })
      }
      observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
      call('c-type', 'mcp__mousse__computer_use', TYPE, `Typed ${SECRET} into Notes.`)
      call('c-bot', 'mcp__mousse__use_tool', BOT_SCRIPT, `{"refused":{"code":"not_granted","message":"${SECRET}"}}`, true)
      call('c-other', 'mcp__mousse__use_tool', { tool: 'thread_list', arguments: { query: 'design review' } }, 'Two threads.')
      return frames.text
    }),
    commitConversation: vi.fn(),
    standaloneWorkspace: vi.fn((threadId: string) => `/standalone/${threadId}`),
    configured: () => true
  } satisfies ClaudeSubscriptionClient
  await new ClaudeSubscriptionAdapter(() => client).startTurn(turnInput(), transcript.sink, control(), host())
  return transcript
}

async function codexRows() {
  const transcript = watchedTranscript()
  const mcp = (id: string, tool: string, args: unknown, end: Record<string, unknown>) => ({ start: { type: 'mcpToolCall', id, server: 'mousse', tool, arguments: args, status: 'inProgress' }, end: { type: 'mcpToolCall', id, server: 'mousse', tool, arguments: args, ...end } })
  const client = {
    chat: vi.fn(async (chat: CodexChatInput) => {
      const click = mcp('x-click', 'computer_use', { tool: 'click', arguments: { x: 10, y: 20, text: SECRET } }, { status: 'completed', result: { content: [{ type: 'text', text: 'Captured screenshot' }] } })
      const bot = mcp('x-bot', 'use_tool', BOT_SCRIPT, { status: 'failed', error: { message: `script said ${SECRET}` } })
      for (const call of [click, bot]) {
        chat.onTool?.(codexToolEvent(call.start as never, 'start')!)
        chat.onTool?.(codexToolEvent(call.end as never, 'complete')!)
      }
      // A call still open when the turn ends is closed by the service with no result.
      const open = mcp('x-open', 'computer_use', TYPE, {})
      chat.onTool?.(codexToolEvent(open.start as never, 'start')!)
      chat.onTool?.(closeEvent({ callId: 'x-open', title: 'mousse.computer_use', toolName: 'mcp__mousse__computer_use' }, 'done'))
      return { text: '', codexThreadId: 'ct', turnId: 'tu', model: 'gpt' }
    }),
    commitConversation: vi.fn(),
    standaloneWorkspace: vi.fn((threadId: string) => `/standalone/${threadId}`),
    configured: () => true,
    interrupt: vi.fn(),
    userSetup: vi.fn()
  } as unknown as CodexClient
  await new CodexAdapter(() => client).startTurn(turnInput({ llmProvider: 'codex', instanceId: 'codex' }), transcript.sink, control(), host())
  return transcript
}

async function acpRows() {
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }) as never)
      .onRequest(methods.agent.session.prompt, async (c) => {
        const update = (u: Record<string, unknown>) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: u } as never)
        const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
        // Antigravity's own title quotes what it types; its arguments come in a later update.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-type', name: 'mcp_mousse_computer_use', title: `Typing "${SECRET}" into Notes`, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-type', rawInput: TYPE, title: `Typing "${SECRET}"`, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-type', status: 'completed', content: text(`Typed ${SECRET}.`) })
        // A bot's use_tool, said to run computer use only by its late arguments, and failed.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-bot', name: 'mcp_mousse_use_tool', title: `Run use_tool ${SECRET}`, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-bot', rawInput: BOT_SCRIPT, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-bot', status: 'failed', content: text(`script said ${SECRET}`) })
        // use_tool whose arguments never say which tool it runs: nothing of it is kept, whatever it was.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-none', name: 'mcp_mousse_use_tool', title: SECRET, rawInput: { arguments: { text: SECRET } }, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-none', status: 'completed', content: text(SECRET) })
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-num', name: 'mcp_mousse_use_tool', title: SECRET, rawInput: { tool: 42, arguments: { text: SECRET } }, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-num', status: 'completed', content: text(SECRET) })
        // A call an agent names only by its title, with no arguments.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-title', title: 'computer_use (mousse MCP Server)', kind: 'other', status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-title', status: 'completed', content: text('Captured screenshot') })
        return { stopReason: 'end_turn' }
      })
  })
  const sessions = new AcpSessions({
    label: 'Antigravity', defaultInstanceId: 'acp:fake', questions: new UserQuestionService(), connect: agent.connect, quirks: NO_QUIRKS,
    store: { saved: () => undefined, setSaved: () => undefined, models: () => [], setModels: () => undefined },
    launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: vi.fn(), signInRequiredMessage: 'Sign in first'
  })
  cleanups.push(() => sessions.stop())
  const transcript = watchedTranscript()
  // As the ACP adapter maps each event (`drivers/acp/adapter.ts`).
  const toolRows = createRuntimeToolMapper({ aborted: () => false })
  await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'Fill the note', onText: vi.fn(), onTool: (event: ProviderToolEvent) => transcript.sink.tool(toolRows(withClosure(event as never, false))) })
  return transcript
}

async function cursorRows() {
  const mcp = (toolName: string, args: unknown) => ({ type: 'mcp', args: { toolName, providerIdentifier: 'mousse', args } })
  const type = mcp('computer_use', TYPE)
  const bot = mcp('use_tool', BOT_SCRIPT)
  const host = new FakeCursorHost({
    create: () => ({ agentId: 'agent-1' }),
    send: (_params, fake) => {
      setTimeout(() => {
        const delta = (update: Record<string, unknown>) => fake.emit({ event: 'delta', runId: 'run-1', update } as never)
        delta({ type: 'tool-call-started', callId: 'k-type', toolCall: type })
        delta({ type: 'tool-call-completed', callId: 'k-type', toolCall: { ...type, result: { status: 'success', value: { content: [{ text: { text: `Typed ${SECRET}.` } }], isError: false } } } })
        // The run ends before the bot's call reports its end: the row ends stopped.
        delta({ type: 'tool-call-started', callId: 'k-bot', toolCall: bot })
        fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' } as never)
      }, 1)
      return { runId: 'run-1' }
    }
  })
  const home = mkdtempSync(join(tmpdir(), 'mousse-cua-privacy-'))
  const instance = 'cursor:work'
  const stateDir = instanceStateDir(home, instance)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
  let stored: unknown = { [instance]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness: Harness = testHarness({ drivers: [cursorDriver({ connect: host.connect, cancelDeadlineMs: 200 })], instances, profileHome: home })
  cleanups.push(() => { harness.stop(); rmSync(home, { recursive: true, force: true }) })
  const transcript = watchedTranscript()
  const binding = await harness.bind(harness.resolveStored({ instanceId: instance, llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
  const spec: TurnSpec = {
    binding,
    input: { threadId: 'thread', instanceId: binding.instanceId, llmProvider: '', model: binding.model, mode: 'agent', prompt: 'Fill the note', cwd: home, nativeHistory: '', signal: new AbortController().signal } as unknown as TurnInput,
    sink: { ...transcript.sink, text: () => {}, thinking: () => {} } as unknown as TurnSpec['sink'],
    control: { drainSteer: () => undefined, heartbeat: () => {} } as unknown as TurnSpec['control'],
    host: { context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as TurnSpec['host']
  }
  await (await harness.startTurn(spec)).result
  return transcript
}

async function opencodeRows() {
  const fake = await fakeOpencodeServer()
  const root = mkdtempSync(join(tmpdir(), 'mousse-cua-opencode-'))
  const binaryPath = join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  writeFileSync(binaryPath, '#!/bin/sh\n', { mode: 0o755 })
  const driver = opencodeDriver({ startServer: (launch, signal) => fake.start(launch, signal), interruptWaitMs: 2_000 })
  const runtime = driver.create({
    instanceId: 'opencode:opencode', builtIn: false, config: driver.decodeConfig({ binaryPath }),
    env: instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base: { PATH: '' } }),
    profileHome: root, installationHome: root, stateDir: root, questions: new UserQuestionService(),
    findBinary: () => undefined, changed: () => {}, signedOut: () => false, saveLaunch: async () => {}
  })
  cleanups.push(() => { void runtime.stop().then(() => fake.close()); rmSync(root, { recursive: true, force: true }) })
  // OpenCode names an MCP tool `<server>_<tool>`; Mousse's server for this thread is `mousse_<12 hex>`.
  const tool = (name: string) => `${mousseServerName('thread-1')}_${name}`
  fake.onPrompt = (session) => {
    const event = (type: string, data: Record<string, unknown>) => fake.emit(type, { sessionID: session.id, assistantMessageID: 'm', ...data })
    const call = (id: string, name: string, input: unknown, end: Record<string, unknown>, failed = false) => {
      event('session.tool.input.started', { id, name })
      event('session.tool.called', { id, input, executed: false })
      event(failed ? 'session.tool.failed' : 'session.tool.success', { id, executed: true, ...end })
    }
    call('o-type', tool('computer_use'), TYPE, { content: [{ type: 'text', text: `Typed ${SECRET}.` }] })
    call('o-bot', tool('use_tool'), BOT_SCRIPT, { error: { type: 'tool.failed', message: `script said ${SECRET}` } }, true)
    call('o-none', tool('use_tool'), { arguments: { text: SECRET } }, { content: [{ type: 'text', text: SECRET }] })
    fake.reply(session.id, 'done')
  }
  const transcript = watchedTranscript()
  await runtime.adapter.startTurn(turnInput({ threadId: 'thread-1', instanceId: 'opencode:opencode', llmProvider: '', model: 'anthropic/claude-haiku-5-5', permissionMode: 'full', cwd: root } as Partial<TurnInput>), transcript.sink, control(), host())
  return transcript
}

function piRows() {
  const transcript = watchedTranscript()
  const engine = new PiRpcEngine({ instanceId: 'pi:x', provider: 'x', label: 'X', capabilities: PI_RPC_CAPS, env: () => ({ env: {} }) } as unknown as PiRpcEngineOptions)
  const rpc = engine as unknown as { turnEvent(thread: unknown, turn: unknown, event: unknown): void }
  const thread = { groups: { refresh: async () => {} } }
  const turn = {
    progress: () => {}, announced: new Set(), openTools: new Map(), fileCalls: new Map(), ledgerRows: new Map(), reply: { break: () => {} },
    episode: { ended: () => {} }, host: { tools: {} }, sink: { ...transcript.sink, lineEdits: () => {} } as TurnSink
  }
  const call = (id: string, toolName: string, args: unknown, result: string, isError = false) => {
    rpc.turnEvent(thread, turn, { type: 'tool_execution_start', toolCallId: id, toolName, args })
    rpc.turnEvent(thread, turn, { type: 'tool_execution_end', toolCallId: id, toolName, args, isError, result: { content: [{ type: 'text', text: result }] } })
  }
  call('p-type', 'computer_use', TYPE, `Typed ${SECRET}.`)
  call('p-bot', 'use_tool', BOT_SCRIPT, `script said ${SECRET}`, true)
  call('p-none', 'use_tool', { arguments: { text: SECRET } }, SECRET)
  return transcript
}

let root: Root
let mount: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
})
afterEach(() => {
  act(() => root.unmount())
  mount.remove()
  vi.unstubAllGlobals()
})

type Part = { type: string; toolCallId: string; state?: string; input?: unknown; output?: unknown; useToolTarget?: string }
/** Each saved tool row as the window draws it, named in order by `ids`: its part, title, and text with the row opened. */
function drawn(messages: ChatMessage[], ids: string[] = []): Map<string, { part: Part; title: string; text: string }> {
  const parts = mousseToUIMessages(messages).flatMap((message) => message.parts as unknown as Part[]).filter((part) => part.type.startsWith('tool-'))
  if (ids.length) expect(parts).toHaveLength(ids.length)
  const rows = new Map<string, { part: Part; title: string; text: string }>()
  parts.forEach((part, index) => {
    act(() => root.render(createElement(ToolRenderer, { part, chatStatus: 'ready' })))
    const toggle = mount.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    if (toggle) act(() => toggle.click())
    rows.set(ids[index] ?? String(index), { part, title: callTitle(part, part.state === 'output-error'), text: mount.textContent?.replace(/\s+/g, ' ').trim() ?? '' })
  })
  return rows
}

function expectNoSecret(transcript: ReturnType<typeof watchedTranscript>, rows: ReturnType<typeof drawn>): void {
  for (const snapshot of transcript.seen) expect(snapshot).not.toContain(SECRET)
  for (const [, row] of rows) {
    expect(JSON.stringify(row.part)).not.toContain(SECRET)
    expect(row.title).not.toContain(SECRET)
    expect(row.text).not.toContain(SECRET)
  }
}

describe('a computer use call keeps nothing it typed, ran or got back', () => {
  it('Claude Code: a direct call and a bot’s, across the call’s two starts; another tool through use_tool as before', async () => {
    const transcript = await claudeRows()
    const rows = drawn(transcript.saved(), ['c-type', 'c-bot', 'c-other'])
    expectNoSecret(transcript, rows)
    expect(rows.get('c-type')).toMatchObject({ title: 'Type text Notes', part: { input: { tool: 'type_text', arguments: { app: 'Notes' } }, output: 'Completed' } })
    expect(rows.get('c-type')!.text).toMatch(/Type text.*Notes.*"app": "Notes".*Completed/)
    expect(rows.get('c-bot')).toMatchObject({ title: 'Run script failed', part: { state: 'output-error', output: 'Computer action refused' } })
    // Another tool through use_tool: its arguments and result as any call's, and the tool it ran kept on the row.
    const other = rows.get('c-other')!
    expect(other.part).toMatchObject({ input: { tool: 'thread_list', arguments: { query: 'design review' } }, useToolTarget: 'thread_list' })
    expect(other.text).toContain('Two threads.')
  })

  it('Codex: a call, a bot’s failed call, and one the service closes with no result', async () => {
    const transcript = await codexRows()
    const rows = drawn(transcript.saved(), ['x-click', 'x-bot', 'x-open'])
    expectNoSecret(transcript, rows)
    expect(rows.get('x-click')).toMatchObject({ title: 'Click (10, 20)', part: { input: { tool: 'click', arguments: { x: 10, y: 20 } }, output: 'Captured screenshot' } })
    expect(rows.get('x-bot')).toMatchObject({ title: 'Run script failed', part: { state: 'output-error', output: 'Computer action failed' } })
    expect(rows.get('x-open')!.title).toBe('Type text Notes')
  })

  it('ACP: an agent title that quotes the text, late arguments, use_tool without a tool, and a call named by title only', async () => {
    const transcript = await acpRows()
    const saved = transcript.saved()
    const rows = drawn(saved, ['a-type', 'a-bot', 'a-none', 'a-num', 'a-title'])
    expectNoSecret(transcript, rows)
    expect(saved.map((row) => row.toolCall?.title)).toEqual(['Computer: type_text', 'Computer: run_script', 'Using tool', 'Using tool', 'Using the computer'])
    expect(rows.get('a-type')).toMatchObject({ title: 'Type text Notes', part: { output: 'Completed' } })
    expect(rows.get('a-bot')).toMatchObject({ title: 'Run script failed', part: { output: 'Computer action failed' } })
    for (const id of ['a-none', 'a-num']) expect(rows.get(id)).toMatchObject({ title: 'Used a tool', part: { output: undefined } })
    expect(rows.get('a-title')).toMatchObject({ title: 'Used the computer', part: { output: 'Captured screenshot' } })
  })

  it('Cursor: a call, and a bot’s call the run ended before it reported its end', async () => {
    const transcript = await cursorRows()
    const saved = transcript.saved()
    const rows = drawn(saved, ['k-type', 'k-bot'])
    expectNoSecret(transcript, rows)
    expect(rows.get('k-type')).toMatchObject({ title: 'Type text Notes', part: { output: 'Completed' } })
    expect(saved.filter((row) => row.toolCall)[1].activity).toMatchObject({ status: 'interrupted' })
    expect(rows.get('k-bot')!.text).toBe('Stopped run script')
  })

  it('OpenCode: a call, a bot’s failed call, and use_tool without a tool, named as OpenCode names Mousse’s tools', async () => {
    const transcript = await opencodeRows()
    const rows = drawn(transcript.saved(), ['o-type', 'o-bot', 'o-none'])
    expectNoSecret(transcript, rows)
    expect(rows.get('o-type')).toMatchObject({ title: 'Type text Notes', part: { input: { tool: 'type_text', arguments: { app: 'Notes' } } } })
    expect(rows.get('o-bot')).toMatchObject({ title: 'Run script failed' })
    expect(rows.get('o-none')).toMatchObject({ title: 'Used a tool' })
  })

  it('Pi: a call, a bot’s failed call, and use_tool without a tool', () => {
    const transcript = piRows()
    const rows = drawn(transcript.saved(), ['p-type', 'p-bot', 'p-none'])
    expectNoSecret(transcript, rows)
    expect(rows.get('p-type')).toMatchObject({ title: 'Type text Notes', part: { output: 'Completed' } })
    expect(rows.get('p-bot')).toMatchObject({ title: 'Run script failed', part: { output: 'Computer action failed' } })
    expect(rows.get('p-none')).toMatchObject({ title: 'Used a tool' })
  })
})

describe('a row saved before computer use calls were kept this way', () => {
  const row = (toolName: string, input: unknown, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `m-${toolName}`, role: 'tool', kind: 'mcp_tool_call', content: '', timestamp: 1, callId: 'old',
    toolCall: { title: toolName, summary: 'The tool returned successfully.', details: [], status: 'completed', toolName },
    activity: { kind: 'generic', toolName, status: 'completed', ...(input !== undefined ? { input } : {}), output: 'Done.' },
    ...extra
  } as unknown as ChatMessage)

  it('arguments cut to fit when saved show nothing of them for a computer use call, or a use_tool of unknown target', () => {
    const cut = { truncated: true, preview: `{"tool":"type_text","arguments":{"text":"${SECRET}"` }
    for (const name of ['mcp__mousse__computer_use', 'mcp__mousse__use_tool']) {
      const [drawnRow] = [...drawn([row(name, cut)]).values()]
      expect(drawnRow.text).not.toContain(SECRET)
      expect(drawnRow.title).not.toContain(SECRET)
    }
  })

  it('a use_tool of another tool, cut to fit, is shown as before', () => {
    const cut = { truncated: true, preview: '{"tool":"thread_list","arguments":{"query":"design review"' }
    const saved = row('mcp__mousse__use_tool', cut)
    const [drawnRow] = [...drawn([{ ...saved, activity: { ...saved.activity!, useToolTarget: 'thread_list' } as ChatMessage['activity'] }]).values()]
    expect(drawnRow.text).toContain('Ran use tool in Mousse')
    expect(drawnRow.text).toContain('{"tool":"thread_list"')
  })

  it('a computer use row with nothing recorded says it used the computer', () => {
    const [drawnRow] = [...drawn([row('mcp__mousse__computer_use', undefined)]).values()]
    expect(drawnRow.title).toBe('Used the computer')
    expect(drawnRow.text).not.toContain('Done.')
  })
})
