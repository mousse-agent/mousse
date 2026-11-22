// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages, queuedContentWithText, splitQueuedContent } from '../../src/renderer/components/QueuedMessages'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../../src/renderer/components/ComposerNotice'
import { QUEUE_DRAFT_MOVED_NOTICE, SENT_NOW_HIDE_MS, STARTING_ITEM_HOLD_MS, startingItem, useThreadQueue, withDraftAppended, type QueueHold } from '../../src/renderer/hooks/useThreadQueue'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { withSteersOnTheWay } from '../../src/renderer/lib/steersOnTheWay'
import type { QueuedMessage, Thread } from '../../src/shared/types'
import { agentMessage } from '../../src/mms/run/mcp/appTools/agentMessage'

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
/** What the queue handed to the composer. */
let toComposer: ReturnType<typeof vi.fn>

/** The queue as the chat renders it: in the conversation, with its errors and notes in the composer's notice slot. */
function Chat({ hold = null, lastPromptId = null, lastPromptQueueItemId = null, turnSettingUp = false }: { hold?: QueueHold | null; lastPromptId?: string | null; lastPromptQueueItemId?: string | null; turnSettingUp?: boolean }) {
  const thread = useThreadQueue({ threadId: 't1', hold, onDraftToComposer: toComposer, lastPromptId, lastPromptQueueItemId, turnSettingUp })
  // The reply's steered messages, as the conversation shows them: the transcript with the steers on their way.
  const transcript = useAppStore((state) => state.messages)
  const steered = withSteersOnTheWay(transcript, thread.steersOnTheWay, 't1').filter((message) => message.role === 'user' && message.steered)
  return createElement(Fragment, null,
    createElement('ol', { className: 'reply' }, steered.map((message) => createElement('li', { key: message.id }, message.content))),
    createElement(ComposerNoticeSource, { notice: thread.error ? { tone: 'error', title: thread.error, onDismiss: thread.clearError } : null }),
    createElement(ComposerNoticeSource, { notice: thread.draftMoved ? { tone: 'info', title: QUEUE_DRAFT_MOVED_NOTICE, onDismiss: thread.dismissDraftMoved } : null }),
    createElement(ComposerNoticeSource, { notice: thread.notice ? { tone: 'info', title: thread.notice, onDismiss: thread.clearNotice } : null }),
    createElement(ComposerNoticeSlot),
    createElement(QueuedMessages, { queue: thread }))
}

beforeEach(async () => {
  ;(await import('../../src/renderer/lib/steerKey')).forgetSteerKey()
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  push = null
  listed = []
  toComposer = vi.fn()
  // Open edits and their notices live in the app store, by thread.
  useAppStore.setState({ queueEditDrafts: {}, queueDraftNotices: {}, messages: [] })
  api = {
    list: vi.fn(async () => listed),
    edit: vi.fn(async (_thread: string, itemId: string, content: string) => ({ item: queued(itemId, content) })),
    reorder: vi.fn(async (_thread: string, ids: string[]) => ids.map((id) => listed.find((item) => item.id === id)!)),
    remove: vi.fn(async () => null),
    promoteToSteer: vi.fn(async () => ({ ok: true }))
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
/** The steered messages the reply shows, by their words. */
const reply = () => [...host.querySelectorAll<HTMLElement>('.reply li')].map((item) => item.textContent)
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

  it('labels a message another thread\'s agent queued before it runs, showing only its words; its editor starts from them and saves the person\'s own text', async () => {
    useAppStore.setState({ threads: [{ id: 'sender', name: 'Fix flaky test' } as Thread] })
    const letter = agentMessage('sender', 'Fix flaky test', 'Also rerun the integration suite')
    const origin = { kind: 'agent' as const, threadId: 'sender', runId: 'run-s', hops: 1, title: 'Fix flaky test', body: { head: letter.head, tail: letter.tail } }
    await show([queued('a', letter.text, { source: 'mcp', origin }), queued('b', 'typed by the person')])
    expect(row('a').querySelector('.chat-agent-sender')?.textContent).toBe('Agent·Fix flaky test')
    expect(row('a').querySelector('.chat-user-bubble p')?.textContent).toBe('Also rerun the integration suite')
    expect(row('b').querySelector('.chat-agent-sender')).toBeNull()

    await click(button('a', 'Edit'))
    const area = row('a').querySelector('textarea')!
    expect(area.value).toBe('Also rerun the integration suite')
    await type(area, 'Rerun only the flaky test')
    await key(area, { key: 'Enter' })
    // The saved text carries no label: the daemon then stores it as the person's (it drops the agent origin on a person's edit).
    expect(api.edit).toHaveBeenCalledWith('t1', 'a', 'Rerun only the flaky test', letter.text)
  })

  it('shows text in angle brackets as written, from the person or from another thread\'s agent', async () => {
    const text = 'Do the <work of first task>, then <b>this</b> and <thinking>\nplan\n</thinking> <!-- note'
    useAppStore.setState({ threads: [{ id: 'sender', name: 'Planner' } as Thread] })
    const letter = agentMessage('sender', 'Planner', text)
    const origin = { kind: 'agent' as const, threadId: 'sender', runId: 'run-s', hops: 1, title: 'Planner', body: { head: letter.head, tail: letter.tail } }
    await show([queued('a', text), queued('b', letter.text, { source: 'mcp', origin })])
    expect(rows().map((entry) => entry.querySelector('.chat-user-bubble p')?.textContent)).toEqual([text, text])
    expect(host.querySelector('.chat-user-bubble b, .chat-user-bubble thinking')).toBeNull()
  })

  it('shows when each message was queued on its line: the time today, the date on an earlier day', async () => {
    await show([queued('a', 'today', { enqueuedAt: new Date().toISOString() }), queued('b', 'earlier', { enqueuedAt: '2026-11-09T12:00:00Z' })])
    const time = (id: string) => row(id).querySelector('.queued-message-line')?.textContent
    expect(time('a')).toMatch(/^\d{1,2}:\d{2}\s[AP]M/)
    expect(time('b')).toMatch(/^Nov 9/)
  })

  it('says "Queued" once, on the last line', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    const labels = [...host.querySelectorAll('.queued-message-state')]
    expect(labels.map((label) => label.textContent)).toEqual(['Queued'])
    expect(row('c').contains(labels[0]!)).toBe(true)
    expect(labels[0]!.getAttribute('title')).toBe('Sends when the current reply ends')
  })

  it('says a Stop holds the queue, and what sends it, instead of "Queued"', async () => {
    await show([queued('a', 'one', { heldAfterStop: true }), queued('b', 'two', { heldAfterStop: true })])
    const labels = [...host.querySelectorAll('.queued-message-state')]
    expect(labels.map((label) => label.textContent)).toEqual(['Held after Stop'])
    expect(labels[0]!.getAttribute('title')).toBe('Sends after the reply to your next message, or send it now')
  })

  it('says why the queue waits while no reply runs: the last turn finishing, the next being set up, other work', async () => {
    const label = () => [...host.querySelectorAll('.queued-message-state')].map((entry) => [entry.textContent, entry.getAttribute('title')])
    await show([queued('a', 'one', { waitsFor: 'finish' }), queued('b', 'two', { waitsFor: 'finish' })])
    expect(label()).toEqual([['Waits for the last turn to finish', 'The reply is complete; the turn is still saving its checkpoint']])
    expect(row('b').querySelector('.queued-message-state')).not.toBeNull()
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one', { waitsFor: 'setup' }), queued('b', 'two', { waitsFor: 'setup' })] }) })
    expect(label()).toEqual([['Next turn is starting', 'The next turn is being set up']])
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one', { waitsForLease: true })] }) })
    expect(label()).toEqual([['Waits for the thread to be free', 'Other work on this thread is running']])
    // The wait is over: back to "Queued".
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one')] }) })
    expect(label()).toEqual([['Queued', 'Sends when the current reply ends']])
  })

  it('edits in place: Enter saves the new text and the message keeps its place', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    await click(button('b', 'Edit'))
    const area = row('b').querySelector('textarea')!
    expect(area.value).toBe('two')
    expect(document.activeElement).toBe(area)
    await type(area, 'two, but better\nwith a second line')
    await key(area, { key: 'Enter' })
    // Saved only if the message still has the text the edit started from.
    expect(api.edit).toHaveBeenCalledWith('t1', 'b', 'two, but better\nwith a second line', 'two')
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

  describe('when the message changes elsewhere while it is edited', () => {
    const changedLine = () => row('a').querySelector('.queued-message-changed')
    const textButton = (label: string) => [...row('a').querySelectorAll<HTMLButtonElement>('.queued-message-text-btn')].find((entry) => entry.textContent === label)!

    it('keeps the draft and says so when the save finds newer text, then loads the new text on request', async () => {
      api.edit.mockResolvedValueOnce({ item: queued('a', 'theirs'), changed: true })
      await show([queued('a', 'one')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, 'mine')
      await click(button('a', 'Save'))
      expect(api.edit).toHaveBeenCalledWith('t1', 'a', 'mine', 'one')
      const area = row('a').querySelector('textarea')!
      expect(area.value).toBe('mine')
      expect(changedLine()?.textContent).toContain('Changed elsewhere')
      expect(button('a', 'Save')!.disabled).toBe(true)
      // The error line of the composer is for failures; this is not one.
      expect(host.querySelector('.composer-notice')).toBeNull()
      await click(textButton('Load new'))
      expect(row('a').querySelector('textarea')!.value).toBe('theirs')
      expect(changedLine()).toBeNull()
    })

    it('saves the kept draft over the new text', async () => {
      api.edit.mockResolvedValueOnce({ item: queued('a', 'theirs'), changed: true })
      await show([queued('a', 'one')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, 'mine')
      await click(button('a', 'Save'))
      await click(textButton('Keep mine'))
      expect(changedLine()).toBeNull()
      expect(row('a').querySelector('textarea')!.value).toBe('mine')
      await click(button('a', 'Save'))
      expect(api.edit).toHaveBeenLastCalledWith('t1', 'a', 'mine', 'theirs')
      expect(host.querySelector('textarea')).toBeNull()
    })

    it('says so as soon as the queue shows the new text, when the draft has changes', async () => {
      await show([queued('a', 'one')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, 'mine')
      await act(async () => { push!({ threadId: 't1', items: [queued('a', 'theirs')] }) })
      expect(row('a').querySelector('textarea')!.value).toBe('mine')
      expect(changedLine()?.textContent).toContain('Changed elsewhere')
    })

    it('follows the new text when the draft has no changes of its own', async () => {
      await show([queued('a', 'one')])
      await click(button('a', 'Edit'))
      await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one, revised')] }) })
      const area = row('a').querySelector('textarea')!
      expect(area.value).toBe('one, revised')
      expect(changedLine()).toBeNull()
      await type(area, 'one, revised again')
      await click(button('a', 'Save'))
      expect(api.edit).toHaveBeenCalledWith('t1', 'a', 'one, revised again', 'one, revised')
    })
  })

  describe('when the message starts while it is edited', () => {
    const editA = async (text: string) => {
      await show([queued('a', 'one'), queued('b', 'two')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, text)
    }

    it('moves the unsaved edit to the composer when the message leaves the queue', async () => {
      await editA('one, but better')
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, but better', markers: '' }))
      expect(host.querySelector('textarea')).toBeNull()
      expect(host.querySelector('.composer-notice')?.textContent).toContain(QUEUE_DRAFT_MOVED_NOTICE)
    })

    it('moves it too when the message is still listed but already sending', async () => {
      await editA('one, but better')
      await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one', { state: 'steering' }), queued('b', 'two')] }) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, but better', markers: '' }))
      expect(host.querySelector('textarea')).toBeNull()
    })

    it('moves nothing when the edit had no changes', async () => {
      await editA('one')
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      expect(toComposer).not.toHaveBeenCalled()
      expect(host.querySelector('.composer-notice')).toBeNull()
    })

    it('shows only the composer note when the save was refused because the message started', async () => {
      const answer = deferred<{ item: QueuedMessage }>()
      api.edit.mockReturnValueOnce(answer.promise)
      await editA('one, but better')
      await click(button('a', 'Save'))
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      await act(async () => { answer.reject(new Error("Error invoking remote method 'queue:edit': Error: Queue item a already started and can no longer be edited.")) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, but better', markers: '' }))
      const notices = [...host.querySelectorAll('.composer-notice')].map((entry) => entry.textContent)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain(QUEUE_DRAFT_MOVED_NOTICE)
    })

    it('waits for a save in flight, and recovers nothing when it went through', async () => {
      const answer = deferred<{ item: QueuedMessage }>()
      api.edit.mockReturnValueOnce(answer.promise)
      await editA('one, but better')
      await click(button('a', 'Save'))
      // The daemon saved it and the message started before the answer came back.
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      expect(toComposer).not.toHaveBeenCalled()
      await act(async () => { answer.resolve({ item: queued('a', 'one, but better') }) })
      expect(toComposer).not.toHaveBeenCalled()
      expect(host.querySelector('textarea')).toBeNull()
      expect(host.querySelector('.composer-notice')).toBeNull()
    })

    it("keeps the message's attachments and references with the recovered draft", async () => {
      const image = { name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }
      const markers = '[Attached files: notes.txt]'
      await show([queued('a', `Look at this\n\n${markers}`, { images: [image] }), queued('b', 'two')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, 'Look at that')
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'Look at that', markers, images: [image] }))
    })

    it('gives the images back when the edit cleared the text of a message with images', async () => {
      const image = { name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }
      await show([queued('a', 'Look at this', { images: [image] }), queued('b', 'two')])
      await click(button('a', 'Edit'))
      await type(row('a').querySelector('textarea')!, '')
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: '', markers: '', images: [image] }))
      expect(host.querySelector('.composer-notice')?.textContent).toContain(QUEUE_DRAFT_MOVED_NOTICE)
    })

    it('puts the text in an empty composer, or on a new line after what it has', () => {
      expect(withDraftAppended('', 'edit')).toBe('edit')
      expect(withDraftAppended('  ', 'edit')).toBe('edit')
      expect(withDraftAppended('typed', 'edit')).toBe('typed\nedit')
      expect(withDraftAppended('typed\n', 'edit')).toBe('typed\nedit')
    })
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

  it('sends the clicked message now, by its id, once however often Send now is clicked before it answers', async () => {
    let answer!: () => void
    api.promoteToSteer.mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ ok: true }) }))
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    const send = button('c', 'Send')!
    // Two clicks in the same frame, before the button shows busy.
    await act(async () => { send.click(); send.click() })
    expect(api.promoteToSteer).toHaveBeenCalledTimes(1)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'c')
    // C leaves the queue at the click: the transcript shows it as sent, in the reply it joins.
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a', 'b'])
    await act(async () => { answer() })
    // The daemon lists C as steering until the reply reads it; it stays out of the queue, A and B wait in order.
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('b', 'two'), queued('c', 'three', { intent: 'steer', state: 'steering' })] }) })
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a', 'b'])
  })

  it('a double click on Send now sends only the clicked message, not the one that moves under the pointer', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    await click(button('c', 'Send'))
    // C left the list; the second click of the double click lands on B's button, which moved under the pointer.
    await act(async () => { button('b', 'Send')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })) })
    expect(api.promoteToSteer).toHaveBeenCalledTimes(1)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'c')
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a', 'b'])
  })

  it('shows a message sent now again at once when a Stop puts it back first in the queue', async () => {
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('b', 'Send'))
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('b', 'two', { intent: 'steer', state: 'steering' })] }) })
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a'])
    // The turn was stopped before it read B: the daemon lists it pending, first.
    await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two'), queued('a', 'one')] }) })
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['b', 'a'])
  })

  it('shows a message sent now in the reply from the click, and once when its copy in the turn arrives', async () => {
    let answer!: () => void
    api.promoteToSteer.mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ ok: true }) }))
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('b', 'Send'))
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a'])
    expect(reply()).toEqual(['two'])
    await act(async () => { answer() })
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('b', 'two', { intent: 'steer', state: 'steering' })] }) })
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'echo-b', role: 'user', content: 'two', timestamp: '2026-11-09T10:01:00Z', steered: true, steerItemId: 'b' } as never)
    })
    expect(reply()).toEqual(['two'])
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a'])
  })

  it('keeps a message sent now in the reply when the queue drops it before its copy in the turn arrives', async () => {
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('b', 'Send'))
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one')] }) })
    expect(reply()).toEqual(['two'])
    await act(async () => {
      useAppStore.getState().addMessage({ id: 'echo-b', role: 'user', content: 'two', timestamp: '2026-11-09T10:01:00Z', steered: true, steerItemId: 'b' } as never)
    })
    expect(reply()).toEqual(['two'])
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a'])
  })

  it('keeps a steer in the reply when it is sent now before the queue lists it', async () => {
    let thread!: ReturnType<typeof useThreadQueue>
    function Steering() {
      thread = useThreadQueue({ threadId: 't1', onDraftToComposer: toComposer })
      const transcript = useAppStore((state) => state.messages)
      const steered = withSteersOnTheWay(transcript, thread.steersOnTheWay, 't1').filter((message) => message.role === 'user' && message.steered)
      return createElement('ol', { className: 'reply' }, steered.map((message) => createElement('li', { key: message.id }, message.content)))
    }
    listed = [queued('a', 'one')]
    act(() => root.render(createElement(Steering)))
    await act(async () => { push!({ threadId: 't1', items: listed }) })
    // The send answered with the queued item before the daemon's list shows it: it is sent now by its id.
    await act(async () => { void thread.steer('srv-1', queued('srv-1', 'steer this')) })
    expect(reply()).toEqual(['steer this'])
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('srv-1', 'steer this', { intent: 'steer', state: 'steering' })] }) })
    expect(reply()).toEqual(['steer this'])
  })

  it('shows a message sent now into the running reply back in the queue if the turn never takes it', async () => {
    vi.useFakeTimers()
    try {
      await show([queued('a', 'one'), queued('b', 'two')])
      await click(button('b', 'Send'))
      // The turn has not taken it: the daemon lists B as waiting, first.
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two'), queued('a', 'one')] }) })
      expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a'])
      expect(reply()).toEqual(['two'])
      await act(async () => { vi.advanceTimersByTime(SENT_NOW_HIDE_MS) })
      expect(rows().map((item) => item.dataset.queuedId)).toEqual(['b', 'a'])
      expect(reply()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a refused message out of the reply as it comes back to the queue', async () => {
    api.promoteToSteer.mockResolvedValueOnce({ ok: false })
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('b', 'Send'))
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a', 'b'])
    expect(reply()).toEqual([])
  })

  it('offers no Send now on a steer another process takes, and says why', async () => {
    await show([queued('a', 'one'), queued('s', 'steer elsewhere', { intent: 'steer' })])
    const send = row('s').querySelector<HTMLButtonElement>('.queued-message-send')!
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('Sent into the running reply')
    expect(host.textContent).not.toContain('Sending now')
  })

  it('a second steer key press right after the first does not send the next queued message too', async () => {
    await show([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    const row = rows().find((item) => item.dataset.queuedId === 'a')!
    row.focus()
    await key(row, { key: 'Enter', ctrlKey: true })
    // Focus moved on to B; the same chord pressed again a moment later lands there.
    const next = document.activeElement as HTMLElement
    expect(next.dataset.queuedId).toBe('b')
    await key(next, { key: 'Enter', ctrlKey: true })
    expect(api.promoteToSteer).toHaveBeenCalledTimes(1)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'a')
  })

  it('puts a message back in the queue when Send now is refused', async () => {
    api.promoteToSteer.mockRejectedValueOnce(new Error('No active turn to steer on this thread.'))
    await show([queued('a', 'one'), queued('b', 'two')])
    await click(button('b', 'Send'))
    expect(rows().map((item) => item.dataset.queuedId)).toEqual(['a', 'b'])
  })

  it('sends a focused queued message now with the steer key, once', async () => {
    await show([queued('a', 'one'), queued('b', 'two')])
    const row = rows().find((item) => item.dataset.queuedId === 'b')!
    row.focus()
    await key(row, { key: 'Enter', ctrlKey: true })
    await key(row, { key: 'Enter', ctrlKey: true })
    expect(api.promoteToSteer).toHaveBeenCalledTimes(1)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'b')
    // Focus moves on to the next queued message (here the first, as B was last), not to the page, where the same
    // chord would answer an approval; and that is held off for a moment too.
    expect(document.activeElement).toBe(rows().find((item) => item.dataset.queuedId === 'a'))
    const { steerKeyRecently } = await import('../../src/renderer/lib/steerKey')
    expect(steerKeyRecently()).toBe(true)
    // Enter alone, or with another modifier, does nothing here.
    await key(rows()[0]!, { key: 'Enter' })
    await key(rows()[0]!, { key: 'Enter', ctrlKey: true, shiftKey: true })
    expect(api.promoteToSteer).toHaveBeenCalledTimes(1)
  })

  it('names the steer key in the Send now tooltip', async () => {
    await show([queued('a', 'one')])
    expect(button('a', 'Send')!.title).toBe('Steer: send now (Ctrl+Enter)')
  })

  it('shows a queued subagent result by what it reports, never by the text the model reads, and offers no edit', async () => {
    const notice = [{ delegationId: 'd1', childThreadId: 'a', title: 'API reviewer', runStatus: 'completed', fullyShown: true }]
    await show([queued('n', 'Subagent "API reviewer" (thread a) finished task d1.\nSECRET RESULT', { intent: 'steer', subagentNotice: notice })])
    expect(row('n').textContent).toContain('API reviewer')
    expect(row('n').textContent).not.toContain('SECRET RESULT')
    expect(button('n', 'Edit')).toBeNull()
  })

  it('shows a queued settle notice by the thread it is about, never by the text the model reads, and offers no edit', async () => {
    const notice = [{ watchId: 'w1', threadId: 't2', title: 'Fix build', event: 'ended' as const, status: 'completed' }]
    await show([queued('s', '[Mousse notice, not from the user or any agent]\nSECRET RESULT', { source: 'thread-notice', settleNotice: notice })])
    expect(row('s').textContent).toContain('Fix build')
    expect(row('s').textContent).toContain('finished')
    expect(row('s').textContent).not.toContain('SECRET RESULT')
    expect(button('s', 'Edit')).toBeNull()
  })

  it('leaves internal items out', async () => {
    await show([queued('a', 'one'), queued('i', 'wake up', { internal: true })])
    expect(rows().map((entry) => entry.dataset.queuedId)).toEqual(['a'])
  })
})

describe('the first queued message when its turn starts', () => {
  /** The chat with the transcript's last prompt: `p1` until the next turn's prompt shows. */
  const render = (prompt: { id: string; queueItemId?: string }, turnSettingUp = false) =>
    act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(Chat, { lastPromptId: prompt.id, lastPromptQueueItemId: prompt.queueItemId ?? null, turnSettingUp }))))
  const start = async (items: QueuedMessage[]) => {
    listed = items
    render({ id: 'p1' })
    await act(async () => { push!({ threadId: 't1', items }) })
  }
  const ids = () => rows().map((item) => item.dataset.queuedId)

  it('stays first in the queue after the daemon takes it, and leaves as its prompt shows', async () => {
    await start([queued('a', 'one'), queued('b', 'two')])
    // The daemon took A for its turn; its prompt is not in the transcript yet.
    await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
    expect(ids()).toEqual(['a', 'b'])
    // It takes no change on its way.
    expect(button('a', 'Send')!.disabled).toBe(true)
    // Its prompt shows: it leaves the queue in the same render.
    render({ id: 'p2', queueItemId: 'a' })
    expect(ids()).toEqual(['b'])
  })

  it('says its turn is starting while it waits for its prompt, not what it waited for before', async () => {
    await start([queued('a', 'one', { waitsFor: 'finish' })])
    expect(row('a').querySelector('.queued-message-state')?.textContent).toBe('Waits for the last turn to finish')
    // The last turn finished and the daemon took A for the next one, still being set up.
    await act(async () => { push!({ threadId: 't1', items: [] }) })
    expect(row('a').querySelector('.queued-message-state')?.textContent).toBe('Next turn is starting')
  })

  it('stays as long as its turn is being set up, then waits a while for its prompt', async () => {
    vi.useFakeTimers()
    try {
      await start([queued('a', 'one')])
      // The daemon took A for its turn, whose setup takes a minute.
      render({ id: 'p1' }, true)
      await act(async () => { push!({ threadId: 't1', items: [] }) })
      await act(async () => { vi.advanceTimersByTime(60_000) })
      expect(ids()).toEqual(['a'])
      expect(row('a').querySelector('.queued-message-state')?.textContent).toBe('Next turn is starting')
      // The setup ends: its prompt is due; with none, it leaves after the usual while.
      render({ id: 'p1' })
      await act(async () => { vi.advanceTimersByTime(STARTING_ITEM_HOLD_MS) })
      expect(ids()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves when another prompt shows, or after a while when none does', async () => {
    vi.useFakeTimers()
    try {
      await start([queued('a', 'one'), queued('b', 'two')])
      await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two')] }) })
      render({ id: 'p2' })
      expect(ids()).toEqual(['b'])
      await act(async () => { push!({ threadId: 't1', items: [] }) })
      expect(ids()).toEqual(['b'])
      await act(async () => { vi.advanceTimersByTime(STARTING_ITEM_HOLD_MS) })
      expect(ids()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves at once when it is removed here, or when the whole queue is cleared', async () => {
    await start([queued('a', 'one'), queued('b', 'two'), queued('c', 'three')])
    // The list without it arrives after the remove answered.
    await click(button('a', 'Remove'))
    await act(async () => { push!({ threadId: 't1', items: [queued('b', 'two'), queued('c', 'three')] }) })
    expect(ids()).toEqual(['b', 'c'])
    await act(async () => { push!({ threadId: 't1', items: [] }) })
    expect(ids()).toEqual([])
  })

  it('shows a message whose prompt is already in the transcript only there', async () => {
    listed = [queued('a', 'one'), queued('b', 'two')]
    render({ id: 'p2', queueItemId: 'a' })
    await act(async () => { push!({ threadId: 't1', items: listed }) })
    expect(ids()).toEqual(['b'])
  })

  it('names the message taken: the first waiting one, only when it alone left', () => {
    const a = queued('a', 'one'), b = queued('b', 'two')
    expect(startingItem([a, b], [b], () => false)).toBe(a)
    expect(startingItem([a, b], [], () => false)).toBeNull()
    expect(startingItem([a, b], [a], () => false)).toBeNull()
    expect(startingItem([a, b], [b], (id) => id === 'a')).toBeNull()
    const steering = queued('s', 'steer', { state: 'steering', intent: 'steer' })
    expect(startingItem([steering, a, b], [steering, b], () => false)).toBe(a)
  })
})

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('a message shown while its send is on its way', () => {
  function SendingChat({ optimistic, hidden, onQueueObserved }: {
    optimistic: QueuedMessage[]
    hidden?: ReadonlySet<string>
    onQueueObserved?: (threadId: string, items: QueuedMessage[]) => void
  }) {
    const thread = useThreadQueue({ threadId: 't1', optimisticItems: optimistic, hiddenRequestIds: hidden, onQueueObserved })
    return createElement(QueuedMessages, { queue: thread })
  }
  const ids = () => rows().map((item) => item.dataset.queuedId)

  it('shows once when the queue lists it before the send answers', async () => {
    const observed = vi.fn()
    const copy = queued('optimistic:x', 'two', { clientRequestId: 'req-2' })
    act(() => root.render(createElement(SendingChat, { optimistic: [copy], onQueueObserved: observed })))
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one')] }) })
    expect(ids()).toEqual(['a', 'optimistic:x'])
    // The daemon lists the item its send queued; the send has not answered yet.
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('srv-2', 'two', { clientRequestId: 'req-2' })] }) })
    expect(ids()).toEqual(['a', 'srv-2'])
    expect(observed).toHaveBeenLastCalledWith('t1', expect.arrayContaining([
      expect.objectContaining({ id: 'srv-2', clientRequestId: 'req-2' })
    ]))
  })

  it('keeps an identical message sent earlier apart from it', async () => {
    const copy = queued('optimistic:x', 'two', { clientRequestId: 'req-2' })
    act(() => root.render(createElement(SendingChat, { optimistic: [copy] })))
    await act(async () => { push!({ threadId: 't1', items: [queued('srv-1', 'two', { clientRequestId: 'req-1' })] }) })
    expect(ids()).toEqual(['srv-1', 'optimistic:x'])
  })

  it('does not show a steer the running turn could not take yet, which is sent now as soon as its send answers', async () => {
    act(() => root.render(createElement(SendingChat, { optimistic: [], hidden: new Set(['req-3']) })))
    await act(async () => { push!({ threadId: 't1', items: [queued('a', 'one'), queued('srv-3', 'steer this', { clientRequestId: 'req-3' })] }) })
    expect(ids()).toEqual(['a'])
  })
})

describe('a change that answers after the thread changed', () => {
  /** The chat with a thread switch: the hook stays, the conversation (and its queue) is drawn per thread. */
  function SwitchingChat({ threadId }: { threadId: string | null }) {
    const thread = useThreadQueue({ threadId, onDraftToComposer: toComposer })
    return createElement(Fragment, null,
      createElement(ComposerNoticeSource, { notice: thread.error ? { tone: 'error', title: thread.error, onDismiss: thread.clearError } : null }),
      createElement(ComposerNoticeSource, { notice: thread.draftMoved ? { tone: 'info', title: QUEUE_DRAFT_MOVED_NOTICE, onDismiss: thread.dismissDraftMoved } : null }),
      createElement(ComposerNoticeSlot),
      createElement(QueuedMessages, { key: threadId ?? 'none', queue: thread }))
  }
  const open = async (threadId: string, items: QueuedMessage[]) => {
    act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(SwitchingChat, { threadId }))))
    await act(async () => { push!({ threadId, items }) })
  }
  /** Shows no thread at all. */
  const close = () => { act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(SwitchingChat, { threadId: null })))) }
  /** The thread list as the app has it; a thread that leaves it was deleted. */
  const threadList = (...ids: string[]) => { act(() => { useAppStore.setState({ threads: ids.map((id) => ({ id, name: id }) as Thread) }) }) }
  const editT1 = async (text: string) => {
    await open('t1', t1)
    await click(button('a', 'Edit'))
    await type(row('a').querySelector('textarea')!, text)
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
    const answer = deferred<{ item: QueuedMessage }>()
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

  it('keeps an unsaved edit open with its draft across a switch to another thread and back', async () => {
    await open('t1', t1)
    await click(button('a', 'Edit'))
    await type(row('a').querySelector('textarea')!, 'one, still being written')
    await open('t2', t2)
    expect(host.querySelector('textarea')).toBeNull()
    await open('t1', t1)
    expect(row('a').querySelector('textarea')?.value).toBe('one, still being written')
    expect(toComposer).not.toHaveBeenCalled()
  })

  it('recovers the draft into its own thread when the message starts while another thread is shown', async () => {
    await open('t1', t1)
    await click(button('a', 'Edit'))
    await type(row('a').querySelector('textarea')!, 'one, edited')
    await open('t2', t2)
    await act(async () => { push!({ threadId: 't1', items: [t1[1]!] }) })
    expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, edited', markers: '' }))
    // The note belongs to that thread: it shows there, not here.
    expect(host.querySelector('.composer-notice')).toBeNull()
    await open('t1', [t1[1]!])
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelector('.composer-notice')?.textContent).toContain(QUEUE_DRAFT_MOVED_NOTICE)
    expect(toComposer).toHaveBeenCalledTimes(1)
  })

  it('recovers the draft when the thread is shown again without the message', async () => {
    await open('t1', t1)
    await click(button('a', 'Edit'))
    await type(row('a').querySelector('textarea')!, 'one, edited')
    await open('t2', t2)
    await open('t1', [t1[1]!])
    expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, edited', markers: '' }))
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('recovers the draft once when two updates of the hidden thread come before a render', async () => {
    await editT1('one, edited')
    await open('t2', t2)
    await act(async () => {
      push!({ threadId: 't1', items: [t1[1]!] })
      push!({ threadId: 't1', items: [t1[1]!] })
    })
    expect(toComposer).toHaveBeenCalledTimes(1)
  })

  for (const away of ['another thread', 'no thread'] as const) {
    it(`recovers the draft when a save fails after its message left the queue, with ${away} shown`, async () => {
      const answer = deferred<{ item: QueuedMessage }>()
      api.edit.mockReturnValueOnce(answer.promise)
      await editT1('one, edited')
      await click(button('a', 'Save'))
      if (away === 'no thread') close()
      else await open('t2', t2)
      // The message started while the save was in flight: nothing is decided until the save answers.
      await act(async () => { push!({ threadId: 't1', items: [t1[1]!] }) })
      expect(toComposer).not.toHaveBeenCalled()
      await act(async () => { answer.reject(new Error('Queue item a already started and can no longer be edited.')) })
      expect(toComposer).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'one, edited', markers: '' }))
      expect(useAppStore.getState().queueEditDrafts.t1).toBeUndefined()
    })
  }

  it('forgets the edit and its notice when the thread is deleted', async () => {
    threadList('t1', 't2')
    await editT1('one, edited')
    await open('t2', t2)
    expect(useAppStore.getState().queueEditDrafts.t1).toBeDefined()
    threadList('t2')
    expect(useAppStore.getState().queueEditDrafts.t1).toBeUndefined()
    // The deleted thread's queue drains later: there is nothing to recover.
    await act(async () => { push!({ threadId: 't1', items: [] }) })
    expect(toComposer).not.toHaveBeenCalled()
    // A notice of a deleted thread goes too.
    useAppStore.getState().setQueueDraftNotice('t3', true)
    threadList('t2', 't3')
    threadList('t2')
    expect(useAppStore.getState().queueDraftNotices).toEqual({})
  })

  it('does not recover the edit of a thread deleted while its save was in flight', async () => {
    const answer = deferred<{ item: QueuedMessage }>()
    api.edit.mockReturnValueOnce(answer.promise)
    threadList('t1', 't2')
    await editT1('one, edited')
    await click(button('a', 'Save'))
    await open('t2', t2)
    await act(async () => { push!({ threadId: 't1', items: [] }) })
    threadList('t2')
    await act(async () => { answer.reject(new Error('Thread not found')) })
    expect(toComposer).not.toHaveBeenCalled()
    expect(useAppStore.getState().queueEditDrafts.t1).toBeUndefined()
    expect(useAppStore.getState().queueDraftNotices.t1).toBeUndefined()
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
    expect(state().querySelector('.animate-spin svg')).not.toBeNull()
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
    expect(button('b', 'Send the queued message now')?.title).toBe('Steer: send now (Ctrl+Enter)')
    expect(button('b', 'Edit')).not.toBeNull()
    expect(button('b', 'Remove')).not.toBeNull()
    await click(skip)
    expect(api.promoteToSteer).toHaveBeenCalledWith('t1', 'a')
    expect(host.querySelector('.composer-notice')).toBeNull()
  })

  it('says so when the compaction had already finished: the message goes first with the compacted context', async () => {
    api.promoteToSteer.mockResolvedValueOnce({ ok: true, notice: 'compaction_finished' })
    await show([queued('a', 'one')], { historyTokens: 182_000 })
    await click(button('a', 'Send now: skip compacting')!)
    expect(host.querySelector('.composer-notice')?.textContent).toContain('Compaction already finished · sent first with the compacted context')
  })

  it('leaves the size out when the context is not known', async () => {
    await show([queued('a', 'one')], {})
    expect(button('a', 'Send now: skip compacting')?.title).toBe('Send now: skip compacting and keep the full history')
  })
})
