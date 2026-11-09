// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages, queuedContentWithText, splitQueuedContent } from '../../src/renderer/components/QueuedMessages'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../../src/renderer/components/ComposerNotice'
import { useThreadQueue, type QueueHold } from '../../src/renderer/hooks/useThreadQueue'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LIST = '1. Run the tests\n2. Fix what fails\n3. Open the PR'
const queued = (id: string, content: string, patch: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({ id, threadId: 't1', content, enqueuedAt: '2026-11-09T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui', ...patch }) as QueuedMessage

let host: HTMLDivElement
let root: Root
let push: ((event: { threadId: string; items: QueuedMessage[] }) => void) | null
/** What the daemon lists. */
let listed: QueuedMessage[]
let api: { list: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn>; reorder: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; promoteToSteer: ReturnType<typeof vi.fn> }

/** The queue as the chat renders it: in the conversation, with its errors in the composer's notice slot. */
function Chat({ hold = null }: { hold?: QueueHold | null }) {
  const thread = useThreadQueue({ threadId: 't1', hold })
  return createElement(Fragment, null,
    createElement(ComposerNoticeSource, { notice: thread.error ? { tone: 'error', title: thread.error, onDismiss: thread.clearError } : null }),
    createElement(ComposerNoticeSlot),
    createElement(QueuedMessages, { queue: thread }))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  push = null
  listed = []
  api = {
    list: vi.fn(async () => listed),
    edit: vi.fn(async (_thread: string, itemId: string, content: string) => queued(itemId, content)),
    reorder: vi.fn(async (_thread: string, ids: string[]) => ids.map((id) => listed.find((item) => item.id === id)!)),
    remove: vi.fn(async () => null),
    promoteToSteer: vi.fn(async () => true)
  }
  ;(window as unknown as { mousse: unknown }).mousse = {
    queue: { ...api, onUpdated: (listener: typeof push) => { push = listener; return () => { push = null } } }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const show = async (items: QueuedMessage[], hold: QueueHold | null = null) => {
  listed = items
  act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(Chat, { hold }))))
  await act(async () => { push!({ threadId: 't1', items }) })
}
const rows = () => [...host.querySelectorAll<HTMLElement>('.queued-message')]
const row = (id: string) => host.querySelector<HTMLElement>(`[data-queued-id="${id}"]`)!
const button = (id: string, label: string) => row(id).querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)
const click = async (element: HTMLElement | null) => { await act(async () => { element!.click() }) }
const key = async (element: HTMLElement, init: KeyboardEventInit) => {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}
const type = async (area: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('queued messages in the conversation', () => {
  it('shows each one as a prompt bubble with its full text, line breaks included', async () => {
    await show([queued('a', LIST), queued('b', 'Then deploy')])
    const texts = rows().map((entry) => entry.querySelector('.chat-user-bubble p')?.textContent)
    expect(texts).toEqual([LIST, 'Then deploy'])
  })

  it('hides the markers the agent reads and keeps them when the text is edited', async () => {
    const content = 'Look at this\n\n[Attached files: notes.txt]'
    expect(splitQueuedContent(content)).toEqual({ text: 'Look at this', markers: '[Attached files: notes.txt]' })
    expect(queuedContentWithText(content, ' Look at that ')).toBe('Look at that\n\n[Attached files: notes.txt]')
    expect(queuedContentWithText('Plain', 'Changed')).toBe('Changed')
    await show([queued('a', content)])
    expect(row('a').querySelector('.chat-user-bubble p')?.textContent).toBe('Look at this')
  })

  it('says "Queued" once, on the last line', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    const labels = [...host.querySelectorAll('.queued-message-state')]
    expect(labels.map((label) => label.textContent)).toEqual(['Queued'])
    expect(row('c').contains(labels[0]!)).toBe(true)
    expect(labels[0]!.getAttribute('title')).toBe('Sends when the current reply ends')
  })

  it('edits in place: Enter saves the new text and the message keeps its place', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    await click(button('b', 'Edit'))
    const area = row('b').querySelector('textarea')!
    expect(area.value).toBe('two')
    expect(document.activeElement).toBe(area)
    await type(area, 'two, but better\nwith a second line')
    await key(area, { key: 'Enter' })
    expect(api.edit).toHaveBeenCalledWith('t1', 'b', 'two, but better\nwith a second line')
    expect(host.querySelector('textarea')).toBeNull()
    expect(rows().map((entry) => entry.dataset.queuedId)).toEqual(['a', 'b', 'c'])
    expect(row('b').querySelector('.chat-user-bubble p')?.textContent).toBe('two, but better\nwith a second line')
  })

  it('adds a line with Shift+Enter instead of saving', async () => {
    await show([queued('a', 'one')])
    await click(button('a', 'Edit'))
    await key(row('a').querySelector('textarea')!, { key: 'Enter', shiftKey: true })
    expect(api.edit).not.toHaveBeenCalled()
    expect(row('a').querySelector('textarea')).not.toBeNull()
  })

  it('cancels an edit with Escape and saves nothing', async () => {
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('a', 'Edit'))
    const area = row('a').querySelector('textarea')!
    await type(area, 'something else')
    await key(area, { key: 'Escape' })
    expect(api.edit).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')).toBeNull()
    expect(row('a').querySelector('.chat-user-bubble p')?.textContent).toBe('one')
  })

  it('keeps the editor open and shows the error when the edit is refused', async () => {
    api.edit.mockRejectedValueOnce(new Error("Error invoking remote method 'queue:edit': Error: Queue item a already started and can no longer be edited."))
    await show([queued('a', 'one')])
    await click(button('a', 'Edit'))
    const area = row('a').querySelector('textarea')!
    await type(area, 'changed')
    await click(button('a', 'Save'))
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('.composer-notice')?.textContent).toContain('already started')
  })

  it('moves a message with Alt+Up and Alt+Down on its grip', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    await key(button('a', 'Reorder')!, { key: 'ArrowDown', altKey: true })
    expect(api.reorder).toHaveBeenLastCalledWith('t1', ['b', 'a', 'c'])
    await key(button('c', 'Reorder')!, { key: 'ArrowUp', altKey: true })
    expect(api.reorder).toHaveBeenLastCalledWith('t1', ['b', 'c', 'a'])
    // Without Alt the arrows do nothing; the first cannot go up.
    await key(button('b', 'Reorder')!, { key: 'ArrowDown' })
    await key(button('b', 'Reorder')!, { key: 'ArrowUp', altKey: true })
    expect(api.reorder).toHaveBeenCalledTimes(2)
  })

  describe('dragging by the grip', () => {
    /** jsdom has no DragEvent; React reads `dataTransfer` off the native event. */
    const fire = async (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: () => undefined, setDragImage: () => undefined, getData: () => '', effectAllowed: 'all', dropEffect: 'move', types: [] }
      })
      await act(async () => { target.dispatchEvent(event) })
    }
    /** Picks `id` up by its grip and holds it over `overId`: the list shows the new order, nothing is saved yet. */
    const pickUp = async (id: string, overId: string) => {
      await fire(button(id, 'Reorder')!, 'pointerdown')
      await fire(row(id), 'dragstart')
      await fire(row(overId), 'dragover')
    }
    const ids = () => rows().map((entry) => entry.dataset.queuedId)

    it('saves the new order when it is dropped on the list', async () => {
      await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
      await pickUp('a', 'c')
      expect(ids()).toEqual(['b', 'c', 'a'])
      expect(api.reorder).not.toHaveBeenCalled()
      await fire(row('c'), 'drop')
      await fire(row('a'), 'dragend')
      expect(api.reorder).toHaveBeenCalledTimes(1)
      expect(api.reorder).toHaveBeenCalledWith('t1', ['b', 'c', 'a'])
      expect(ids()).toEqual(['b', 'c', 'a'])
    })

    it('puts the order back and saves nothing when the drag is cancelled (Escape, or let go outside the list)', async () => {
      await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
      await pickUp('a', 'c')
      expect(ids()).toEqual(['b', 'c', 'a'])
      // No drop on the list: the drag only ends.
      await fire(row('a'), 'dragend')
      expect(api.reorder).not.toHaveBeenCalled()
      expect(ids()).toEqual(['a', 'b', 'c'])
    })
  })

  it('puts the order back when the reorder fails', async () => {
    api.reorder.mockRejectedValueOnce(new Error('nope'))
    await show([queued('a', 'one'), queued('b', 'two')])
    await key(button('a', 'Reorder')!, { key: 'ArrowDown', altKey: true })
    expect(rows().map((entry) => entry.dataset.queuedId)).toEqual(['a', 'b'])
  })

  it('shows the grip only when there is something to reorder', async () => {
    await show([queued('a', 'one')])
    expect(button('a', 'Reorder')).toBeNull()
  })

  it('sends one now and removes one through the queue', async () => {
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('a', 'Send'))
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'a')
    await click(button('b', 'Remove'))
    expect(api.remove).toHaveBeenCalledWith('t1', 'b')
  })

  it('shows a queued subagent result by what it reports, never by the text the model reads, and offers no edit', async () => {
    const notice = [{ delegationId: 'd1', childThreadId: 'a', title: 'API reviewer', runStatus: 'completed', fullyShown: true }]
    await show([queued('n', 'Subagent "API reviewer" (thread a) finished task d1.\nSECRET RESULT', { intent: 'steer', subagentNotice: notice })])
    expect(row('n').textContent).toContain('API reviewer')
    expect(row('n').textContent).not.toContain('SECRET RESULT')
    expect(button('n', 'Edit')).toBeNull()
  })

  it('leaves internal items out', async () => {
    await show([queued('a', 'one'), queued('i', 'wake up', { internal: true })])
    expect(rows().map((entry) => entry.dataset.queuedId)).toEqual(['a'])
  })
})

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('a change that answers after the thread changed', () => {
  /** The chat with a thread switch: the hook stays, the conversation (and its queue) is drawn per thread. */
  function SwitchingChat({ threadId }: { threadId: string }) {
    const thread = useThreadQueue({ threadId })
    return createElement(Fragment, null,
      createElement(ComposerNoticeSource, { notice: thread.error ? { tone: 'error', title: thread.error, onDismiss: thread.clearError } : null }),
      createElement(ComposerNoticeSlot),
      createElement(QueuedMessages, { key: threadId, queue: thread }))
  }
  const open = async (threadId: string, items: QueuedMessage[]) => {
    act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(SwitchingChat, { threadId }))))
    await act(async () => { push!({ threadId, items }) })
  }
  const t1 = [queued('a', 'one'), queued('b', 'two')]
  const t2 = [queued('x', 'other thread', { threadId: 't2' })]
  const ids = () => rows().map((entry) => entry.dataset.queuedId)

  it("leaves the new thread's queue alone when a reorder of the old one is saved late", async () => {
    const answer = deferred<QueuedMessage[]>()
    api.reorder.mockReturnValueOnce(answer.promise)
    await open('t1', t1)
    await key(button('a', 'Reorder')!, { key: 'ArrowDown', altKey: true })
    await open('t2', t2)
    await act(async () => { answer.resolve([t1[1]!, t1[0]!]) })
    expect(ids()).toEqual(['x'])
  })

  it('shows nothing and reloads nothing when a change of the old thread fails late', async () => {
    const reorder = deferred<QueuedMessage[]>()
    const remove = deferred<null>()
    const steer = deferred<boolean>()
    api.reorder.mockReturnValueOnce(reorder.promise)
    api.remove.mockReturnValueOnce(remove.promise)
    api.promoteToSteer.mockReturnValueOnce(steer.promise)
    await open('t1', t1)
    await key(button('a', 'Reorder')!, { key: 'ArrowDown', altKey: true })
    await click(button('b', 'Remove'))
    await click(button('a', 'Send'))
    await open('t2', t2)
    api.list.mockClear()
    await act(async () => {
      reorder.reject(new Error('nope'))
      remove.reject(new Error('nope'))
      steer.resolve(false)
    })
    await act(async () => { await new Promise((done) => setTimeout(done, 200)) })
    expect(ids()).toEqual(['x'])
    expect(host.querySelector('.composer-notice')).toBeNull()
    expect(api.list).not.toHaveBeenCalledWith('t1')
  })

  it("does not put the old thread's messages back when its edit fails late", async () => {
    const answer = deferred<QueuedMessage>()
    api.edit.mockReturnValueOnce(answer.promise)
    await open('t1', t1)
    await click(button('a', 'Edit'))
    await type(row('a').querySelector('textarea')!, 'changed')
    await click(button('a', 'Save'))
    await open('t2', t2)
    await act(async () => { answer.reject(new Error('nope')) })
    expect(ids()).toEqual(['x'])
    expect(host.querySelector('.composer-notice')).toBeNull()
  })

  it("does not reload the old thread over the new one's load", async () => {
    const answer = deferred<QueuedMessage[]>()
    api.reorder.mockReturnValueOnce(answer.promise)
    await open('t1', t1)
    await key(button('a', 'Reorder')!, { key: 'ArrowDown', altKey: true })
    // The new thread has no update yet: its own load fills it.
    listed = t2
    act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(SwitchingChat, { threadId: 't2' }))))
    await act(async () => { answer.reject(new Error('nope')) })
    await act(async () => { await new Promise((done) => setTimeout(done, 200)) })
    expect(api.list).not.toHaveBeenCalledWith('t1')
    expect(api.list).toHaveBeenCalledWith('t2')
    expect(ids()).toEqual(['x'])
  })
})

describe('queued messages while a compaction runs', () => {
  const state = () => host.querySelector<HTMLElement>('.queued-message-state')!

  it('puts a spinner on the one "Queued", which says the messages send after compacting', async () => {
    await show([queued('a', 'one'), queued('b', 'two')], { historyTokens: 182_000 })
    expect(host.querySelectorAll('.queued-message-state')).toHaveLength(1)
    expect(state().textContent).toBe('Queued')
    expect(state().title).toBe('Sends after compacting')
    expect(state().querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('has no spinner once nothing holds the queue', async () => {
    await show([queued('a', 'one')])
    expect(state().title).toBe('Sends when the current reply ends')
    expect(state().querySelector('svg')).toBeNull()
  })

  it('offers to skip compacting on the first message, keeping the full history it names', async () => {
    await show([queued('a', 'one'), queued('b', 'two')], { historyTokens: 182_000 })
    const skip = button('a', 'Send now: skip compacting')!
    expect(skip.title).toBe('Send now: skip compacting and keep the full 182K history')
    expect(skip.getAttribute('aria-label')).toBe(skip.title)
    // The others keep their usual actions.
    expect(button('b', 'Send the queued message now')?.title).toBe('Send now')
    expect(button('b', 'Edit')).not.toBeNull()
    expect(button('b', 'Remove')).not.toBeNull()
    await click(skip)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'a')
  })

  it('leaves the size out when the context is not known', async () => {
    await show([queued('a', 'one')], {})
    expect(button('a', 'Send now: skip compacting')?.title).toBe('Send now: skip compacting and keep the full history')
  })
})
