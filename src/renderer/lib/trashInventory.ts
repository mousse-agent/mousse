import { errorDiagnostic, knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'
import type { LifecycleState, LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { formatBytes } from '../../shared/storage'
import type { ThreadSearchSkipped } from '../../shared/types'

/**
 * The "Recently deleted" list: which lifecycle records show, how they read and sort, and the
 * controller that restores, previews and permanently deletes them. No React in here, so the
 * whole flow runs in plain tests.
 */

const DAY_MS = 86_400_000
/** Threads that are not in (or on their way into) the trash. */
const LIVE_STATES: ReadonlySet<LifecycleState> = new Set(['active', 'draining'])
const REFRESH_DEBOUNCE_MS = 400

/**
 * A lifecycle record as the list shows it. A record of another of the user's computers names that computer
 * (`node`, `computerName`): it can be restored from here, but it is permanently deleted only there.
 */
export type TrashRecord = TaskLifecycleRecord & { node?: string; computerName?: string }

export interface TrashInventoryReply {
  lifecycles: TrashRecord[]
  taskNames?: Record<string, string>
  trashPolicy: TrashRetentionPolicy
  trashSweepStatus: { suspended: boolean; reason?: string }
  /** The other computers whose trash could not be read this time. */
  skipped?: ThreadSearchSkipped[]
}
export interface PurgeReclaim { bytes: number; estimated: boolean; partial: boolean }
export interface PurgeInput { preview?: boolean; operationId?: string; expectedGeneration?: number; previewDigest?: string; discard?: boolean }
export interface TrashApi {
  inventory(): Promise<TrashInventoryReply>
  restore(threadId: string): Promise<unknown>
  purge(threadId: string, options?: PurgeInput): Promise<{ preview?: LifecyclePurgePreview; reclaim?: PurgeReclaim }>
}

export interface TrashRow {
  taskId: string
  state: LifecycleState
  name: string
  /** "Deleted 3 days ago · permanently deleted in 27 days" */
  meta?: string
  /** Why this one stays or what went wrong, shown under the row. */
  note?: string
  canRestore: boolean
  canDelete: boolean
  canRetry: boolean
  /** The computer that holds the thread, for a thread of another computer. */
  computer?: string
}

/** Why a thread of another computer cannot be permanently deleted from here. */
export const deleteElsewhere = (computer: string): string => `Delete permanently on ${computer}`

/** Same timestamp fallback as the daemon's sweep; this is presentation only. */
export function trashedAtMs(record: TaskLifecycleRecord): number | undefined {
  const completed = record.operations.filter((operation) => operation.kind === 'trash' && operation.phase === 'completed').at(-1)?.completedAt
  const time = Date.parse(record.trashedAt ?? completed ?? record.createdAt)
  return Number.isFinite(time) ? time : undefined
}

export function deletedAgo(trashedAt: number, now: number): string {
  const days = Math.floor(Math.max(0, now - trashedAt) / DAY_MS)
  if (days === 0) return 'Deleted today'
  return days === 1 ? 'Deleted yesterday' : `Deleted ${days} days ago`
}

/** The retention rule in words: when the automatic emptying would delete it, or that it will not. */
export function retentionLabel(trashedAt: number, policy: TrashRetentionPolicy | undefined, paused: boolean, now: number): string | undefined {
  if (!policy) return undefined
  if (!policy.automaticPurge) return 'Kept until you delete it'
  if (paused) return 'Automatic deletion is paused'
  const days = Math.ceil((trashedAt + policy.graceDays * DAY_MS - now) / DAY_MS)
  if (days <= 0) return 'Permanently deleted at the next cleanup'
  return days === 1 ? 'Permanently deleted in 1 day' : `Permanently deleted in ${days} days`
}

const isListed = (record: TrashRecord) => !record.parentTaskId && record.state !== 'purged' && !LIVE_STATES.has(record.state)

/** How many root threads are in (or entering) the trash. */
export function trashCount(records: readonly TrashRecord[]): number {
  return records.filter(isListed).length
}

/** Root threads in (or entering) the trash, unfinished deletions first, then newest deletion first. */
export function trashRows(
  records: readonly TrashRecord[],
  taskNames: Record<string, string>,
  policy: TrashRetentionPolicy | undefined,
  options: { now?: number; paused?: boolean } = {}
): TrashRow[] {
  const now = options.now ?? Date.now()
  const listed = records.filter(isListed)
  const key = (record: TrashRecord) => trashedAtMs(record) ?? Date.parse(record.updatedAt) ?? 0
  const name = (record: TrashRecord) => taskNames[record.taskId] ?? 'Untitled thread'
  return [...listed]
    .sort((a, b) =>
      Number(b.state === 'purge-started') - Number(a.state === 'purge-started') ||
      (key(b) || 0) - (key(a) || 0) ||
      name(a).localeCompare(name(b)) ||
      a.taskId.localeCompare(b.taskId))
    .map((record) => {
      const idle = record.state === 'trashed'
      const parts: string[] = []
      let note: string | undefined
      switch (record.state) {
        case 'trash-moving': parts.push('Moving to trash…'); break
        case 'restore-moving': parts.push('Restoring…'); break
        case 'blocked': note = record.blockedReason ?? 'Blocked'; break
        case 'purge-started': {
          const items = record.purge?.items ?? []
          parts.push(`Deletion started · ${items.filter((item) => item.status === 'removed').length} of ${items.length} removed · can’t be restored`)
          note = record.purge?.error
          break
        }
        case 'trashed': {
          const trashedAt = trashedAtMs(record)
          if (trashedAt !== undefined) {
            parts.push(deletedAgo(trashedAt, now))
            const retention = retentionLabel(trashedAt, policy, options.paused ?? false, now)
            if (retention) parts.push(retention)
          }
          note = record.blockedReason
          break
        }
        default: break
      }
      return {
        taskId: record.taskId,
        state: record.state,
        name: name(record),
        ...(parts.length ? { meta: parts.join(' · ') } : {}),
        ...(note ? { note } : {}),
        canRestore: idle,
        // Permanent delete cannot be undone, so it stays on the computer that holds the thread.
        canDelete: idle && !record.node,
        // A deletion that began on another computer is retried there; this one cannot purge its threads.
        canRetry: record.state === 'purge-started' && Boolean(record.purge?.operationId) && !record.node,
        ...(record.node ? { computer: record.computerName ?? 'the other computer' } : {})
      }
    })
}

function joinWords(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

export interface DeletionSummary {
  /** What permanent deletion removes, in words: "transcript, worktree and branch". */
  lost: string
  headline: string
  frees: string
  /** Worktrees whose results exist nowhere else. */
  unpublishedWorktrees: number
  /** Files outside Git that exist nowhere else. */
  soleCopyPaths: number
  needsDiscard: boolean
  /** Names the work that would be lost; present exactly when `needsDiscard`. */
  discardWarning?: string
  blockers: string[]
}

/** The one-glance reading of a purge preview, so the dialog can lead with what is lost. */
export function summarizeDeletion(preview: LifecyclePurgePreview, name: string, reclaim?: PurgeReclaim): DeletionSummary {
  const kinds = new Set(preview.items.map((item) => item.kind))
  const lost = joinWords([
    'transcript',
    ...(kinds.has('worktree') ? ['worktree'] : []),
    ...(kinds.has('ref') ? ['branch'] : []),
    ...(kinds.has('scheduled-row') ? ['scheduled tasks'] : [])
  ])
  const unpublishedWorktrees = preview.items.filter((item) => item.kind === 'worktree' && item.discardRequired).length
  const soleCopyPaths = preview.items.filter((item) => item.kind === 'path' && item.discardRequired).length
  const needsDiscard = unpublishedWorktrees > 0 || soleCopyPaths > 0
  const approximate = Boolean(reclaim && (reclaim.estimated || reclaim.partial))
  const bytes = reclaim?.bytes ?? preview.exclusiveBytes
  const lostWork: string[] = []
  if (unpublishedWorktrees) lostWork.push(`${unpublishedWorktrees} ${unpublishedWorktrees === 1 ? 'worktree has' : 'worktrees have'} unpublished work`)
  if (soleCopyPaths) lostWork.push(`${soleCopyPaths} ${soleCopyPaths === 1 ? 'folder holds' : 'folders hold'} files that exist nowhere else`)
  return {
    lost,
    headline: `Permanently deletes the ${lost} of “${name}”. This can’t be undone.`,
    frees: `Frees ${approximate ? 'about ' : ''}${formatBytes(bytes)}.`,
    unpublishedWorktrees,
    soleCopyPaths,
    needsDiscard,
    ...(needsDiscard ? { discardWarning: `Unpublished work will be lost: ${lostWork.join('; ')}.` } : {}),
    blockers: preview.blockers
  }
}

export function trashErrorMessage(cause: unknown): string {
  const shape = cause as Partial<AppErrorShape> | null
  const descriptor = shape && typeof shape.code === 'string' && typeof shape.message === 'string' && parseErrorInfo(shape.errorInfo)
    ? knownAppError(shape as AppErrorShape)
    : normalizeAppError(cause, 'storage_request_failed')
  return descriptor.message
}

export interface PurgeConfirmation {
  taskId: string
  name: string
  preview: LifecyclePurgePreview
  reclaim?: PurgeReclaim
  discard: boolean
  submitting: boolean
  /** Why the last attempt did not go through (busy, blocked, changed since the preview). */
  error?: string
}
export interface TrashState {
  loaded: boolean
  records: TrashRecord[]
  taskNames: Record<string, string>
  policy?: TrashRetentionPolicy
  paused: boolean
  /** The other computers whose trash is not in the list this time. */
  skipped?: ThreadSearchSkipped[]
  /** A request is running for this thread; every action waits. */
  busyTaskId?: string
  /** The last background refresh failed. */
  refreshError?: string
  /** The last action on `taskId` failed; kept until the next action. */
  notice?: { taskId: string; message: string }
  confirmation?: PurgeConfirmation
}

export interface TrashController {
  getState(): TrashState
  subscribe(listener: () => void): () => void
  /** Single-flight; background callers skip while an action runs. */
  refresh(): Promise<void>
  /** Fed with the current thread ids; refreshes (debounced) only when the set changed. */
  threadsChanged(ids: readonly string[]): void
  restore(taskId: string): Promise<boolean>
  requestPurge(taskId: string): Promise<boolean>
  setDiscard(discard: boolean): void
  confirmPurge(): Promise<boolean>
  cancelPurge(): void
  retryPurge(taskId: string): Promise<boolean>
  /** Stops timers. The controller stays usable. */
  dispose(): void
}

export function createTrashController(
  api: TrashApi,
  options: { newOperationId?: () => string; onError?: (cause: unknown, operation: string) => void } = {}
): TrashController {
  const newOperationId = options.newOperationId ?? (() => crypto.randomUUID())
  const onError = options.onError ?? ((cause, operation) => console.error('Recently deleted request failed', errorDiagnostic(normalizeAppError(cause, 'storage_request_failed'), operation)))
  let state: TrashState = { loaded: false, records: [], taskNames: {}, paused: false }
  const listeners = new Set<() => void>()
  let inFlight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let seenThreads: string | undefined
  const set = (patch: Partial<TrashState>) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const load = (): Promise<void> => {
    if (inFlight) return inFlight
    const request = api.inventory().then((result) => {
      set({ loaded: true, records: result.lifecycles, taskNames: result.taskNames ?? {}, policy: result.trashPolicy, paused: result.trashSweepStatus.suspended, skipped: result.skipped, refreshError: undefined })
    }).finally(() => { if (inFlight === request) inFlight = null })
    inFlight = request
    return request
  }
  const settleConfirmation = () => {
    const confirmation = state.confirmation
    if (!confirmation) return
    // A purge that began (or finished) leaves the dialog behind: its preview no longer applies.
    if (state.records.find((record) => record.taskId === confirmation.taskId)?.state !== 'trashed') set({ confirmation: undefined })
  }
  /** One action at a time; the list is re-read afterwards whether or not it worked. */
  const act = async (taskId: string, operation: string, work: () => Promise<void>): Promise<boolean> => {
    if (state.busyTaskId) return false
    set({ busyTaskId: taskId, notice: undefined })
    let failure: string | undefined
    try {
      await inFlight?.catch(() => {})
      await work()
    } catch (cause) {
      onError(cause, operation)
      failure = trashErrorMessage(cause)
    }
    await load().catch((cause) => onError(cause, 'threads.inventory'))
    set({ busyTaskId: undefined, ...(failure ? { notice: { taskId, message: failure } } : {}) })
    settleConfirmation()
    return failure === undefined
  }
  const nameOf = (taskId: string) => state.taskNames[taskId] ?? 'Untitled thread'
  const fetchPreview = async (taskId: string): Promise<{ preview: LifecyclePurgePreview; reclaim?: PurgeReclaim }> => {
    const result = await api.purge(taskId, { preview: true })
    if (!result.preview) throw new Error('Deletion preview is unavailable')
    return { preview: result.preview, ...(result.reclaim ? { reclaim: result.reclaim } : {}) }
  }
  const confirmationFrom = (taskId: string, fetched: { preview: LifecyclePurgePreview; reclaim?: PurgeReclaim }): PurgeConfirmation =>
    ({ taskId, name: nameOf(taskId), ...fetched, discard: false, submitting: false })
  const refresh = async (): Promise<void> => {
    if (state.busyTaskId) return
    await load().catch((cause) => {
      onError(cause, 'threads.inventory')
      set({ refreshError: 'Unable to refresh recently deleted threads. Please try again.' })
    })
  }
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    threadsChanged(ids) {
      const signature = [...ids].sort().join('\n')
      const previous = seenThreads
      seenThreads = signature
      if (previous === undefined || previous === signature) return
      clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void refresh() }, REFRESH_DEBOUNCE_MS)
    },
    restore: (taskId) => act(taskId, 'threads.restore', async () => { await api.restore(taskId) }),
    async requestPurge(taskId) {
      const remote = state.records.find((record) => record.taskId === taskId)
      if (remote?.node) {
        set({ notice: { taskId, message: deleteElsewhere(remote.computerName ?? 'the other computer') } })
        return false
      }
      let fetched: Awaited<ReturnType<typeof fetchPreview>> | undefined
      const ok = await act(taskId, 'threads.purge.preview', async () => { fetched = await fetchPreview(taskId) })
      // Shown once the list is re-read and the controller is idle, so a quick confirm is never ignored.
      if (ok && fetched) set({ confirmation: confirmationFrom(taskId, fetched) })
      return ok
    },
    setDiscard(discard) {
      if (state.confirmation && !state.confirmation.submitting) set({ confirmation: { ...state.confirmation, discard } })
    },
    async confirmPurge() {
      const confirmation = state.confirmation
      if (!confirmation || confirmation.submitting || state.busyTaskId) return false
      const summary = summarizeDeletion(confirmation.preview, confirmation.name, confirmation.reclaim)
      // Unpublished work is only discarded after the person ticked the box; blockers are never overridden.
      if (summary.blockers.length || summary.needsDiscard && !confirmation.discard) return false
      set({ confirmation: { ...confirmation, submitting: true, error: undefined } })
      const { preview, taskId, discard } = confirmation
      let stale = false
      const ok = await act(taskId, 'threads.purge', async () => {
        try {
          await api.purge(taskId, { operationId: newOperationId(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard })
        } catch (cause) {
          stale = (cause as { code?: string } | null)?.code === 'resource_purge_preview_stale'
          throw cause
        }
      })
      if (ok) { set({ confirmation: undefined }); return true }
      const reason = state.notice?.message
      if (state.confirmation) {
        // Still trashed: stay open with the reason (busy, blocked, or the thread changed since the preview).
        set({ confirmation: { ...state.confirmation, submitting: false, ...(reason ? { error: reason } : {}) }, notice: undefined })
        if (stale) await fetchPreview(taskId).then((fetched) => set({ confirmation: { ...confirmationFrom(taskId, fetched), ...(reason ? { error: reason } : {}) } }), () => {})
      }
      return false
    },
    cancelPurge() {
      if (state.confirmation && !state.confirmation.submitting) set({ confirmation: undefined })
    },
    retryPurge(taskId) {
      const operationId = state.records.find((record) => record.taskId === taskId)?.purge?.operationId
      if (!operationId) return Promise.resolve(false)
      return act(taskId, 'threads.purge.retry', async () => { await api.purge(taskId, { operationId }) })
    },
    dispose() { clearTimeout(timer); timer = undefined }
  }
}
