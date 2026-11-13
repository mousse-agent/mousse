// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages } from '../../src/renderer/components/QueuedMessages'
import { useThreadQueue } from '../../src/renderer/hooks/useThreadQueue'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const queued = (id: string, content: string, threadId = T): QueuedMessage =>
  ({ id, threadId, content, enqueuedAt: '2026-11-13T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui' }) as QueuedMessage

/** Each message's height (bubble and line) in the fake layout: "tall" ones 200 px, others 60 px. */
const heightOf = (row: Element) => (row.textContent?.includes('tall') ? 200 : 60)

/** A resize observer the test fires by hand, as the browser would after layout. */
const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>()
class FakeResizeObserver {
  private entry: { callback: ResizeObserverCallback; targets: Set<Element> }
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set() }
    observers.add(this.entry)
  }
  observe(target: Element) { this.entry.targets.add(target) }
  unobserve(target: Element) { this.entry.targets.delete(target) }
  disconnect() { this.entry.targets.clear(); observers.delete(this.entry) }
}
/** Runs the observers watching the queue's list, as after a frame's layout. */
const layout = async () => {
  await act(async () => {
    for (const entry of [...observers]) {
      if ([...entry.targets].some((target) => target.classList.contains('queued-messages-list'))) entry.callback([], entry as unknown as ResizeObserver)
    }
  })
}

let host: HTMLDivElement
let transcript: HTMLDivElement
let root: Root
let push: ((event: { threadId: string; items: QueuedMessage[] }) => void) | null
let visibleHeight: number
/** Each test's own thread: a thread's open fold outlives the component. */
let T = 't0'
let threadCount = 0

function Chat({ threadId }: { threadId: string }) {
  const queue = useThreadQueue({ threadId })
  return createElement(QueuedMessages, { queue })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  observers.clear()
  visibleHeight = 900
  T = `t${++threadCount}`
  host = document.createElement('div')
  host.className = 'mousse-chat-shell'
  transcript = document.createElement('div')
  transcript.className = 'an-message-list'
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: () => visibleHeight })
  const content = document.createElement('div')
  transcript.append(content)
  host.append(transcript)
  document.body.append(host)
  root = createRoot(content)
  push = null
  useAppStore.setState({ queueEditDrafts: {}, queueDraftNotices: {} })
  // The fake layout: the list starts at 0 and each message ends where the ones above it add up to.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    let bottom = 0
    if (this.classList.contains('queued-message')) {
      for (const row of this.parentElement!.children) {
        bottom += heightOf(row)
        if (row === this) break
      }
    }
    return { top: 0, bottom, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  ;(window as unknown as { mousse: unknown }).mousse = {
    queue: {
      list: vi.fn(async () => []),
      edit: vi.fn(),
      reorder: vi.fn(),
      remove: vi.fn(async () => null),
      promoteToSteer: vi.fn(async () => ({ ok: true })),
      onUpdated: (listener: typeof push) => { push = listener; return () => { push = null } }
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (threadId = T) => act(() => root.render(createElement(Chat, { threadId })))
const list = async (items: QueuedMessage[], threadId = T) => {
  await act(async () => { push!({ threadId, items }) })
  await layout()
}
const toggle = () => host.querySelector<HTMLButtonElement>('.queued-messages-toggle')
const fold = () => host.querySelector<HTMLElement>('.queued-messages-fold')!
const row = (id: string) => host.querySelector<HTMLElement>(`[data-queued-id="${id}"]`)!
const labelRow = () => host.querySelector('.queued-message-state')?.closest('.queued-message')?.getAttribute('data-queued-id')

const longQueue = () => [queued('a', 'a tall one'), queued('b', 'b tall one'), queued('c', 'c'), queued('d', 'd'), queued('e', 'e')]

describe('a long queue folds to what fits', () => {
  it('shows a queue that fits in full, with no fold line', async () => {
    render()
    await list([queued('a', 'a'), queued('b', 'b'), queued('c', 'c'), queued('d', 'd')])
    expect(toggle()).toBeNull()
    expect(labelRow()).toBe('d')
  })

  it('past a third of the visible transcript, shows the whole messages that fit and "Show all N queued"', async () => {
    render()
    await list(longQueue())
    // 900 px visible: 300 px for the queue; the first tall one fits, the second does not.
    expect(toggle()?.textContent).toBe('Show all 5 queued')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(fold().classList.contains('is-pinned')).toBe(true)
    expect(fold().style.height).toBe('200px')
    expect(labelRow()).toBe('a')
  })

  it('opens and folds again from the line under it', async () => {
    render()
    await list(longQueue())
    await act(async () => { toggle()!.click() })
    await layout()
    expect(toggle()?.textContent).toBe('Show less')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(fold().classList.contains('is-pinned')).toBe(false)
    expect(labelRow()).toBe('e')
    await act(async () => { toggle()!.click() })
    await layout()
    expect(toggle()?.textContent).toBe('Show all 5 queued')
    expect(fold().style.height).toBe('200px')
  })

  it('measures again when the transcript is resized', async () => {
    render()
    await list(longQueue())
    visibleHeight = 1500
    await layout()
    // 500 px: 200 + 200 + 60 fit, the next 60 does not.
    expect(fold().style.height).toBe('460px')
    expect(labelRow()).toBe('c')
    visibleHeight = 3000
    await layout()
    expect(toggle()).toBeNull()
    expect(labelRow()).toBe('e')
  })

  it('leaves out the part of the transcript under the composer', async () => {
    render()
    await list(longQueue())
    visibleHeight = 1500
    host.style.setProperty('--chat-composer-stack', '600px')
    await layout()
    // 900 px visible over the composer: back to one message.
    expect(fold().style.height).toBe('200px')
  })

  it('measures again when messages are added, removed or moved', async () => {
    render()
    await list([queued('c', 'c'), queued('d', 'd')])
    expect(toggle()).toBeNull()
    await list([queued('c', 'c'), queued('d', 'd'), queued('a', 'a tall one')])
    expect(toggle()?.textContent).toBe('Show all 3 queued')
    expect(labelRow()).toBe('d')
    // Moved to the top: 200 + 60 fit, the last 60 does not.
    await list([queued('a', 'a tall one'), queued('c', 'c'), queued('d', 'd')])
    expect(fold().style.height).toBe('260px')
    expect(labelRow()).toBe('c')
    // A removed message (not the first, which stays while its turn starts) makes room.
    await list([queued('a', 'a tall one'), queued('c', 'c')])
    expect(toggle()).toBeNull()
    expect(labelRow()).toBe('c')
  })

  it('keeps a message just added out of sight until it is measured', async () => {
    render()
    await list([queued('c', 'c'), queued('d', 'd')])
    expect(fold().style.height).toBe('120px')
    await act(async () => { push!({ threadId: T, items: [queued('c', 'c'), queued('d', 'd'), queued('a', 'a tall one')] }) })
    // Committed, not yet measured: the list keeps the height it had, so nothing jumps.
    expect(fold().style.height).toBe('120px')
    await layout()
    expect(fold().style.height).toBe('120px')
    expect(toggle()?.textContent).toBe('Show all 3 queued')
  })

  it('opens when a hidden message takes focus', async () => {
    render()
    await list(longQueue())
    await act(async () => { row('d').focus() })
    expect(toggle()?.textContent).toBe('Show less')
  })

  it('opens when the focused message moves past the fold', async () => {
    render()
    await list([queued('c', 'c'), queued('a', 'a tall one'), queued('d', 'd')])
    expect(toggle()?.textContent).toBe('Show all 3 queued')
    await act(async () => { row('c').focus() })
    expect(toggle()?.textContent).toBe('Show all 3 queued')
    // Moved last: it keeps the focus and is now past the fold (200 + 60 fit, its 60 does not).
    await list([queued('a', 'a tall one'), queued('d', 'd'), queued('c', 'c')])
    expect(document.activeElement).toBe(row('c'))
    expect(toggle()?.textContent).toBe('Show less')
  })

  it('keeps a shown message focused without opening', async () => {
    render()
    await list(longQueue())
    await act(async () => { row('a').focus() })
    expect(toggle()?.textContent).toBe('Show all 5 queued')
  })

  it('remembers an open fold for its thread until the queue empties', async () => {
    render()
    await list(longQueue())
    await act(async () => { toggle()!.click() })
    await layout()
    await list(longQueue())
    expect(toggle()?.textContent).toBe('Show less')
    await list([])
    await list(longQueue())
    expect(toggle()?.textContent).toBe('Show all 5 queued')
  })

  it('a thread opened elsewhere stays folded here', async () => {
    const other = `${T}-other`
    render()
    await list(longQueue())
    await act(async () => { toggle()!.click() })
    render(other)
    await list(longQueue().map((item) => ({ ...item, threadId: other })), other)
    expect(toggle()?.textContent).toBe('Show all 5 queued')
    render()
    await list(longQueue())
    expect(toggle()?.textContent).toBe('Show less')
  })
})
