// @vitest-environment jsdom
/**
 * A tool row says what the call did: which query a web search ran and which sites came back, which URL a fetch read,
 * whatever the runtime. A call that sent no arguments shows its tool's words alone, never "summary: <tool> details: []".
 *
 * ACP runs its real session (a scripted in-process agent, hand-authored) through the mapper its adapter wraps it in;
 * Cursor's events are built by its own `cursorToolActivity`, as its session sends them; OpenCode's driver runs against a
 * hand-authored server (`fakeOpencodeServer.ts`) that names Mousse's tools as OpenCode 2.0.20 does. All go into the real
 * transcript assembler and are drawn by the real tool renderer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { withClosure } from '../../src/mms/harness/drivers/acp/adapter'
import { cursorToolActivity, cursorToolName } from '../../src/mms/harness/cursor/session'
import type { TurnInput } from '../../src/mms/harness/adapter'
import { opencodeDriver } from '../../src/mms/harness/drivers/opencode'
import { instanceEnv } from '../../src/mms/harness/env'
import { mousseServerName } from '../../src/mms/harness/opencode/rules'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { createRuntimeToolMapper } from '../../src/mms/run/transcript/promptRuntime'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { ToolRenderer } from '../../src/renderer/chat/components/agent-elements/tools/tool-renderer'
import { callTitle } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import type { ProviderToolEvent } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'
import { fakeOpencodeServer } from '../harness/fakeOpencodeServer'
import { transcriptSink } from '../support/transcriptSink'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A search provider's text result, as Mousse's web_search returns it. */
const RESULTS = [
  'Title: Best robot vacuums of 2026',
  'URL: https://www.example.com/vacuums',
  'Text: Our picks…',
  '',
  'Title: Vacuum price tracker',
  'URL: https://prices.test/vacuum?ref=1',
  'Text: Prices fall in November.'
].join('\n')

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function acpRows(): Promise<ChatMessage[]> {
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }) as never)
      .onRequest(methods.agent.session.prompt, async (c) => {
        const update = (u: Record<string, unknown>) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: u } as never)
        const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }]
        // Antigravity names Mousse's tools `mcp_mousse_<tool>` and sends the arguments with the call.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-search', name: 'mcp_mousse_web_search', title: 'mcp_mousse_web_search', rawInput: { query: 'robot vacuum prices' }, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-search', status: 'completed', content: text(RESULTS) })
        // An agent that opens the call with `{}` and sends its arguments in a later update.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-fetch', name: 'mcp_mousse_web_fetch', title: 'mcp_mousse_web_fetch', rawInput: {}, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-fetch', rawInput: { url: 'https://example.com/vacuums/review' }, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-fetch', status: 'completed', content: text('# Review') })
        // A call that never sends arguments.
        await update({ sessionUpdate: 'tool_call', toolCallId: 'a-bare', name: 'mcp_mousse_running_list', title: 'mcp_mousse_running_list', status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'a-bare', status: 'completed' })
        return { stopReason: 'end_turn' }
      })
  })
  const sessions = new AcpSessions({
    label: 'Antigravity', defaultInstanceId: 'acp:fake', questions: new UserQuestionService(), connect: agent.connect, quirks: NO_QUIRKS,
    store: { saved: () => undefined, setSaved: () => undefined, models: () => [], setModels: () => undefined },
    launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: vi.fn(), signInRequiredMessage: 'Sign in first'
  })
  cleanups.push(() => sessions.stop())
  const transcript = transcriptSink()
  // As the ACP adapter maps each event (`drivers/acp/adapter.ts`).
  const toolRows = createRuntimeToolMapper({ aborted: () => false })
  await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'Find vacuum prices', onText: vi.fn(), onTool: (event: ProviderToolEvent) => transcript.sink.tool(toolRows(withClosure(event as never, false))) })
  return JSON.parse(JSON.stringify(transcript.messages)) as ChatMessage[]
}

function cursorRows(): ChatMessage[] {
  const transcript = transcriptSink()
  const toolRows = createRuntimeToolMapper({ aborted: () => false })
  const call = { type: 'mcp', args: { toolName: 'web_search', providerIdentifier: 'mousse', args: { query: 'robot vacuum prices' } } }
  const done = { ...call, result: { status: 'success', value: { content: [{ text: { text: RESULTS } }], isError: false } } }
  // As Cursor's session sends a call's start and end (`harness/cursor/session.ts`).
  for (const [phase, toolCall] of [['start', call], ['complete', done]] as const) {
    const activity = cursorToolActivity(toolCall)
    transcript.sink.tool(toolRows({ phase, callId: 'k-search', title: 'Mcp web_search', toolName: cursorToolName(toolCall), ...(activity ? { activity } : {}), ...(phase === 'complete' ? { status: 'completed' } : {}) }))
  }
  return JSON.parse(JSON.stringify(transcript.messages)) as ChatMessage[]
}

async function opencodeRows(): Promise<ChatMessage[]> {
  const fake = await fakeOpencodeServer()
  const root = mkdtempSync(join(tmpdir(), 'mousse-tool-rows-opencode-'))
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
  fake.onPrompt = (session) => {
    const event = (type: string, data: Record<string, unknown>) => fake.emit(type, { sessionID: session.id, assistantMessageID: 'm', ...data })
    // OpenCode names an MCP tool `<server>_<tool>`; Mousse's server for this thread is `mousse_<12 hex>`.
    event('session.tool.input.started', { id: 'o-search', name: `${mousseServerName('t')}_web_search` })
    event('session.tool.called', { id: 'o-search', input: { query: 'robot vacuum prices' }, executed: false })
    event('session.tool.success', { id: 'o-search', content: [{ type: 'text', text: RESULTS }], executed: true })
    fake.reply(session.id, 'done')
  }
  const transcript = transcriptSink()
  await runtime.adapter.startTurn(
    { runId: 'r', attemptId: 'a', threadId: 't', instanceId: 'opencode:opencode', llmProvider: '', model: 'anthropic/claude-haiku-5-5', modelPinned: true, mode: 'agent', permissionMode: 'full', prompt: 'Find vacuum prices', messages: [], cwd: root, nativeHistory: '', signal: new AbortController().signal } as unknown as TurnInput,
    transcript.sink,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    { tools: {}, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
  )
  return JSON.parse(JSON.stringify(transcript.messages)) as ChatMessage[]
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

type Part = { type: string; toolCallId: string; state?: string; input?: unknown; output?: unknown }
/** Each saved tool row as the window draws it: its title (as the turn's line says it) and its text with the row opened. */
function drawn(messages: ChatMessage[]): Array<{ title: string; text: string; sites: string[] }> {
  const parts = mousseToUIMessages(messages).flatMap((message) => message.parts as unknown as Part[]).filter((part) => part.type.startsWith('tool-'))
  return parts.map((part) => {
    act(() => root.render(createElement(ToolRenderer, { part, chatStatus: 'ready' })))
    const toggle = mount.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    if (toggle) act(() => toggle.click())
    const sites = [...mount.querySelectorAll('[aria-label="Sites"] li')].map((item) => item.textContent ?? '')
    return { title: callTitle(part, part.state === 'output-error'), text: mount.textContent?.replace(/\s+/g, ' ').trim() ?? '', sites }
  })
}

describe('a tool row says what the call did', () => {
  it('ACP: a web search names its query and the sites it found, a fetch its late URL, and a call with no arguments only what it did', async () => {
    const [search, fetch, bare] = drawn(await acpRows())
    expect(search!.title).toBe('Searched the web robot vacuum prices')
    expect(search!.text).toContain('robot vacuum prices')
    expect(search!.sites).toEqual(['Best robot vacuums of 2026example.com', 'Vacuum price trackerprices.test'])
    expect(fetch!.title).toBe('Read a web page https://example.com/vacuums/review')
    expect(fetch!.text).toContain('https://example.com/vacuums/review')
    for (const row of [search, fetch, bare]) expect(row!.text).not.toMatch(/summary:|details:|mcp_mousse_/)
    expect(bare!.title).toBe('Checked what is running in Mousse')
  })

  it('OpenCode: a web search names its query and the sites it found', async () => {
    const [search] = drawn((await opencodeRows()).filter((row) => row.toolCall))
    expect(search!.title).toBe('Searched the web robot vacuum prices')
    expect(search!.sites).toEqual(['Best robot vacuums of 2026example.com', 'Vacuum price trackerprices.test'])
  })

  it('Cursor: a web search names its query and the sites it found', () => {
    const [search] = drawn(cursorRows())
    expect(search!.title).toBe('Searched the web robot vacuum prices')
    expect(search!.sites).toEqual(['Best robot vacuums of 2026example.com', 'Vacuum price trackerprices.test'])
  })
})
