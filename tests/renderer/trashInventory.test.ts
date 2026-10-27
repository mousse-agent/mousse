import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppErrorShape } from '../../src/shared/errors'
import type { LifecyclePurgeItem, LifecyclePurgePreview, LifecycleState, TaskLifecycleRecord, TrashRetentionPolicy } from '../../src/shared/resourceLifecycle'
import {
  createTrashController, retentionLabel, summarizeDeletion, trashCount, trashRows,
  type PurgeInput, type PurgeReclaim, type TrashApi
} from '../../src/renderer/lib/trashInventory'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const POLICY: TrashRetentionPolicy = { schemaVersion: 1, graceDays: 30, automaticPurge: true }

function record(taskId: string, state: LifecycleState, extra: Partial<TaskLifecycleRecord> = {}): TaskLifecycleRecord {
  return {
    schemaVersion: 1, minimumWriterVersion: 1, profileId: 'p', taskId, generation: 3, state,
    originalLocation: `/t/${taskId}`, location: `/t/${taskId}`, locations: [`/t/${taskId}`], operations: [],
    createdAt: iso(90), updatedAt: iso(1), ...extra
  }
}
const trashed = (taskId: string, daysAgo: number, extra: Partial<TaskLifecycleRecord> = {}) => record(taskId, 'trashed', { trashedAt: iso(daysAgo), ...extra })

function item(kind: LifecyclePurgeItem['kind'], id: string, extra: Partial<LifecyclePurgeItem> = {}): LifecyclePurgeItem {
  return { id, kind, identity: `/x/${id}`, ownerTaskId: 't', status: 'pending', ...extra }
}
function preview(taskId: string, items: LifecyclePurgeItem[], extra: Partial<LifecyclePurgePreview> = {}): LifecyclePurgePreview {
  return { schemaVersion: 1, taskId, generation: 3, digest: 'digest-1', items, ownedTaskIds: [taskId], blockers: [], retained: [], exclusiveBytes: 2048, ...extra }
}
const safe = [item('path', 'data'), item('worktree', 'wt'), item('ref', 'branch')]
const unpublished = [item('path', 'data'), item('worktree', 'wt', { discardRequired: true, reason: 'This result may contain unpublished work' })]

function publicError(code: string, message: string): AppErrorShape {
  return { code, message, errorInfo: { category: 'conflict', retryable: false } }
}

/** A daemon stand-in: the list the sidebar reads changes only when an action really succeeds. */
function fakeDaemon(initial: TaskLifecycleRecord[], options: { previews?: Record<string, LifecyclePurgePreview>; reclaim?: PurgeReclaim } = {}) {
  const records = [...initial]
  const calls = { inventory: 0, restore: [] as string[], purge: [] as Array<{ taskId: string; options?: PurgeInput }> }
  const behaviour = {
    restore: undefined as undefined | (() => Promise<unknown>),
    purge: undefined as undefined | ((taskId: string, options: PurgeInput) => Promise<void>),
    inventoryGate: undefined as undefined | Promise<void>
  }
  const names = Object.fromEntries(initial.map((entry) => [entry.taskId, `Thread ${entry.taskId}`]))
  const set = (taskId: string, patch: Partial<TaskLifecycleRecord>) => {
    const index = records.findIndex((entry) => entry.taskId === taskId)
    records[index] = { ...records[index]!, ...patch }
  }
  const api: TrashApi = {
    async inventory() {
      calls.inventory += 1
      await behaviour.inventoryGate
      return { lifecycles: records.map((entry) => ({ ...entry })), taskNames: names, trashPolicy: POLICY, trashSweepStatus: { suspended: false } }
    },
    async restore(taskId) {
      calls.restore.push(taskId)
      if (behaviour.restore) return behaviour.restore()
      set(taskId, { state: 'active' })
    },
    async purge(taskId, purgeOptions) {
      calls.purge.push({ taskId, ...(purgeOptions ? { options: purgeOptions } : {}) })
      if (purgeOptions?.preview) return { preview: options.previews?.[taskId] ?? preview(taskId, safe), ...(options.reclaim ? { reclaim: options.reclaim } : {}) }
      if (behaviour.purge) await behaviour.purge(taskId, purgeOptions ?? {})
      else set(taskId, { state: 'purged' })
      return {}
    }
  }
  return { api, calls, behaviour, set, records }
}
const quiet = { onError: () => {}, newOperationId: () => 'op-1' }

afterEach(() => { vi.useRealTimers() })

describe('recently deleted list', () => {
  it('lists root threads in or entering the trash, never live, purged or subagent records', () => {
    const rows = trashRows([
      record('live', 'active'), record('draining', 'draining'), trashed('gone', 2, { state: 'purged' }),
      trashed('child', 2, { parentTaskId: 'parent' }), trashed('kept', 2), record('moving', 'trash-moving')
    ], { kept: 'Kept thread' }, POLICY, { now: NOW })
    expect(rows.map((row) => row.taskId).sort()).toEqual(['kept', 'moving'])
    expect(trashCount([record('live', 'active'), trashed('kept', 2), trashed('child', 2, { parentTaskId: 'parent' })])).toBe(1)
    expect(rows.find((row) => row.taskId === 'kept')?.name).toBe('Kept thread')
    expect(rows.find((row) => row.taskId === 'moving')).toMatchObject({ name: 'Untitled thread', meta: 'Moving to trash…', canRestore: false, canDelete: false })
  })

  it('puts unfinished deletions first, then the most recently deleted, then by name', () => {
    const rows = trashRows([
      trashed('old', 20), trashed('new', 1), trashed('b-same', 5), trashed('a-same', 5),
      record('half', 'purge-started', { purge: { ...preview('half', [item('path', 'a', { status: 'removed' }), item('worktree', 'b')]), operationId: 'op-9', startedAt: iso(10), discardAuthorized: false } })
    ], { 'a-same': 'Alpha', 'b-same': 'Beta', old: 'Old', new: 'New', half: 'Half' }, POLICY, { now: NOW })
    expect(rows.map((row) => row.name)).toEqual(['Half', 'New', 'Alpha', 'Beta', 'Old'])
  })

  it('says when each thread was deleted and how many days of retention are left', () => {
    const [today, three, overdue] = trashRows([trashed('a', 0), trashed('b', 3), trashed('c', 40)], { a: 'A', b: 'B', c: 'C' }, POLICY, { now: NOW })
    expect(today!.meta).toBe('Deleted today · Permanently deleted in 30 days')
    expect(three!.meta).toBe('Deleted 3 days ago · Permanently deleted in 27 days')
    expect(overdue!.meta).toBe('Deleted 40 days ago · Permanently deleted at the next cleanup')
  })

  it('reads the retention rule: kept until deleted when automatic emptying is off, paused after a clock change', () => {
    const at = NOW - 29 * DAY - 1000
    expect(retentionLabel(at, { ...POLICY, automaticPurge: false }, false, NOW)).toBe('Kept until you delete it')
    expect(retentionLabel(at, POLICY, true, NOW)).toBe('Automatic deletion is paused')
    expect(retentionLabel(at, POLICY, false, NOW)).toBe('Permanently deleted in 1 day')
    expect(retentionLabel(at, undefined, false, NOW)).toBeUndefined()
    const [row] = trashRows([trashed('a', 2)], { a: 'A' }, { ...POLICY, graceDays: 7 }, { now: NOW })
    expect(row!.meta).toBe('Deleted 2 days ago · Permanently deleted in 5 days')
  })

  it('shows why a thread is kept in the trash and how far an unfinished deletion got', () => {
    const rows = trashRows([
      trashed('held', 4, { blockedReason: 'Automatic trash cleanup retains unpublished or sole-copy content.' }),
      record('half', 'purge-started', { purge: { ...preview('half', [item('path', 'a', { status: 'removed' }), item('worktree', 'b'), item('ref', 'c')]), operationId: 'op-9', startedAt: iso(1), discardAuthorized: false, error: 'Purge could not remove a locked resource.' } })
    ], {}, POLICY, { now: NOW })
    const half = rows.find((row) => row.taskId === 'half')!
    expect(half).toMatchObject({ meta: 'Deletion started · 1 of 3 removed · can’t be restored', note: 'Purge could not remove a locked resource.', canRetry: true, canRestore: false, canDelete: false })
    expect(rows.find((row) => row.taskId === 'held')).toMatchObject({ note: 'Automatic trash cleanup retains unpublished or sole-copy content.', canRestore: true, canDelete: true, canRetry: false })
  })
})

describe('permanent deletion summary', () => {
  it('names what is lost and what it frees', () => {
    const summary = summarizeDeletion(preview('t', safe, { exclusiveBytes: 1536 }), 'Fix login', { bytes: 2 * 1024 ** 3, estimated: false, partial: false })
    expect(summary.headline).toBe('Permanently deletes the transcript, worktree and branch of “Fix login”. This can’t be undone.')
    expect(summary.frees).toBe('Frees 2.00 GB.')
    expect(summary).toMatchObject({ needsDiscard: false, unpublishedWorktrees: 0, soleCopyPaths: 0, blockers: [] })
    expect(summary.discardWarning).toBeUndefined()
  })

  it('names unpublished work and only-copy files, and says "about" for an estimate', () => {
    const summary = summarizeDeletion(
      preview('t', [item('path', 'scratch', { discardRequired: true }), item('worktree', 'a', { discardRequired: true }), item('worktree', 'b', { discardRequired: true })]),
      'Fix login', { bytes: 1024, estimated: true, partial: false })
    expect(summary.lost).toBe('transcript and worktree')
    expect(summary).toMatchObject({ needsDiscard: true, unpublishedWorktrees: 2, soleCopyPaths: 1 })
    expect(summary.discardWarning).toBe('Unpublished work will be lost: 2 worktrees have unpublished work; 1 folder holds files that exist nowhere else.')
    expect(summary.frees).toBe('Frees about 1.0 KB.')
    expect(summarizeDeletion(preview('t', safe), 'x', { bytes: 1024, estimated: false, partial: true }).frees).toBe('Frees about 1.0 KB.')
  })

  it('falls back to the preview size, singular wording, and carries blockers', () => {
    const summary = summarizeDeletion(preview('t', [item('worktree', 'a', { discardRequired: true })], { exclusiveBytes: 10, blockers: ['Workspace retained: /x: busy'] }), 'x')
    expect(summary.frees).toBe('Frees 10 B.')
    expect(summary.discardWarning).toBe('Unpublished work will be lost: 1 worktree has unpublished work.')
    expect(summary.blockers).toEqual(['Workspace retained: /x: busy'])
  })
})

describe('recently deleted controller', () => {
  it('reads the inventory once for overlapping refreshes and publishes it', async () => {
    const daemon = fakeDaemon([trashed('a', 2)])
    const controller = createTrashController(daemon.api, quiet)
    expect(controller.getState().loaded).toBe(false)
    await Promise.all([controller.refresh(), controller.refresh(), controller.refresh()])
    expect(daemon.calls.inventory).toBe(1)
    expect(controller.getState()).toMatchObject({ loaded: true, policy: POLICY, paused: false })
    expect(controller.getState().records.map((entry) => entry.taskId)).toEqual(['a'])
  })

  it('keeps the list and reports a failed refresh without throwing', async () => {
    const daemon = fakeDaemon([trashed('a', 2)])
    const controller = createTrashController(daemon.api, quiet)
    await controller.refresh()
    const failing = { ...daemon.api, inventory: () => Promise.reject(new Error('socket closed')) }
    const second = createTrashController(failing, quiet)
    await expect(second.refresh()).resolves.toBeUndefined()
    expect(second.getState().refreshError).toBe('Unable to refresh recently deleted threads. Please try again.')
    expect(controller.getState().refreshError).toBeUndefined()
  })

  it('restores a thread and the list no longer shows it afterwards', async () => {
    const daemon = fakeDaemon([trashed('a', 2), trashed('b', 3)])
    const controller = createTrashController(daemon.api, quiet)
    await controller.refresh()
    expect(await controller.restore('a')).toBe(true)
    expect(daemon.calls.restore).toEqual(['a'])
    const state = controller.getState()
    expect(state.busyTaskId).toBeUndefined()
    expect(state.notice).toBeUndefined()
    expect(trashRows(state.records, state.taskNames, state.policy, { now: NOW }).map((row) => row.taskId)).toEqual(['b'])
    expect(daemon.records.find((entry) => entry.taskId === 'a')?.state).toBe('active')
  })

  it('shows why a restore failed, keeps the row, and re-reads the list', async () => {
    const daemon = fakeDaemon([trashed('a', 2)])
    daemon.behaviour.restore = () => Promise.reject(publicError('resource_purge_io_error', 'Another operation owns this thread; try again.'))
    const controller = createTrashController(daemon.api, quiet)
    await controller.refresh()
    const before = daemon.calls.inventory
    expect(await controller.restore('a')).toBe(false)
    expect(daemon.calls.inventory).toBe(before + 1)
    expect(controller.getState().notice).toEqual({ taskId: 'a', message: 'Another operation owns this thread; try again.' })
    expect(controller.getState().busyTaskId).toBeUndefined()
    expect(trashRows(controller.getState().records, {}, POLICY, { now: NOW })).toHaveLength(1)
    // The next action clears the old reason.
    daemon.behaviour.restore = undefined
    expect(await controller.restore('a')).toBe(true)
    expect(controller.getState().notice).toBeUndefined()
  })

  it('runs one action at a time and skips background refreshes while it runs', async () => {
    const daemon = fakeDaemon([trashed('a', 2), trashed('b', 3)])
    let release!: () => void
    daemon.behaviour.restore = () => new Promise<void>((resolve) => { release = () => { daemon.set('a', { state: 'active' }); resolve() } })
    const controller = createTrashController(daemon.api, quiet)
    await controller.refresh()
    const first = controller.restore('a')
    await vi.waitFor(() => expect(controller.getState().busyTaskId).toBe('a'))
    expect(await controller.restore('b')).toBe(false)
    expect(await controller.requestPurge('b')).toBe(false)
    const calls = daemon.calls.inventory
    await controller.refresh()
    expect(daemon.calls.inventory).toBe(calls)
    release()
    expect(await first).toBe(true)
    expect(daemon.calls.restore).toEqual(['a'])
    expect(controller.getState().busyTaskId).toBeUndefined()
  })

  it('waits for an older inventory read before the action so a late snapshot cannot undo it', async () => {
    const daemon = fakeDaemon([trashed('a', 2)])
    let open!: () => void
    daemon.behaviour.inventoryGate = new Promise<void>((resolve) => { open = resolve })
    const controller = createTrashController(daemon.api, quiet)
    const stale = controller.refresh()
    const restoring = controller.restore('a')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(daemon.calls.restore).toEqual([])
    daemon.behaviour.inventoryGate = undefined
    open()
    await stale
    expect(await restoring).toBe(true)
    expect(controller.getState().records.find((entry) => entry.taskId === 'a')?.state).toBe('active')
  })

  describe('permanent delete', () => {
    it('previews first, sends the reviewed digest and generation, and drops the row when it succeeds', async () => {
      const daemon = fakeDaemon([trashed('a', 2)], { reclaim: { bytes: 5000, estimated: false, partial: false } })
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      expect(await controller.requestPurge('a')).toBe(true)
      expect(daemon.calls.purge).toEqual([{ taskId: 'a', options: { preview: true } }])
      expect(controller.getState().confirmation).toMatchObject({ taskId: 'a', name: 'Thread a', discard: false, submitting: false, reclaim: { bytes: 5000 } })
      expect(await controller.confirmPurge()).toBe(true)
      expect(daemon.calls.purge[1]).toEqual({ taskId: 'a', options: { operationId: 'op-1', expectedGeneration: 3, previewDigest: 'digest-1', discard: false } })
      const state = controller.getState()
      expect(state.confirmation).toBeUndefined()
      expect(trashRows(state.records, state.taskNames, state.policy, { now: NOW })).toEqual([])
      expect(trashCount(state.records)).toBe(0)
    })

    it('shows the confirmation only once the controller is idle, so an immediate confirm is accepted', async () => {
      const daemon = fakeDaemon([trashed('a', 2)])
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      const seen: Array<{ confirmation: boolean; busy: boolean }> = []
      controller.subscribe(() => { const state = controller.getState(); if (state.confirmation) seen.push({ confirmation: true, busy: state.busyTaskId !== undefined }) })
      await controller.requestPurge('a')
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((entry) => !entry.busy)).toBe(true)
      expect(await controller.confirmPurge()).toBe(true)
    })

    it('cancelling deletes nothing and leaves the thread restorable', async () => {
      const daemon = fakeDaemon([trashed('a', 2)])
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      controller.cancelPurge()
      expect(controller.getState().confirmation).toBeUndefined()
      expect(daemon.calls.purge.every((call) => call.options?.preview)).toBe(true)
      expect(await controller.confirmPurge()).toBe(false)
      expect(await controller.restore('a')).toBe(true)
    })

    it('never deletes unpublished work until it is explicitly accepted, then sends discard', async () => {
      const daemon = fakeDaemon([trashed('a', 2)], { previews: { a: preview('a', unpublished) } })
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      expect(await controller.confirmPurge()).toBe(false)
      expect(daemon.calls.purge).toHaveLength(1)
      controller.setDiscard(true)
      controller.setDiscard(false)
      expect(await controller.confirmPurge()).toBe(false)
      controller.setDiscard(true)
      expect(await controller.confirmPurge()).toBe(true)
      expect(daemon.calls.purge[1]!.options).toMatchObject({ discard: true, previewDigest: 'digest-1' })
    })

    it('never overrides a blocker, even with the discard box ticked', async () => {
      const daemon = fakeDaemon([trashed('a', 2)], { previews: { a: preview('a', unpublished, { blockers: ['Workspace retained: /x/wt: a terminal is open'] }) } })
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      controller.setDiscard(true)
      expect(await controller.confirmPurge()).toBe(false)
      expect(daemon.calls.purge).toHaveLength(1)
      expect(controller.getState().confirmation?.preview.blockers).toEqual(['Workspace retained: /x/wt: a terminal is open'])
    })

    it('keeps the dialog open with the reason when the daemon refuses because the thread is busy', async () => {
      const daemon = fakeDaemon([trashed('a', 2)])
      daemon.behaviour.purge = () => Promise.reject(publicError('resource_purge_io_error', 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.'))
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      const before = daemon.calls.inventory
      expect(await controller.confirmPurge()).toBe(false)
      const state = controller.getState()
      expect(state.confirmation).toMatchObject({ taskId: 'a', submitting: false, error: expect.stringContaining('locked or permission-protected resource') })
      expect(state.notice).toBeUndefined()
      expect(state.busyTaskId).toBeUndefined()
      expect(daemon.calls.inventory).toBe(before + 1)
      expect(trashRows(state.records, state.taskNames, state.policy, { now: NOW })).toHaveLength(1)
      // The person can try again once the lock is gone.
      daemon.behaviour.purge = undefined
      expect(await controller.confirmPurge()).toBe(true)
      expect(controller.getState().confirmation).toBeUndefined()
    })

    it('closes the dialog and shows the reason on the row when a deletion started and then failed', async () => {
      const daemon = fakeDaemon([trashed('a', 2)])
      daemon.behaviour.purge = async (taskId) => {
        daemon.set(taskId, { state: 'purge-started', purge: { ...preview(taskId, [item('path', 'p', { status: 'removed' }), item('worktree', 'w')]), operationId: 'op-1', startedAt: iso(0), discardAuthorized: false, error: 'Purge could not remove a locked resource.' } })
        throw publicError('resource_purge_io_error', 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.')
      }
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      expect(await controller.confirmPurge()).toBe(false)
      const state = controller.getState()
      expect(state.confirmation).toBeUndefined()
      expect(state.notice).toMatchObject({ taskId: 'a', message: expect.stringContaining('locked or permission-protected') })
      const [row] = trashRows(state.records, state.taskNames, state.policy, { now: NOW })
      expect(row).toMatchObject({ state: 'purge-started', canRetry: true, canRestore: false, note: 'Purge could not remove a locked resource.' })
    })

    it('retries an unfinished deletion with its original operation and refreshes the list', async () => {
      const half = record('a', 'purge-started', { purge: { ...preview('a', [item('path', 'p', { status: 'removed' }), item('worktree', 'w')]), operationId: 'op-original', startedAt: iso(1), discardAuthorized: true } })
      const daemon = fakeDaemon([half])
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      expect(await controller.retryPurge('a')).toBe(true)
      expect(daemon.calls.purge).toEqual([{ taskId: 'a', options: { operationId: 'op-original' } }])
      expect(trashCount(controller.getState().records)).toBe(0)
      expect(await controller.retryPurge('missing')).toBe(false)
    })

    it('reloads the preview when the thread changed since it was reviewed, and asks again for the discard tick', async () => {
      const daemon = fakeDaemon([trashed('a', 2)], { previews: { a: preview('a', unpublished) } })
      daemon.behaviour.purge = () => Promise.reject(publicError('resource_purge_preview_stale', 'Purge preview changed; review a fresh inventory.'))
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      controller.setDiscard(true)
      expect(await controller.confirmPurge()).toBe(false)
      const previews = daemon.calls.purge.filter((call) => call.options?.preview)
      expect(previews).toHaveLength(2)
      expect(controller.getState().confirmation).toMatchObject({ discard: false, error: 'Purge preview changed; review a fresh inventory.' })
    })

    it('does not leak internal error text from an unclassified failure', async () => {
      const daemon = fakeDaemon([trashed('a', 2)])
      daemon.behaviour.purge = () => Promise.reject(new Error('EBUSY: C:\\Users\\someone\\secret'))
      const controller = createTrashController(daemon.api, quiet)
      await controller.refresh()
      await controller.requestPurge('a')
      await controller.confirmPurge()
      const message = controller.getState().confirmation?.error ?? ''
      expect(message).toContain('Reference:')
      expect(message).not.toContain('secret')
    })
  })

  describe('following thread updates', () => {
    it('refreshes once, after a pause, only when the set of threads changed', async () => {
      vi.useFakeTimers()
      const daemon = fakeDaemon([trashed('a', 2)])
      const controller = createTrashController(daemon.api, quiet)
      controller.threadsChanged(['x', 'y'])
      controller.threadsChanged(['y', 'x'])
      await vi.advanceTimersByTimeAsync(1000)
      expect(daemon.calls.inventory).toBe(0)
      controller.threadsChanged(['x'])
      controller.threadsChanged(['x', 'z'])
      expect(daemon.calls.inventory).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(daemon.calls.inventory).toBe(1)
      controller.dispose()
    })

    it('stops pending refreshes when disposed and notifies subscribers of changes only while subscribed', async () => {
      vi.useFakeTimers()
      const daemon = fakeDaemon([trashed('a', 2)])
      const controller = createTrashController(daemon.api, quiet)
      const seen: boolean[] = []
      const off = controller.subscribe(() => seen.push(controller.getState().loaded))
      controller.threadsChanged(['x'])
      controller.threadsChanged(['y'])
      controller.dispose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(daemon.calls.inventory).toBe(0)
      await controller.refresh()
      expect(seen).toContain(true)
      off()
      const count = seen.length
      await controller.restore('a')
      expect(seen).toHaveLength(count)
    })
  })
})
