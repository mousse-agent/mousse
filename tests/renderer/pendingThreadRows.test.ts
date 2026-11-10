// @vitest-environment jsdom
/**
 * A send that starts a thread lists its sidebar row at once (`lib/pendingThreadRows`): named from the prompt, Working
 * and open, before the service has made the thread. The thread's own row takes its place without a second row, a move
 * or a remount, whichever comes first of the service's answer and a pushed list, and a send that stops takes it away.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actions = vi.hoisted(() => ({
  selectThread: vi.fn(async () => undefined),
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined)
}))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const {
  addPendingThreadRow, claimPendingThreadRow, dropPendingThreadRows, holdNewChat, pendingThreadRow, pruneRowKeys, servedPendingRows, typedAfterSend, usePendingThreadRows, withPendingRows
} = await import('../../src/renderer/lib/pendingThreadRows')

const at = '2026-11-05T10:00:00.000Z'
const project = (id: string, name: string): Project => ({ id, name, path: `/p/${name}`, createdAt: at, order: 0 })
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
/** An empty thread the composer shows: not listed until it is started. */
const draft = (id: string, over: Partial<Thread> = {}): Thread => {
  const { startedAt: _unstarted, ...rest } = thread(id, 'New Thread', over)
  return rest
}

const listed = [thread('a', 'Fix tests', { order: -1 }), thread('b', 'Ship it', { order: -2 })]
const now = Date.parse('2026-11-05T11:00:00.000Z')

/** The row a send from a new chat in `p1` makes, as the composer makes it at the click. */
function rowFor(text: string, over: { shown?: Thread; reuses?: boolean; threads?: Thread[] } = {}) {
  return pendingThreadRow({
    profileId: 'default',
    text,
    attached: false,
    shown: over.shown,
    reuses: over.reuses ?? false,
    workspace: { projectId: 'p1' },
    threads: over.threads ?? listed,
    now,
    newKey: () => 'k1'
  })
}

describe('the pending row a send makes', () => {
  it('is named from the first words of the prompt, on top of its project, and is new until the service makes the thread', () => {
    const row = rowFor('Please plan the release notes for 0.2. Then draft them.')!
    expect(row.key).toBe('pending:k1')
    expect(row.thread).toMatchObject({ id: 'pending:k1', name: 'Plan the release notes', titleSource: 'provisional', projectId: 'p1', order: -3 })
    expect(row.thread.startedAt).toBe(new Date(now).toISOString())
    expect(row.threadId).toBeUndefined()
  })

  it('is the shown empty thread when the send uses it', () => {
    const row = rowFor('Plan the release', { shown: draft('d1'), reuses: true })!
    expect(row).toMatchObject({ key: 'd1', threadId: 'd1', from: 'd1' })
    expect(row.thread).toMatchObject({ id: 'd1', name: 'Plan the release', order: -3 })
  })

  it('is not made for a command or for nothing to send', () => {
    expect(rowFor('/usage')).toBeUndefined()
    expect(rowFor('   ')).toBeUndefined()
    expect(pendingThreadRow({ profileId: null, text: '', attached: true, shown: undefined, reuses: false, workspace: {}, threads: [], newKey: () => 'k2' })?.thread.name).toBe('New Thread')
  })
})


/** A thread the service made for the send just now. */
const made = (id: string, over: Partial<Thread> = {}) =>
  thread(id, 'New Thread', { order: -3, createdAt: new Date(now + 5).toISOString(), firstSendPending: true, ...over })

describe('the list the sidebar shows', () => {
  it('lists the row Working and open before the service answers, and nothing can be done to it', () => {
    const row = rowFor('Plan the release', { shown: draft('d1') })!
    const shown = withPendingRows([...listed, draft('d1')], [row], {}, 'd1')
    expect(shown.threads.filter((entry) => entry.id === 'pending:k1')).toHaveLength(1)
    expect(shown.activity['pending:k1']).toBe('processing')
    expect(shown.openRowId).toBe('pending:k1')
    expect([...shown.unmade]).toEqual(['pending:k1'])
  })

  it('shows the thread the service made in the row, under the row key, once', () => {
    const row = { ...rowFor('Plan the release', { shown: draft('d1') })!, threadId: 't1' }
    const shown = withPendingRows([...listed, made('t1')], [row], {}, 't1', new Map([['t1', { key: 'pending:k1', at: now }]]))
    expect(shown.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't1'])
    // Named from the prompt until the service names it, and Working until it reports the thread's state.
    expect(shown.threads[2]).toMatchObject({ name: 'Plan the release', titleSource: 'provisional', order: -3 })
    expect(shown.activity.t1).toBe('processing')
    expect(shown.rowKeys.get('t1')).toBe('pending:k1')
    expect(shown.openRowId).toBe('t1')
    expect(shown.unmade.size).toBe(0)
    // What the service says wins.
    const named = withPendingRows([...listed, { ...made('t1'), name: 'Release notes', titleSource: 'auto' }], [row], { t1: 'completed' }, 't1')
    expect(named.threads[2]).toMatchObject({ name: 'Release notes', titleSource: 'auto' })
    expect(named.activity.t1).toBe('completed')
  })

  it('takes a thread a pushed list brings before the create answers as the row, not as a second row', () => {
    const row = rowFor('Plan the release', { shown: draft('d1') })!
    const shown = withPendingRows([...listed, made('t1')], [row], {}, 'd1')
    expect(shown.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't1'])
    expect(shown.threads[2]!.name).toBe('Plan the release')
    expect(shown.openRowId).toBe('t1')
  })

  it('takes no thread made elsewhere for the row: another place, made before the click, a bot chat, a subagent or an automation', () => {
    const row = rowFor('Plan the release', { shown: draft('d1') })!
    const others = [
      made('other-project', { projectId: 'p2' }),
      made('no-project', { projectId: undefined }),
      made('other-computer', { node: 'studio' }),
      made('private', { localOnly: true }),
      made('older', { createdAt: new Date(now - 60_000).toISOString() }),
      made('bot-chat'),
      made('subagent', { lineage: { parentThreadId: 'a', rootThreadId: 'a', relationship: 'subagent' } }),
      made('manager', { automationManager: true } as Partial<Thread>),
      made('archived', { settledAt: at })
    ]
    const shown = withPendingRows([...listed, ...others], [row], {}, 'd1', undefined, new Set(['bot-chat']))
    expect(shown.threads.map((entry) => entry.id)).toEqual(['a', 'b', ...others.map((entry) => entry.id), 'pending:k1'])
    expect(shown.threads.filter((entry) => entry.name === 'Plan the release')).toHaveLength(1)
    // A clock a few seconds behind still counts.
    const behind = withPendingRows([...listed, made('t1', { createdAt: new Date(now - 4_000).toISOString() })], [row], {}, 'd1')
    expect(behind.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't1'])
  })

  it('keeps the row when a list pushed before the answer does not have the thread yet', () => {
    const row = rowFor('Plan the release')!
    const early = withPendingRows(listed, [row], {}, null)
    expect(early.threads.map((entry) => entry.id)).toEqual(['a', 'b', 'pending:k1'])
  })

  it('never lists the row again once its thread is known: a thread deleted mid-turn is gone', () => {
    const row = { ...rowFor('Plan the release')!, threadId: 't1' }
    const deleted = withPendingRows(listed, [row], {}, 't1')
    expect(deleted.threads.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(deleted.activity).toEqual({})
    // The same for an empty thread the send used.
    const reused = rowFor('Plan the release', { shown: draft('d1'), reuses: true })!
    expect(withPendingRows(listed, [reused], {}, 'd1').threads.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('lists the reused empty thread as started, with nothing to do to it until the service starts it', () => {
    const row = rowFor('Plan the release', { shown: draft('d1'), reuses: true })!
    const shown = withPendingRows([...listed, draft('d1')], [row], { d1: 'idle' }, 'd1')
    expect(shown.threads.find((entry) => entry.id === 'd1')).toMatchObject({ name: 'Plan the release', startedAt: row.thread.startedAt, order: -3 })
    expect(shown.activity.d1).toBe('processing')
    expect(shown.threads.filter((entry) => entry.id === 'd1')).toHaveLength(1)
    expect([...shown.unmade]).toEqual(['d1'])
    const started = withPendingRows([...listed, { ...draft('d1'), startedAt: at }], [row], {}, 'd1')
    expect(started.unmade.size).toBe(0)
  })

  it('counts a row served once its thread is listed started, named and with a state of its own', () => {
    const row = { ...rowFor('Plan the release')!, threadId: 't1' }
    expect(servedPendingRows([row], [made('t1')], { t1: 'processing' })).toEqual([])
    expect(servedPendingRows([row], [{ ...made('t1'), name: 'Plan the release' }], {})).toEqual([])
    expect(servedPendingRows([row], [{ ...made('t1'), name: 'Plan the release' }], { t1: 'processing' })).toEqual(['pending:k1'])
  })
})

describe('typing while the row is drawn', () => {
  it('keeps only what was typed after the sent text', () => {
    expect(typedAfterSend('Plan', 'Plan the')).toBe(' the')
    expect(typedAfterSend('Plan', 'Plan')).toBe('')
    expect(typedAfterSend('Plan', 'Other')).toBe('')
  })
})

describe('the hold on a new chat', () => {
  it('lets one preparation hold a chat at a time, and each release only its own hold', () => {
    const first = holdNewChat('default', 'd1')!
    expect(first).toBeTypeOf('function')
    expect(holdNewChat('default', 'd1')).toBeNull()
    expect(holdNewChat('default', 'd2')).not.toBeNull()
    first()
    const second = holdNewChat('default', 'd1')!
    // A stale release from the first holder leaves the second hold in place.
    first()
    expect(holdNewChat('default', 'd1')).toBeNull()
    second()
    expect(holdNewChat('default', 'd1')).not.toBeNull()
  })
})

describe('the store', () => {
  beforeEach(() => usePendingThreadRows.setState({ rows: [], rowKeys: new Map() }))

  it('claims the made thread for the row, lists it, and keeps its key after the row goes', () => {
    const row = addPendingThreadRow(rowFor('Plan the release')!)
    const list = vi.fn()
    expect(claimPendingThreadRow(row.key, made('t1'), list, now)).toEqual(made('t1'))
    expect(list).toHaveBeenCalledWith(made('t1'))
    expect(usePendingThreadRows.getState().rows[0]).toMatchObject({ threadId: 't1' })
    dropPendingThreadRows([row.key])
    expect(usePendingThreadRows.getState().rows).toEqual([])
    expect(usePendingThreadRows.getState().rowKeys.get('t1')).toEqual({ key: 'pending:k1', at: now })
  })

  it('lists nothing for a row that is gone', () => {
    const list = vi.fn()
    claimPendingThreadRow('pending:gone', made('t1'), list)
    expect(list).not.toHaveBeenCalled()
  })

  it('forgets a row key a minute after its thread was made, or once its thread is gone', () => {
    usePendingThreadRows.setState({ rowKeys: new Map([['t1', { key: 'pending:k1', at: now }], ['t2', { key: 'pending:k2', at: now }]]) })
    pruneRowKeys(new Set(['t1', 't2']), now + 30_000)
    expect([...usePendingThreadRows.getState().rowKeys.keys()]).toEqual(['t1', 't2'])
    pruneRowKeys(new Set(['t1']), now + 30_000)
    expect([...usePendingThreadRows.getState().rowKeys.keys()]).toEqual(['t1'])
    pruneRowKeys(new Set(['t1']), now + 61_000)
    expect(usePendingThreadRows.getState().rowKeys.size).toBe(0)
  })
})

describe('in the sidebar', () => {
  let root: Root
  let host: HTMLElement
  const appInitial = useAppStore.getInitialState()

  beforeEach(() => {
    const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
    const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
    ;(window as unknown as { mousse: unknown }).mousse = new Proxy({ platform: 'win32' } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
    usePendingThreadRows.setState({ rows: [], rowKeys: new Map() })
    useAppStore.setState({ profileId: 'default', projects: [project('p1', 'Mousse')], threads: [...listed, draft('d1')], threadActivity: {}, activeThreadId: 'd1', threadsSidebarView: 'projects', sidebarMode: 'projects', threadFeedOrder: [] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ThreadsSidebar)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(appInitial)
    usePendingThreadRows.setState({ rows: [], rowKeys: new Map() })
  })

  const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-tree .threads-sidebar-thread')]
  const titles = () => rows().map((row) => row.textContent)
  const addRow = (over: { reuses?: boolean } = {}) =>
    act(() => { addPendingThreadRow(rowFor('Plan the release', { shown: draft('d1'), threads: useAppStore.getState().threads, ...over })!) })

  it('paints the row on the click, then the made thread in the same element, with no second row and no move', () => {
    addRow()
    const pending = rows()[0]!
    expect(pending.dataset.threadId).toBe('pending:k1')
    expect(pending.textContent).toContain('Plan the release')
    expect(pending.classList.contains('active')).toBe(true)
    expect(pending.querySelector('.threads-sidebar-status-spinner')).not.toBeNull()
    // Nothing to act on before the thread exists.
    act(() => pending.click())
    expect(actions.selectThread).not.toHaveBeenCalled()

    // A list pushed before the create answers already has the made thread.
    act(() => useAppStore.setState({ threads: [...useAppStore.getState().threads, made('t1')] }))
    expect(rows()).toHaveLength(3)
    // The create answers: the composer moves to the thread.
    act(() => {
      claimPendingThreadRow('pending:k1', made('t1'))
      useAppStore.setState({ activeThreadId: 't1' })
    })
    const real = rows()[0]!
    expect(real).toBe(pending)
    expect(real.dataset.threadId).toBe('t1')
    expect(real.classList.contains('active')).toBe(true)
    expect(titles()).toEqual([expect.stringContaining('Plan the release'), expect.stringContaining('Ship it'), expect.stringContaining('Fix tests')])

    // The service names and runs it: the row is served and goes, and the thread's own row stays as it was.
    act(() => useAppStore.setState({ threads: useAppStore.getState().threads.map((entry) => (entry.id === 't1' ? { ...entry, name: 'Plan the release', titleSource: 'provisional' as const } : entry)), threadActivity: { t1: 'processing' } }))
    expect(usePendingThreadRows.getState().rows).toEqual([])
    expect(rows()[0]).toBe(pending)
    expect(rows()).toHaveLength(3)
  })

  it('takes the row away when the send stops before the thread is made', () => {
    addRow()
    expect(rows()).toHaveLength(3)
    act(() => dropPendingThreadRows(['pending:k1']))
    expect(rows().map((row) => row.dataset.threadId)).toEqual(['b', 'a'])
  })

  it('shows no row for a thread deleted while its first turn runs', () => {
    addRow()
    act(() => {
      claimPendingThreadRow('pending:k1', made('t1'), (thread) => useAppStore.getState().upsertThread(thread))
      useAppStore.setState({ activeThreadId: 't1' })
    })
    expect(rows().map((row) => row.dataset.threadId)).toEqual(['t1', 'b', 'a'])
    // Deleted: the next list does not have it.
    act(() => useAppStore.setState({ threads: useAppStore.getState().threads.filter((entry) => entry.id !== 't1') }))
    expect(rows().map((row) => row.dataset.threadId)).toEqual(['b', 'a'])
    expect(host.querySelector('[data-thread-id^="pending:"]')).toBeNull()
  })

  it('offers nothing on the reused empty thread until the service starts it, and takes no drop', () => {
    addRow({ reuses: true })
    const row = rows()[0]!
    expect(row.dataset.threadId).toBe('d1')
    expect(row.draggable).toBe(false)
    expect(row.parentElement!.querySelector('.threads-sidebar-thread-actions')).toBeNull()
    act(() => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(host.querySelector('input')).toBeNull()
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // A thread dragged onto it does not drop there.
    const dragged = rows()[1]!
    act(() => { dragged.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: { setData: () => undefined, effectAllowed: '' } })) })
    const over = Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: { types: [] }, clientY: 0 })
    act(() => { row.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(false)
  })

  it('never writes a pending row into the Threads tab order', () => {
    act(() => useAppStore.setState({ threadsSidebarView: 'threads' }))
    addRow()
    const cards = () => [...host.querySelectorAll<HTMLButtonElement>('.threads-sidebar-feed-list .threads-sidebar-thread')]
    expect(cards()[0]!.dataset.threadId).toBe('pending:k1')
    const dataTransfer = { setData: () => undefined, effectAllowed: '', types: [] }
    const last = cards()[cards().length - 1]!
    act(() => { last.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer })) })
    const target = cards()[1]!
    act(() => { target.dispatchEvent(Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer, clientY: 0 })) })
    act(() => { target.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer, clientY: 0 })) })
    const order = useAppStore.getState().threadFeedOrder
    expect(order.length).toBeGreaterThan(0)
    expect(order.some((id) => id.startsWith('pending:'))).toBe(false)
  })
})
