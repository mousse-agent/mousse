// @vitest-environment jsdom
/**
 * The window leaves the thread it shows once that thread is deleted, wherever the delete came from
 * (`lib/leaveDeletedThread`): when a list without it arrives and the service confirms it is gone, the window goes to
 * the first thread that is not archived, or to a new chat. Nothing else (a thread not listed yet, another computer's
 * row, a thread the service still has) makes it move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { qualifyId } from '../../src/shared/threadRef'

const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { watchDeletedShownThread, shownThreadLeftList, threadAfterDeletion } = await import('../../src/renderer/lib/leaveDeletedThread')

const at = '2026-11-11T10:00:00.000Z'
const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name: id, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...over })

/** What `threads:get` throws while the thread's delete is still under way, or the service cannot answer. */
const notYet = () => new Error("Error invoking remote method 'threads:get': MmsProtocolError: Thread not found")

let service: Map<string, Thread>
/** Threads in the trash: their delete is under way and may still put them back. */
let deleting: Set<string>
let api: { get: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn>; newChatAfterDelete: ReturnType<typeof vi.fn> }
let stop: () => void

/** The window shows `shown`; the service and the window's list both have `threads`. */
function windowShowing(shown: string, threads: Thread[]): void {
  service = new Map(threads.map((entry) => [entry.id, entry]))
  deleting = new Set()
  useAppStore.setState({ threads, activeThreadId: shown, messages: [] })
}

/** A delete, from this window or from anywhere else: the service no longer has the threads, then its list arrives. */
function deleteInService(...ids: string[]): void {
  for (const id of ids) service.delete(id)
  useAppStore.getState().setThreads([...service.values()])
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  api = {
    // As main answers it: the thread, null once it is gone, an error while its delete is under way.
    get: vi.fn(async (id: string) => {
      if (deleting.has(id)) throw notYet()
      return service.get(id) ?? null
    }),
    select: vi.fn(async () => undefined),
    newChatAfterDelete: vi.fn(async () => {
      const made = thread('new-chat', { name: 'New Chat', startedAt: undefined })
      service.set(made.id, made)
      return made
    })
  }
  ;(window as unknown as { mousse: unknown }).mousse = { threads: api }
  stop = watchDeletedShownThread(undefined, [20, 20, 20, 20])
})

afterEach(() => {
  stop()
  useAppStore.setState({ threads: [], activeThreadId: null })
})

describe('the shown thread is deleted', () => {
  it('from this window: the chat goes to the first thread that is not archived', async () => {
    windowShowing('a', [thread('archived-one', { settledAt: at }), thread('a', { settledAt: at }), thread('b'), thread('c')])
    // The sidebar's Delete: the service deletes it, and the list without it reaches the window.
    deleteInService('a')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('b'))
    expect(api.select).toHaveBeenCalledWith('b')
    expect(api.newChatAfterDelete).not.toHaveBeenCalled()
  })

  it('from elsewhere (another window, the CLI, its expiry): the chat leaves it the same way', async () => {
    windowShowing('a', [thread('b'), thread('a')])
    deleteInService('a')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('b'))
    expect(api.get).toHaveBeenCalledWith('a')
    expect(api.select).toHaveBeenCalledTimes(1)
  })

  it('with no other thread to show: the chat goes to a new chat', async () => {
    windowShowing('a', [thread('a'), thread('old', { settledAt: at })])
    deleteInService('a')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('new-chat'))
    expect(api.newChatAfterDelete).toHaveBeenCalledTimes(1)
    expect(api.select).toHaveBeenCalledWith('new-chat')
  })

  it('a subagent thread shown when its parent is deleted: the chat leaves it, never for another subagent', async () => {
    const child = (id: string, parent: string) => thread(id, { lineage: { parentThreadId: parent, rootThreadId: parent, relationship: 'subagent' } })
    windowShowing('child', [thread('parent', { settledAt: at }), child('child', 'parent'), thread('other'), child('other-child', 'other')])
    deleteInService('parent', 'child')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('other'))
  })

  it('leaves it once, however many lists without it arrive', async () => {
    windowShowing('a', [thread('a'), thread('b')])
    deleteInService('a')
    useAppStore.getState().setThreads([...service.values()])
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('b'))
    await settled()
    expect(api.select).toHaveBeenCalledTimes(1)
  })
})

describe('while the service cannot say yet', () => {
  it('waits out a delete still under way, then leaves once the thread is gone', async () => {
    windowShowing('a', [thread('a'), thread('b')])
    // Trashed, not yet purged: the list no longer has it, but the delete may still put it back.
    deleting.add('a')
    deleteInService('a')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useAppStore.getState().activeThreadId).toBe('a')
    deleting.delete('a')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('b'))
  })

  it('stays when a delete under way puts the thread back (refused)', async () => {
    windowShowing('a', [thread('a'), thread('b')])
    deleting.add('a')
    deleteInService('a')
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Put back: the service has it again, and its list follows.
    deleting.delete('a')
    service.set('a', thread('a'))
    useAppStore.getState().setThreads([...service.values()])
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(useAppStore.getState().activeThreadId).toBe('a')
    expect(api.select).not.toHaveBeenCalled()
  })

  it('asks again after an error, instead of staying on a deleted thread for good', async () => {
    windowShowing('a', [thread('a'), thread('b')])
    api.get.mockRejectedValueOnce(new Error('MMS client not connected'))
    deleteInService('a')
    await vi.waitFor(() => expect(useAppStore.getState().activeThreadId).toBe('b'))
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})

describe('the window stays', () => {
  it('on a thread the service still has (a list from elsewhere without it, or a refused delete that put it back)', async () => {
    windowShowing('a', [thread('a'), thread('b')])
    useAppStore.getState().setThreads([thread('b')])
    await settled()
    await settled()
    expect(api.get).toHaveBeenCalledWith('a')
    expect(useAppStore.getState().activeThreadId).toBe('a')
    expect(api.select).not.toHaveBeenCalled()
  })

  it('on a thread not listed yet (just made, or still the Send\'s pending row)', async () => {
    windowShowing('fresh', [thread('b')])
    useAppStore.getState().setThreads([thread('b'), thread('c')])
    await settled()
    expect(api.get).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeThreadId).toBe('fresh')
  })

  it('on another computer\'s thread whose row left the list (that computer is out of reach)', async () => {
    const remote = qualifyId('nod_0123456789abcdefghjkmnpqrs', 'thread-1')
    windowShowing(remote, [thread(remote), thread('b')])
    useAppStore.getState().setThreads([thread('b')])
    await settled()
    expect(api.get).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeThreadId).toBe(remote)
  })

  it('where the person went meanwhile', async () => {
    windowShowing('a', [thread('a'), thread('b'), thread('c')])
    let answer: (value: unknown) => void = () => {}
    api.get.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve(null) }))
    deleteInService('a')
    useAppStore.getState().switchToThread('c')
    answer(undefined)
    await settled()
    await settled()
    expect(useAppStore.getState().activeThreadId).toBe('c')
    expect(api.select).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('shownThreadLeftList needs the thread in the list before and not after', () => {
    expect(shownThreadLeftList([thread('a')], [], 'a')).toBe(true)
    expect(shownThreadLeftList([], [], 'a')).toBe(false)
    expect(shownThreadLeftList([thread('a')], [thread('a')], 'a')).toBe(false)
    expect(shownThreadLeftList([thread('a')], [], null)).toBe(false)
  })

  it('threadAfterDeletion skips archived threads, subagents and the deleted thread', () => {
    const sub = thread('s', { lineage: { parentThreadId: 'p', rootThreadId: 'p', relationship: 'subagent' } })
    expect(threadAfterDeletion([thread('x', { settledAt: at }), thread('p'), sub], 'p')).toBeUndefined()
    expect(threadAfterDeletion([thread('x', { settledAt: at }), thread('p', { settledAt: at }), sub, thread('y')], 'z')).toBe('y')
  })
})
