import { create } from 'zustand'
import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { cleanTitleText, fitTitle, heuristicTitle } from '../../shared/threadTitleText'
import type { Thread, ThreadActivitySnapshot } from '../../shared/types'

/**
 * The sidebar row of a thread a send is starting. It is listed in the same frame as the click on Send, before
 * anything is awaited (the service has not made or started the thread yet), named from the prompt and shown Working.
 * The thread's own row takes its place, under the same React key, once the service lists it, so the row neither
 * remounts nor moves. It is kept apart from the thread list, so a list push that comes before or after the service
 * answers cannot drop it or list it twice.
 */
export interface PendingThreadRow {
  /** The row's key: the shown empty thread's id when the send uses it, else `pending:<uuid>` until the thread is made. */
  key: string
  profileId: string | null
  /** What the row shows until the service lists the thread as started. */
  thread: Thread
  /** The thread the composer showed at the click (null for none). While it still shows, the pending row is the open one. */
  from: string | null
  /** The thread the service made, or the empty one the send uses. */
  threadId?: string
  /** The thread as the service made it, listed if the send stops before its first message went. */
  made?: Thread
  /** Threads listed at the click: a new one in the same place that a list push brings before the create answers is this one. */
  listedAtSend: ReadonlySet<string>
}

const PENDING_PREFIX = 'pending:'

/** Whether a row id is a pending row's own key, with no thread behind it yet. */
export function isPendingRowId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX)
}

/** The row's name: the first words of the prompt, as the service names it on the first send; the default name without any. */
export function pendingRowTitle(text: string): string {
  return heuristicTitle(text) || fitTitle(cleanTitleText(text).text) || 'New Thread'
}

/** Where a new thread goes and what it is, as the composer shows it at the click. */
export interface PendingRowWorkspace {
  projectId?: string
  node?: string
  localOnly?: boolean
  worktreeEnabled?: boolean
  expiryMs?: number
  expiryStopsRun?: boolean
}

/**
 * The pending row for a send from the new-chat composer, or undefined when the send starts no thread (a slash
 * command, or nothing to send). `shown` is the empty thread on screen; `reuses` says the send uses it rather than
 * making one (`composerCreatesThread`).
 */
export function pendingThreadRow(input: {
  profileId: string | null
  text: string
  attached: boolean
  shown: Thread | undefined
  reuses: boolean
  workspace: PendingRowWorkspace
  threads: readonly Thread[]
  now?: number
  newKey?: () => string
}): PendingThreadRow | undefined {
  const trimmed = input.text.trim()
  if (trimmed.startsWith('/') || (!trimmed && !input.attached)) return undefined
  const at = input.now ?? Date.now()
  const iso = new Date(at).toISOString()
  const { workspace } = input
  const projectId = workspace.projectId
  // On top of its group, as the service puts a thread on its first send.
  const siblings = input.threads.filter((thread) => (thread.projectId ?? undefined) === projectId && !thread.settledAt && isThreadStarted(thread))
  const order = siblings.reduce((min, thread) => Math.min(min, thread.order), 0) - 1
  const name = pendingRowTitle(trimmed)
  const named = isDefaultThreadName(name) ? {} : { name, titleSource: 'provisional' as const }
  const from = input.shown?.id ?? null
  const listedAtSend = new Set(input.threads.map((thread) => thread.id))
  if (input.reuses && input.shown) {
    return {
      key: input.shown.id,
      profileId: input.profileId,
      thread: { ...input.shown, startedAt: iso, updatedAt: iso, order, ...named },
      from,
      threadId: input.shown.id,
      listedAtSend
    }
  }
  const key = `${PENDING_PREFIX}${input.newKey?.() ?? crypto.randomUUID()}`
  return {
    key,
    profileId: input.profileId,
    thread: {
      id: key,
      name: named.name ?? 'New Thread',
      ...(named.titleSource ? { titleSource: named.titleSource } : {}),
      createdAt: iso,
      updatedAt: iso,
      startedAt: iso,
      order,
      ...(projectId ? { projectId } : {}),
      ...(workspace.localOnly ? { localOnly: true } : workspace.node ? { node: workspace.node } : {}),
      ...(projectId && workspace.worktreeEnabled ? { worktreeEnabled: true } : {}),
      ...(workspace.expiryMs !== undefined && !workspace.node
        ? { expiresAt: new Date(at + workspace.expiryMs).toISOString(), ...(workspace.expiryStopsRun ? { expiryStopsRun: true } : {}) }
        : {})
    },
    from,
    listedAtSend
  }
}

function samePlace(thread: Thread, row: Thread): boolean {
  return (
    (thread.projectId ?? undefined) === (row.projectId ?? undefined) &&
    (thread.node ?? undefined) === (row.node ?? undefined) &&
    Boolean(thread.localOnly) === Boolean(row.localOnly)
  )
}

/** The thread list as the sidebar shows it, with each pending send's row in it. */
export interface ShownThreads {
  threads: Thread[]
  activity: ThreadActivitySnapshot
  /** The React key of each row that began as a pending row, by the id it is listed under now. */
  rowKeys: ReadonlyMap<string, string>
  /** The row highlighted as open: a pending row while the composer it was sent from still shows. */
  openRowId: string | null
}

/**
 * Lists each pending row in `threads`: in place of its thread once the service lists it (named from the prompt and
 * shown Working until the service says otherwise), else as a row of its own. A thread made for a pending send that
 * a list push brings before the create answers is recognised as it (new since the click, in the same place, started),
 * so it is never listed twice. A thread with no pending row is listed as it is.
 */
export function withPendingRows(
  threads: Thread[],
  rows: readonly PendingThreadRow[],
  activity: ThreadActivitySnapshot,
  activeThreadId: string | null,
  rowKeys: ReadonlyMap<string, string> = new Map()
): ShownThreads {
  if (rows.length === 0) return { threads, activity, rowKeys, openRowId: activeThreadId }
  const out = threads.slice()
  const keys = new Map(rowKeys)
  const starting: string[] = []
  const claimed = new Set(rows.flatMap((row) => (row.threadId ? [row.threadId] : [])))
  let openRowId = activeThreadId
  for (const row of rows) {
    let index = row.threadId ? out.findIndex((thread) => thread.id === row.threadId) : -1
    if (!row.threadId) {
      index = out.findIndex((thread) =>
        !row.listedAtSend.has(thread.id) && !claimed.has(thread.id) && Boolean(thread.startedAt) && !thread.settledAt && !thread.lineage && samePlace(thread, row.thread))
      if (index !== -1) claimed.add(out[index]!.id)
    }
    // The send is still on the composer it came from: its row is the open one.
    if (row.from === activeThreadId) openRowId = index === -1 ? row.key : out[index]!.id
    if (index === -1) {
      out.push(row.thread)
      starting.push(row.key)
      continue
    }
    const real = out[index]!
    keys.set(real.id, row.key)
    out[index] = {
      ...real,
      ...(real.startedAt ? {} : { startedAt: row.thread.startedAt, order: row.thread.order }),
      // Named from the prompt until the service names it (the same words, from the same message).
      ...(isDefaultThreadName(real.name) && !isDefaultThreadName(row.thread.name) ? { name: row.thread.name, titleSource: 'provisional' as const } : {})
    }
    starting.push(real.id)
  }
  // Working until the service reports the thread's own state.
  let shownActivity = activity
  for (const id of starting) {
    if (activity[id] !== undefined && activity[id] !== 'idle') continue
    if (shownActivity === activity) shownActivity = { ...activity }
    shownActivity[id] = 'processing'
  }
  return { threads: out, activity: shownActivity, rowKeys: keys, openRowId }
}

/**
 * Resolves once the next frame has been drawn, so work that follows (renders of the composer and transcript, the
 * service calls) does not hold back the frame that shows the pending row. A window that draws no frame (hidden) goes
 * on after `fallbackMs`.
 */
export function afterNextPaint(fallbackMs = 50): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve()
      return
    }
    const timer = setTimeout(resolve, fallbackMs)
    // The frame is drawn after its animation frame callbacks run; a task queued from one runs after the drawing.
    requestAnimationFrame(() => setTimeout(() => {
      clearTimeout(timer)
      resolve()
    }, 0))
  })
}

interface PendingThreadRowsState {
  rows: PendingThreadRow[]
  /** Row keys of threads that began as pending rows, kept so their row keeps its key after the pending row goes. */
  rowKeys: ReadonlyMap<string, string>
}

export const usePendingThreadRows = create<PendingThreadRowsState>(() => ({ rows: [], rowKeys: new Map() }))

/** Lists a pending row now. */
export function addPendingThreadRow(row: PendingThreadRow): PendingThreadRow {
  usePendingThreadRows.setState((state) => ({ rows: [...state.rows.filter((entry) => entry.key !== row.key), row] }))
  return row
}

/** The service made the row's thread: its row is that thread's from now on. */
export function claimPendingThreadRow(key: string, thread: Thread): Thread {
  usePendingThreadRows.setState((state) => {
    if (!state.rows.some((row) => row.key === key)) return state
    const rowKeys = new Map(state.rowKeys)
    rowKeys.set(thread.id, key)
    return { rows: state.rows.map((row) => (row.key === key ? { ...row, threadId: thread.id, made: thread } : row)), rowKeys }
  })
  return thread
}

/**
 * The send is over: its thread's row (if the service started one) is listed from the thread list alone. A send that
 * stopped before its first message went leaves a thread the service made listed as made, so its row does not blink
 * out until the next list push; an empty thread it would have used is not listed again.
 */
export function settlePendingThreadRow(key: string, listMade: (thread: Thread) => void): void {
  const row = usePendingThreadRows.getState().rows.find((entry) => entry.key === key)
  if (!row) return
  if (row.made && isThreadStarted(row.made)) listMade(row.made)
  usePendingThreadRows.setState((state) => ({ rows: state.rows.filter((entry) => entry.key !== key) }))
}
