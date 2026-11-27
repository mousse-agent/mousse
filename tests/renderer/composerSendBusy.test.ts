// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_LOST_RECONNECT, SERVICE_LOST_TITLE } from '../../src/renderer/components/ServiceLostNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer, its notices and what the queue lists.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return {
    MousseAgentChatShell: ({ composer, queue }: { composer: never; queue?: { items: Array<{ id: string; content: string }> } }) =>
      create(ComposerNoticeProvider, null, composer, create('ol', { className: 'test-queue' }, (queue?.items ?? []).map((item) => create('li', { key: item.id }, item.content))))
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let listeners: Record<string, Array<(payload?: unknown) => void>>
let orchestrator: Record<string, unknown>

/** `window.mousse` for the composer: `orchestrator` overrides answer, `on…` subscriptions are captured; any other call stays pending. */
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

async function mount(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

async function send(text: string): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  listeners = {}
  orchestrator = {}
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the composer follows what a send did', () => {
  it('shows a message the service queued in the queue only, not also in the transcript', async () => {
    // The composer was idle when the message was sent, but a turn started meanwhile, so the service queued it.
    let turnRunning = false
    const now = new Date().toISOString()
    orchestrator.sendToThread = vi.fn(async () => {
      turnRunning = true
      return {
        message: '', actions: [], queued: true,
        queueItem: { id: 'queue-1', threadId: 'thread-a', content: 'Second message', mode: 'build', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui' }
      }
    })
    orchestrator.isTurnActive = vi.fn(async () => turnRunning)
    await mount()
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const shown: string[][] = []
    const off = useAppStore.subscribe((state) => { shown.push(state.messages.map((message) => message.id)) })
    await send('Second message')
    off()

    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    // The message was painted in the transcript while the send was on its way, then moved to the queue.
    expect(shown.some((ids) => ids.some((id) => id.startsWith('optimistic:')))).toBe(true)
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(['m-1'])
  })

  it('queues a message sent while the earlier prompt is on its way, before the thread reports its turn', async () => {
    const now = new Date().toISOString()
    // The first prompt's send answers when its turn ends; the second is queued behind it.
    orchestrator.sendToThread = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(async (_thread: string, request: { requestId: string }) => ({
        message: '', actions: [], queued: true,
        queueItem: { id: 'queue-1', threadId: 'thread-a', content: 'Second message', mode: 'build', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui', clientRequestId: request.requestId }
      }))
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await send('First prompt')
    // The thread does not report the turn yet: nothing marks it busy.
    await act(async () => { useAppStore.setState({ loading: false }) })
    const shown: string[][] = []
    const off = useAppStore.subscribe((state) => { shown.push(state.messages.map((message) => message.content)) })
    await send('Second message')
    off()

    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(2)
    // Never painted as a prompt of its own in the transcript: it went to the queue.
    expect(shown.some((contents) => contents.includes('Second message'))).toBe(false)
  })

  it('queues a message sent between two queued turns, while messages still wait in the queue', async () => {
    const now = new Date().toISOString()
    orchestrator.sendToThread = vi.fn(async () => ({
      message: '', actions: [], queued: true,
      queueItem: { id: 'queue-2', threadId: 'thread-a', content: 'Third message', mode: 'build', enqueuedAt: now, order: 2, intent: 'normal', state: 'pending', source: 'gui' }
    }))
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    // The last turn ended and the next queued one has not started: nothing reports a turn, one message waits.
    await act(async () => {
      for (const listener of listeners['queue.onUpdated'] ?? []) {
        listener({ threadId: 'thread-a', items: [{ id: 'queue-1', threadId: 'thread-a', content: 'Second message', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui' }] })
      }
    })
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const shown: string[][] = []
    const off = useAppStore.subscribe((state) => { shown.push(state.messages.map((message) => message.content)) })
    await send('Third message')
    off()

    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    expect(shown.some((contents) => contents.includes('Third message'))).toBe(false)
  })

  it('starts a turn for a message sent after a Stop held the queue, and shows it once', async () => {
    const now = new Date().toISOString()
    // The service starts the turn at once; its send answers when that turn ends.
    orchestrator.sendToThread = vi.fn(() => new Promise(() => undefined))
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    // A Stop ended the last turn: the message queued before it waits for the person.
    await act(async () => {
      for (const listener of listeners['queue.onUpdated'] ?? []) {
        listener({ threadId: 'thread-a', items: [{ id: 'queue-1', threadId: 'thread-a', content: 'Held message', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui', heldAfterStop: true }] })
      }
    })
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await send('After the Stop')

    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().messages.map((message) => message.content)).toContain('After the Stop')
    expect([...host.querySelectorAll('.test-queue li')].map((item) => item.textContent)).toEqual(['Held message'])
  })

  it('takes a message painted in the queue out of it when the service started its turn instead', async () => {
    const now = new Date().toISOString()
    orchestrator.sendToThread = vi.fn(() => new Promise(() => undefined))
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    // The window still lists a message waiting in the queue, so the send is painted there.
    await act(async () => {
      for (const listener of listeners['queue.onUpdated'] ?? []) {
        listener({ threadId: 'thread-a', items: [{ id: 'queue-1', threadId: 'thread-a', content: 'Waiting message', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui' }] })
      }
    })
    await send('Sent now')
    const listed = () => [...host.querySelectorAll('.test-queue li')].map((item) => item.textContent)
    expect(listed()).toEqual(['Waiting message', 'Sent now'])

    // The service started it as a turn: the transcript shows it while the send is still on its way.
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await act(async () => {
      useAppStore.setState({ messages: [...useAppStore.getState().messages, { id: 'm-2', role: 'user', content: 'Sent now', timestamp: now }] as never })
    })
    await settle()
    expect(listed()).toEqual(['Waiting message'])
  })

  it('stops showing busy and shows the service notice again when reconnecting fails', async () => {
    orchestrator.retryConnection = vi.fn(async () => { throw new Error('ipc closed') })
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    await act(async () => { for (const listener of listeners['orchestrator.onConnectionFailed'] ?? []) listener({}) })
    await settle()
    expect(host.textContent).toContain(SERVICE_LOST_TITLE)

    const reconnect = host.querySelector<HTMLButtonElement>(`button[aria-label="${SERVICE_LOST_RECONNECT}"]`)!
    await act(async () => { reconnect.click() })
    await settle()

    expect(orchestrator.retryConnection).toHaveBeenCalledWith('thread-a')
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    expect(useAppStore.getState().loading).toBe(false)
    expect(host.textContent).toContain(SERVICE_LOST_TITLE)
  })

  it('tells the subagents only once the thread accepted the message ("Also tell subagents", §2.5)', async () => {
    orchestrator.sendToThread = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'queue_images_full', message: 'Too many images are waiting in this thread.' }, requestAcknowledged: false })
      .mockResolvedValueOnce({ message: 'Done.', actions: [] })
    orchestrator.isTurnActive = vi.fn(async () => false)
    orchestrator.correctSubagents = vi.fn(async () => ({ revisionId: 'revision:1', deliveries: [] }))
    await mount()
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    await act(async () => useAppStore.getState().setSubagents('thread-a', [{
      childThreadId: 'child-1', title: 'Reviewer', activity: 'working', state: 'working', latestDelegationId: 'd-1', unread: false,
      provider: null, model: null, workspace: null, role: null, createdAt: now, updatedAt: now, waitingOn: [], tasks: []
    }] as never))
    const tell = () => host.querySelector<HTMLButtonElement>('.composer-tell-subagents-btn')!
    await act(async () => tell().click())
    await send('Use the v2 API')
    // Refused: the thread never took it, so neither do its subagents.
    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    expect(orchestrator.correctSubagents).not.toHaveBeenCalled()
    await act(async () => tell().click())
    await send('Use the v2 API')
    expect(orchestrator.correctSubagents).toHaveBeenCalledWith('thread-a', 'Use the v2 API', expect.any(String))
  })
})
