// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStatusFromTurn, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { collectNativeSubagentCards } from '../../src/renderer/chat/adapters/nativeSubagents'
import { collectSubagentCalls, joinSubagentCards } from '../../src/renderer/chat/adapters/subagentCards'
import { runtimeToolEvent } from '../../src/mms/run/transcript/promptRuntime'
import { TranscriptAssembler, type TranscriptHooks, type TranscriptStreamState } from '../../src/mms/run/transcript/TranscriptAssembler'
import { recordSubagentCall } from '../../src/shared/subagentTools'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { LOCATED_CLASS } from '../../src/renderer/chat/components/agent-elements/reveal-message'
import { SubagentCardsContext } from '../../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { LineageSection } from '../../src/renderer/components/sideCard/LineageSection'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { CHAT_NAVIGATION_TIMEOUT_MS, revealSubagent, useChatNavigationStore } from '../../src/renderer/stores/chatNavigationStore'
import { useProviderSnapshotsStore } from '../../src/renderer/lib/providerSnapshots'
import type { SubagentSummary } from '../../src/shared/subagents'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-16T09:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const RUN = 'run:thread:t1:ordinal:1'

const user = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
const row = (id: string, seconds: number, activity: Partial<AgentActivityItem> & { kind: AgentActivityItem['kind'] }): ChatMessage =>
  ({
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at(seconds),
    turnId: RUN,
    toolCall: { title: activity.toolName ?? 'Agent', summary: activity.toolName ?? 'Agent', details: [], status: 'complete' },
    activity: { id, callId: `toolu_${id}`, toolName: 'Agent', status: 'done', startedAt: at(seconds), runId: RUN, ...activity }
  }) as ChatMessage

/** Claude Code's own Explore agent, still running: it has no thread, only its card in the transcript. */
const runningExplore = (id: string, seconds: number, description: string) =>
  row(id, seconds, { kind: 'subagent', agentType: 'Explore', description, status: 'running' } as never)
const nestedCommand = (id: string, seconds: number, parentId: string) =>
  row(id, seconds, { kind: 'command', toolName: 'Bash', command: `ls ${id}`, output: 'ok', parentId } as never)

// Two agents started together, as in the report: their cards share one group, which starts folded.
const messages: ChatMessage[] = [
  user('u1', 0, 'Look into bots'),
  runningExplore('a1', 2, 'Explore bot work and threads'),
  runningExplore('a2', 3, 'Explore bot metering and tools'),
  nestedCommand('c1', 5, 'a1'),
  nestedCommand('c2', 6, 'a2')
]

describe('Nest rows of a thread', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { mousse: unknown }).mousse = {
      orchestrator: { getMessages: async () => [] },
      subagents: { list: async () => [], onUpdated: () => () => undefined }
    }
    useAppStore.setState({ activeThreadId: 't1', messages })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(useAppStore.getInitialState())
    useChatNavigationStore.setState({ subagent: null })
    useProviderSnapshotsStore.setState({ scopes: {} })
    vi.useRealTimers()
  })

  const showChat = async (shown: ChatMessage[]) => {
    const ui = mousseToUIMessages(shown)
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, true) },
        createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })))
    })
  }

  it('drop a request no transcript took, so a card that shows later does not open by itself', async () => {
    vi.useFakeTimers()
    await showChat([user('u0', 0, 'Something else')])
    act(() => revealSubagent('a2'))
    act(() => vi.advanceTimersByTime(CHAT_NAVIGATION_TIMEOUT_MS + 1))
    expect(useChatNavigationStore.getState().subagent).toBeNull()
    await showChat(messages)
    expect(host.querySelector('[data-native-subagent="a2"] button.subagent-card')!.getAttribute('aria-expanded')).toBe('false')
  })

  it("rename a subagent's model when its provider's list loads after the row is drawn", async () => {
    const child = { childThreadId: 'child', title: 'Reviewer', activity: 'working', state: 'working', provider: 'codex:chatgpt-subscription', model: 'house-model', waitingOn: [], createdAt: at(1), updatedAt: at(1) } as unknown as SubagentSummary
    useAppStore.setState({ activeThreadId: 't1', messages: [] })
    // The daemon reports the thread's subagent.
    ;(window as unknown as { mousse: { subagents: { list: unknown } } }).mousse.subagents.list = async () => [child]
    await act(async () => root.render(createElement(LineageSection, { threadId: 't1', projectId: null })))
    const model = () => host.querySelector('.lineage-model')?.textContent
    await vi.waitFor(() => expect(model()).toBe('House Model'))
    act(() => useProviderSnapshotsStore.setState({ scopes: { device: { loading: false, snapshots: [{ instanceId: 'codex:chatgpt-subscription', driver: 'codex', builtIn: false, models: { entries: [], source: 'none', names: { 'house-model': 'House Model 2' } } } as never] } } }))
    expect(model()).toBe('House Model 2')
  })

  it.each([
    { toolName: 'start_subagent', status: 'running', task: undefined, label: 'Working' },
    { toolName: 'invoke_subagent', status: 'running', task: 'Read the documentation for the model picker.', label: 'Working' },
    { toolName: 'invoke_subagent', status: 'done', task: 'Read the documentation for the model picker.', label: 'Launched' }
  ] as const)('opens an Antigravity $toolName row from Nest when its call is $status', async ({ toolName, status, task, label }) => {
    const shown = [
      user('u1', 0, 'Look into the model picker'),
      row('agy1', 1, { kind: 'subagent', toolName, description: 'Documentation reviewer', prompt: task, status, ...(status === 'done' ? { endedAt: at(2) } : {}) })
    ]
    const ui = mousseToUIMessages(shown)
    useAppStore.setState({ activeThreadId: 't1', messages: shown, turnStates: { t1: { phase: 'streaming', turnId: RUN } } })
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, true, true) },
          createElement(MessageList, { messages: ui, status: 'streaming' })),
        createElement('aside', null, createElement(LineageSection, { threadId: 't1', projectId: null }))))
    })

    if (status === 'done') {
      const launchedGroup = [...host.querySelectorAll<HTMLButtonElement>('aside button')]
        .find((button) => button.textContent?.includes('1 launched'))
      expect(launchedGroup).toBeDefined()
      await act(async () => launchedGroup!.click())
    }
    const rowButton = [...host.querySelectorAll<HTMLButtonElement>('aside button')]
      .find((button) => button.textContent?.includes('Documentation reviewer'))
    expect(rowButton?.textContent).toContain(label)
    await act(async () => rowButton!.click())
    const card = host.querySelector<HTMLElement>('[data-native-subagent="agy1"]')
    expect(card?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(card?.textContent).toContain(task ?? 'No subagent activity reported')
  })

  it('open a running subagent of Claude Code from its row: the transcript lands on its card, opened', async () => {
    const ui = mousseToUIMessages(messages)
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, true) },
          createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })),
        createElement('aside', null, createElement(LineageSection, { threadId: 't1', projectId: null }))))
    })
    // The card is in sight but not opened before the click.
    expect(host.querySelector('[data-native-subagent="a2"] button.subagent-card')!.getAttribute('aria-expanded')).toBe('false')

    const lineageRow = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('Explore bot metering and tools'))!
    expect(lineageRow.textContent).toContain('Working')
    await act(async () => lineageRow.click())

    const card = host.querySelector<HTMLElement>('[data-native-subagent="a2"]')
    expect(card).not.toBeNull()
    await act(async () => {
      for (let frame = 0; frame < 30 && !card!.classList.contains(LOCATED_CLASS); frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      }
    })
    expect(card!.classList.contains(LOCATED_CLASS)).toBe(true)
    const cardButton = card!.querySelector<HTMLButtonElement>('button.subagent-card')!
    expect(cardButton.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(cardButton)
    expect(useChatNavigationStore.getState().subagent).toBeNull()
  })

  it('opens a finished native subagent from Nest even when its turn is folded behind Worked for', async () => {
    const finishedMessages: ChatMessage[] = [
      user('u1', 0, 'Look into bots'),
      row('done1', 2, { kind: 'subagent', agentType: 'Explore', description: 'Explore bot work and threads', status: 'done', summary: 'Found 3 files.', endedAt: at(10) } as never),
      nestedCommand('c1', 5, 'done1'),
      { id: 'ans1', role: 'assistant', content: 'Here is what it found.', timestamp: at(12), turnId: RUN } as ChatMessage
    ]
    const ui = mousseToUIMessages(finishedMessages)
    useAppStore.setState({ activeThreadId: 't1', messages: finishedMessages })
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, false) },
          createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })),
        createElement('aside', null, createElement(LineageSection, { threadId: 't1', projectId: null }))))
    })
    // Settled card is folded behind Worked for before the click.
    expect(host.querySelector('[data-native-subagent="done1"]')).toBeNull()
    expect(host.querySelector('.turn-work-toggle')?.getAttribute('aria-expanded')).toBe('false')

    const finishedGroup = [...host.querySelectorAll<HTMLButtonElement>('aside button')]
      .find((button) => button.textContent?.includes('1 finished'))!
    await act(async () => finishedGroup.click())
    const lineageRow = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('Explore bot work and threads'))!
    await act(async () => lineageRow.click())

    const card = host.querySelector<HTMLElement>('[data-native-subagent="done1"]')
    expect(card).not.toBeNull()
    expect(host.querySelector('.turn-work-toggle')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      for (let frame = 0; frame < 30 && !card!.classList.contains(LOCATED_CLASS); frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      }
    })
    expect(card!.classList.contains(LOCATED_CLASS)).toBe(true)
    const cardButton = card!.querySelector<HTMLButtonElement>('button.subagent-card')!
    expect(cardButton.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(cardButton)
  })

  it('groups Antigravity mcp_mousse_delegate_task calls into an inline subagent group card inside Worked for and lists them in Nest', async () => {
    const assembled: ChatMessage[] = [user('u1', 0, 'Create researchers')]
    const state: TranscriptStreamState = { activeAssistantMessageId: null, activeThinkingMessageId: null, activeToolCallMessageIds: new Map() }
    const hooks: TranscriptHooks = {
      getMessage: (id) => assembled.find((m) => m.id === id),
      addMessage: (m) => assembled.push(m),
      updateMessage: (m) => { const idx = assembled.findIndex((x) => x.id === m.id); if (idx >= 0) assembled[idx] = m },
      removeMessage: (id) => { const idx = assembled.findIndex((x) => x.id === id); if (idx >= 0) assembled.splice(idx, 1) },
      emitAdded: () => {},
      emitUpdated: () => {},
      persist: () => {},
      setPhase: () => {}
    }
    const assembler = new TranscriptAssembler(hooks, state)
    for (const [callId, title, delegationId, childThreadId] of [
      ['c1', 'GitHub researcher', 'd-gh', 'child-gh'],
      ['c2', 'Reddit researcher', 'd-rd', 'child-rd']
    ] as const) {
      assembler.tool(runtimeToolEvent({
        phase: 'start', callId, title: 'Run mcp_mousse_delegate_task', toolName: 'mcp_mousse_delegate_task',
        record: recordSubagentCall('mcp_mousse_delegate_task', { title, prompt: 'Research' }, {})!
      }))
      assembler.tool(runtimeToolEvent({
        phase: 'complete', callId, title: 'Run mcp_mousse_delegate_task', toolName: 'mcp_mousse_delegate_task',
        record: recordSubagentCall('mcp_mousse_delegate_task', { title }, { text: JSON.stringify({ delegationId, childThreadId, title }) })!
      }))
    }
    const subagents: SubagentSummary[] = [
      { childThreadId: 'child-gh', title: 'GitHub researcher', activity: 'idle', state: 'done', latestDelegationId: 'd-gh', unread: false, provider: 'antigravity', model: 'gemini-4-neon', workspace: 'shared', role: null, createdAt: at(1), updatedAt: at(5), waitingOn: [], tasks: [{ delegationId: 'd-gh', childRunId: 'r-gh', outcome: 'done', unread: false, continued: false, createdAt: at(1), completedAt: at(5) }] },
      { childThreadId: 'child-rd', title: 'Reddit researcher', activity: 'idle', state: 'done', latestDelegationId: 'd-rd', unread: false, provider: 'antigravity', model: 'gemini-4-neon', workspace: 'shared', role: null, createdAt: at(2), updatedAt: at(6), waitingOn: [], tasks: [{ delegationId: 'd-rd', childRunId: 'r-rd', outcome: 'done', unread: false, continued: false, createdAt: at(2), completedAt: at(6) }] }
    ]
    const ui = mousseToUIMessages(assembled)
    const cards = joinSubagentCards(collectSubagentCalls(ui), subagents, { loaded: true })
    expect(cards.size).toBe(2)

    useAppStore.setState({ activeThreadId: 't1', messages: assembled, turnStates: { t1: { phase: 'completed', turnId: RUN } } })
    ;(window as unknown as { mousse: { subagents: { list: unknown } } }).mousse.subagents.list = async () => subagents
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(SubagentCardsContext.Provider, { value: cards },
          createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })),
        createElement('aside', null, createElement(LineageSection, { threadId: 't1', projectId: null }))))
    })
    expect(host.querySelector('.subagent-cards.is-group')).toBeNull()
    const toggle = host.querySelector<HTMLButtonElement>('.turn-work-toggle')!
    expect(toggle.querySelector('[title="2 subagents inside"]')).not.toBeNull()
    await act(async () => toggle.click())
    const group = host.querySelector('.subagent-cards.is-group')
    expect(group?.textContent).toContain('2 subagents')
    expect(group?.textContent).toContain('2 done')
    expect(group?.textContent).toContain('GitHub researcher')
    expect(group?.textContent).toContain('Reddit researcher')
    await vi.waitFor(() => expect(host.querySelector('aside')?.textContent).toContain('2 finished'))
  })
})
