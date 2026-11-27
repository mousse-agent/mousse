// @vitest-environment jsdom
/**
 * Switching to a thread that is slow to open (issue #1969, slice 2), as a person sees it in the sidebar, the title
 * bar and the chat:
 * - a switch that finishes within OPENING_CUE_MS shows no cue;
 * - a thread still opening after it shows the cue on its row and in the title, without renaming the thread still shown;
 * - a thread of another computer with nothing here is shown then, with "Loading from <computer>…", not held a second;
 * - the thread before's Stop and approval never show under the new thread;
 * - a transcript that cannot be read says "Couldn't reach <computer>" with Retry, never the new-thread page.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingUserQuestions } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows which thread's transcript it was given and the composer it was handed. Every render is kept with
// the approvals it was given to draw in the transcript: a render React draws before effects run is a frame on screen.
const shellRenders: Array<{ threadId: string | null; approvals: number }> = []
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return {
    MousseAgentChatShell: ({ composer, threadId, messages, permissionRequests }: { composer: never; threadId: string | null; messages: Array<{ id: string }>; permissionRequests?: Record<string, unknown> }) => {
      shellRenders.push({ threadId, approvals: Object.keys(permissionRequests ?? {}).length })
      return create(ComposerNoticeProvider, null,
        create('div', { 'data-shown-thread': threadId ?? '', 'data-shown-messages': messages.map((entry) => entry.id).join(' ') }),
        composer)
    }
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const NODE = 'nod_0123456789abcdefghjkmnpqrs'
const REMOTE = `${NODE}:thr_remote`
// The store keeps transcripts it has shown for the whole file: the failure case uses a thread no case has shown.
const UNREACHABLE = `${NODE}:thr_unreachable`
const now = new Date().toISOString()
const started = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Thread ${id}`, createdAt: now, updatedAt: now, startedAt: now, order: 0, ...extra })
const message = (id: string, content: string) => ({ id, role: 'user', content, timestamp: now })
const PROMPT = 'Run npm test?'

let root: Root
let host: HTMLElement
let threads: Record<string, unknown>
let questionListeners: Array<(payload: PendingUserQuestions) => void>
let frames: Array<{ thread: string; text: string; stop: boolean; approve: boolean; empty: boolean }>
let observer: MutationObserver | undefined

/** `window.mousse`: `threads` overrides answer; any other call stays pending, like a slow service. */
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
    threads: section(threads),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    orchestrator: section({
      onQuestionsPending: (listener: (payload: PendingUserQuestions) => void) => { questionListeners.push(listener); return () => undefined },
      approvalRequests: () => Promise.resolve([])
    })
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
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
}

async function store() {
  return (await import('../../src/renderer/stores/appStore')).useAppStore
}

function record(): void {
  const shown = host.querySelector<HTMLElement>('[data-shown-thread]')
  frames.push({
    thread: shown?.dataset.shownThread ?? '',
    text: host.querySelector('.chat')?.textContent ?? '',
    stop: Boolean(host.querySelector('.chat [aria-label="Stop run"]')),
    approve: [...host.querySelectorAll('.chat button')].some((button) => button.textContent?.trim() === 'Approve'),
    empty: Boolean(host.querySelector('.chat--empty'))
  })
}

async function mount(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
  const { TitleBarNav } = await import('../../src/renderer/components/TitleBarNav')
  const { setThreadPathInTitleBar } = await import('../../src/renderer/lib/threadPathSetting')
  setThreadPathInTitleBar(true)
  await act(async () => root.render(createElement(Fragment, null,
    createElement('div', { 'data-area': 'title' }, createElement(TitleBarNav)),
    createElement('div', { 'data-area': 'sidebar' }, createElement(ThreadsSidebar)),
    createElement(OrchestratorChat))))
  await settle()
  frames = []
  observer = new MutationObserver(record)
  observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true })
}

const shownThread = () => host.querySelector<HTMLElement>('[data-shown-thread]')?.dataset.shownThread
const title = () => host.querySelector('[data-area="title"]')?.textContent ?? ''
const row = (threadId: string) => host.querySelector<HTMLElement>(`[data-area="sidebar"] [data-thread-id="${CSS.escape(threadId)}"]`)!
/** The status the row of `threadId` announces while it opens, if any. */
const rowOpening = (threadId: string) => row(threadId).querySelector('[role="status"]')?.getAttribute('aria-label') ?? null
const chatText = () => host.querySelector('.chat')?.textContent ?? ''

async function click(threadId: string): Promise<void> {
  await act(async () => { row(threadId).click() })
}

async function deliverView(threadId: string, messages: unknown[]): Promise<void> {
  const useAppStore = await store()
  await act(async () => { useAppStore.getState().applyThreadView({ threadId, messages, agents: [], tasks: [] } as never) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  threads = {}
  questionListeners = []
  frames = []
  const { useComputersStore } = await import('../../src/renderer/lib/computers')
  useComputersStore.setState({ loaded: true, routed: true, byNode: { [NODE]: { node: NODE, name: 'Mac mini', online: true } as never }, devices: [] })
  const useAppStore = await store()
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, sidebarMode: 'projects',
    threadsSidebarView: 'projects', activeThreadId: 'thread-a', openingThreadId: null, transcriptPending: false,
    transcriptFailed: null, openingCueThreadId: null, projects: [],
    threads: [started('thread-a'), started('thread-local'), started('thread-quick'), started(REMOTE, { node: NODE, name: 'Remote work' }), started(UNREACHABLE, { node: NODE, name: 'Far work' })] as never,
    turnStates: {},
    messages: [message('a-1', 'First thread')] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  observer?.disconnect()
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('opening a thread that is slow to show', () => {
  it('shows no cue when the thread shows within the cue delay', async () => {
    await mount()
    await click('thread-quick')
    await wait(40)
    await deliverView('thread-quick', [message('quick-1', 'Quick')])
    const { OPENING_CUE_MS } = await import('../../src/renderer/lib/threadActions')
    await wait(OPENING_CUE_MS + 30)
    expect(shownThread()).toBe('thread-quick')
    expect(rowOpening('thread-quick')).toBeNull()
    expect(frames.some((frame) => /Opening|Loading/.test(frame.text))).toBe(false)
    expect(title()).not.toMatch(/Opening|Loading/)
  })

  it('marks a held thread of this computer as opening in its row and the title, keeping the shown thread as it was', async () => {
    await mount()
    await click('thread-local')
    expect(rowOpening('thread-local')).toBeNull()
    const { OPENING_CUE_MS } = await import('../../src/renderer/lib/threadActions')
    await wait(OPENING_CUE_MS + 30)
    expect(rowOpening('thread-local')).toBe('Opening Thread thread-local…')
    expect(title()).toContain('Opening Thread thread-local…')
    // The chat still shows the thread before, and the title does not call it by the new thread's name.
    expect(shownThread()).toBe('thread-a')
    expect(title()).not.toMatch(/Thread thread-local(?!…)/)

    await deliverView('thread-local', [message('local-1', 'Local')])
    expect(shownThread()).toBe('thread-local')
    expect(rowOpening('thread-local')).toBeNull()
    expect(title()).not.toContain('Opening')
  })

  it('shows a cold thread of another computer early, waiting with "Loading from <computer>…", then its messages', async () => {
    await mount()
    await click(REMOTE)
    const { OPENING_CUE_MS, OPEN_THREAD_HOLD_MS } = await import('../../src/renderer/lib/threadActions')
    await wait(OPENING_CUE_MS + 30)
    expect(OPENING_CUE_MS + 30).toBeLessThan(OPEN_THREAD_HOLD_MS)
    expect(shownThread()).toBe(REMOTE)
    expect(host.querySelector('.chat [role="status"]')?.textContent).toContain('Loading from Mac mini…')
    expect(rowOpening(REMOTE)).toBe('Loading from Mac mini…')
    expect(title()).toContain('Remote work')
    expect(host.querySelector('.chat--empty')).toBeNull()

    await deliverView(REMOTE, [message('remote-1', 'Remote')])
    expect(host.querySelector<HTMLElement>('[data-shown-thread]')?.dataset.shownMessages).toBe('remote-1')
    expect(chatText()).not.toContain('Loading from')
    expect(rowOpening(REMOTE)).toBeNull()
  })

  it.each([
    ['Stop', 'stop'],
    ['approval', 'approve']
  ] as const)('never shows the thread before\'s %s under the new thread', async (_name, control) => {
    const useAppStore = await store()
    if (control === 'stop') useAppStore.setState({ turnStates: { 'thread-a': { threadId: 'thread-a', turnId: 'run-a', phase: 'streaming', updatedAt: now } } as never })
    await mount()
    if (control === 'approve') {
      await act(async () => {
        for (const listener of questionListeners) listener({
          requestId: 'req-a', threadId: 'thread-a',
          questions: [{ id: 'permission', prompt: PROMPT, options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }],
          approval: { answerPath: 'live' }
        } as never)
      })
      await settle()
    }
    // The control: the thread before shows it.
    record()
    expect(frames.at(-1)?.[control]).toBe(true)
    frames = []
    shellRenders.length = 0

    await click(REMOTE)
    const { OPENING_CUE_MS } = await import('../../src/renderer/lib/threadActions')
    await wait(OPENING_CUE_MS + 30)
    expect(shownThread()).toBe(REMOTE)
    const underNew = frames.filter((frame) => frame.thread === REMOTE)
    expect(underNew.length).toBeGreaterThan(0)
    expect(underNew.filter((frame) => frame[control] || frame.text.includes(PROMPT))).toEqual([])
    expect(shellRenders.filter((render) => render.threadId === REMOTE && render.approvals > 0)).toEqual([])
  })

  it('says it could not reach the computer, with Retry that reads the thread again', async () => {
    let attempt = 0
    threads.select = vi.fn(() => (++attempt === 1 ? Promise.reject(new Error('peer offline')) : new Promise(() => undefined)))
    await mount()
    const { selectThread } = await import('../../src/renderer/lib/threadActions')
    await act(async () => { void selectThread(UNREACHABLE).catch(() => undefined) })
    await settle()
    expect(shownThread()).toBe(UNREACHABLE)
    const alert = host.querySelector('.chat [role="alert"]')
    expect(alert?.textContent).toContain("Couldn't reach Mac mini")
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.new-thread-row')).toBeNull()
    expect(frames.some((frame) => frame.thread === UNREACHABLE && frame.empty)).toBe(false)

    const retry = [...alert!.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'))!
    await act(async () => { retry.click() })
    await settle()
    expect(threads.select).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.chat [role="alert"]')).toBeNull()
    expect(host.querySelector('.chat [role="status"]')?.textContent).toContain('Loading from Mac mini…')

    await deliverView(UNREACHABLE, [message('far-1', 'Far')])
    expect(host.querySelector<HTMLElement>('[data-shown-thread]')?.dataset.shownMessages).toBe('far-1')
    expect(chatText()).not.toMatch(/Loading from|Couldn't reach/)
  })
})
