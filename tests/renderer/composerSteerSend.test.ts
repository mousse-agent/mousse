// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorResponse, OrchestratorSendRequest, QueuedMessage } from '../../src/shared/types'
import { SERVICE_LOST_RECONNECT, SERVICE_LOST_TITLE } from '../../src/renderer/components/ServiceLostNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows the composer and queue. The transcript it receives is kept for the checks.
const transcript = vi.hoisted(() => ({ messages: [] as Array<{ id: string; role: string; parts?: Array<{ type: string; text?: string }>; metadata?: { steered?: boolean } }> }))
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create, Fragment } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  const { QueuedMessages } = await import('../../src/renderer/components/QueuedMessages')
  return {
    MousseAgentChatShell: ({ composer, messages, queue }: { composer: never; messages: typeof transcript.messages; queue: never }) => {
      transcript.messages = messages
      return create(ComposerNoticeProvider, null, create(Fragment, null, queue ? create(QueuedMessages, { queue }) : null, composer))
    }
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
    skills: section('skills', { list: () => Promise.resolve({ skills: [] }) }),
    // Each inline image also goes as its file: a pasted one is written to a temporary file.
    threads: section('threads', { attachmentPath: async (file: File) => `/tmp/mousse-attachments/${file.name}` }),
    fileDrag: section('fileDrag', { pathOf: () => '' })
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

async function send(text: string, init: KeyboardEventInit = {}): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init })) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  listeners = {}
  orchestrator = {}
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: true, turnStates: {}, threadActivity: {},
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

describe('a steer from the composer', () => {
  // The turn could not take the steer yet (it is still being set up): the message goes with Steer, and the service sends
  // it into the turn. Another thread opened before the send answers changes nothing about it.
  it('goes with its Steer, so the service keeps it for the turn even if another thread opens before the send answers', async () => {
    let answer!: (result: unknown) => void
    const accepted = new Promise((resolve) => { answer = resolve })
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => false)
    orchestrator.sendToThread = vi.fn(() => accepted)
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    const promote = vi.fn(async () => ({ ok: true }))
    bridge.queue.promoteToSteer = promote
    await send('Use the id', { ctrlKey: true })
    expect(orchestrator.sendToThread).toHaveBeenCalledExactlyOnceWith('thread-a', expect.objectContaining({ content: 'Use the id', steer: true }))

    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await act(async () => { useAppStore.getState().switchToThread('thread-b') })
    const queueItem = { id: 'q-first', threadId: 'thread-a', content: 'Use the id', state: 'pending', intent: 'normal', enqueuedAt: new Date().toISOString(), order: 0, sendsNext: true }
    await act(async () => { answer({ message: '', actions: [], queued: true, queueItem, steerApplied: true }) })
    // Nothing more to do here: the service took it, once.
    expect(promote).not.toHaveBeenCalled()
  })

  it('does not send a queue item into a later turn when its intended turn ended', async () => {
    let answer!: (result: unknown) => void
    const accepted = new Promise((resolve) => { answer = resolve })
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => false)
    orchestrator.sendToThread = vi.fn(() => accepted)
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    const promote = vi.fn(async () => ({ ok: true }))
    bridge.queue.promoteToSteer = promote
    await send('Use the id', { ctrlKey: true })

    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await act(async () => { useAppStore.getState().switchToThread('thread-b') })
    const queueItem = { id: 'q-first', threadId: 'thread-a', content: 'Use the id', state: 'pending', intent: 'normal', enqueuedAt: new Date().toISOString(), order: 0 }
    await act(async () => { answer({ message: '', actions: [], queued: true, queueItem }) })
    expect(promote).not.toHaveBeenCalled()
  })

  it('is not sent again when its request gets no answer: the thread is read again, and the text comes back only if it did not arrive', async () => {
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => { throw new Error('reply lost') })
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [], queued: true }))
    orchestrator.send = vi.fn(async () => ({ message: '', actions: [], queued: true }))
    const select = vi.fn(async () => undefined)
    const list = vi.fn(async () => [])
    ;(window as unknown as { mousse: Record<string, unknown> }).mousse = (window as unknown as { mousse: Record<string, unknown> }).mousse
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    bridge.threads.select = select
    bridge.queue.list = list
    await send('Use the id', { ctrlKey: true })
    await settle(20)
    expect(orchestrator.steer).toHaveBeenCalledTimes(1)
    // Never sent a second time as a queued message.
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(orchestrator.send).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith('thread-a')
    // It did not arrive: the text is back in the composer.
    expect(host.querySelector<HTMLTextAreaElement>('.composer-input')!.value).toBe('Use the id')
  })
})

describe('the composer while the thread works with no turn of its own running here', () => {
  /** The thread as the sidebar shows it, while this window has no running turn for it. */
  const showThread = async (activity: 'processing' | 'waiting' | 'completed') => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({ loading: false, turnStates: { 'thread-a': { phase: 'completed', turnId: 'run-1' } } as never, threadActivity: { 'thread-a': activity } })
  }

  it('steers while the thread shows working or waiting (its subagents, a turn ending), and sends as usual once it is done', async () => {
    orchestrator.isTurnActive = vi.fn(async () => false)
    orchestrator.steer = vi.fn(async () => true)
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [] }))
    orchestrator.send = vi.fn(async () => ({ message: '', actions: [] }))
    await showThread('waiting')
    await mount()
    await send('Use the id', { ctrlKey: true })
    expect(orchestrator.steer).toHaveBeenCalledWith('Use the id', 'thread-a')
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()

    await showThread('processing')
    await settle()
    await send('And the name', { ctrlKey: true })
    expect(orchestrator.steer).toHaveBeenLastCalledWith('And the name', 'thread-a')

    // Done: the same keys send a message that starts a turn.
    await showThread('completed')
    await settle()
    await send('Next task', { ctrlKey: true })
    expect(orchestrator.steer).toHaveBeenCalledTimes(2)
    expect((orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls.length + (orchestrator.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})

describe('a steer the running turn could not take', () => {
  it('is said to be queued, not shown as steered, and is not sent again', async () => {
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => 'queued')
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [], queued: true }))
    await mount()
    await send('Use the id', { ctrlKey: true })
    await settle()
    expect(orchestrator.steer).toHaveBeenCalledTimes(1)
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    const { STEER_QUEUED } = await import('../../src/renderer/components/OrchestratorChat')
    expect(host.textContent).toContain(STEER_QUEUED)
    expect(host.querySelector<HTMLTextAreaElement>('.composer-input')!.value).toBe('')
  })
})

describe('a steer with an image', () => {
  it('sends Steer and the image together to the service', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => undefined }))
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => true)
    const queueItem = { id: 'q-shot', threadId: 'thread-a', content: 'Look at this', state: 'steering', intent: 'steer', enqueuedAt: new Date().toISOString(), order: 0 }
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [], queued: true, queueItem, steerApplied: true }))
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    const promoteToSteer = vi.fn(async () => ({ ok: true }))
    bridge.queue.promoteToSteer = promoteToSteer
    bridge.queue.list = vi.fn(async () => [])

    // A screenshot pasted into the composer.
    const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    const shot = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => shot }], files: [], getData: () => '' } })
    await act(async () => { input.dispatchEvent(paste) })
    await settle()
    await send('Look at this', { ctrlKey: true })
    await settle(20)

    // The text-only steer would drop the image: not used.
    expect(orchestrator.steer).not.toHaveBeenCalled()
    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    const [threadId, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { content: string; steer?: boolean; images?: Array<{ mimeType: string; data: string }> }]
    expect(threadId).toBe('thread-a')
    expect(request.content).toMatch(/^Look at this\n\n\[Attached files: /)
    expect(request.images).toEqual([expect.objectContaining({ mimeType: 'image/png', data: 'iVBORw==' })])
    expect(request.steer).toBe(true)
    expect(promoteToSteer).not.toHaveBeenCalled()
  })
})

/** The words of the steered messages the conversation shows. */
const steeredShown = () =>
  transcript.messages
    .filter((message) => message.role === 'user' && message.metadata?.steered)
    .map((message) => (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(''))

describe('a steer on its way into the reply', () => {
  it('shows in the reply from the click, before the service answers, and once when its copy arrives', async () => {
    orchestrator.isTurnActive = vi.fn(async () => true)
    // The thread's turn runs: the transcript's last turn is the one the steer joins.
    const { useAppStore: store } = await import('../../src/renderer/stores/appStore')
    store.setState({ turnStates: { 'thread-a': { phase: 'thinking', turnId: 'run-1' } } as never })
    let answer!: (value: boolean) => void
    orchestrator.steer = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    await mount()
    await send('Use the id', { ctrlKey: true })
    expect(host.querySelector<HTMLTextAreaElement>('.composer-input')!.value).toBe('')
    // The service has not answered: the message is in the reply already, not gone.
    expect(steeredShown()).toEqual(['Use the id'])

    // The copy the service writes into the turn arrives, then the answer: still shown once.
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'echo-1', role: 'user', content: 'Use the id', timestamp: new Date(Date.now() + 1000).toISOString(), steered: true } as never)
    })
    expect(steeredShown()).toEqual(['Use the id'])
    await act(async () => { answer(true) })
    await settle()
    expect(steeredShown()).toEqual(['Use the id'])
    expect(transcript.messages.some((message) => message.id === 'echo-1')).toBe(true)
  })

  it('leaves the reply when the turn could not take it: it is in the queue instead', async () => {
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => 'queued')
    await mount()
    await send('Use the id', { ctrlKey: true })
    await settle()
    expect(steeredShown()).toEqual([])
  })
})

describe('a steer made while a prompt is on its way', () => {
  it('is a steer even before the thread reports the turn running: it joins that turn once it can, not the end of the queue', async () => {
    // The thread had a turn before; the new one is not reported running yet (no turn state, no activity).
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({ loading: false, turnStates: { 'thread-a': { phase: 'completed', turnId: 'run-1' } } as never })
    orchestrator.isTurnActive = vi.fn(async () => false)
    // The turn is still being set up: it takes no steer yet.
    orchestrator.steer = vi.fn(async () => false)
    const queueItem = { id: 'q-steer', threadId: 'thread-a', content: 'Use the id', state: 'pending', intent: 'normal', enqueuedAt: new Date().toISOString(), order: 0, sendsNext: true }
    orchestrator.sendToThread = vi.fn((_thread: string, request: { content: string }) =>
      request.content === 'Use the id' ? Promise.resolve({ message: '', actions: [], queued: true, queueItem, steerApplied: true }) : new Promise(() => undefined))
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    const promoteToSteer = vi.fn(async () => ({ ok: true }))
    bridge.queue.promoteToSteer = promoteToSteer
    bridge.queue.list = vi.fn(async () => [])

    await send('Fix the login bug')
    await send('Use the id', { ctrlKey: true })
    await settle()

    expect(orchestrator.steer).not.toHaveBeenCalled()
    expect(orchestrator.sendToThread).toHaveBeenCalledWith('thread-a', expect.objectContaining({ content: 'Use the id', steer: true }))
    expect(promoteToSteer).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Sends next')
    expect(steeredShown()).toEqual([])
  })
})

it('starts A and B independently and keeps ordinary and Steer sends with A before acknowledgements', async () => {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  const { createAndSelectThread, selectThread } = await import('../../src/renderer/lib/threadActions')
  const now = new Date().toISOString()
  const draft = (id: string) => ({ id, name: 'New Chat', createdAt: now, updatedAt: now, order: 0, settingsRevision: 1, worktreeEnabled: false })
  useAppStore.setState({ threads: [draft('thread-a')], messages: [], loading: false, lastNewThreadProjectId: null })
  const sends: Array<{ threadId: string; request: OrchestratorSendRequest; answer: (response: OrchestratorResponse) => void }> = []
  orchestrator.isTurnActive = vi.fn(async () => false)
  orchestrator.sendToThread = vi.fn((threadId: string, request: OrchestratorSendRequest) =>
    new Promise<OrchestratorResponse>((answer) => sends.push({ threadId, request, answer }))
  )
  orchestrator.steer = vi.fn(async () => false)
  await mount()
  const create = vi.fn(async () => draft('thread-b'))
  window.mousse.threads.create = create
  window.mousse.threads.select = vi.fn(async () => undefined)

  await send('First A')
  await act(async () => { await vi.waitFor(() => expect(sends).toHaveLength(1)) })
  expect(sends[0]).toMatchObject({ threadId: 'thread-a', request: { content: 'First A' } })
  await act(async () => { await createAndSelectThread() })
  expect(create).toHaveBeenCalledOnce()
  expect(useAppStore.getState().activeThreadId).toBe('thread-b')

  await send('First B')
  await act(async () => { await vi.waitFor(() => expect(sends).toHaveLength(2)) })
  expect(sends[1]).toMatchObject({ threadId: 'thread-b', request: { content: 'First B' } })
  await act(async () => useAppStore.setState({ turnStates: {
    'thread-a': { threadId: 'thread-a', phase: 'queued', turnId: 'run-a', updatedAt: now },
    'thread-b': { threadId: 'thread-b', phase: 'queued', turnId: 'run-b', updatedAt: now }
  } }))
  await act(async () => { await selectThread('thread-a') })
  expect(transcript.messages.map((message) => message.parts?.[0]?.text)).toContain('First A')

  // Identical text still represents two different requests with different intent.
  await send('Follow up')
  await send('Follow up', { ctrlKey: true })
  expect(sends.slice(2).map(({ threadId, request }) => [threadId, request.content, request.steerRunId])).toEqual([
    ['thread-a', 'Follow up', undefined], ['thread-a', 'Follow up', 'run-a']
  ])
  expect(sends[2]!.request.requestId).not.toBe(sends[3]!.request.requestId)
  expect(orchestrator.steer).not.toHaveBeenCalled()
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-queued-id]')]
  expect(rows()).toHaveLength(2)
  expect(rows().every((row) => row.textContent?.includes('Follow up'))).toBe(true)
  expect(rows().filter((row) => row.textContent?.includes('Sends next'))).toHaveLength(1)

  await act(async () => { await selectThread('thread-b') })
  expect(rows()).toHaveLength(0)
  expect(transcript.messages.map((message) => message.parts?.[0]?.text)).toContain('First B')
  const saved = sends.slice(2).map(({ request }, index): QueuedMessage => ({
    id: `saved-${index}`, threadId: 'thread-a', clientRequestId: request.requestId, content: request.content,
    state: 'pending', intent: 'normal', enqueuedAt: now, order: index,
    ...(request.steer ? { sendsNext: true } : {})
  }))
  await act(async () => sends.slice(2).forEach(({ answer }, index) => answer({ message: '', actions: [], queued: true, queueItem: saved[index] })))
  await act(async () => { await selectThread('thread-a') })
  expect(rows().map((row) => row.dataset.queuedId)).toEqual(['saved-0', 'saved-1'])
  await act(async () => {
    for (const listener of listeners['queue.onUpdated'] ?? []) listener({ threadId: 'thread-a', items: saved })
  })
  expect(rows().map((row) => row.dataset.queuedId)).toEqual(['saved-0', 'saved-1'])
  expect(rows().filter((row) => row.textContent?.includes('Sends next'))).toHaveLength(1)
})
