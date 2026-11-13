// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows which thread's transcript it was given (its messages' ids) and the composer, where the empty
// page's headline and logo and the new-thread settings sit.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return {
    MousseAgentChatShell: ({ composer, threadId, messages }: { composer: never; threadId: string | null; messages: Array<{ id: string }> }) =>
      create(ComposerNoticeProvider, null,
        create('div', { 'data-shown-thread': threadId ?? '', 'data-shown-messages': messages.map((entry) => entry.id).join(' ') }),
        composer)
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let threads: Record<string, unknown>
/**
 * Every paint of the chat while a test watches: whether it was the empty page, whether the empty logo or the
 * new-thread settings were in it, and the thread and messages it showed.
 */
let frames: Array<{ empty: boolean; logo: boolean; settings: boolean; thread: string; messages: string[] }>
let observer: MutationObserver | undefined
// The store's transcript cache lives for the whole file, so each case uses threads no earlier case left cached.

/** `window.mousse` for the chat: `threads` overrides answer; any other call stays pending, like a slow service. */
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
    skills: section({ list: () => Promise.resolve({ skills: [] }) })
  }
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

function record(): void {
  const chat = host.querySelector('.chat')
  const shown = host.querySelector<HTMLElement>('[data-shown-thread]')
  frames.push({
    empty: Boolean(chat?.classList.contains('chat--empty')),
    logo: Boolean(host.querySelector('.chat-empty-logo')),
    settings: Boolean(host.querySelector('.new-thread-row')),
    thread: shown?.dataset.shownThread ?? '',
    messages: (shown?.dataset.shownMessages ?? '').split(' ').filter(Boolean)
  })
}

/** The thread the chat shows now, and its messages' ids. */
function shownThread(): { thread: string; messages: string } {
  const shown = host.querySelector<HTMLElement>('[data-shown-thread]')
  return { thread: shown?.dataset.shownThread ?? '', messages: shown?.dataset.shownMessages ?? '' }
}

/** Paints that showed a started thread without its own messages: empty, the empty page, new-thread settings, or another thread's messages. */
function framesWithoutOwnMessages(): typeof frames {
  return frames.filter((frame) =>
    frame.empty || frame.logo || frame.settings || frame.messages.length === 0 ||
    frame.messages.some((id) => !id.startsWith(`${frame.thread.replace('thread-', '')}-`)))
}

async function mount(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
  frames = []
  observer = new MutationObserver(record)
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
}

const now = new Date().toISOString()
const message = (id: string, content: string) => ({ id, role: 'user', content, timestamp: now })
const started = (id: string) => ({ id, name: id, createdAt: now, updatedAt: now, startedAt: now, order: 0 })

async function store() {
  return (await import('../../src/renderer/stores/appStore')).useAppStore
}

async function switchTo(threadId: string): Promise<void> {
  const { selectThread } = await import('../../src/renderer/lib/threadActions')
  await act(async () => { void selectThread(threadId).catch(() => undefined) })
  await settle()
}

async function deliverView(threadId: string, messages: unknown[]): Promise<void> {
  const useAppStore = await store()
  await act(async () => { useAppStore.getState().applyThreadView({ threadId, messages, agents: [], tasks: [] } as never) })
  await settle()
}

/** The main process's echo of a selection, which arrives before the thread's view. */
async function deliverSelected(threadId: string): Promise<void> {
  const useAppStore = await store()
  await act(async () => { useAppStore.getState().switchToThread(threadId, { keepWorkspace: true }) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  threads = {}
  frames = []
  const useAppStore = await store()
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a',
    transcriptPending: false,
    threads: [
      started('thread-a'),
      started('thread-b'),
      started('thread-c'),
      started('thread-d'),
      started('thread-e'),
      started('thread-f'),
      started('thread-slow'),
      started('thread-cleared'),
      started('thread-unreachable'),
      { id: 'thread-draft', name: 'New Chat', createdAt: now, updatedAt: now, order: 0 }
    ] as never,
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

describe('switching threads', () => {
  it('shows a started thread outside the cache with its messages in the first paint that shows it', async () => {
    await mount()
    expect(host.querySelector('.chat')?.classList.contains('chat--empty')).toBe(false)

    // The select never answers; main's echo comes first and no view has arrived yet. The chat stays on thread-a.
    await switchTo('thread-b')
    await deliverSelected('thread-b')
    expect(shownThread()).toEqual({ thread: 'thread-a', messages: 'a-1' })

    // The view shows thread-b and its messages together.
    await deliverView('thread-b', [message('b-1', 'Second thread')])
    expect(shownThread()).toEqual({ thread: 'thread-b', messages: 'b-1' })
    expect((await store()).getState()).toMatchObject({ activeThreadId: 'thread-b', openingThreadId: null, transcriptPending: false })

    // And through another uncached thread for good measure.
    await switchTo('thread-c')
    await deliverView('thread-c', [message('c-1', 'Third thread')])

    expect(frames.map((frame) => frame.thread)).toContain('thread-c')
    expect(framesWithoutOwnMessages()).toEqual([])
    expect(host.querySelector('.ambient-glow')).toBeNull()
  })

  it('never shows one thread under another when switching quickly, or going back before the view arrives', async () => {
    await mount()
    // thread-d is held, then thread-e is asked for before thread-d's view: thread-d's late view is dropped.
    await switchTo('thread-d')
    await switchTo('thread-e')
    await deliverView('thread-d', [message('d-1', 'Fourth thread')])
    expect(shownThread()).toEqual({ thread: 'thread-a', messages: 'a-1' })
    await deliverView('thread-e', [message('e-1', 'Fifth thread')])
    expect(shownThread()).toEqual({ thread: 'thread-e', messages: 'e-1' })

    // Back to the thread on screen while thread-f is held: thread-f's view no longer opens it.
    await switchTo('thread-f')
    await switchTo('thread-e')
    await deliverView('thread-f', [message('f-1', 'Sixth thread')])
    expect(shownThread()).toEqual({ thread: 'thread-e', messages: 'e-1' })

    expect(framesWithoutOwnMessages()).toEqual([])
  })

  it('shows a thread whose view is slow after a short wait, without the empty page', async () => {
    await mount()
    await switchTo('thread-slow')
    expect(shownThread()).toEqual({ thread: 'thread-a', messages: 'a-1' })
    const { OPEN_THREAD_HOLD_MS } = await import('../../src/renderer/lib/threadActions')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, OPEN_THREAD_HOLD_MS + 20)) })
    expect((await store()).getState()).toMatchObject({ activeThreadId: 'thread-slow', transcriptPending: true })
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.new-thread-row')).toBeNull()

    await deliverView('thread-slow', [message('slow-1', 'Slow thread')])
    expect(shownThread()).toEqual({ thread: 'thread-slow', messages: 'slow-1' })
    expect(frames.filter((frame) => frame.empty || frame.logo || frame.settings)).toEqual([])
  })

  it('goes straight to a cached thread with no waiting frame', async () => {
    await mount()
    await switchTo('thread-b')
    await deliverView('thread-b', [message('b-1', 'Second thread')])

    // thread-a is cached from when it was left.
    await switchTo('thread-a')
    const useAppStore = await store()
    expect(useAppStore.getState().transcriptPending).toBe(false)
    expect(useAppStore.getState().messages.map((entry) => entry.id)).toEqual(['a-1'])
    expect(frames.filter((frame) => frame.empty || frame.logo)).toEqual([])
  })

  it('shows the empty page for a started thread once its view says it has no messages', async () => {
    await mount()
    await switchTo('thread-cleared')
    expect(host.querySelector('.chat--empty')).toBeNull()

    await deliverView('thread-cleared', [])
    expect(host.querySelector('.chat--empty')).not.toBeNull()
    expect(host.querySelector('.chat-empty-logo')).not.toBeNull()
  })

  it('shows the empty page for a new draft at once, without waiting for its view', async () => {
    await mount()
    await switchTo('thread-draft')
    expect((await store()).getState().transcriptPending).toBe(false)
    expect(host.querySelector('.chat--empty')).not.toBeNull()
    expect(host.querySelector('.chat-empty-logo')).not.toBeNull()
  })

  it('stops waiting when the select fails', async () => {
    threads.select = vi.fn(async () => { throw new Error('service gone') })
    await mount()
    await switchTo('thread-unreachable')
    expect(threads.select).toHaveBeenCalledWith('thread-unreachable')
    expect((await store()).getState()).toMatchObject({ activeThreadId: 'thread-unreachable', transcriptPending: false })
  })
})
