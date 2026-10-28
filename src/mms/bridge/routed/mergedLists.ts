import { qualifyRoutedEvent, qualifyRoutedResult } from '../../../shared/bridge/routedIds'
import { NetError, type NodeId, type StreamDescriptor } from '../../../shared/net'
import { parseQualifiedId } from '../../../shared/threadRef'
import { isSubagentThread } from '../../../shared/threadLineage'
import type {
  Project,
  Thread,
  ThreadActivitySnapshot,
  ThreadActivityState,
  ThreadSearchResult,
  ThreadSearchSkipped
} from '../../../shared/types'
import type { MmsProfileServices } from '../../MmsProfileServices'
import {
  REMOTE_LISTS_CACHE_MAX_BYTES,
  REMOTE_THREAD_OPENED_KEEP_MS,
  type SqliteRemoteLists
} from '../../net/store/remoteLists'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { RemoteListsPort } from '../../protocol/remoteListsPort'
import type { BridgeHub } from '../hub'
import type { ListsSnapshot } from '../remote/MmsListsSource'
import { PRIVATE_LISTS_SUBJECT } from '../remote/privateStreams'
import { repositoryIdentitiesFor, type RepositoryIdentity } from '../remote/repositoryIdentity'
import type { ComputerRef } from './computerErrors'
import {
  activityOfStatus,
  fitSnapshot,
  frontOrder,
  interleave,
  movedToFront,
  placeNewRows,
  projectRow,
  sameRow,
  threadRow,
  type Placed
} from './listRows'
import type { RoutedClient } from './RoutedClient'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** How often the computers to read the lists of are looked at again. */
const RECONCILE_MS = 5_000
/** A search or the Recently deleted list waits this long for a computer before it names it as not searched. */
const FAN_OUT_DEADLINE_MS = 2_000
/** Rows kept for one computer, whatever it sends. */
const MAX_THREAD_ROWS = 5_000
const MAX_PROJECT_ROWS = 500
/** Projects of other computers follow this computer's own in the sidebar. */
const REMOTE_PROJECT_ORDER_BASE = 1_000_000
/** How long the answer of "which of your projects is this repository" is reused. */
const SAME_AS_TTL_MS = 10 * 60_000
/** A computer that cannot stream its lists (an older one) is read again this often. */
const READ_POLL_MS = 30_000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
/** Writing the cache of a computer's lists waits for the changes to settle. */
const CACHE_SETTLE_MS = 2_000

interface Computer {
  node: NodeId
  name: string
  threads: Map<string, Thread>
  projects: Map<string, Project>
  activity: Map<string, ThreadActivityState>
  /** Where each of its threads sits here, by the thread's id on that computer. */
  positions: Map<string, number>
  positionsLoaded: boolean
  /** The order the computer itself gave each thread, to see when it moves one to its front. */
  ownerOrders: Map<string, number>
  /** The newest snapshot, as the computer wrote it, for the offline cache. */
  snapshot?: unknown
  online: boolean
  /** A snapshot of the current stream has arrived: what follows are changes, not a first look. */
  live: boolean
  /** `stream`: its private lists stream; `read`: an older computer, asked now and then; `none`: not reachable for lists. */
  mode: 'stream' | 'read' | 'none'
  attached?: { close(): void }
  attaching?: Promise<void>
  retryAt: number
  failures: number
  /** A project of the computer (qualified id) and the project of this computer with the same Git history. */
  sameAs: Map<string, string>
  matches: Map<string, { remote: string | null; at: number }>
  matching?: Promise<void>
  matchAgain?: boolean
  cacheTimer?: ReturnType<typeof setTimeout>
  lastRead?: number
}

export interface MergedListsOptions {
  services: MmsProfileServices
  hub: Pick<BridgeHub, 'attach' | 'threads' | 'projects'>
  client: Pick<RoutedClient, 'openStream' | 'closeStream' | 'call'>
  store: SqliteRemoteLists
  /** This computer's node. */
  self(): NodeId | undefined
  /** The other computers of the user, with the names they go by. */
  computers(): ComputerRef[]
  /** Whether a session with the computer is open. */
  online(node: NodeId): boolean
  /** Whether routing is on for this profile. */
  enabled(): boolean
  clock?: { now(): number }
  reconcileMs?: number
  readPollMs?: number
  fanOutDeadlineMs?: number
}

/** The shape every snapshot is checked against before any row is made from it. */
function listsSnapshot(value: unknown): ListsSnapshot | undefined {
  if (!isRecord(value) || value.kind !== 'mousse.lists') return undefined
  if (!Array.isArray(value.threads) || !Array.isArray(value.projects)) return undefined
  const rows = (items: unknown[], max: number): Json[] =>
    items
      .filter(
        (item): item is Json => isRecord(item) && typeof item.id === 'string' && item.id !== ''
      )
      .slice(0, max)
  return {
    ...(value as unknown as ListsSnapshot),
    threads: rows(value.threads, MAX_THREAD_ROWS) as unknown as ListsSnapshot['threads'],
    projects: rows(value.projects, MAX_PROJECT_ROWS) as unknown as ListsSnapshot['projects'],
    status: isRecord(value.status) ? (value.status as ListsSnapshot['status']) : {},
    chats: []
  }
}

/** Why a computer was not asked or did not answer, as a search names it. */
function skipReason(error: unknown): ThreadSearchSkipped['reason'] {
  if (error instanceof DomainRpcError) {
    if (error.code === 'computer_offline') return 'offline'
    if (error.code === 'deadline_exceeded') return 'slow'
    return 'unavailable'
  }
  if (error instanceof NetError && ['peer_offline', 'route_unreachable'].includes(error.code))
    return 'offline'
  return 'unavailable'
}

/**
 * The threads, projects and statuses of the user's other computers as one list with this computer's.
 *
 * - Each online computer's private lists stream is read; what it last sent is kept on disk (at most 2 MiB
 *   for a computer), so its threads stay listed, marked offline, while it cannot be reached.
 * - A row keeps its place. A thread of another computer enters at the position its `updatedAt` gives among
 *   the rows of its group and stays there unless a person drags it, a person sends in it from this
 *   computer, or its computer moves it to its own front. The place is kept here (`remote_thread_order`).
 * - A new snapshot is compared row by row with the last one: a row that says the same keeps its object.
 * - A status change of a thread that this computer started, sent in, or opened in the last seven days (or
 *   any thread, if the person asked for all) reaches the window as an `activity` event, which is what
 *   notifies. A thread's first status on a link, and everything after a reconnect, arrives only as part of
 *   `activity.snapshot`, which never notifies.
 *
 * The merged rows are given to handlers (`threads.list` and every result that carries the whole list) and
 * to the event stream (`threads.updated`, `projects.updated`, `activity.snapshot`) for windows only.
 */
export class MergedLists implements RemoteListsPort {
  private readonly computersByNode = new Map<NodeId, Computer>()
  private readonly opened = new Map<string, number>()
  private readonly searches = new Map<string, AbortController>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private offProjects?: () => void
  private localProjectsTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly options: MergedListsOptions) {
    try {
      for (const [key, at] of options.store.opened()) this.opened.set(key, at)
    } catch {
      // Without the record of openings only a thread this computer started or sent in notifies.
    }
  }

  private now(): number {
    return (this.options.clock ?? Date).now()
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    const reconcile = (): void => void this.reconcile()
    this.timer = setInterval(reconcile, this.options.reconcileMs ?? RECONCILE_MS)
    this.timer.unref?.()
    const onProjects = (): void => this.localProjectsChanged()
    this.options.services.events.on('projects:updated', onProjects)
    this.offProjects = () => this.options.services.events.off('projects:updated', onProjects)
    void this.reconcile()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.localProjectsTimer) clearTimeout(this.localProjectsTimer)
    this.offProjects?.()
    for (const controller of this.searches.values()) controller.abort()
    this.searches.clear()
    for (const c of this.computersByNode.values()) this.detach(c)
  }

  /** The computers that are listed, for tests and the device screens. */
  state(): Array<{ node: NodeId; online: boolean; live: boolean; mode: string; threads: number }> {
    return [...this.computersByNode.values()].map((c) => ({
      node: c.node,
      online: c.online,
      live: c.live,
      mode: c.mode,
      threads: c.threads.size
    }))
  }

  private computerOf(ref: ComputerRef): Computer {
    let c = this.computersByNode.get(ref.node)
    if (!c) {
      c = {
        node: ref.node,
        name: ref.name,
        threads: new Map(),
        projects: new Map(),
        activity: new Map(),
        positions: new Map(),
        positionsLoaded: false,
        ownerOrders: new Map(),
        online: false,
        live: false,
        mode: 'none',
        retryAt: 0,
        failures: 0,
        sameAs: new Map(),
        matches: new Map()
      }
      this.computersByNode.set(ref.node, c)
      this.loadCache(c)
    }
    c.name = ref.name
    return c
  }

  /** What the computer last sent, from disk, so its threads are listed before (and while) it is out of reach. */
  private loadCache(c: Computer): void {
    try {
      const cached = this.options.store.snapshots().find((entry) => entry.node === c.node)
      if (cached) this.ingest(c, JSON.parse(cached.snapshot), false)
    } catch {
      // An unreadable cache is a computer with no rows yet.
    }
  }

  /** Looks at which computers there are and which are reachable: attaches, marks offline, forgets removed ones. */
  async reconcile(): Promise<void> {
    if (this.closed) return
    if (!this.options.enabled()) {
      this.clear()
      return
    }
    const present = new Map(this.options.computers().map((ref) => [ref.node, ref]))
    for (const node of [...this.computersByNode.keys()]) if (!present.has(node)) this.forget(node)
    for (const ref of present.values()) {
      const c = this.computerOf(ref)
      const online = this.options.online(c.node)
      if (!online && c.online) this.markOffline(c)
      c.online = online
      if (!online) continue
      if (c.mode === 'read') {
        if (this.now() - (c.lastRead ?? 0) >= (this.options.readPollMs ?? READ_POLL_MS))
          await this.readOlder(c)
      } else if (!c.attached && !c.attaching && this.now() >= c.retryAt) await this.attach(c)
    }
  }

  /** Routing went off: nothing is merged, and nothing stays attached. */
  private clear(): void {
    let any = false
    for (const c of this.computersByNode.values()) {
      this.detach(c)
      if (c.threads.size || c.projects.size) any = true
      c.threads = new Map()
      c.projects = new Map()
      c.activity = new Map()
      c.live = false
      c.mode = 'none'
    }
    if (any) this.pushLists(true, true, true)
  }

  private forget(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (!c) return
    this.detach(c, false)
    this.computersByNode.delete(node)
    try {
      this.options.store.dropComputer(node)
    } catch {
      // The rows are gone from the list either way.
    }
    this.pushLists(c.threads.size > 0, c.projects.size > 0, c.activity.size > 0)
  }

  private detach(c: Computer, keepCache = true): void {
    // What it last sent is written now, not left to the timer, so the next start has it.
    if (c.cacheTimer) {
      clearTimeout(c.cacheTimer)
      c.cacheTimer = undefined
      if (keepCache) this.writeCache(c)
    }
    const held = c.attached
    c.attached = undefined
    c.live = false
    if (held) {
      held.close()
      void this.options.client.closeStream(c.node, { kind: 'lists' })
    }
  }

  /** A session with `node` opened: its lists are read again now. */
  nodeOnline(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (c) {
      c.retryAt = 0
      c.failures = 0
    }
    void this.reconcile()
  }

  /** A session with `node` ended; if it was the last, its rows stay, marked offline. */
  nodeOffline(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (!c || this.options.online(node)) return
    c.online = false
    this.markOffline(c)
  }

  private markOffline(c: Computer): void {
    c.live = false
    // What its threads were doing is not known while it is out of reach.
    const hadActivity = c.activity.size > 0
    c.activity = new Map()
    if (!c.threads.size && !c.projects.size) {
      if (hadActivity) this.pushLists(false, false, true)
      return
    }
    let threads = false
    let projects = false
    for (const [id, row] of c.threads)
      if (!row.offline) {
        c.threads.set(id, { ...row, offline: true })
        threads = true
      }
    for (const [id, row] of c.projects)
      if (!row.offline) {
        c.projects.set(id, { ...row, offline: true })
        projects = true
      }
    this.pushLists(threads, projects, hadActivity)
  }

  private async attach(c: Computer): Promise<void> {
    if (c.attached || c.attaching) return c.attaching
    const { hub, client } = this.options
    c.attaching = (async () => {
      try {
        const handle = await hub.attach(
          { nodeId: c.node, entityId: PRIVATE_LISTS_SUBJECT },
          (update) => {
            if (update.kind === 'snapshot') this.ingest(c, update.value, true)
          },
          () => {
            // The stream was ended (the computer turned the setting off, blocked this device, or restarted).
            c.attached = undefined
            c.live = false
            this.markOffline(c)
            this.backOff(c)
          },
          {
            room: 'lists',
            open: async () => {
              const opened = await client.openStream(c.node, { kind: 'lists' })
              return { descriptor: opened.descriptor as StreamDescriptor, head: opened.head }
            }
          }
        )
        c.attached = handle
        c.mode = 'stream'
        c.failures = 0
      } catch (error) {
        if (this.closed) return
        if (error instanceof DomainRpcError && error.code === 'computer_outdated') {
          // A computer from before the lists stream is read now and then through the API a phone uses.
          c.mode = 'read'
          await this.readOlder(c)
          return
        }
        c.mode = 'none'
        if (error instanceof DomainRpcError && error.code === 'computer_offline') {
          c.online = false
          this.markOffline(c)
        } else this.markOffline(c)
        this.backOff(c)
      }
    })().finally(() => {
      c.attaching = undefined
    })
    return c.attaching
  }

  private backOff(c: Computer): void {
    c.failures += 1
    c.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(c.failures - 1, 5))
  }

  /** An older computer's lists, as its phone API gives them: no subagents, no statuses, at most a few hundred threads. */
  private async readOlder(c: Computer): Promise<void> {
    c.lastRead = this.now()
    try {
      const [projects, threads] = await Promise.all([
        this.options.hub.projects(c.node),
        this.options.hub.threads(c.node)
      ])
      const snapshot = {
        kind: 'mousse.lists',
        version: 1,
        projects: isRecord(projects) && Array.isArray(projects.projects) ? projects.projects : [],
        threads: isRecord(threads) && Array.isArray(threads.threads) ? threads.threads : [],
        status: {},
        chats: []
      }
      this.ingest(c, snapshot, true)
    } catch {
      this.markOffline(c)
    }
  }

  // ------------------------------------------------------------------ snapshots

  private loadPositions(c: Computer): void {
    if (c.positionsLoaded) return
    c.positionsLoaded = true
    try {
      c.positions = this.options.store.positions(c.node)
    } catch {
      c.positions = new Map()
    }
  }

  /** The place a group's rows are held to: this computer's own threads of the project, and the rows placed so far. */
  private fixedByGroup(except?: { node: NodeId; ids: ReadonlySet<string> }): Map<string, Placed[]> {
    const groups = new Map<string, Placed[]>()
    const add = (key: string, placed: Placed): void => {
      const list = groups.get(key)
      if (list) list.push(placed)
      else groups.set(key, [placed])
    }
    let local: Thread[] = []
    try {
      local = this.options.services.threads.listAllThreads()
    } catch {
      // Placed against the other computers' rows only.
    }
    for (const thread of local)
      if (!isSubagentThread(thread))
        add(thread.projectId ?? '', {
          id: thread.id,
          order: thread.order,
          updatedAt: thread.updatedAt
        })
    for (const c of this.computersByNode.values())
      for (const row of c.threads.values()) {
        if (isSubagentThread(row)) continue
        const ownerId = parseQualifiedId(row.id)?.id
        if (except && c.node === except.node && ownerId && except.ids.has(ownerId)) continue
        add(this.groupKey(c, row.projectId), {
          id: row.id,
          order: row.order,
          updatedAt: row.updatedAt
        })
      }
    return groups
  }

  /** The group a row of `c` sorts with: this computer's project with the same Git history, else its own project. */
  private groupKey(c: Computer, projectId: string | undefined): string {
    if (!projectId) return ''
    return c.sameAs.get(projectId) ?? projectId
  }

  /**
   * Makes rows of a snapshot and tells the windows what changed. `live` is false for what was read from the
   * cache: its rows are marked offline and it says nothing about what the threads are doing.
   */
  private ingest(c: Computer, raw: unknown, live: boolean): void {
    if (this.closed) return
    const snapshot = listsSnapshot(raw)
    if (!snapshot) return
    if (live) c.online = true
    const context = { node: c.node, offline: !live }
    const qualified = qualifyRoutedResult('lists.snapshot', snapshot, {
      node: c.node,
      self: this.options.self()
    }) as ListsSnapshot
    this.loadPositions(c)

    // Projects first: a thread's group depends on which project of this computer its project matches.
    const projects = new Map<string, Project>()
    qualified.projects.forEach((raw, index) => {
      const id = String(raw.id)
      const order =
        REMOTE_PROJECT_ORDER_BASE +
        (typeof (raw as { order?: unknown }).order === 'number'
          ? (raw as { order: number }).order
          : index)
      const row = projectRow(raw as unknown as Json, order, context, c.sameAs.get(id))
      const known = c.projects.get(id)
      projects.set(id, known && sameRow(known, row) ? known : row)
    })
    const projectsChanged = !sameMap(c.projects, projects)
    c.projects = projects

    // Where each row sits.
    const owner = snapshot.threads as unknown as Json[]
    const rows = qualified.threads as unknown as Json[]
    const ownerOrder = (thread: Json): number =>
      typeof thread.order === 'number' ? thread.order : 0
    const ownerGroups = new Map<string, Array<{ id: string; order: number }>>()
    owner.forEach((thread) => {
      if (isRecord(thread.lineage)) return
      const key = typeof thread.projectId === 'string' ? thread.projectId : ''
      const list = ownerGroups.get(key) ?? []
      list.push({ id: String(thread.id), order: ownerOrder(thread) })
      ownerGroups.set(key, list)
    })
    const ownerIds = new Set(owner.map((thread) => String(thread.id)))
    const fresh = new Map<string, Array<{ id: string; updatedAt: string }>>()
    const front: Array<{ id: string; group: string }> = []
    owner.forEach((thread, index) => {
      if (isRecord(thread.lineage)) return
      const id = String(thread.id)
      const group = this.groupKey(
        c,
        typeof rows[index]!.projectId === 'string' ? (rows[index]!.projectId as string) : undefined
      )
      if (!c.positions.has(id)) {
        const list = fresh.get(group) ?? []
        list.push({ id, updatedAt: String(thread.updatedAt ?? '') })
        fresh.set(group, list)
        return
      }
      const key = typeof thread.projectId === 'string' ? thread.projectId : ''
      const others = (ownerGroups.get(key) ?? [])
        .filter((item) => item.id !== id)
        .map((item) => item.order)
      if (live && movedToFront(c.ownerOrders.get(id), ownerOrder(thread), others))
        front.push({ id, group })
    })
    const changed: Array<[string, number]> = []
    if (fresh.size || front.length) {
      const fixed = this.fixedByGroup({
        node: c.node,
        ids: new Set([...fresh.values()].flat().map((row) => row.id))
      })
      for (const [group, list] of fresh) {
        const placed = placeNewRows(fixed.get(group) ?? [], list)
        for (const [id, order] of placed) {
          c.positions.set(id, order)
          changed.push([id, order])
          const list2 = fixed.get(group) ?? []
          list2.push({
            id: `${c.node}:${id}`,
            order,
            updatedAt: list.find((row) => row.id === id)?.updatedAt ?? ''
          })
          fixed.set(group, list2)
        }
      }
      for (const { id, group } of front) {
        const others = (fixed.get(group) ?? []).filter((placed) => placed.id !== `${c.node}:${id}`)
        const order = frontOrder(others.map((placed) => placed.order))
        c.positions.set(id, order)
        changed.push([id, order])
      }
    }
    if (changed.length) this.safely(() => this.options.store.setPositions(c.node, changed))
    if (live) {
      for (const id of [...c.positions.keys()]) if (!ownerIds.has(id)) c.positions.delete(id)
      this.safely(() => this.options.store.forgetPositions(c.node, ownerIds))
    }
    c.ownerOrders = new Map(owner.map((thread) => [String(thread.id), ownerOrder(thread)]))

    // The rows: an unchanged row keeps its object.
    const threads = new Map<string, Thread>()
    owner.forEach((thread, index) => {
      const id = String(thread.id)
      const row = threadRow(rows[index]!, c.positions.get(id) ?? ownerOrder(thread), context)
      const known = c.threads.get(row.id)
      threads.set(row.id, known && sameRow(known, row) ? known : row)
    })
    const threadsChanged = !sameMap(c.threads, threads)
    c.threads = threads

    // Statuses: the change of each thread's, and whether the window may be told as an event.
    const activity = new Map<string, ThreadActivityState>()
    // What the cache says is the last known state of the rows, not of the threads: no status comes from it.
    if (live)
      for (const [id, status] of Object.entries(qualified.status)) {
        const state = activityOfStatus(status)
        if (state && threads.has(id)) activity.set(id, state)
      }
    const transitions: Array<{ id: string; state: ThreadActivityState }> = []
    for (const id of new Set([...c.activity.keys(), ...activity.keys()])) {
      const before = c.activity.get(id)
      const now = activity.get(id)
      if (before !== now) transitions.push({ id, state: now ?? 'idle' })
    }
    // An event only for a change seen on a link that was already live: a first look and a reconnect never notify.
    const asEvents = live && c.live
    c.activity = activity
    if (live) c.live = true
    if (live) c.snapshot = raw
    if (live) this.scheduleCache(c)
    this.pushLists(
      threadsChanged,
      projectsChanged,
      transitions.length > 0,
      asEvents ? transitions : []
    )
    if (projectsChanged || !c.matches.size) this.matchProjects(c)
  }

  private scheduleCache(c: Computer): void {
    if (c.cacheTimer) return
    c.cacheTimer = setTimeout(() => {
      c.cacheTimer = undefined
      if (!this.closed) this.writeCache(c)
    }, CACHE_SETTLE_MS)
    c.cacheTimer.unref?.()
  }

  private writeCache(c: Computer): void {
    if (c.snapshot === undefined) return
    // What is kept is at most 2 MiB: the threads archived longest ago (or updated longest ago) are left out first.
    const snapshot = listsSnapshot(c.snapshot)
    if (!snapshot) return
    this.safely(() =>
      this.options.store.saveSnapshot(
        c.node,
        JSON.stringify(fitSnapshot(snapshot, REMOTE_LISTS_CACHE_MAX_BYTES))
      )
    )
  }

  private safely(work: () => void): void {
    try {
      work()
    } catch {
      // What is remembered on disk is best effort; the rows in memory are right.
    }
  }

  // ------------------------------------------------------------------ events

  private push(type: string, data: unknown, threadId?: string): void {
    this.options.services.events.emit({
      channel: 'protocol:event',
      data: { type, data, ...(threadId ? { threadId } : {}) }
    })
  }

  /**
   * Tells the windows what changed. The events carry this computer's own lists; each window's projection
   * of them adds the rows of the other computers (`projectEventFor`).
   */
  private pushLists(
    threads: boolean,
    projects: boolean,
    activity: boolean,
    transitions: ReadonlyArray<{ id: string; state: ThreadActivityState }> = []
  ): void {
    if (this.closed) return
    const { services } = this.options
    if (threads) this.push('threads.updated', { threads: services.threads.listAllThreads() })
    if (projects) this.push('projects.updated', { projects: services.projects.listProjects() })
    if (!activity) return
    // The events first, so a window sees each change as one before the snapshot makes it the state.
    for (const { id, state } of transitions)
      if (this.notifies(id)) this.push('activity', { threadId: id, state }, id)
    this.push('activity.snapshot', { activity: services.threadRuntimes.getActivitySnapshot() })
  }

  /** Whether a status change of this thread may notify: this computer started it, sent in it, opened it lately, or all are asked for. */
  private notifies(id: string): boolean {
    const ref = parseQualifiedId(id)
    const c = ref && this.computersByNode.get(ref.node as NodeId)
    const row = c?.threads.get(id)
    if (!ref || !row) return false
    if (this.options.services.settings.get().notifications?.allRemoteThreads === true) return true
    const self = this.options.self()
    if (self && (row.startedFrom?.node === self || row.sentFrom?.node === self)) return true
    const opened = this.opened.get(`${ref.node}|${ref.id}`)
    return opened !== undefined && this.now() - opened < REMOTE_THREAD_OPENED_KEEP_MS
  }

  // ------------------------------------------------------------------ what a person does here

  /** A window keeps the thread in view: it notifies from now on, for seven days. */
  noteOpened(qualifiedId: string): void {
    const ref = parseQualifiedId(qualifiedId)
    if (!ref) return
    this.opened.set(`${ref.node}|${ref.id}`, this.now())
    this.safely(() => this.options.store.markOpened(ref.node as NodeId, ref.id))
  }

  /**
   * A thread in view changed its own row on its computer (the stream of that thread says so before the lists do):
   * the row of the merged lists takes it now, keeping its place. A thread not listed yet comes with the lists.
   */
  applyMetadata(node: NodeId, thread: Json): void {
    const c = this.computersByNode.get(node)
    if (!c || !this.options.enabled()) return
    const found = qualifyRoutedEvent(
      'thread.metadata',
      { thread },
      { node, self: this.options.self() }
    )
    const qualified = isRecord(found) && isRecord(found.thread) ? found.thread : undefined
    const known =
      qualified && typeof qualified.id === 'string' ? c.threads.get(qualified.id) : undefined
    if (!qualified || !known) return
    const row = threadRow(qualified, known.order, { node, offline: known.offline === true })
    if (sameRow(known, row)) return
    c.threads.set(known.id, row)
    this.pushLists(true, false, false)
  }

  /** A person sent in the thread from this computer: it moves to the front of its group and notifies. */
  noteSent(qualifiedId: string): void {
    const ref = parseQualifiedId(qualifiedId)
    const c = ref && this.computersByNode.get(ref.node as NodeId)
    const row = c?.threads.get(qualifiedId)
    if (!ref || !c || !row) return
    this.noteOpened(qualifiedId)
    const group = this.groupKey(c, row.projectId)
    const others = (this.fixedByGroup().get(group) ?? []).filter((placed) => placed.id !== row.id)
    const order = frontOrder(others.map((placed) => placed.order))
    if (row.order === order) return
    this.setOrders(c, [[ref.id, order]])
  }

  /** A drag: the rows of other computers among `orderedIds` take places that keep the group in that order. */
  reorder(orderedIds: readonly string[]): void {
    const local = new Map(
      this.options.services.threads
        .listAllThreads()
        .map((thread) => [thread.id, thread.order] as const)
    )
    const remote = new Set<string>()
    for (const c of this.computersByNode.values()) for (const id of c.threads.keys()) remote.add(id)
    const sequence = orderedIds
      .filter((id) => remote.has(id) || local.has(id))
      .map((id) => ({ id, ...(remote.has(id) ? {} : { order: local.get(id)! }) }))
    // Kept rows must ascend: a row of this computer that was left out of the drag stays where it was.
    const orders = interleave(sequence)
    const byNode = new Map<NodeId, Array<[string, number]>>()
    for (const [id, order] of orders) {
      const ref = parseQualifiedId(id)
      if (!ref) continue
      const list = byNode.get(ref.node as NodeId) ?? []
      list.push([ref.id, order])
      byNode.set(ref.node as NodeId, list)
    }
    for (const [node, entries] of byNode) {
      const c = this.computersByNode.get(node)
      if (c) this.setOrders(c, entries, false)
    }
    if (byNode.size) this.pushLists(true, false, false)
  }

  private setOrders(c: Computer, entries: Array<[string, number]>, push = true): void {
    for (const [id, order] of entries) {
      c.positions.set(id, order)
      const key = `${c.node}:${id}`
      const row = c.threads.get(key)
      if (row) c.threads.set(key, { ...row, order })
    }
    this.safely(() => this.options.store.setPositions(c.node, entries))
    if (push) this.pushLists(true, false, false)
  }

  // ------------------------------------------------------------------ the port

  threads(scope?: { projectId: string | null }): Thread[] {
    if (!this.options.enabled()) return []
    const rows: Thread[] = []
    for (const c of this.computersByNode.values())
      for (const row of c.threads.values()) {
        if (!scope) rows.push(row)
        else if (scope.projectId === null) {
          if (!row.projectId) rows.push(row)
        } else if (row.projectId && this.groupKey(c, row.projectId) === scope.projectId)
          rows.push(row)
        else if (row.projectId === scope.projectId) rows.push(row)
      }
    return rows
  }

  projects(): Project[] {
    if (!this.options.enabled()) return []
    return [...this.computersByNode.values()].flatMap((c) => [...c.projects.values()])
  }

  activity(): ThreadActivitySnapshot {
    if (!this.options.enabled()) return {}
    const out: ThreadActivitySnapshot = {}
    for (const c of this.computersByNode.values())
      for (const [id, state] of c.activity) out[id] = state
    return out
  }

  // ------------------------------------------------------------------ fan-out

  /** Calls `work` on every computer of the list that is online, each with its own short deadline. */
  private async fanOut<T>(
    connection: string | undefined,
    work: (c: Computer, signal: AbortSignal) => Promise<T>
  ): Promise<{
    answers: Array<{ c: Computer; value: T }>
    skipped: ThreadSearchSkipped[]
    superseded: boolean
  }> {
    const key = connection ?? ''
    this.searches.get(key)?.abort()
    const controller = new AbortController()
    this.searches.set(key, controller)
    const skipped: ThreadSearchSkipped[] = []
    const answers: Array<{ c: Computer; value: T }> = []
    try {
      await Promise.all(
        [...this.computersByNode.values()].map(async (c) => {
          if (!this.options.online(c.node)) {
            skipped.push({ node: c.node, name: c.name, reason: 'offline' })
            return
          }
          const deadline = this.options.fanOutDeadlineMs ?? FAN_OUT_DEADLINE_MS
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadline)])
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            // The call itself stops with the signal; the race also covers the steps before it can be stopped.
            const value = await Promise.race([
              work(c, signal),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new DomainRpcError('deadline_exceeded', `${c.name} did not answer in time.`)
                    ),
                  deadline
                )
                timer.unref?.()
              })
            ])
            answers.push({ c, value })
          } catch (error) {
            if (!controller.signal.aborted)
              skipped.push({ node: c.node, name: c.name, reason: skipReason(error) })
          } finally {
            if (timer) clearTimeout(timer)
          }
        })
      )
      return { answers, skipped, superseded: controller.signal.aborted }
    } finally {
      if (this.searches.get(key) === controller) this.searches.delete(key)
    }
  }

  async search(
    connection: string | undefined,
    query: string,
    limit: number
  ): Promise<{ results: ThreadSearchResult[]; skipped: ThreadSearchSkipped[] }> {
    if (!this.options.enabled()) return { results: [], skipped: [] }
    const { answers, skipped, superseded } = await this.fanOut(connection, async (c, signal) => {
      const raw = await this.options.client.call(
        c.node,
        'threads.search',
        { query, limit },
        { signal }
      )
      const found = qualifyRoutedResult('threads.search', raw, {
        node: c.node,
        self: this.options.self()
      })
      const results = isRecord(found) && Array.isArray(found.results) ? found.results : []
      return results
        .filter(isRecord)
        .map((result) => ({ ...result, node: c.node }) as unknown as ThreadSearchResult)
    })
    if (superseded) return { results: [], skipped: [] }
    return { results: answers.flatMap((answer) => answer.value), skipped: sortSkipped(skipped) }
  }

  async inventory(connection: string | undefined): Promise<{
    lifecycles: Array<Record<string, unknown>>
    taskNames: Record<string, string>
    skipped: ThreadSearchSkipped[]
  }> {
    if (!this.options.enabled()) return { lifecycles: [], taskNames: {}, skipped: [] }
    const { answers, skipped, superseded } = await this.fanOut(connection, async (c, signal) => {
      const raw = await this.options.client.call(c.node, 'threads.inventory', {}, { signal })
      return qualifyRoutedResult('threads.inventory', raw, {
        node: c.node,
        self: this.options.self()
      })
    })
    const lifecycles: Array<Record<string, unknown>> = []
    const taskNames: Record<string, string> = {}
    if (superseded) return { lifecycles, taskNames, skipped: [] }
    for (const { c, value } of answers) {
      if (!isRecord(value)) continue
      for (const record of Array.isArray(value.lifecycles) ? value.lifecycles : []) {
        if (!isRecord(record)) continue
        // The computer's own folders are not for this one to read with its path rules.
        const { cleanupOwner: _owner, ...rest } = record
        lifecycles.push({
          ...rest,
          originalLocation: '',
          location: '',
          locations: [],
          node: c.node,
          computerName: c.name
        })
      }
      if (isRecord(value.taskNames))
        for (const [id, name] of Object.entries(value.taskNames))
          if (typeof name === 'string') taskNames[id] = name
    }
    return { lifecycles, taskNames, skipped: sortSkipped(skipped) }
  }

  // ------------------------------------------------------------------ projects that are the same repository

  private localProjectsChanged(): void {
    if (this.localProjectsTimer || this.closed) return
    this.localProjectsTimer = setTimeout(() => {
      this.localProjectsTimer = undefined
      for (const c of this.computersByNode.values()) {
        c.matches.clear()
        this.matchProjects(c)
      }
    }, 1_000)
    this.localProjectsTimer.unref?.()
  }

  /** Finds, for each project of this computer that is a Git repository, which project of `c` is the same one. */
  private matchProjects(c: Computer): void {
    if (this.closed || !c.online || !c.projects.size) return
    if (c.matching) {
      c.matchAgain = true
      return
    }
    c.matching = this.runMatch(c)
      .catch(() => undefined)
      .finally(() => {
        c.matching = undefined
        if (c.matchAgain) {
          c.matchAgain = false
          this.matchProjects(c)
        }
      })
  }

  private async runMatch(c: Computer): Promise<void> {
    const { services, client } = this.options
    const identities = repositoryIdentitiesFor(services)
    const byRoot = new Map<string, { id: string; identity: RepositoryIdentity; atTop: boolean }>()
    for (const project of services.projects.listProjects()) {
      const identity = await identities.of(project.path)
      if (!identity) continue
      const atTop =
        (await identities.rootOf(project.path)) === identity.root && project.path === identity.root
      const known = byRoot.get(identity.root)
      if (!known || (atTop && !known.atTop))
        byRoot.set(identity.root, { id: project.id, identity, atTop })
    }
    const sameAs = new Map<string, string>()
    for (const { id, identity } of byRoot.values()) {
      const key = `${identity.root}|${identity.roots.join(',')}`
      let held = c.matches.get(key)
      if (!held || this.now() - held.at > SAME_AS_TTL_MS) {
        let remote: string | null = null
        try {
          const raw = await client.call(
            c.node,
            'projects.match',
            { roots: identity.roots, remotes: identity.remotes },
            { signal: AbortSignal.timeout(30_000) }
          )
          const found = qualifyRoutedResult('projects.match', raw, {
            node: c.node,
            self: this.options.self()
          })
          remote = isRecord(found) && typeof found.projectId === 'string' ? found.projectId : null
        } catch (error) {
          // A computer that cannot answer now (offline, older) is asked again later.
          if (error instanceof DomainRpcError && error.code === 'computer_outdated') remote = null
          else return
        }
        held = { remote, at: this.now() }
        c.matches.set(key, held)
      }
      // A project of the computer that several of this one's match goes to the first; the top folder came first.
      if (held.remote && !sameAs.has(held.remote)) sameAs.set(held.remote, id)
    }
    if (sameMapValues(c.sameAs, sameAs)) return
    c.sameAs = sameAs
    let changed = false
    for (const [id, row] of c.projects) {
      const next = sameAs.get(id)
      if (row.sameAs === next) continue
      const { sameAs: _old, ...rest } = row
      c.projects.set(id, next ? { ...rest, sameAs: next } : rest)
      changed = true
    }
    if (changed) this.pushLists(false, true, false)
  }
}

function sortSkipped(skipped: ThreadSearchSkipped[]): ThreadSearchSkipped[] {
  return [...skipped].sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node))
}

/** Whether two maps hold the very same row objects: an unchanged row keeps its object, so this is the diff. */
function sameMap<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of b) if (a.get(key) !== value) return false
  return true
}

function sameMapValues(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of b) if (a.get(key) !== value) return false
  return true
}
