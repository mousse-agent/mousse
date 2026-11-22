// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows the queue and the composer; the transcript it is given is kept for the checks.
const transcript = vi.hoisted(() => ({ messages: [] as Array<{ id: string; role: string; parts?: Array<{ type: string; text?: string }>; metadata?: { steered?: boolean } }> }))
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create, Fragment: Frag } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  const { QueuedMessages } = await import('../../src/renderer/components/QueuedMessages')
  return {
    MousseAgentChatShell: ({ composer, messages, queue }: { composer: never; messages: typeof transcript.messages; queue: never }) => {
      transcript.messages = messages
      return create(ComposerNoticeProvider, null, create(Frag, null, queue ? create(QueuedMessages, { queue }) : null, composer))
    }
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let listeners: Record<string, Array<(payload?: unknown) => void>>
let promoteToSteer: ReturnType<typeof vi.fn>
let orchestrator: Record<string, unknown>

/** `window.mousse` for the chat: `queue.promoteToSteer` answers, `on…` subscriptions are captured; any other call stays pending. */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (name: string, overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        if (key.startsWith('on')) {
          return (listener: (payload?: unknown) => void) => {
            const list = (listeners[`${name}.${key}`] ??= [])
            list.push(listener)
            return () => { list.splice(list.indexOf(listener), 1) }
          }
        }
        return (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    queue: section('queue', { promoteToSteer }),
    orchestrator: section('orchestrator', orchestrator),
    skills: section('skills', { list: () => Promise.resolve({ skills: [] }) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section(key, {})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const queued = (id: string, content: string, patch: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({ id, threadId: 'thread-a', content, enqueuedAt: new Date().toISOString(), order: 1, intent: 'normal', state: 'pending', source: 'gui', ...patch }) as QueuedMessage

/** The daemon's queue list for the thread. */
async function listQueue(items: QueuedMessage[]): Promise<void> {
  await act(async () => { for (const listener of listeners['queue.onUpdated'] ?? []) listener({ threadId: 'thread-a', items }) })
}

async function store() {
  return (await import('../../src/renderer/stores/appStore')).useAppStore
}

/** The transcript as the conversation shows it: each row's words, steered ones marked. */
const shown = () =>
  transcript.messages.map((message) => {
    const text = (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
    return message.role === 'user' && message.metadata?.steered ? `steer: ${text}` : text
  }).filter(Boolean)
const queueRows = () => [...host.querySelectorAll<HTMLElement>('.queued-message')]
const row = (id: string) => host.querySelector<HTMLElement>(`[data-queued-id="${id}"]`)

const earlier = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

// The chat is large: loaded once, before the first test's clock starts.
beforeAll(async () => { await import('../../src/renderer/components/OrchestratorChat') }, 120_000)

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  listeners = {}
  promoteToSteer = vi.fn(async () => ({ ok: true }))
  orchestrator = {}
  const useAppStore = await store()
  // The previous turn has finished; a new turn of the thread (a subagent's result woke it) is being set up, so the
  // thread has no running turn yet.
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, threadActivity: {},
    turnStates: { 'thread-a': { phase: 'completed', turnId: 'run-1' } } as never,
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: earlier(120), updatedAt: earlier(60), startedAt: earlier(120), order: 0 }] as never,
    messages: [
      { id: 'p-1', role: 'user', content: 'Fix the bug', timestamp: earlier(120), turnId: 'run-1' },
      { id: 'r-1', role: 'assistant', content: 'Fixed it.', timestamp: earlier(60), turnId: 'run-1' }
    ] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(Fragment, null, createElement(OrchestratorChat))))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('a queued message sent now while the next turn is still being set up', () => {
  it('shows an already promoted message when the thread opens and steers the next message with the shortcut', async () => {
    const useAppStore = await store()
    await act(async () => { useAppStore.setState({ turnStates: { 'thread-a': { phase: 'queued', turnId: 'run-4' } } as never }) })
    await listQueue([queued('q-1', 'one', { sendsNext: true }), queued('q-2', 'two')])
    expect(row('q-1')?.textContent).toContain('Sends next')
    expect(row('q-1')?.querySelector<HTMLButtonElement>('.queued-message-send')?.disabled).toBe(true)
    const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(promoteToSteer).toHaveBeenCalledExactlyOnceWith('thread-a', 'q-2')
  })

  it('says so when its turn ended before it could join: an ordinary queued message again, that can be sent now', async () => {
    await listQueue([queued('q-1', 'one', { steerMissed: true }), queued('q-2', 'two')])
    expect(row('q-1')?.textContent).toContain('Not steered')
    expect(row('q-1')?.textContent).not.toContain('Sends next')
    expect(row('q-1')?.querySelector<HTMLButtonElement>('.queued-message-send')?.disabled).toBe(false)
  })

  it('waits first in the queue, never in the finished reply, and shows in the new turn once it runs', async () => {
    await listQueue([queued('q-1', 'is it still running ?')])
    await act(async () => { row('q-1')!.querySelector<HTMLButtonElement>('.queued-message-send')!.click() })
    await settle()

    expect(promoteToSteer).toHaveBeenCalledWith('thread-a', 'q-1')
    // Not inside the previous turn's finished reply: it is still in the queue, marked as going next.
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])
    expect(queueRows().map((item) => item.dataset.queuedId)).toEqual(['q-1'])
    expect(row('q-1')!.textContent).toContain('Sends next')
    expect(row('q-1')!.querySelector<HTMLButtonElement>('.queued-message-send')!.disabled).toBe(true)

    // The daemon lists it first while the turn is set up; nothing changes, however long that takes.
    await listQueue([queued('q-1', 'is it still running ?')])
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])
    expect(queueRows().map((item) => item.dataset.queuedId)).toEqual(['q-1'])

    // The turn runs: its prompt is in the transcript, and the daemon hands the message to it.
    const useAppStore = await store()
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'p-4', role: 'user', content: 'Subagent finished', timestamp: new Date().toISOString(), turnId: 'run-4' } as never)
      useAppStore.setState({ turnStates: { 'thread-a': { phase: 'thinking', turnId: 'run-4' } } as never })
    })
    await listQueue([queued('q-1', 'is it still running ?', { intent: 'steer', state: 'steering' })])
    await settle()
    // In the new turn, after its prompt, and no longer in the queue.
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.', 'Subagent finished', 'steer: is it still running ?'])
    expect(queueRows()).toEqual([])

    // Its copy in the turn arrives: shown once.
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'echo-1', role: 'user', content: 'is it still running ?', timestamp: new Date(Date.now() + 1000).toISOString(), steered: true, steerItemId: 'q-1' } as never)
    })
    await listQueue([])
    await settle()
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.', 'Subagent finished', 'steer: is it still running ?'])
    expect(queueRows()).toEqual([])
  })

  it('stays an ordinary queued message, first, when the turn is stopped before it runs', async () => {
    const useAppStore = await store()
    // The turn being set up shows as queued.
    await act(async () => { useAppStore.setState({ turnStates: { 'thread-a': { phase: 'queued', turnId: 'run-4' } } as never }) })
    await listQueue([queued('q-1', 'one'), queued('q-2', 'two')])
    await act(async () => { row('q-2')!.querySelector<HTMLButtonElement>('.queued-message-send')!.click() })
    await listQueue([queued('q-2', 'two'), queued('q-1', 'one')])
    await settle()
    expect(row('q-2')!.textContent).toContain('Sends next')
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])

    // Stopped while set up: the thread is idle again and the message waits, first, for the person.
    await act(async () => { useAppStore.setState({ turnStates: { 'thread-a': { phase: 'idle' } } as never }) })
    await settle()
    expect(queueRows().map((item) => item.dataset.queuedId)).toEqual(['q-2', 'q-1'])
    expect(row('q-2')!.textContent).not.toContain('Sends next')
    expect(row('q-2')!.querySelector<HTMLButtonElement>('.queued-message-send')!.disabled).toBe(false)
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])
  })

  it('runs as a turn of its own when the thread has nothing running by then: its prompt shows once, not as a steer', async () => {
    await listQueue([queued('q-1', 'next thing')])
    await act(async () => { row('q-1')!.querySelector<HTMLButtonElement>('.queued-message-send')!.click() })
    await settle()
    expect(row('q-1')!.textContent).toContain('Sends next')
    // The daemon takes it for its turn: its prompt is in the transcript.
    const useAppStore = await store()
    await listQueue([])
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'p-5', role: 'user', content: 'next thing', timestamp: new Date().toISOString(), turnId: 'run-5', queueItemId: 'q-1' } as never)
      useAppStore.setState({ turnStates: { 'thread-a': { phase: 'thinking', turnId: 'run-5' } } as never })
    })
    await settle()
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.', 'next thing'])
    expect(queueRows()).toEqual([])
  })

  it('is no longer marked when Send now is refused', async () => {
    promoteToSteer.mockResolvedValueOnce({ ok: false })
    await listQueue([queued('q-1', 'one')])
    await act(async () => { row('q-1')!.querySelector<HTMLButtonElement>('.queued-message-send')!.click() })
    await settle()
    expect(queueRows().map((item) => item.dataset.queuedId)).toEqual(['q-1'])
    expect(row('q-1')!.textContent).not.toContain('Sends next')
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])
  })

  it('from the composer (Ctrl+Enter) while the turn shows as set up: queued, marked as sending next, never in the finished reply', async () => {
    const useAppStore = await store()
    await act(async () => { useAppStore.setState({ turnStates: { 'thread-a': { phase: 'queued', turnId: 'run-4' } } as never }) })
    await settle()
    // The send carries the intended run while the turn is still setting up.
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => false)
    const queueItem = queued('q-7', 'use the id', { sendsNext: true })
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [], queued: true, queueItem }))
    const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'use the id')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    await settle()
    await listQueue([queueItem])
    await settle()

    expect(orchestrator.steer).not.toHaveBeenCalled()
    expect(orchestrator.sendToThread).toHaveBeenCalledWith('thread-a', expect.objectContaining({ content: 'use the id', steer: true, steerRunId: 'run-4' }))
    expect(promoteToSteer).not.toHaveBeenCalled()
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.'])
    expect(queueRows().map((item) => item.dataset.queuedId)).toEqual(['q-7'])
    expect(row('q-7')!.textContent).toContain('Sends next')
  })

  it('goes into a running reply from the click, as before', async () => {
    const useAppStore = await store()
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'p-4', role: 'user', content: 'Next task', timestamp: new Date().toISOString(), turnId: 'run-4' } as never)
      useAppStore.setState({ turnStates: { 'thread-a': { phase: 'tool_running', turnId: 'run-4' } } as never })
    })
    await listQueue([queued('q-1', 'use the id')])
    await act(async () => { row('q-1')!.querySelector<HTMLButtonElement>('.queued-message-send')!.click() })
    await settle()
    expect(shown()).toEqual(['Fix the bug', 'Fixed it.', 'Next task', 'steer: use the id'])
    expect(queueRows()).toEqual([])
  })
})
