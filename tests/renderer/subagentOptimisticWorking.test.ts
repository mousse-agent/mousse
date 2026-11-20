// @vitest-environment jsdom
/**
 * Opening a newly started subagent from Nest before its internal turn begins shows Working + Starting…
 * and its SubagentParentBar rather than the empty new-chat screen.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LineageSection } from '../../src/renderer/components/sideCard/LineageSection'
import { findSubagentEntry, isSubagentStartingOptimistically } from '../../src/renderer/components/subagentStatus'
import { isNewEmptyThread } from '../../src/renderer/lib/newThread'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { getDefaultSettings } from '../../src/shared/settings'
import type { SubagentSummary } from '../../src/shared/subagents'
import type { ChatMessage, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

function makeSubagentSummary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    childThreadId: 'sub-1',
    title: 'API reviewer',
    activity: 'queued',
    state: 'queued',
    latestDelegationId: 'del-1',
    unread: false,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    workspace: 'isolated',
    role: 'review',
    createdAt: iso(0),
    updatedAt: iso(0),
    waitingOn: [],
    tasks: [{
      delegationId: 'del-1',
      childRunId: 'run:thread:sub-1:ordinal:1',
      outcome: 'running',
      unread: false,
      continued: false,
      createdAt: iso(0),
      completedAt: null
    }],
    ...overrides
  }
}

describe('subagent optimistic working helpers', () => {
  it('never treats a subagent thread as an empty new-chat draft', () => {
    const lineage = { parentThreadId: 'parent-1', rootThreadId: 'parent-1', relationship: 'subagent' as const }
    expect(isNewEmptyThread('sub-1', { name: 'New Chat', lineage }, 0)).toBe(false)
    expect(isNewEmptyThread('sub-1', { name: 'API reviewer', lineage }, 0)).toBe(false)
    // Control: an ordinary unstarted draft is still a new empty thread.
    expect(isNewEmptyThread('draft-1', { name: 'New Chat' }, 0)).toBe(true)
    expect(isNewEmptyThread('started-1', { name: 'Fix bug', startedAt: iso(0) }, 0)).toBe(false)
  })

  it('finds a subagent entry by local childThreadId or remote computer.ref', () => {
    const local = makeSubagentSummary({ childThreadId: 'sub-local' })
    const remote = makeSubagentSummary({
      childThreadId: 'sub-standin',
      computer: { node: 'mac-mini', name: 'Mac Mini', online: true, ref: 'mac-mini:remote-child-1' }
    })
    const map = { 'parent-1': [local, remote] }
    expect(findSubagentEntry(map, 'sub-local')).toEqual({ parentThreadId: 'parent-1', subagent: local })
    expect(findSubagentEntry(map, 'mac-mini:remote-child-1')).toEqual({ parentThreadId: 'parent-1', subagent: remote })
    expect(findSubagentEntry(map, 'unrelated')).toBeUndefined()
    expect(findSubagentEntry(map, null)).toBeUndefined()
  })

  it.each([
    { label: 'queued with no turn state and 0 messages', state: 'queued', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: true },
    { label: 'starting with idle turn state and 0 messages', state: 'starting', turnPhase: 'idle', messageCount: 0, hasSetupFailure: false, expected: true },
    { label: 'working with no turn state and 0 messages', state: 'working', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: true },
    { label: 'daemon already reports failed', state: 'queued', turnPhase: 'failed', messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'daemon already reports stopped', state: 'queued', turnPhase: 'stopped', messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'daemon already reports completed', state: 'working', turnPhase: 'completed', messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'setup failure recorded', state: 'queued', turnPhase: undefined, messageCount: 0, hasSetupFailure: true, expected: false },
    { label: 'messages already loaded', state: 'working', turnPhase: 'idle', messageCount: 1, hasSetupFailure: false, expected: false },
    { label: 'Nest reports done', state: 'done', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'Nest reports stopped', state: 'stopped', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'Nest reports failed', state: 'failed', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'Nest reports needs_input', state: 'needs_input', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: false },
    { label: 'Nest reports paused', state: 'paused', turnPhase: undefined, messageCount: 0, hasSetupFailure: false, expected: false }
  ] as const)('optimistic starting decision: $label -> $expected', ({ state, turnPhase, messageCount, hasSetupFailure, expected }) => {
    expect(isSubagentStartingOptimistically({
      subagent: { state, waitingOn: [] },
      turnPhase,
      messageCount,
      hasSetupFailure
    })).toBe(expected)
  })
})

describe('clicking a starting subagent in Nest', () => {
  let host: HTMLDivElement
  let root: Root
  let listSubagents: (threadId: string) => Promise<SubagentSummary[]>
  let onSelectThread: (threadId: string) => Promise<void>

  const parentThread: Thread = {
    id: 'parent-1',
    name: 'Build API',
    createdAt: iso(0),
    updatedAt: iso(0),
    startedAt: iso(0),
    order: 0
  }

  const draftThread: Thread = {
    id: 'draft-1',
    name: 'New Chat',
    createdAt: iso(0),
    updatedAt: iso(0),
    order: 1
  }

  function stubBridge(): void {
    const pending = () => new Promise(() => undefined)
    const section = (overrides: Record<string, unknown>): unknown =>
      new Proxy(overrides, {
        get: (target, key) => {
          if (typeof key !== 'string') return undefined
          if (key in target) return target[key]
          if (key.startsWith('on')) return () => () => undefined
          return () => pending()
        }
      })
    const sections: Record<string, unknown> = {
      threads: section({
        select: (threadId: string) => onSelectThread(threadId)
      }),
      subagents: section({
        list: (threadId: string) => listSubagents(threadId),
        onUpdated: () => () => undefined
      }),
      orchestrator: section({
        isTurnActive: async () => false,
        getMessages: async () => [],
        getContextUsage: async () => ({ percent: 0, used: 0, limit: 0, modelName: null, source: 'estimated', categories: [] })
      }),
      skills: section({ list: async () => ({ skills: [] }) }),
      settings: section({ getOptions: async () => ({ llmProviders: [] }), get: async () => getDefaultSettings() }),
      queue: section({ list: async () => [] })
    }
    ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (!(key in target)) target[key] = section({})
        return target[key]
      }
    })
  }

  async function settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    listSubagents = async () => []
    onSelectThread = async (threadId: string) => {
      // Simulate daemon replying with an empty transcript before the subagent's turn starts internally.
      useAppStore.getState().applyThreadView({ threadId, messages: [], agents: [], tasks: [] })
    }
    stubBridge()
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      profileId: 'prf_test',
      profileReady: true,
      workspaceReady: true,
      loading: false,
      newChatAnimations: true,
      activeThreadId: 'parent-1',
      transcriptPending: false,
      threads: [parentThread, draftThread],
      messages: [{ id: 'p-msg-1', role: 'user', content: 'Review the API', timestamp: iso(0) } as ChatMessage],
      turnStates: {},
      threadActivity: {},
      subagentsByParent: {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(useAppStore.getInitialState())
    vi.unstubAllGlobals()
  })

  async function mountWorkspace() {
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    function Workspace() {
      const activeThreadId = useAppStore((s) => s.activeThreadId)
      return createElement(Fragment, null,
        createElement(OrchestratorChat),
        createElement('aside', null, createElement(LineageSection, { threadId: activeThreadId, projectId: null })))
    }
    await act(async () => { root.render(createElement(Workspace)) })
    await settle()
  }

  it('shows Working + Starting… and SubagentParentBar instead of the new-chat screen even before threads:updated or turnState arrive', async () => {
    const summary = makeSubagentSummary({ childThreadId: 'sub-1', title: 'API reviewer', state: 'queued', activity: 'queued' })
    listSubagents = async (id) => (id === 'parent-1' ? [summary] : [])
    useAppStore.getState().setSubagents('parent-1', [summary])

    await mountWorkspace()

    // Click the subagent in Nest before `threads:updated` even lists `sub-1` and before any turnState exists.
    const row = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('API reviewer'))
    expect(row).toBeDefined()
    await act(async () => { row!.click() })
    await settle()

    expect(useAppStore.getState().activeThreadId).toBe('sub-1')
    // Must NEVER render the new-chat empty screen or its logo/glow/new-thread settings.
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.chat-empty-logo')).toBeNull()
    expect(host.querySelector('.ambient-glow')).toBeNull()
    expect(host.querySelector('.new-thread-row')).toBeNull()
    // Must immediately show SubagentParentBar identifying its parent.
    expect(host.querySelector('.subagent-parent-bar')?.textContent).toContain('Subagent of Build API')
    // Must optimistically show Working + Starting… in the transcript.
    expect(host.querySelector('.turn-work-label')?.textContent).toMatch(/^Working/)
    expect(host.querySelector('[data-turn-progress="starting"]')?.textContent).toContain('Starting…')

    // Once the subagent's real first prompt arrives, the starting placeholder hands off cleanly to the turn row.
    await act(async () => {
      useAppStore.getState().setTurnState({ threadId: 'sub-1', turnId: 'run:1', phase: 'thinking', step: { kind: 'starting' }, startedAt: iso(1), updatedAt: iso(1) })
      useAppStore.getState().addMessage({ id: 'sub-msg-1', role: 'user', content: 'Review the API endpoints', timestamp: iso(1) } as ChatMessage)
    })
    await settle()

    expect(host.querySelector('[data-turn-key="__starting__"]')).toBeNull()
    expect(host.querySelectorAll('.turn-work-label')).toHaveLength(1)
    expect(host.querySelector('.turn-work-label')?.textContent).toMatch(/^Working/)
    expect(host.textContent).toContain('Review the API endpoints')
  })

  it('clears optimistic Working when the subagent stops before producing messages, without flashing the new-chat screen', async () => {
    const childThread: Thread = {
      id: 'sub-2',
      name: 'Stopped reviewer',
      createdAt: iso(0),
      updatedAt: iso(0),
      startedAt: iso(0),
      order: 0,
      lineage: { parentThreadId: 'parent-1', rootThreadId: 'parent-1', relationship: 'subagent' }
    }
    const starting = makeSubagentSummary({ childThreadId: 'sub-2', title: 'Stopped reviewer', state: 'starting', activity: 'starting' })
    const stopped = makeSubagentSummary({ childThreadId: 'sub-2', title: 'Stopped reviewer', state: 'stopped', activity: 'idle' })
    let current = starting
    listSubagents = async (id) => (id === 'parent-1' ? [current] : [])
    useAppStore.setState({ threads: [parentThread, childThread, draftThread] })
    useAppStore.getState().setSubagents('parent-1', [starting])

    await mountWorkspace()

    const row = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('Stopped reviewer'))
    await act(async () => { row!.click() })
    await settle()

    expect(host.querySelector('.turn-work-label')?.textContent).toMatch(/^Working/)
    expect(host.querySelector('.chat--empty')).toBeNull()

    // Subagent is cancelled/stopped before writing any messages.
    current = stopped
    await act(async () => {
      useAppStore.getState().setSubagents('parent-1', [stopped])
    })
    await settle()

    expect(host.querySelector('.turn-work-label')).toBeNull()
    expect(host.querySelector('[data-turn-progress]')).toBeNull()
    // Still never falls back to the new-chat empty screen for a subagent thread.
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.chat-empty-logo')).toBeNull()
    expect(host.querySelector('.subagent-parent-bar')?.textContent).toContain('Subagent of Build API')
  })

  it('shows optimistic Working when opening a starting remote subagent by computer.ref', async () => {
    const remoteSummary = makeSubagentSummary({
      childThreadId: 'sub-remote-standin',
      title: 'Mac runner',
      state: 'starting',
      activity: 'starting',
      computer: { node: 'mac-mini', name: 'Mac Mini', online: true, ref: 'mac-mini:thread-99' }
    })
    listSubagents = async (id) => (id === 'parent-1' ? [remoteSummary] : [])
    useAppStore.getState().setSubagents('parent-1', [remoteSummary])

    await mountWorkspace()

    const row = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('Mac runner'))
    await act(async () => { row!.click() })
    await settle()

    expect(useAppStore.getState().activeThreadId).toBe('mac-mini:thread-99')
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.turn-work-label')?.textContent).toMatch(/^Working/)
    expect(host.querySelector('[data-turn-progress="starting"]')?.textContent).toContain('Starting…')
  })

  it('still shows the empty new-chat screen when opening an ordinary draft thread', async () => {
    await mountWorkspace()
    const { selectThread } = await import('../../src/renderer/lib/threadActions')
    await act(async () => { await selectThread('draft-1') })
    await settle()

    expect(useAppStore.getState().activeThreadId).toBe('draft-1')
    expect(host.querySelector('.chat--empty')).not.toBeNull()
    expect(host.querySelector('.chat-empty-logo')).not.toBeNull()
  })
})
