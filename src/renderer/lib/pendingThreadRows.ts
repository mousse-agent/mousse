import { create } from 'zustand'
import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { cleanTitleText, fitTitle, heuristicTitle } from '../../shared/threadTitleText'
import type { Thread, ThreadActivitySnapshot } from '../../shared/types'
import { workspacePendingKey } from './newThread'

/**
 * The sidebar row of a thread a send is starting. It is listed in the same frame as the click on Send, before
 * anything is awaited (the service has not made or started the thread yet), named from the prompt and shown Working.
 * The thread's own row takes its place, under the same React key, once the service lists it, so the row neither
 * remounts nor moves. It is kept apart from the thread list, so a list push that comes before or after the service
 * answers cannot drop it or list it twice. Once its thread is known, the row is that thread's: a thread deleted later
 * is gone from the sidebar, never shown again as a pending row.
 */
export interface PendingThreadRow {
  /** The row's key: the shown empty thread's id when the send uses it, else `pending:<uuid>` until the thread is made. */
  key: string
  profileId: string | null
  /** What the row shows until the service lists the thread as started. */
  thread: Thread
  /** The thread the composer showed at the click (null for none). While it still shows, the pending row is the open one. */
  from: string | null
  /** The thread the service made, or the empty one the send uses. Set, the row is only ever that thread's. */
  threadId?: string
  /** Threads listed at the click: a new one in the same place that a list push brings before the create answers is this one. */
  listedAtSend: ReadonlySet<string>
  /** When Send was clicked (ms since the epoch). */
  at: number
}

const PENDING_PREFIX = 'pending:'
/** How far a thread's creation time may be before the click and still be the one the click made (clocks differ). */
const CLOCK_SKEW_MS = 10_000
/** How long a made thread's row keeps the pending row's key: past it, the row may remount once, unseen. */
const ROW_KEY_MS = 60_000

/** Whether a row id is a pending row's own key, with no thread behind it yet. */
export function isPendingRowId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX)
}

/** The row's name: the first words of the prompt, as the service names it on the first send; the default name without any. */
export function pendingRowTitle(text: string): string {
  return heuristicTitle(text) || fitTitle(cleanTitleText(text).text) || 'New Thread'
}

/** What was typed into the composer after `sent` was sent from it, while it was not locked yet: kept, not cleared. */
export function typedAfterSend(sent: string, now: string): string {
  return now.length > sent.length && now.startsWith(sent) ? now.slice(sent.length) : ''
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
      listedAtSend,
      at
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
    listedAtSend,
    at
  }
}

/** The same project (or none), the same computer and the same Private setting. */
function samePlace(thread: Thread, row: Thread): boolean {
  return (
    (thread.projectId ?? undefined) === (row.projectId ?? undefined) &&
    (thread.node ?? undefined) === (row.node ?? undefined) &&
    Boolean(thread.localOnly) === Boolean(row.localOnly)
  )
}

/**
 * Whether `thread`, brought by a list before the create answered, is the one this row's send made: new since the
 * click (not listed then, and made no earlier than the click allowing for clocks), in the same place, started, and
 * none of what makes threads on its own (a subagent, an automation's manager, a bot's chat in `exclude`).
 */
function madeForRow(thread: Thread, row: PendingThreadRow, exclude: ReadonlySet<string | undefined>): boolean {
  const created = Date.parse(thread.createdAt)
  return (
    !row.listedAtSend.has(thread.id) &&
    !exclude.has(thread.id) &&
    Boolean(thread.startedAt) &&
    !thread.settledAt &&
    !thread.lineage &&
    !thread.automationManager &&
    Number.isFinite(created) &&
    created >= row.at - CLOCK_SKEW_MS &&
    samePlace(thread, row.thread)
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
  /** Rows the service has not made or started yet: nothing can be done to them (open, rename, archive, drag, drop). */
  unmade: ReadonlySet<string>
}

/** A made thread's row key, and when it was made. */
export interface RowKey {
  key: string
  at: number
}

const NO_ROW_KEYS: ReadonlyMap<string, RowKey> = new Map()
const NONE: ReadonlySet<string> = new Set()

/**
 * Lists each pending row in `threads`: in place of its thread once the service lists it (named from the prompt and
 * shown Working until the service says otherwise), else as a row of its own until its thread is known. A row whose
 * thread is known but not listed (deleted meanwhile, or not pushed yet) shows nothing. A thread made for a pending
 * send that a list push brings before the create answers is recognised as it (`madeForRow`), so it is never listed
 * twice. A thread with no pending row is listed as it is.
 */
export function withPendingRows(
  threads: Thread[],
  rows: readonly PendingThreadRow[],
  activity: ThreadActivitySnapshot,
  activeThreadId: string | null,
  rowKeys: ReadonlyMap<string, RowKey> = NO_ROW_KEYS,
  exclude: ReadonlySet<string | undefined> = NONE
): ShownThreads {
  const keys = new Map([...rowKeys].map(([id, entry]) => [id, entry.key]))
  if (rows.length === 0) return { threads, activity, rowKeys: keys, openRowId: activeThreadId, unmade: NONE }
  const out = threads.slice()
  const starting: string[] = []
  const unmade = new Set<string>()
  const claimed = new Set(rows.flatMap((row) => (row.threadId ? [row.threadId] : [])))
  let openRowId = activeThreadId
  for (const row of rows) {
    let index: number
    if (row.threadId) {
      index = out.findIndex((thread) => thread.id === row.threadId)
      // Its thread is known: the row is that thread's, and shows nothing while it is not listed.
      if (index === -1) continue
    } else {
      index = out.findIndex((thread) => !claimed.has(thread.id) && madeForRow(thread, row, exclude))
      if (index !== -1) claimed.add(out[index]!.id)
    }
    // The send is still on the composer it came from: its row is the open one.
    if (row.from === activeThreadId) openRowId = index === -1 ? row.key : out[index]!.id
    if (index === -1) {
      out.push(row.thread)
      starting.push(row.key)
      unmade.add(row.key)
      continue
    }
    const real = out[index]!
    keys.set(real.id, row.key)
    if (!real.startedAt) unmade.add(real.id)
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
  return { threads: out, activity: shownActivity, rowKeys: keys, openRowId, unmade }
}

/**
 * Rows the service has taken over: their thread is listed started, named and with a state of its own, so the row shows
 * the same without them. They go before the send ends, so nothing of them outlives what the service lists.
 */
export function servedPendingRows(rows: readonly PendingThreadRow[], threads: readonly Thread[], activity: ThreadActivitySnapshot): string[] {
  return rows.flatMap((row) => {
    const thread = row.threadId ? threads.find((entry) => entry.id === row.threadId) : undefined
    const state = thread ? activity[thread.id] : undefined
    return thread?.startedAt && !isDefaultThreadName(thread.name) && state !== undefined && state !== 'idle' ? [row.key] : []
  })
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

/**
 * Who is preparing a new chat's first send (`workspacePendingKey`): the composer's Send or a quick action. Taken
 * before anything renders or awaits, so a second preparation of the same chat (a double Send, or a quick action in the
 * frame before the composer locks) is refused at once. Each holder releases only its own hold.
 */
const newChatHolds = new Map<string, symbol>()

/** Holds the new chat shown as `threadId` for a first send; null while it is held already. The returned release is idempotent. */
export function holdNewChat(profileId: string, threadId: string | null): (() => void) | null {
  const key = workspacePendingKey(profileId, threadId)
  if (newChatHolds.has(key)) return null
  const hold = Symbol(key)
  newChatHolds.set(key, hold)
  return () => {
    if (newChatHolds.get(key) === hold) newChatHolds.delete(key)
  }
}

interface PendingThreadRowsState {
  rows: PendingThreadRow[]
  /** Row keys of threads that began as pending rows, kept a while so their row keeps its key after the pending row goes. */
  rowKeys: ReadonlyMap<string, RowKey>
}

export const usePendingThreadRows = create<PendingThreadRowsState>(() => ({ rows: [], rowKeys: new Map() }))

/** Lists a pending row now. */
export function addPendingThreadRow(row: PendingThreadRow): PendingThreadRow {
  usePendingThreadRows.setState((state) => ({ rows: [...state.rows.filter((entry) => entry.key !== row.key), row] }))
  return row
}

/**
 * The service made the row's thread: the row is that thread's from now on. `list` lists the thread when the window
 * does not have it yet (the composer moved on before it was made), so the row does not blink out until the next push.
 */
export function claimPendingThreadRow(key: string, thread: Thread, list: (thread: Thread) => void = () => undefined, now = Date.now()): Thread {
  const row = usePendingThreadRows.getState().rows.find((entry) => entry.key === key)
  if (!row) return thread
  list(thread)
  usePendingThreadRows.setState((state) => {
    const rowKeys = new Map(state.rowKeys)
    rowKeys.set(thread.id, { key, at: now })
    return { rows: state.rows.map((entry) => (entry.key === key ? { ...entry, threadId: thread.id } : entry)), rowKeys }
  })
  return thread
}

/** Takes rows away: the send is over, or the service took the row over. */
export function dropPendingThreadRows(keys: readonly string[]): void {
  if (keys.length === 0) return
  usePendingThreadRows.setState((state) => {
    const rows = state.rows.filter((row) => !keys.includes(row.key))
    return rows.length === state.rows.length ? state : { rows }
  })
}

/** Forgets the row keys of threads made more than a minute ago, or no longer listed. */
export function pruneRowKeys(listed: ReadonlySet<string>, now = Date.now()): void {
  const { rowKeys, rows } = usePendingThreadRows.getState()
  const active = new Set(rows.flatMap((row) => (row.threadId ? [row.threadId] : [])))
  const kept = [...rowKeys].filter(([id, entry]) => active.has(id) || (listed.has(id) && now - entry.at < ROW_KEY_MS))
  if (kept.length !== rowKeys.size) usePendingThreadRows.setState({ rowKeys: new Map(kept) })
}
