// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerNoticeProvider,
  ComposerNoticeSlot,
  ComposerNoticeSource,
  ComposerNoticeStore,
  DOCK_FADE_MS,
  QUEUE_REVEAL_MS,
  type ComposerNoticeProps
} from '../../src/renderer/components/ComposerNotice'
import { QueuedMessages } from '../../src/renderer/components/QueuedMessages'
import { ServiceLostNotice, SERVICE_LOST_TITLE } from '../../src/renderer/components/ServiceLostNotice'
import { pausedRunNotice } from '../../src/renderer/chat/components/PausedRunNotice'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-06T10:00:00Z')
const paused: ComposerNoticeProps = pausedRunNotice({
  pause: { runId: 'run:1', until: new Date(NOW + 2 * 3_600_000).toISOString(), estimated: false, autoResume: false },
  now: NOW,
  busy: null,
  error: null,
  onResume: () => undefined,
  onEndPause: () => undefined,
  onDismissError: () => undefined
})
const queued = (id: string, content: string) => ({ id, threadId: 't1', content, enqueuedAt: '2026-11-06T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui' }) as unknown as QueuedMessage

let host: HTMLDivElement
let root: Root
let push: ((event: { threadId: string; items: QueuedMessage[] }) => void) | null

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  push = null
  ;(window as unknown as { mousse: unknown }).mousse = {
    queue: {
      list: vi.fn().mockResolvedValue([]),
      onUpdated: (listener: typeof push) => { push = listener; return () => { push = null } }
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** The composer's dock as OrchestratorChat renders it: the notice slot, then the queue. */
const dock = ({ pause = false, lost = false, optimistic = [] as QueuedMessage[] } = {}) => act(() => root.render(
  createElement(ComposerNoticeProvider, null, createElement(Fragment, null,
    createElement(ComposerNoticeSource, { notice: pause ? paused : null }),
    createElement(ServiceLostNotice, { lost, onReconnect: () => undefined, onDismiss: () => undefined }),
    createElement(ComposerNoticeSlot),
    createElement(QueuedMessages, { threadId: 't1', optimisticItems: optimistic })
  ))
))
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const notices = () => [...host.querySelectorAll('.composer-notice')].map((entry) => (entry.querySelector('.composer-notice-title-full') ?? entry.querySelector('.composer-notice-title'))?.textContent)
const queue = () => host.querySelector<HTMLElement>('.queued-messages')

describe('the dock above the composer', () => {
  it('ranks the lost service over a paused run, then approval, errors, the queue and other info', () => {
    const store = new ComposerNoticeStore()
    store.set('info', { tone: 'info', title: 'Steered' })
    store.setStrip('queue', true)
    expect(store.top()).toBeNull()
    expect(store.stripState('queue')).toBe('shown')
    store.set('error', { tone: 'error', title: 'Send failed' })
    expect(store.top()?.title).toBe('Send failed')
    expect(store.stripState('queue')).toBe('hidden')
    store.set('approval', { tone: 'warning', title: 'Approval', priority: 'approval' })
    expect(store.top()?.title).toBe('Approval')
    store.set('paused', paused)
    expect(store.top()).toBe(paused)
    store.set('service', { tone: 'error', title: 'Service lost', priority: 'service' })
    expect(store.top()?.title).toBe('Service lost')
    store.set('service', null)
    expect(store.top()).toBe(paused)
  })

  it('hides the queue behind a paused run', async () => {
    dock({ pause: true })
    await act(async () => { push!({ threadId: 't1', items: [queued('q1', 'Run the tests next')] }) })
    expect(notices()).toEqual([paused.title])
    expect(queue()).toBeNull()
  })

  it('shows a message sent while paused in the queue for a moment, then the paused run again', async () => {
    dock({ pause: true })
    await act(async () => { push!({ threadId: 't1', items: [queued('q1', 'Run the tests next')] }) })
    // Sending while paused adds the message to the queue.
    dock({ pause: true, optimistic: [queued('optimistic:1', 'Then deploy')] })
    expect(notices()).toEqual([])
    expect(queue()?.textContent).toContain('Then deploy')
    expect(queue()?.classList.contains('is-leaving')).toBe(false)
    await advance(QUEUE_REVEAL_MS - 100)
    expect(queue()).not.toBeNull()
    await advance(100)
    // It fades out, then the paused run comes back.
    expect(queue()?.classList.contains('is-leaving')).toBe(true)
    expect(notices()).toEqual([])
    await advance(DOCK_FADE_MS)
    expect(queue()).toBeNull()
    expect(notices()).toEqual([paused.title])
  })

  it('does not reveal the queue for the list a thread opens with', async () => {
    dock({ pause: true })
    await act(async () => { push!({ threadId: 't1', items: [queued('q1', 'a'), queued('q2', 'b')] }) })
    expect(queue()).toBeNull()
    expect(notices()).toEqual([paused.title])
  })

  it('shows the queue itself when nothing outranks it', async () => {
    dock()
    await act(async () => { push!({ threadId: 't1', items: [queued('q1', 'Run the tests next')] }) })
    expect(notices()).toEqual([])
    expect(queue()?.textContent).toContain('Run the tests next')
  })

  it('puts the lost service over a paused run', async () => {
    dock({ pause: true, lost: true })
    expect(notices()).toEqual([SERVICE_LOST_TITLE])
    dock({ pause: true, lost: false })
    expect(notices()).toEqual([paused.title])
  })
})
