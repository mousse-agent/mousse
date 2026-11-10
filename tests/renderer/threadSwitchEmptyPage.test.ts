// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript itself is not part of this check: the shell shows the composer, where the empty page's headline and logo sit.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let threads: Record<string, unknown>
/** Every paint of the chat while a test watches: whether it was the empty page, and whether the empty logo was in it. */
let frames: Array<{ empty: boolean; logo: boolean }>
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
  frames.push({ empty: Boolean(chat?.classList.contains('chat--empty')), logo: Boolean(host.querySelector('.chat-empty-logo')) })
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
  it('never shows the empty page while a thread with messages loads slowly', async () => {
    await mount()
    expect(host.querySelector('.chat')?.classList.contains('chat--empty')).toBe(false)

    // The select never answers and no view has arrived yet.
    await switchTo('thread-b')
    expect((await store()).getState().activeThreadId).toBe('thread-b')
    expect((await store()).getState().transcriptPending).toBe(true)
    expect(host.querySelector('.chat--empty')).toBeNull()
    expect(host.querySelector('.chat-empty-logo')).toBeNull()
    expect(host.querySelector('.ambient-glow')).toBeNull()

    await deliverView('thread-b', [message('b-1', 'Second thread')])
    expect((await store()).getState().transcriptPending).toBe(false)
    expect(host.querySelector('.chat--empty')).toBeNull()

    // And through another uncached thread for good measure.
    await switchTo('thread-c')
    await deliverView('thread-c', [message('c-1', 'Third thread')])

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter((frame) => frame.empty || frame.logo)).toEqual([])
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
    expect((await store()).getState().transcriptPending).toBe(false)
  })
})
