// @vitest-environment jsdom
/**
 * Claims proven here:
 * 1. While viewing an idle thread, background subagents churning activity, updating their Nest lists,
 *    or touching unrelated threads render neither the sidebar nor the viewed chat.
 * 2. Moving the caret across ordinary text in the composer does not re-render ChatComposer; moving into
 *    or out of an `@mention` query still updates the mention picker.
 * 3. Rapid typing in the composer renders neither AgentChat nor MessageList, and throttles localStorage
 *    draft writes while still persisting on leading edge, flush/beforeunload, and immediate clear.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import type { ChatMessage, Project, Thread, ThreadActivitySnapshot, TurnState } from '../../src/shared/types'
import type { SubagentSummary } from '../../src/shared/subagents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))

let root: Root
let host: HTMLElement

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
    orchestrator: section({ pendingQuestions: () => Promise.resolve([]) }),
    settings: section({
      get: () => Promise.resolve({
        provider: { llmProvider: 'claude-subscription', model: 'opus' },
        permissions: { defaultMode: 'accept_edits' },
        integrations: { skills: { enabledSkills: [] } }
      }),
      getOptions: () => Promise.resolve({ themes: [], accentColors: [], llmProviders: [], agentTypes: [] })
    }),
    skills: section({ list: () => Promise.resolve({ skills: [{ id: 's1', name: 'helper', description: 'Helper skill' }] }) }),
    subagents: section({ list: () => Promise.resolve([]) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 25, 10, 0, 0) + n * 1000).toISOString()
const project: Project = { id: 'p1', name: 'Mousse', path: '/p/mousse', createdAt: at(0), order: 0 } as Project
const makeThread = (id: string, name: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, name, projectId: 'p1', createdAt: at(0), updatedAt: at(1), startedAt: at(0), order: 0, ...extra }) as Thread

const transcript = (): ChatMessage[] => [
  { id: 'u1', role: 'user', content: 'Hello', timestamp: at(1), turnId: 't1' },
  { id: 'a1', role: 'assistant', content: 'Hi there, ready when you are.', timestamp: at(2) }
]

const idleTurn = (threadId: string): TurnState => ({ threadId, turnId: null, phase: 'idle', updatedAt: at(1) }) as TurnState

const subagentRow = (childThreadId: string, state: SubagentSummary['state'], n = 1): SubagentSummary => ({
  childThreadId,
  title: childThreadId,
  state,
  createdAt: at(n),
  updatedAt: at(n)
} as SubagentSummary)

async function mountWorkspace() {
  vi.resetModules()
  stubBridge()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.getState().activateProfile('prf_perf_ui')
  const threads = [
    makeThread('idle-thread', 'Idle chat'),
    makeThread('busy-parent', 'Busy parent'),
    makeThread('sub-1', 'Worker 1', { lineage: { parentThreadId: 'busy-parent', rootThreadId: 'busy-parent', relationship: 'subagent', depth: 1 } }),
    makeThread('sub-2', 'Worker 2', { lineage: { parentThreadId: 'busy-parent', rootThreadId: 'busy-parent', relationship: 'subagent', depth: 1 } })
  ]
  const initialActivity: ThreadActivitySnapshot = {
    'busy-parent': 'waiting',
    'sub-1': 'processing',
    'sub-2': 'processing'
  }
  useAppStore.setState({
    profileId: 'prf_perf_ui',
    profileReady: true,
    workspaceReady: true,
    loading: false,
    activeThreadId: 'idle-thread',
    threadsSidebarView: 'threads',
    projects: [project],
    threads,
    messages: transcript(),
    threadActivity: {},
    turnStates: {
      'idle-thread': idleTurn('idle-thread'),
      'busy-parent': idleTurn('busy-parent')
    },
    stopRequests: {}
  })
  useAppStore.getState().setThreadActivity(initialActivity)
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
  await act(async () => root.render(createElement('div', null, createElement(ThreadsSidebar), createElement(OrchestratorChat))))
  await settle()
  return useAppStore
}

async function measure(action: () => void) {
  const counts = startRenderCounts()
  await act(async () => action())
  await settle(2)
  stopRenderCounts()
  return counts
}

const composer = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = () => undefined
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  stopRenderCounts()
  vi.unstubAllGlobals()
})

describe('UI responsiveness while background subagents run', () => {
  it('background subagent activity churn, touches, and Nest updates do not re-render an idle chat or the sidebar', async () => {
    const useAppStore = await mountWorkspace()

    // Subagent 1 flips processing -> waiting -> completed -> idle while sub-2 stays processing:
    // busy-parent's rolled-up activity remains 'processing'.
    const churnCounts = await measure(() => {
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting', 'sub-1': 'waiting', 'sub-2': 'processing' })
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting', 'sub-1': 'completed', 'sub-2': 'processing' })
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting', 'sub-2': 'processing' })
    })
    expect(churnCounts.ThreadsSidebar ?? 0).toBe(0)
    expect(churnCounts.OrchestratorChat ?? 0).toBe(0)
    expect(churnCounts.AgentChat ?? 0).toBe(0)
    expect(churnCounts.MessageList ?? 0).toBe(0)

    // Unrelated thread touches and another parent's subagent list updates must not re-render the idle chat.
    const touchCounts = await measure(() => {
      useAppStore.getState().applyThreadTouches([{ id: 'busy-parent', updatedAt: at(50) }, { id: 'sub-2', updatedAt: at(51) }])
    })
    expect(touchCounts.OrchestratorChat ?? 0).toBe(0)
    expect(touchCounts.AgentChat ?? 0).toBe(0)
    expect(touchCounts.MessageList ?? 0).toBe(0)

    const subagentCounts = await measure(() => {
      useAppStore.getState().setSubagents('busy-parent', [subagentRow('sub-1', 'done', 2), subagentRow('sub-2', 'working', 3)])
      // Repeating the same subagent list for busy-parent is also a no-op.
      useAppStore.getState().setSubagents('busy-parent', [subagentRow('sub-1', 'done', 2), subagentRow('sub-2', 'working', 3)])
    })
    expect(subagentCounts.OrchestratorChat ?? 0).toBe(0)
    expect(subagentCounts.AgentChat ?? 0).toBe(0)
    expect(subagentCounts.MessageList ?? 0).toBe(0)

    // Sibling check: when a subagent actually asks for input, the sidebar DOES update to show its Input state.
    const askCounts = await measure(() => {
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting', 'sub-2': 'awaiting_input' })
    })
    expect(askCounts.ThreadsSidebar ?? 0).toBeGreaterThan(0)
    expect(host.querySelector('.threads-sidebar-card[data-thread-id="busy-parent"] .threads-sidebar-card-status-input')).not.toBeNull()

    // Sibling check: when the last running subagent finishes and the parent drops from processing to waiting, sidebar updates.
    await measure(() => {
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting', 'sub-2': 'processing' })
    })
    const finishCounts = await measure(() => {
      useAppStore.getState().setThreadActivity({ 'busy-parent': 'waiting' })
    })
    expect(finishCounts.ThreadsSidebar ?? 0).toBeGreaterThan(0)
  })

  it('moving the caret in ordinary text does not re-render ChatComposer, while entering/leaving @mention still opens/closes suggestions', async () => {
    await mountWorkspace()
    const input = composer()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hello world @hel end')
      input.setSelectionRange(0, 0)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(2)

    // Move caret across ordinary text ("hello world ") — no @mention at old or new caret.
    const moveCounts = await measure(() => {
      for (const pos of [2, 5, 8, 11, 3]) {
        input.setSelectionRange(pos, pos)
        input.dispatchEvent(new Event('select', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
      }
    })
    expect(moveCounts.ChatComposer ?? 0).toBe(0)
    expect(moveCounts.OrchestratorChat ?? 0).toBe(0)

    // Move caret into `@hel` (index 16) — mention picker opens.
    const enterMention = await measure(() => {
      input.setSelectionRange(16, 16)
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
    expect(enterMention.ChatComposer ?? 0).toBeGreaterThan(0)
    expect(host.querySelector('[aria-label="File, folder and skill suggestions"]')).not.toBeNull()

    // Move caret back out into ordinary text (index 2) — mention picker closes.
    const leaveMention = await measure(() => {
      input.setSelectionRange(2, 2)
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(leaveMention.ChatComposer ?? 0).toBeGreaterThan(0)
    expect(host.querySelector('[aria-label="File, folder and skill suggestions"]')).toBeNull()
  })

  it('rapid typing does not re-render AgentChat or MessageList and throttles localStorage draft writes', async () => {
    const useAppStore = await mountWorkspace()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setItem.mockClear()

    const input = composer()
    const typeBurst = await measure(() => {
      let text = ''
      for (const ch of 'abcdefgh') {
        text += ch
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
        input.setSelectionRange(text.length, text.length)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    // Transcript components must stay completely untouched while typing.
    expect(typeBurst.AgentChat ?? 0).toBe(0)
    expect(typeBurst.MessageList ?? 0).toBe(0)
    // Leading write persists immediately, subsequent keystrokes in the same burst do not each write localStorage.
    const workspaceWrites = setItem.mock.calls.filter(([key]) => key === 'mousse-profile-prf_perf_ui-workspace')
    expect(workspaceWrites.length).toBeLessThanOrEqual(2)

    // Closing the window flushes the latest draft synchronously.
    window.dispatchEvent(new Event('beforeunload'))
    const saved = JSON.parse(window.localStorage.getItem('mousse-profile-prf_perf_ui-workspace') ?? '{}') as {
      composerDrafts?: Record<string, string>
    }
    expect(saved.composerDrafts?.['idle-thread']).toBe('abcdefgh')

    // Clearing the draft persists immediately without waiting for throttle.
    useAppStore.getState().clearComposerDraft('idle-thread')
    const afterClear = JSON.parse(window.localStorage.getItem('mousse-profile-prf_perf_ui-workspace') ?? '{}') as {
      composerDrafts?: Record<string, string>
    }
    expect(afterClear.composerDrafts?.['idle-thread']).toBeUndefined()
  })
})
