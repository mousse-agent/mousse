// @vitest-environment jsdom
/**
 * Pushes other than text that arrive while a reply streams: the threads' activity, the turn's state and snapshots
 * (of every thread's turn, and of the transcript). Each renders only what shows its data: the line under Working, the
 * status of the streaming thread's row. The chat, the transcript, its turns and the sidebar's rows stay as they are.
 *
 * Rows are counted through the computer badge each of them draws (on the worktree line of its card), and the chat
 * through its shell, so the counts need nothing from the components they measure.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import type { ChatMessage, Project, Thread, ThreadActivitySnapshot, TurnState, TurnStateSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Renders of each sidebar row (by thread id) and of the chat, while a test counts. */
const rowRenders: Record<string, number> = {}
let chatRenders = 0

vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/ComputerBadge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/components/ComputerBadge')>()
  const { createElement: create } = await import('react')
  return {
    ...actual,
    ThreadComputerBadge: (props: Parameters<typeof actual.ThreadComputerBadge>[0]) => {
      const id = (props.thread as { id?: string }).id
      if (id) rowRenders[id] = (rowRenders[id] ?? 0) + 1
      return create(actual.ThreadComputerBadge, props)
    }
  }
})
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/chat/components/MousseAgentChatShell')>()
  const { createElement: create } = await import('react')
  return {
    ...actual,
    MousseAgentChatShell: (props: Parameters<typeof actual.MousseAgentChatShell>[0]) => {
      chatRenders += 1
      return create(actual.MousseAgentChatShell, props)
    }
  }
})

let root: Root
let host: HTMLElement

/** `window.mousse` with every call pending and every subscription inert, like a slow service. */
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
  const sections: Record<string, unknown> = { skills: section({ list: () => Promise.resolve({ skills: [] }) }) }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + n * 1000).toISOString()
const project: Project = { id: 'p1', name: 'Mousse', path: '/p/mousse', createdAt: at(0), order: 0 } as Project
// A worktree thread in a project whose new threads use its folder: each card draws its worktree line.
const thread = (id: string, name: string): Thread =>
  ({ id, name, projectId: 'p1', worktreeEnabled: true, createdAt: at(0), updatedAt: at(1), startedAt: at(0), order: 0 }) as Thread
const user = (id: string, n: number, content: string): ChatMessage => ({ id, role: 'user', content, timestamp: at(n), turnId: `t-${id}` })
const assistant = (id: string, n: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, timestamp: at(n), ...extra })

/** Six finished turns, then a reply streaming in. Fresh objects each time, as a snapshot from the service brings them. */
function transcript(): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < 6; i += 1) {
    out.push(user(`u${i}`, i * 2, `Question ${i}`))
    out.push(assistant(`a${i}`, i * 2 + 1, `Answer ${i}`))
  }
  out.push(user('live', 20, 'And now?'))
  out.push(assistant('reply', 21, 'The reply so far', { streaming: true }))
  return out
}

const turn = (over: Partial<TurnState> = {}): TurnState =>
  ({ threadId: 'live-thread', turnId: 'turn-1', phase: 'streaming', startedAt: at(20), updatedAt: at(21), ...over }) as TurnState
const idle = (threadId: string): TurnState => ({ threadId, turnId: null, phase: 'idle', updatedAt: at(1) }) as TurnState
/** Every thread's activity, as each activity push carries it. */
const activity = (live: ThreadActivitySnapshot[string] = 'processing'): ThreadActivitySnapshot =>
  ({ 'live-thread': live, 'other-a': 'completed', 'other-b': 'idle' })
const withoutIdle = (map: ThreadActivitySnapshot): ThreadActivitySnapshot =>
  Object.fromEntries(Object.entries(map).filter(([, state]) => state !== 'idle'))
/** Every thread's turn, as each turn push carries it next to the one that changed. */
const turns = (live: TurnState): TurnStateSnapshot => ({ 'live-thread': live, 'other-a': idle('other-a'), 'other-b': idle('other-b') })

async function store() {
  return (await import('../../src/renderer/stores/appStore')).useAppStore
}

const listed = (): Thread[] => [thread('live-thread', 'Streaming now'), thread('other-a', 'Finished one'), thread('other-b', 'Quiet one')]

/** The sidebar's Threads tab (or `view`) with three threads (or `threads`) beside the chat of the one whose reply streams. */
async function mount(options: { view?: 'threads' | 'projects'; threads?: Thread[]; activity?: ThreadActivitySnapshot; messages?: ChatMessage[]; turn?: TurnState } = {}): Promise<void> {
  stubBridge()
  const useAppStore = await store()
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'live-thread',
    threadsSidebarView: options.view ?? 'threads',
    newThreadWorktree: false,
    projects: [project],
    threads: options.threads ?? listed(),
    messages: options.messages ?? transcript(),
    threadActivity: {},
    turnStates: turns(options.turn ?? turn()),
    stopRequests: {}
  })
  useAppStore.getState().setThreadActivity(options.activity ?? activity())
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
  await act(async () => root.render(createElement('div', null, createElement(ThreadsSidebar), createElement(OrchestratorChat))))
  await settle()
}

/** Applies `push` as the window does, and returns what rendered for it. */
async function counted(push: () => void) {
  for (const key of Object.keys(rowRenders)) delete rowRenders[key]
  chatRenders = 0
  const counts = startRenderCounts()
  await act(async () => push())
  await settle(2)
  stopRenderCounts()
  return { counts, rows: { ...rowRenders }, chat: chatRenders }
}

/** Nothing of the chat or the transcript rendered, and no row of the sidebar. */
function expectTranscriptAndRowsStill(result: Awaited<ReturnType<typeof counted>>) {
  expect(result.chat).toBe(0)
  expect(result.counts.MessageList ?? 0).toBe(0)
  expect(result.counts.TurnRow ?? 0).toBe(0)
  expect(result.counts.AssistantParts ?? 0).toBe(0)
  expect(result.rows).toEqual({})
}

const progressLine = () => host.querySelector<HTMLElement>('[data-turn-progress]')
const card = (threadId: string) => host.querySelector<HTMLElement>(`.threads-sidebar-card[data-thread-id="${threadId}"]`)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  stopRenderCounts()
  setReplyPacing(true)
  vi.unstubAllGlobals()
})

describe('pushes other than text while a reply streams', () => {
  it('a thread-activity push renders no row, the chat or the transcript; a Working to Waiting swap renders that row\'s status only', async () => {
    await mount()
    const useAppStore = await store()
    // Every thread's activity again, unchanged, in both forms the window gets for each activity event: the service's
    // map, which lists idle threads, and the window's own, which leaves them out.
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().setThreadActivity(activity())))
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().setThreadActivity(withoutIdle(activity()))))
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().setThreadActivity(activity())))

    // A tool that only waits: the streaming thread is Waiting for a moment.
    const swapped = await counted(() => useAppStore.getState().setThreadActivity(activity('waiting')))
    expectTranscriptAndRowsStill(swapped)
    expect(swapped.counts['SidebarStatus:live-thread']).toBeGreaterThan(0)
    expect(swapped.counts['SidebarStatus:other-a'] ?? 0).toBe(0)
    expect(card('live-thread')?.textContent).toContain('Waiting')
    expect(card('live-thread')?.textContent).not.toContain('Working')

    const back = await counted(() => useAppStore.getState().setThreadActivity(activity('processing')))
    expectTranscriptAndRowsStill(back)
    expect(card('live-thread')?.textContent).toContain('Working')
  })

  it('a turn-state push renders the line under Working only', async () => {
    await mount()
    const useAppStore = await store()
    expect(progressLine()?.dataset.turnProgress).toBe('writing')
    // The service sends every thread's turn and then the one that changed, both new objects.
    const push = (state: TurnState) => () => {
      useAppStore.getState().setTurnSnapshot(turns(state))
      useAppStore.getState().setTurnState(state)
    }
    const tool = await counted(push(turn({ phase: 'tool_running', updatedAt: at(22) })))
    expectTranscriptAndRowsStill(tool)
    expect(tool.counts.TurnProgressRow).toBeGreaterThan(0)
    expect(progressLine()?.dataset.turnProgress).toBe('running-tool')

    const retry = await counted(push(turn({ phase: 'streaming', step: { kind: 'retrying', attempt: 2, maxAttempts: 3 }, updatedAt: at(23) })))
    expectTranscriptAndRowsStill(retry)
    expect(progressLine()?.dataset.turnProgress).toBe('retrying')
  })

  it('a snapshot push that repeats what is shown renders nothing', async () => {
    await mount()
    const useAppStore = await store()
    const state = useAppStore.getState()
    // Every thread's turn, as it is.
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().setTurnSnapshot(turns(turn()))))
    // The transcript from the service (a resync, a hydration), as it is shown.
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().applyThreadMessages({ threadId: 'live-thread', messages: transcript() }, 'prf_test')))
    expectTranscriptAndRowsStill(await counted(() => useAppStore.getState().applyThreadView({ threadId: 'live-thread', messages: transcript() } as never)))
    expect(useAppStore.getState().messages).toBe(state.messages)
    expect(useAppStore.getState().turnStates).toBe(state.turnStates)
  })

  it('a push that changes what is shown still shows it', async () => {
    await mount()
    const useAppStore = await store()
    // Another thread finished: its row says so.
    await counted(() => useAppStore.getState().setThreadActivity({ ...activity(), 'other-b': 'completed' }))
    expect(card('other-b')?.textContent).toContain('Done')
    // A snapshot with a new message: the transcript shows it (whole, with reply pacing off).
    setReplyPacing(false)
    const longer = [...transcript(), assistant('more', 22, 'A message the snapshot brought')]
    await counted(() => useAppStore.getState().applyThreadMessages({ threadId: 'live-thread', messages: longer }, 'prf_test'))
    expect(host.textContent).toContain('A message the snapshot brought')
    // The turn ends: the line under Working goes.
    await counted(() => {
      useAppStore.getState().setTurnSnapshot(turns(turn({ phase: 'completed', updatedAt: at(30) })))
      useAppStore.getState().setTurnState(turn({ phase: 'completed', updatedAt: at(30) }))
    })
    expect(progressLine()).toBeNull()
  })

  it('in the Projects tree, a parent row shows its subagent swapping Working and Waiting, and only its status renders for it', async () => {
    const subagent = { ...thread('sub', 'Subagent'), lineage: { parentThreadId: 'live-thread', rootThreadId: 'live-thread', relationship: 'subagent' } } as Thread
    // The parent waits on its subagent, which works: the parent's row rolls that up as Working.
    const tree = (sub: ThreadActivitySnapshot[string], parent: ThreadActivitySnapshot[string] = 'waiting'): ThreadActivitySnapshot =>
      ({ ...activity(parent), sub })
    await mount({ view: 'projects', threads: [...listed(), subagent], activity: tree('processing') })
    const useAppStore = await store()
    const status = (threadId: string) => host.querySelector(`.threads-sidebar-thread[data-thread-id="${threadId}"] .threads-sidebar-status-spinner, .threads-sidebar-thread[data-thread-id="${threadId}"] .threads-sidebar-status-icon`)
    const working = (threadId: string) => status(threadId)?.classList.contains('threads-sidebar-status-spinner')
    const waiting = (threadId: string) => status(threadId)?.getAttribute('aria-label') === 'Agent is waiting'
    // Subagents sit under their parent, not beside it.
    expect(host.querySelector('.threads-sidebar-thread[data-thread-id="sub"]')).toBeNull()
    expect(working('live-thread')).toBe(true)

    // The subagent waits on a tool: the parent's rolled-up activity is Waiting.
    const toWaiting = await counted(() => useAppStore.getState().setThreadActivity(tree('waiting')))
    expect(toWaiting.chat).toBe(0)
    expect(toWaiting.counts.MessageList ?? 0).toBe(0)
    expect(toWaiting.counts['SidebarStatus:live-thread']).toBeGreaterThan(0)
    expect(toWaiting.counts['SidebarStatus:other-a'] ?? 0).toBe(0)
    expect(waiting('live-thread')).toBe(true)

    // It works again: the parent reads Working.
    const toWorking = await counted(() => useAppStore.getState().setThreadActivity(tree('processing')))
    expect(toWorking.counts['SidebarStatus:live-thread']).toBeGreaterThan(0)
    expect(toWorking.counts['SidebarStatus:other-a'] ?? 0).toBe(0)
    expect(working('live-thread')).toBe(true)

    // The subagent finishes and the parent works on its own, then waits: its row follows its own activity.
    await counted(() => useAppStore.getState().setThreadActivity(tree('completed', 'processing')))
    expect(working('live-thread')).toBe(true)
    await counted(() => useAppStore.getState().setThreadActivity(tree('completed', 'waiting')))
    expect(waiting('live-thread')).toBe(true)
  })
})

describe('a thought being written', () => {
  const thought = (content: string): ChatMessage =>
    ({ id: 'th', role: 'system', kind: 'thinking', content: '', timestamp: at(21), thinking: { content, status: 'processing' } })

  it('a streamed delta of the thought renders its row only: no sidebar row, the chat or the transcript', async () => {
    const thinking = [...transcript().slice(0, -1), thought('**Reading the logs**\n\nThe first run')]
    await mount({ messages: thinking, turn: turn({ phase: 'thinking', step: { kind: 'reasoning' } }) })
    const useAppStore = await store()
    const { applyStreamedUpdates } = await import('../../src/renderer/stores/liveTextStore')
    const before = useAppStore.getState().messages
    const delta = await counted(() => {
      const state = useAppStore.getState()
      applyStreamedUpdates([thought('**Reading the logs**\n\nThe first run failed on the cache step')], state.messages, state.updateMessages)
    })
    expectTranscriptAndRowsStill(delta)
    expect(delta.counts.ThreadsSidebar ?? 0).toBe(0)
    expect(delta.counts.ThinkingTool).toBe(1)
    expect(useAppStore.getState().messages).toBe(before)
    expect(host.textContent).toContain('failed on the cache step')
  })
})

describe('the shared clock', () => {
  afterEach(() => { vi.useRealTimers() })

  it('turns 5m into 6m a minute later, and renders only what shows a time', async () => {
    // Only the interval and the date are fake: React and `settle` keep their real timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    // Five minutes after the threads' last update; one thread deletes itself in 30 minutes.
    vi.setSystemTime(Date.parse(at(1)) + 5 * 60_000)
    const expiring = { ...thread('other-a', 'Finished one'), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } as Thread
    await mount({ threads: [thread('live-thread', 'Streaming now'), expiring, thread('other-b', 'Quiet one')] })
    const expiry = () => card('other-a')?.querySelector('.thread-expiry-icon')?.getAttribute('title')
    expect(card('other-b')?.querySelector('.threads-sidebar-card-age')?.textContent).toBe('5m')
    expect(expiry()).toBe('Deletes in 30 minutes')

    const tick = await counted(() => { vi.advanceTimersByTime(60_000) })
    expect(card('other-b')?.querySelector('.threads-sidebar-card-age')?.textContent).toBe('6m')
    expect(expiry()).toBe('Deletes in 29 minutes')
    // The clock renders the statuses and the expiry mark, not the rows, the list or the chat.
    expect(tick.counts['SidebarStatus:other-b']).toBeGreaterThan(0)
    expect(tick.rows).toEqual({})
    expect(tick.counts.ThreadsSidebar ?? 0).toBe(0)
    expect(tick.chat).toBe(0)
  })
})

describe('the store keeps what a push repeats', () => {
  it('keeps the activity map, and each thread\'s turn, that a push repeats', async () => {
    const useAppStore = await store()
    useAppStore.setState({ threadActivity: {}, turnStates: turns(turn()), stopRequests: {} })
    useAppStore.getState().setThreadActivity(activity())
    const held = useAppStore.getState()
    // The same activity, with its idle threads listed or not.
    useAppStore.getState().setThreadActivity(activity())
    useAppStore.getState().setThreadActivity(withoutIdle(activity()))
    expect(useAppStore.getState().threadActivity).toBe(held.threadActivity)
    expect(held.threadActivity).toEqual({ 'live-thread': 'processing', 'other-a': 'completed' })
    useAppStore.getState().setTurnState(turn())
    useAppStore.getState().setTurnSnapshot(turns(turn()))
    expect(useAppStore.getState().turnStates).toBe(held.turnStates)

    // One thread's turn changed: the others keep their objects.
    useAppStore.getState().setTurnSnapshot(turns(turn({ phase: 'tool_running', updatedAt: at(40) })))
    const next = useAppStore.getState().turnStates
    expect(next).not.toBe(held.turnStates)
    expect(next['other-a']).toBe(held.turnStates['other-a'])
    expect(next['live-thread']!.phase).toBe('tool_running')
    // A thread gone from the push is gone from the store.
    useAppStore.getState().setThreadActivity({ 'live-thread': 'processing' })
    expect(useAppStore.getState().threadActivity).toEqual({ 'live-thread': 'processing' })
  })

  it('keeps the thread\'s agents and tasks that a push repeats', async () => {
    const useAppStore = await store()
    useAppStore.setState({ agents: [], tasks: [] })
    const held = useAppStore.getState()
    useAppStore.getState().setAgents([])
    useAppStore.getState().setTasks([])
    expect(useAppStore.getState().agents).toBe(held.agents)
    expect(useAppStore.getState().tasks).toBe(held.tasks)
    const agents = [{ id: 'agent-1', name: 'Reviewer' }] as never
    useAppStore.getState().setAgents(agents)
    expect(useAppStore.getState().agents).toBe(agents)
  })
})
