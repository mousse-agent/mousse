// @vitest-environment jsdom
/**
 * A thread of another computer whose agent called `computer_use_request`: the outcome line the agent got is saved on the
 * call's row (ACP, including a call an agent names only in its title; Cursor's MCP call), and this computer's window
 * shows one quiet line naming the computer to set it up on, only when the line said setup is needed there, and calls
 * nothing on this computer: no `computerUse.*` request, no settings change.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import type { Harness } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { TurnInput, TurnSpec } from '../../src/mms/harness/adapter'
import type { StreamingLlmToolEvent } from '../../src/mms/harness/turnEvents'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { TranscriptAssembler, type TranscriptStreamState } from '../../src/mms/run/transcript/TranscriptAssembler'
import { runtimeToolEvent } from '../../src/mms/run/transcript/promptRuntime'
import { ComputerUseSetupCard } from '../../src/renderer/components/ComputerUseSetupCard'
import type { ProviderToolEvent } from '../../src/shared/agentActivity'
import { qualifyId } from '../../src/shared/threadRef'
import type { ChatMessage } from '../../src/shared/types'
import { FakeCursorHost } from '../harness/fakeCursorHost'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OUTPUTS = {
  setup_needed: "[computer-use:setup_needed] Computer use is not set up on Studio Mac: Cua Driver needs installing. The user sees a setup card above the composer; don't wait for it.",
  ready: '[computer-use:ready] Computer use is set up on Studio Mac.',
  declined: "[computer-use:declined] The user said Not now to setting up computer use. Don't ask again in this thread; carry on without it.",
  none: 'Computer use is not available in this Mousse.'
} as const
type Case = keyof typeof OUTPUTS
const NODE = 'nod_0123456789abcdefghjkmnpqrs'
const BANNER = /The agent asked to set up computer use on (.+)\. Open Mousse on \1 → Settings → Computer use/

/** The saved rows of a run of tool events, through the real assembler. */
function transcript() {
  const rows: ChatMessage[] = []
  const state: TranscriptStreamState = { activeAssistantMessageId: null, activeThinkingMessageId: null, activeToolCallMessageIds: new Map(), callToMessage: new Map() }
  const assembler = new TranscriptAssembler({
    getMessage: (id) => rows.find((row) => row.id === id),
    addMessage: (row) => void rows.push(row),
    updateMessage: (row) => {
      const index = rows.findIndex((entry) => entry.id === row.id)
      if (index !== -1) rows[index] = row
    },
    removeMessage: () => undefined,
    emitAdded: () => undefined,
    emitUpdated: () => undefined,
    persist: () => undefined,
    setPhase: () => undefined
  }, state)
  // Saved and read back, as a window of another computer receives them.
  return { assembler, saved: () => JSON.parse(JSON.stringify(rows)) as ChatMessage[] }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** An ACP agent that starts the call by its title only (no name, no input), then completes it with only its id and output. */
async function acpRows(output: string, status: 'completed' | 'failed' = 'completed'): Promise<ChatMessage[]> {
  const agent = inProcessAgent((app: AgentApp) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1' }) as never)
      .onRequest(methods.agent.session.prompt, async (c) => {
        const update = (u: Record<string, unknown>) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: u } as never)
        await update({ sessionUpdate: 'tool_call', toolCallId: 'cu-1', title: 'computer_use_request (mousse MCP Server)', kind: 'other', status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: 'cu-1', status, content: [{ type: 'content', content: { type: 'text', text: output } }] })
        return { stopReason: 'end_turn' }
      })
  })
  const sessions = new AcpSessions({
    label: 'Fake agent', defaultInstanceId: 'acp:fake', questions: new UserQuestionService(), connect: agent.connect, quirks: NO_QUIRKS,
    store: { saved: () => undefined, setSaved: () => undefined, models: () => [], setModels: () => undefined },
    launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: vi.fn(), signInRequiredMessage: 'Sign in first'
  })
  cleanups.push(() => sessions.stop())
  const { assembler, saved } = transcript()
  await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'Open Figma', onText: vi.fn(), onTool: (event: ProviderToolEvent) => assembler.tool(runtimeToolEvent(event)) })
  return saved()
}

/** Cursor's MCP call of the Mousse server, completed with the tool's text. */
async function cursorRows(output: string): Promise<ChatMessage[]> {
  const call = { type: 'mcp', args: { toolName: 'computer_use_request', providerIdentifier: 'mousse', args: { reason: 'Open Figma' } } }
  const host = new FakeCursorHost({
    create: () => ({ agentId: 'agent-1' }),
    send: (_params, fake) => {
      setTimeout(() => {
        fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-started', callId: 'cu-1', toolCall: call } } as never)
        fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-completed', callId: 'cu-1', toolCall: { ...call, result: { status: 'success', value: { content: [{ text: { text: output } }], isError: false } } } } } as never)
        fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' } as never)
      }, 1)
      return { runId: 'run-1' }
    }
  })
  const home = mkdtempSync(join(tmpdir(), 'mousse-cu-remote-'))
  const instance = 'cursor:work'
  const stateDir = instanceStateDir(home, instance)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
  let stored: unknown = { [instance]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness: Harness = testHarness({ drivers: [cursorDriver({ connect: host.connect, cancelDeadlineMs: 200 })], instances, profileHome: home })
  cleanups.push(() => { harness.stop(); rmSync(home, { recursive: true, force: true }) })
  const { assembler, saved } = transcript()
  const binding = await harness.bind(harness.resolveStored({ instanceId: instance, llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
  const spec: TurnSpec = {
    binding,
    input: { threadId: 'thread', instanceId: binding.instanceId, llmProvider: '', model: binding.model, mode: 'agent', prompt: 'Open Figma', cwd: home, nativeHistory: '', signal: new AbortController().signal } as unknown as TurnInput,
    sink: { text: () => {}, thinking: () => {}, tool: (event: StreamingLlmToolEvent) => assembler.tool(event), progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {} } as unknown as TurnSpec['sink'],
    control: { drainSteer: () => undefined, heartbeat: () => {} } as unknown as TurnSpec['control'],
    host: { context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as TurnSpec['host']
  }
  await (await harness.startTurn(spec)).result
  return saved()
}

let host: HTMLDivElement
let root: Root
let request: ReturnType<typeof vi.fn>
let set: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  request = vi.fn(async () => ({ request: null }))
  set = vi.fn(async () => undefined)
  subscribe = vi.fn(() => () => undefined)
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request }, settings: { set }, orchestrator: { onComputerUseSetupRequestChanged: subscribe } }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The card above the composer of a thread on another computer, as OrchestratorChat mounts it. */
const shown = async (messages: ChatMessage[], how: 'qualified' | 'remoteNode', remoteHostName?: string) => {
  await act(async () => root.render(createElement(ComputerUseSetupCard, how === 'qualified'
    ? { threadId: qualifyId(NODE, 'thread'), messages, ...(remoteHostName ? { remoteHostName } : {}) }
    : { threadId: 'thread', remoteNode: NODE, messages, ...(remoteHostName ? { remoteHostName } : {}) })))
  return host.textContent ?? ''
}

describe("another computer's computer_use_request, in this computer's window", () => {
  it.each([
    ['setup_needed', true],
    ['ready', false],
    ['declined', false],
    ['none', false]
  ] as const)('ACP, the call named only in its title: %s → line shown: %s', async (outcome: Case, banner) => {
    const rows = await acpRows(OUTPUTS[outcome])
    expect(rows.filter((row) => row.activity?.status === 'done')).toHaveLength(1)
    const text = await shown(rows, 'qualified')
    if (banner) expect(text).toMatch(BANNER)
    else expect(text).toBe('')
    expect(request).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('ACP: a failed call shows no line, whatever its output says', async () => {
    expect(await shown(await acpRows(OUTPUTS.setup_needed, 'failed'), 'qualified')).toBe('')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['setup_needed', true],
    ['ready', false],
    ['declined', false],
    ['none', false]
  ] as const)("Cursor's MCP call: %s → line shown: %s", async (outcome: Case, banner) => {
    const rows = await cursorRows(OUTPUTS[outcome])
    const text = await shown(rows, 'remoteNode')
    if (banner) expect(text).toMatch(BANNER)
    else expect(text).toBe('')
    expect(request).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('names the computer as Mousse knows it, else as the outcome line did; the latest call decides', async () => {
    const needed = await acpRows(OUTPUTS.setup_needed)
    expect((await shown(needed, 'qualified')).match(BANNER)?.[1]).toBe('Studio Mac')
    expect((await shown(needed, 'qualified', 'Ada’s laptop')).match(BANNER)?.[1]).toBe('Ada’s laptop')
    // Set up since: a later call said ready, so nothing shows.
    const ready = (await acpRows(OUTPUTS.ready)).map((row) => ({ ...row, id: `later-${row.id}` }))
    expect(await shown([...needed, ...ready], 'qualified')).toBe('')
    expect(request).not.toHaveBeenCalled()
  })
})
