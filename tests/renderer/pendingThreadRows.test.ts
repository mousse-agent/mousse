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
  addPendingThreadRow, claimPendingThreadRow, pendingThreadRow, settlePendingThreadRow, usePendingThreadRows, withPendingRows
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

describe('the list the sidebar shows', () => {
  it('lists the row Working and open before the service answers', () => {
    const row = rowFor('Plan the release', { shown: draft('d1') })!
    const shown = withPendingRows([...listed, draft('d1')], [row], {}, 'd1')
    expect(shown.threads.filter((entry) => entry.id === 'pending:k1')).toHaveLength(1)
    expect(shown.activity['pending:k1']).toBe('processing')
    expect(shown.openRowId).toBe('pending:k1')
  })

  it('shows the thread the service made in the row, under the row key, once', () => {
    const row = { ...rowFor('Plan the release', { shown: draft('d1') })!, threadId: 't1' }
    const made = thread('t1', 'New Thread', { order: -3, firstSendPending: true })
    const shown = withPendingRows([...listed, made], [row], {}, 't1', new Map([['t1', 'pending:k1']]))
    expect(shown.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't1'])
    // Named from the prompt until the service names it, and Working until it reports the thread's state.
    expect(shown.threads[2]).toMatchObject({ name: 'Plan the release', titleSource: 'provisional', order: -3 })
    expect(shown.activity.t1).toBe('processing')
    expect(shown.rowKeys.get('t1')).toBe('pending:k1')
    expect(shown.openRowId).toBe('t1')
    // What the service says wins.
    const named = withPendingRows([...listed, { ...made, name: 'Release notes', titleSource: 'auto' }], [row], { t1: 'completed' }, 't1')
    expect(named.threads[2]).toMatchObject({ name: 'Release notes', titleSource: 'auto' })
    expect(named.activity.t1).toBe('completed')
  })

  it('takes a thread a pushed list brings before the create answers as the row, not as a second row', () => {
    const row = rowFor('Plan the release', { shown: draft('d1') })!
    const pushed = [...listed, thread('t1', 'New Thread', { createdAt: new Date(now + 5).toISOString(), order: -3 })]
    const shown = withPendingRows(pushed, [row], {}, 'd1')
    expect(shown.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't1'])
    expect(shown.threads[2]!.name).toBe('Plan the release')
    expect(shown.openRowId).toBe('t1')
    // A thread listed at the click, or one of another project, is not the row's.
    const other = withPendingRows([...listed, thread('t2', 'Elsewhere', { projectId: 'p2' })], [row], {}, 'd1')
    expect(other.threads.map((entry) => entry.id)).toEqual(['a', 'b', 't2', 'pending:k1'])
  })

  it('keeps the row when a list pushed after the answer does not have the thread yet', () => {
    const row = { ...rowFor('Plan the release')!, threadId: 't1' }
    const stale = withPendingRows(listed, [row], {}, 't1')
    expect(stale.threads.map((entry) => entry.id)).toEqual(['a', 'b', 'pending:k1'])
  })

  it('lists the reused empty thread as started until the service starts it', () => {
    const row = rowFor('Plan the release', { shown: draft('d1'), reuses: true })!
    const shown = withPendingRows([...listed, draft('d1')], [row], { d1: 'idle' }, 'd1')
    expect(shown.threads.find((entry) => entry.id === 'd1')).toMatchObject({ name: 'Plan the release', startedAt: row.thread.startedAt, order: -3 })
    expect(shown.activity.d1).toBe('processing')
    expect(shown.threads.filter((entry) => entry.id === 'd1')).toHaveLength(1)
  })
})

describe('the store', () => {
  beforeEach(() => usePendingThreadRows.setState({ rows: [], rowKeys: new Map() }))

  it('claims the made thread for the row and keeps its key after the send', () => {
    const row = addPendingThreadRow(rowFor('Plan the release')!)
    const made = thread('t1', 'New Thread')
    expect(claimPendingThreadRow(row.key, made)).toBe(made)
    expect(usePendingThreadRows.getState().rows[0]).toMatchObject({ threadId: 't1', made })
    const listMade = vi.fn()
    settlePendingThreadRow(row.key, listMade)
    expect(usePendingThreadRows.getState().rows).toEqual([])
    expect(usePendingThreadRows.getState().rowKeys.get('t1')).toBe('pending:k1')
    expect(listMade).toHaveBeenCalledWith(made)
  })

  it('takes the row away when the create fails, with nothing to list', () => {
    const row = addPendingThreadRow(rowFor('Plan the release')!)
    const listMade = vi.fn()
    settlePendingThreadRow(row.key, listMade)
    expect(usePendingThreadRows.getState().rows).toEqual([])
    expect(listMade).not.toHaveBeenCalled()
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
    useAppStore.setState({ profileId: 'default', projects: [project('p1', 'Mousse')], threads: [...listed, draft('d1')], threadActivity: {}, activeThreadId: 'd1', threadsSidebarView: 'projects', sidebarMode: 'projects' })
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

  it('paints the row on the click, then the made thread in the same element, with no second row and no move', () => {
    act(() => { addPendingThreadRow(rowFor('Plan the release', { shown: draft('d1'), threads: useAppStore.getState().threads })!) })
    const pending = rows()[0]!
    expect(pending.dataset.threadId).toBe('pending:k1')
    expect(pending.textContent).toContain('Plan the release')
    expect(pending.classList.contains('active')).toBe(true)
    expect(pending.querySelector('.threads-sidebar-status-spinner')).not.toBeNull()
    // Nothing to act on before the thread exists.
    act(() => pending.click())
    expect(actions.selectThread).not.toHaveBeenCalled()

    // A list pushed before the create answers already has the made thread.
    const made = thread('t1', 'New Thread', { order: -3, createdAt: new Date(now + 5).toISOString(), firstSendPending: true })
    act(() => useAppStore.setState({ threads: [...useAppStore.getState().threads, made] }))
    expect(rows()).toHaveLength(3)
    // The create answers: the composer moves to the thread.
    act(() => {
      claimPendingThreadRow('pending:k1', made)
      useAppStore.setState({ activeThreadId: 't1' })
    })
    const real = rows()[0]!
    expect(real).toBe(pending)
    expect(real.dataset.threadId).toBe('t1')
    expect(real.classList.contains('active')).toBe(true)
    expect(titles()).toEqual([expect.stringContaining('Plan the release'), expect.stringContaining('Ship it'), expect.stringContaining('Fix tests')])

    // The service names and runs it; the send ends, and the thread's own row stays as it was.
    act(() => useAppStore.setState({ threads: useAppStore.getState().threads.map((entry) => (entry.id === 't1' ? { ...entry, name: 'Plan the release', titleSource: 'provisional' as const } : entry)), threadActivity: { t1: 'processing' } }))
    act(() => settlePendingThreadRow('pending:k1', () => undefined))
    expect(rows()[0]).toBe(pending)
    expect(rows()).toHaveLength(3)
  })

  it('takes the row away when the send stops before the thread is made', () => {
    act(() => { addPendingThreadRow(rowFor('Plan the release', { shown: draft('d1'), threads: useAppStore.getState().threads })!) })
    expect(rows()).toHaveLength(3)
    act(() => settlePendingThreadRow('pending:k1', () => undefined))
    expect(rows().map((row) => row.dataset.threadId)).toEqual(['b', 'a'])
  })
})
