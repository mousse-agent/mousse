import type { ChatSummary } from '../../../shared/chats'
import type { Project, Thread, ThreadActivityState, TurnState } from '../../../shared/types'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { rollUpActivities, visibleThreads } from '../../../shared/threadLineage'
import { MAX_DISPLAY_JSON_NODES } from '../../net/sync/codec'
import { mmsJson } from './jsonOutput'

/**
 * The reserved display "thread" that carries a computer's sidebar lists. Real thread ids never
 * contain a colon, so this id cannot name a real thread.
 */
export const LISTS_STREAM_THREAD_ID = 'mousse:lists'
const LISTS_VERSION = 1
/** Coalesces bursts (a send renames, reorders and starts a turn) into one published snapshot. */
const SETTLE_MS = 40
/** Catches changes that reach no event (for example a thread moved to the trash by another client). */
const RECONCILE_MS = 15_000
const PREVIEW_CHARS = 280
const ERROR_CHARS = 280
/** A private snapshot above this size leaves out threads archived long ago (see `trimmed`). */
export const PRIVATE_SOFT_LIMIT_BYTES = 256 * 1024
const ARCHIVE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export type ListsStatusState =
  | 'processing'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  /** Only in a private lists stream, which carries every state a sidebar row can show. */
  | 'waiting'
  | 'paused'

export interface ListsStatus {
  state: ListsStatusState
  /** When the current turn started, for "Working 3m". */
  since?: string
  error?: string
}

export interface ListsChat {
  id: string
  kind: 'direct' | 'group'
  name: string
  /** The thread that mirrors the chat's messages; absent for Space conversations. */
  threadId?: string
  projectId?: string
  /** A conversation published to a Space; it opens only on the computer. */
  network?: true
  agents: string[]
  updatedAt: string
  preview?: string
  run?: { id: string; state: string; startedAt: string; error?: string }
}

/** What a phone needs to draw the Projects, Threads and Chats tabs and their status icons. */
export interface ListsSnapshot {
  kind: 'mousse.lists'
  version: number
  projects: Array<Pick<Project, 'id' | 'name' | 'path' | 'order' | 'pinnedAt'>>
  threads: Array<
    Pick<
      Thread,
      | 'id'
      | 'name'
      | 'projectId'
      | 'createdAt'
      | 'updatedAt'
      | 'order'
      | 'pinnedAt'
      | 'settledAt'
      | 'startedAt'
      | 'worktreeEnabled'
    > &
      /** Only in a private lists stream: the subagent rows' place in the tree, and what the thread runs with. */
      Partial<
        Pick<Thread, 'lineage' | 'permissionMode' | 'modelOverride' | 'startedFrom' | 'sentFrom'>
      >
  >
  /** Threads that are not idle, by id. */
  status: Record<string, ListsStatus>
  chats: ListsChat[]
}

/** The profile services the lists read and watch. */
export type ListsServices = Pick<
  MmsProfileServices,
  'projects' | 'threads' | 'orchestrator' | 'questions' | 'events' | 'threadRuntimes'
> & {
  platform: {
    chats: { snapshot(): { chats: ChatSummary[] }; onChange(listener: () => void): () => void }
  }
}

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function statusOf(
  activity: ThreadActivityState | undefined,
  turn: TurnState | undefined,
  /** A private stream also reports Waiting and Paused, which a phone's row has no state for. */
  all = false
): ListsStatus | undefined {
  const since = turn?.startedAt
  if (activity === 'processing' || activity === 'awaiting_input')
    return { state: activity, ...(since ? { since } : {}) }
  if (all && (activity === 'waiting' || activity === 'paused'))
    return { state: activity, ...(since ? { since } : {}) }
  if (activity === 'completed') return { state: 'completed' }
  if (turn?.phase === 'failed')
    return {
      state: 'failed',
      ...(clip(turn.error, ERROR_CHARS) ? { error: clip(turn.error, ERROR_CHARS) } : {})
    }
  return undefined
}

function chatOf(chat: ChatSummary): ListsChat {
  const agents = chat.participants
    .filter((entry) => entry.kind === 'agent')
    .map((entry) => entry.name)
  if (chat.presentation === 'network')
    return {
      id: chat.id,
      kind: 'group',
      name: chat.name,
      network: true,
      agents,
      updatedAt: chat.updatedAt
    }
  const preview = clip(chat.lastMessage?.text, PREVIEW_CHARS)
  return {
    id: chat.id,
    kind: chat.kind,
    name: chat.name,
    threadId: chat.threadId,
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
    agents,
    updatedAt: chat.updatedAt,
    ...(preview ? { preview } : {}),
    ...(chat.run
      ? {
          run: {
            id: chat.run.id,
            state: chat.run.state,
            startedAt: chat.run.startedAt,
            ...(clip(chat.run.error, ERROR_CHARS)
              ? { error: clip(chat.run.error, ERROR_CHARS) }
              : {})
          }
        }
      : {})
  }
}

/**
 * Builds the sidebar lists from the profile's own services and reports when they change. A
 * ThreadStreamAdapter publishes each changed snapshot to subscribed phones on a signed display stream.
 */
export class MmsListsSource {
  constructor(
    private readonly services: ListsServices,
    private readonly timers: {
      setTimeout(run: () => void, ms: number): unknown
      clearTimeout(handle: unknown): void
      setInterval(run: () => void, ms: number): unknown
      clearInterval(handle: unknown): void
    } = {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    },
    /**
     * `private`: the lists of one computer of the user rather than of a phone. They keep the subagent
     * rows and each thread's `lineage`, say what each thread runs with and where it came from, and
     * report every state a row can show. The phone's lists stay as they were.
     */
    private readonly options: { private?: boolean } = {}
  ) {}

  private chats: ListsChat[] | undefined
  private chatsStale = true
  private watchers = 0

  /**
   * The chats are read from disk. While a watcher runs, both `watch` and `snapshot` reuse the last read
   * until a chat signals or the reconcile tick runs; without a watcher nothing signals, so each call reads.
   */
  private currentChats(): ListsChat[] {
    if (this.watchers === 0 || this.chatsStale || !this.chats) {
      try {
        this.chats = this.services.platform.chats.snapshot().chats.map(chatOf)
      } catch {
        // A profile whose chat store cannot be read still lists its projects and threads.
        this.chats = []
      }
      this.chatsStale = false
    }
    return this.chats
  }

  snapshot(): ListsSnapshot {
    return this.compose(this.currentChats())
  }

  private compose(chats: ListsChat[]): ListsSnapshot {
    const s = this.services
    const activity = s.threadRuntimes.getActivitySnapshot()
    const turns = s.orchestrator.getTurnSnapshot()
    const inventory = s.threads.listAllThreads()
    const own = this.options.private === true
    // A phone lists threads the way the CLI does: subagents sit under their parent, not beside it. Another
    // computer lists them all, with their lineage, and builds the tree itself like the desktop sidebar.
    const threads = own ? inventory : visibleThreads(inventory)
    const snapshot = this.build(s, inventory, threads, own, activity, turns, chats)
    return own ? this.trimmed(snapshot, inventory) : snapshot
  }

  /**
   * A private snapshot grows with the number of threads. Above `PRIVATE_SOFT_LIMIT_BYTES`, archived threads
   * that were settled more than 30 days ago leave it (with the subagents under them); the Archive and
   * Recently deleted views of another computer ask for them with a read when they need them.
   */
  private trimmed(snapshot: ListsSnapshot, inventory: readonly Thread[]): ListsSnapshot {
    if (Buffer.byteLength(JSON.stringify(snapshot)) <= PRIVATE_SOFT_LIMIT_BYTES) return snapshot
    const cutoff = Date.now() - ARCHIVE_KEEP_MS
    const dropped = new Set<string>()
    for (const thread of inventory)
      if (thread.settledAt && !thread.lineage && new Date(thread.settledAt).getTime() < cutoff)
        dropped.add(thread.id)
    if (!dropped.size) return snapshot
    // Whatever hangs below a dropped thread goes with it.
    for (let grew = true; grew;) {
      grew = false
      for (const thread of inventory)
        if (
          thread.lineage &&
          !dropped.has(thread.id) &&
          dropped.has(thread.lineage.parentThreadId)
        ) {
          dropped.add(thread.id)
          grew = true
        }
    }
    const status = { ...snapshot.status }
    for (const id of dropped) delete status[id]
    return {
      ...snapshot,
      threads: snapshot.threads.filter((thread) => !dropped.has(thread.id)),
      status
    }
  }

  private build(
    s: ListsServices,
    inventory: readonly Thread[],
    threads: readonly Thread[],
    own: boolean,
    activity: Record<string, ThreadActivityState>,
    turns: Record<string, TurnState>,
    chats: ListsChat[]
  ): ListsSnapshot {
    // A phone's parent row shows what its subagents are doing; another computer rolls the states up itself.
    const rolledUp = own ? {} : rollUpActivities(inventory, activity)
    const status: Record<string, ListsStatus> = {}
    for (const thread of threads) {
      const entry = statusOf(rolledUp[thread.id] ?? activity[thread.id], turns[thread.id], own)
      if (entry) status[thread.id] = entry
    }
    return mmsJson(
      {
        kind: 'mousse.lists',
        version: LISTS_VERSION,
        projects: s.projects.listProjects().map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          order: project.order,
          pinnedAt: project.pinnedAt
        })),
        threads: threads.map((thread) => ({
          id: thread.id,
          name: thread.name,
          projectId: thread.projectId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          order: thread.order,
          pinnedAt: thread.pinnedAt,
          settledAt: thread.settledAt,
          startedAt: thread.startedAt,
          worktreeEnabled: thread.worktreeEnabled,
          ...(own
            ? {
                lineage: thread.lineage,
                permissionMode: thread.permissionMode,
                modelOverride: thread.modelOverride,
                startedFrom: thread.startedFrom,
                sentFrom: thread.sentFrom
              }
            : {})
        })),
        status,
        chats
      },
      undefined,
      // The larger bound is for another computer of the user. A phone's parser is not known to take more than the
      // wire's 16,384 nodes, so the lists it reads stay within them (as before).
      own ? MAX_DISPLAY_JSON_NODES : undefined
    ) as ListsSnapshot
  }

  /**
   * Calls `changed` shortly after anything the lists show changes. Repeated signals that leave the
   * lists as they were do not call it. Returns a function that stops watching.
   */
  watch(changed: () => void, onError?: (error: unknown) => void): () => void {
    const s = this.services
    this.watchers++
    this.chatsStale = true
    let last = JSON.stringify(this.snapshot())
    let pending: unknown
    let stopped = false
    const check = (): void => {
      pending = undefined
      if (stopped) return
      try {
        const next = JSON.stringify(this.snapshot())
        if (next === last) return
        last = next
        changed()
      } catch (error) {
        onError?.(error)
      }
    }
    const poke = (): void => {
      if (stopped || pending !== undefined) return
      pending = this.timers.setTimeout(check, SETTLE_MS)
    }
    const disposers: Array<() => void> = []
    const on = (target: Emitter, event: string): void => {
      target.on(event, poke)
      disposers.push(() => target.off(event, poke))
    }
    on(s.threads as unknown as Emitter, 'created')
    on(s.threads as unknown as Emitter, 'updated')
    on(s.events as unknown as Emitter, 'threads:updated')
    on(s.events as unknown as Emitter, 'projects:updated')
    for (const event of [
      'thread-started',
      'turn-state',
      'turn-started',
      'turn-completed',
      'turn-failed',
      'turn-aborted',
      'turn-interrupted'
    ])
      on(s.orchestrator as unknown as Emitter, event)
    on(s.threadRuntimes as unknown as Emitter, 'activity')
    on(s.questions as unknown as Emitter, 'pending')
    on(s.questions as unknown as Emitter, 'cleared')
    const chatsChanged = (): void => {
      this.chatsStale = true
      poke()
    }
    disposers.push(s.platform.chats.onChange(chatsChanged))
    const reconcile = this.timers.setInterval(chatsChanged, RECONCILE_MS)
    disposers.push(() => this.timers.clearInterval(reconcile))
    return () => {
      if (stopped) return
      stopped = true
      if (--this.watchers === 0) this.chats = undefined
      if (pending !== undefined) this.timers.clearTimeout(pending)
      for (const dispose of disposers.splice(0)) dispose()
    }
  }
}
