import { createHash, randomUUID } from 'node:crypto'
import type {
  Envelope,
  NodeDelegation,
  Roster,
  StreamId,
  StreamDescriptor,
  StoredRecord
} from '../../../shared/net'
import {
  BOT_STREAM_DELTA_TYPES,
  BOT_STREAM_EVENT_TYPES,
  BRIDGE_ROUTED_EVENT_TYPES,
  BRIDGE_THREAD_EVENT_TYPES,
  NetError,
  newId,
  STORE_TXN_MAX_BYTES,
  STORE_TXN_MAX_ROWS,
  type NodeId
} from '../../../shared/net'
import { isBotStreamKind, type PrivateStreamKind } from '../../../shared/bridge/routed'
import type { Clock, IdentityService, KeyStore, StreamStore } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'
import { canonicalJson, encodeEnvelope, MAX_DISPLAY_JSON_NODES } from '../../net/sync/codec'
import { engineLimits } from '../../netEngine/limits'
import {
  PRIVATE_BOT_STREAMS_TOTAL,
  PRIVATE_STREAM_QUOTA,
  PRIVATE_TERMINAL_RING_BYTES,
  PRIVATE_TERMINAL_RING_ROWS,
  PRIVATE_STREAMS_TOTAL,
  PRIVATE_THREAD_STREAMS_TOTAL,
  sameRoom,
  isPrivateKey,
  parsePrivateKey,
  privateKey,
  privateRecordSubject,
  type PrivateSpec
} from './privateStreams'

export const THREAD_EVENT_TYPES = BRIDGE_THREAD_EVENT_TYPES
/**
 * Event types allowed as display-only deltas (never stored). `questions.updated` stays out of the
 * durable set because older hubs reject unknown durable event types.
 */
export const THREAD_DELTA_TYPES = [
  'thread.message',
  'thread.message-updated',
  'questions.updated'
] as const
/**
 * What only a private stream sends as a display-only delta: a note that something about the thread
 * changed (the reader fetches what it needs), or the new state when that is small.
 */
export const PRIVATE_DELTA_TYPES = [
  'subagents.updated',
  'agents.updated',
  'tasks.updated',
  'pullRequests.updated',
  'actions.updated',
  'workspace.updated',
  'git.selectionChanged',
  'thread.title-generation-failed',
  // A Send now click's outcome (`applied` or `stale`): the window that clicked leaves "Sending…". Phones cannot Send now.
  'steer.now',
  // A bot's live chip (one per activation) and its reply as its chat turn writes it, on that bot's own stream.
  ...BOT_STREAM_DELTA_TYPES
] as const
export interface ThreadDisplayEvent {
  type:
    | (typeof THREAD_EVENT_TYPES)[number]
    | (typeof BRIDGE_ROUTED_EVENT_TYPES)[number]
    | (typeof BOT_STREAM_EVENT_TYPES)[number]
  data: unknown
  ephemeral?: boolean
}
export interface ThreadDeltaEvent {
  type: (typeof THREAD_DELTA_TYPES)[number] | (typeof PRIVATE_DELTA_TYPES)[number]
  data: unknown
  ephemeral: true
}
export type ThreadSourceEvent =
  | ThreadDisplayEvent
  | ThreadDeltaEvent
  /** The source changed as a whole; publish a fresh snapshot instead of an event. */
  | { snapshot: true }
export interface ThreadSourcePort {
  snapshot(threadId: string): unknown
  /**
   * Reads what the next `snapshot` of the thread needs off the event loop (the newest page of its database), so that
   * snapshot does not load the whole thread. `ThreadStreamAdapter.open` awaits it before a stream is opened.
   */
  warm?(threadId: string): Promise<void>
  onThread(
    threadId: string,
    listener: (event: ThreadSourceEvent) => void,
    onError?: (error: unknown) => void
  ): () => void
}
export interface ThreadGenerationPort {
  beginNodeEpoch(stream: StreamId, epoch: number): void
}
interface ActiveThread {
  /** What the stream is stored and sourced under: a thread id, or the key of a private stream. */
  threadId: string
  /** The id its records carry as `threadId`: the thread's own id, or the private stream's subject. */
  subject: string
  /** Set on a private stream: who reads it, and what it is. */
  spec?: PrivateSpec
  /** Records the stream keeps for a reader catching up; a terminal keeps more than a thread. */
  maxRows?: number
  maxBytes?: number
  stream: StreamId
  descriptor: StreamDescriptor
  ring: StoredRecord[]
  bytes: number
  dispose?: () => void
  /** Latest pending delta per coalescing key, flushed at most every deltaIntervalMs. */
  deltas: Map<string, unknown>
  deltaTimer?: { cancel(): void }
  /** Callers that opened this thread, with when each last did. Only they count against a quota. */
  holders: Map<string, number>
  /** Last time the stream was opened, subscribed to or running a turn (wall clock, ms). */
  lastBusyAt: number
  /** A terminal's output that arrived within a few milliseconds of each other, not yet signed and stored. */
  batch?: { bodies: unknown[]; bytes: number; timer?: { cancel(): void } }
  /**
   * Where the snapshot the stream published last begins, while a reader that opens the stream can still be served it:
   * the store holds it whole (no trim cut into it) and no display-only delta went out since, which a new reader would
   * not get. Undefined otherwise, and a reader's open publishes a fresh snapshot first.
   */
  published?: { begin: number }
}
export interface ThreadStreamOptions {
  db: NetDatabase
  store: StreamStore
  generations: ThreadGenerationPort
  identity: IdentityService
  keys: KeyStore
  clock: Clock
  source: ThreadSourcePort
  bootId?: string
  maxRows?: number
  maxBytes?: number
  maxThreads?: number
  /** Threads one caller may hold open at once (default 16). */
  maxThreadsPerHolder?: number
  /** Threads that never count against a caller's quota, such as the shared lists stream. */
  unmetered?(threadId: string): boolean
  /**
   * The one device that may read the stream stored under `threadId` (a phone's own lists, `mousse:lists:<node>`), and
   * the thread id its records carry instead of the key. Undefined for a stream every device of the user may read.
   */
  boundReader?(threadId: string): { reader: NodeId; subject: string } | undefined
  /**
   * Whether the reader of an open private stream may still read it, asked on every read (`privateAccess`): a bot stream
   * is read only while its reader's bot level is not Off and, for one bot's chat, while it reaches that bot. Without
   * it, an open private stream stays readable until it is closed.
   */
  privateReadable?(spec: PrivateSpec): boolean
  /**
   * Whether a session (of `holder`, when given) is being served the stream. Without it, no stream
   * is ever released for being idle.
   */
  isSubscribed?(stream: StreamId, holder?: string): boolean
  /** Whether the thread has a running turn, which keeps its stream open. */
  isTurnActive?(threadId: string): boolean
  /** Release a stream no one is subscribed to and no turn is running on after this long (default 10 minutes). */
  idleMs?: number
  /** Drop the stored records of a stream not opened for this long (default 7 days). */
  staleMs?: number
  /** How often idle streams are looked for (default 1 minute). */
  sweepMs?: number
  /** Minimum spacing between delta flushes per stream (default 100 ms). */
  deltaIntervalMs?: number
  /** `key` names what the delta replaces: one streaming message, or the pending questions. */
  onDelta?(stream: StreamId, data: unknown, key: string): void
  /** Deltas already handed to `onDelta` whose key matches are superseded by a durable record. */
  onDeltaDiscard?(stream: StreamId, matches: (key: string) => boolean): void
  onRecord?(stream: StreamId, record: StoredRecord): void
  onError?(threadId: string, error: unknown, stream: StreamId): void
}
const IDLE_MS = 10 * 60 * 1000,
  STALE_MS = 7 * 24 * 60 * 60 * 1000,
  SWEEP_MS = 60 * 1000,
  STALE_CHECK_MS = 60 * 60 * 1000,
  STALE_BATCH = 20,
  HOLDER_MAX_THREADS = 16,
  SNAPSHOT_MAX = 32 * 1024 * 1024,
  CHUNK_BYTES = 32 * 1024,
  DELTA_MAX = 32 * 1024,
  /**
   * A terminal's chunks that arrive this close together are signed and stored in one transaction, each as its
   * own record. A burst of output (a build, `yes`) is hundreds of chunks a second, and a roster check, a
   * signature and a commit each is far more than a terminal needs.
   */
  BATCH_MS = 4,
  BATCH_MAX_RECORDS = 32,
  /** Well under what one transaction may hold (STORE_TXN_MAX_BYTES, 1 MiB), with the envelopes and signatures counted in. */
  BATCH_MAX_BYTES = 256 * 1024,
  /**
   * Records stored in one transaction at most, and their envelopes and signatures in bytes: half of what the store
   * allows (each record counts two rows, its own and its stream's head). A snapshot is stored in transactions of this
   * size: a 32 KiB chunk takes about 44 KiB signed, so about eleven chunks go in each.
   */
  TXN_RECORDS = Math.floor(STORE_TXN_MAX_ROWS / 4),
  TXN_BYTES = STORE_TXN_MAX_BYTES / 2
const PRIVATE_DELTA_SET: readonly string[] = PRIVATE_DELTA_TYPES
/**
 * The bytes a record body takes on the wire, or undefined when it has more nodes than one record may carry
 * (`MAX_JSON_NODES`). Callers treat that like a body that is too large, never as a failed stream.
 */
function wireSize(body: unknown): number | undefined {
  try {
    return canonicalJson(body).byteLength
  } catch (error) {
    if (error instanceof NetError && error.code === 'too_large') return undefined
    throw error
  }
}
const PRIVATE_DURABLE_SET: readonly string[] = [...BRIDGE_ROUTED_EVENT_TYPES, ...BOT_STREAM_EVENT_TYPES]

/**
 * Streaming message deltas coalesce per message; question updates per thread; the notes only a
 * private stream sends coalesce per kind (and per subagent parent or action, which are many).
 */
function deltaKey(event: ThreadDisplayEvent | ThreadDeltaEvent): string | undefined {
  if (event.type === 'questions.updated') return 'questions'
  if (PRIVATE_DELTA_SET.includes(event.type)) {
    const data = (event.data ?? {}) as { parentThreadId?: unknown; action?: { id?: unknown }; activationId?: unknown }
    // A bot's chip: one per activation, so its chat turn's and its work's do not replace each other.
    const part = data.parentThreadId ?? data.action?.id ?? (event.type === 'bots.activity' ? data.activationId : undefined)
    return `${event.type}:${typeof part === 'string' ? part : ''}`
  }
  const message = (event.data as { message?: { id?: unknown } } | undefined)?.message
  return typeof message?.id === 'string' ? 'message:' + message.id : undefined
}
const isMessageKey = (key: string): boolean => key.startsWith('message:')
/** The ids a note keeps when its payload is too large to send: enough to know what to fetch. */
function omittedIds(data: unknown): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const key of ['threadId', 'parentThreadId'])
    if (typeof (data as Record<string, unknown> | undefined)?.[key] === 'string')
      ids[key] = (data as Record<string, string>)[key]
  return ids
}
/** Display-only adapter. ThreadDataStore remains authoritative; no received wrapper can execute. */
export class ThreadStreamAdapter {
  readonly store: StreamStore
  private readonly active = new Map<StreamId, ActiveThread>()
  /** Which streams one device alone reads (`boundReader`), by stream, kept so a read is not a query. */
  private readonly readerBindings = new Map<StreamId, NodeId | undefined>()
  /** Which streams are private to a reader, kept so the check that runs for every record is not a query. */
  private readonly privateBindings = new Map<
    StreamId,
    { reader: NodeId; kind: PrivateStreamKind } | undefined
  >()
  /**
   * Private thread streams whose source is reading ahead (`openPrivateWarm`). A close that matches one (the reader
   * blocked, its access gone, the stream closed) cancels it: the stream is not opened once the read is done.
   */
  private readonly opening = new Set<{ spec: PrivateSpec; cancelled: boolean }>()
  private readonly boot: string
  private sweepTimer?: { cancel(): void }
  private sweepSlow = false
  private swept = false
  private lastStaleCheckAt = Number.NEGATIVE_INFINITY
  private closed = false
  constructor(private readonly options: ThreadStreamOptions) {
    this.boot = options.bootId ?? randomUUID()
    if (
      !Number.isSafeInteger(options.maxRows ?? 512) ||
      (options.maxRows ?? 512) < 1 ||
      !Number.isSafeInteger(options.maxBytes ?? 1024 * 1024) ||
      (options.maxBytes ?? 1024 * 1024) < 65536
    )
      throw new NetError('bad_request')
    // The column check and the ALTERs share one write transaction, so two openers cannot both add.
    options.db.transaction(() => {
      options.db.database.exec(
        'CREATE TABLE IF NOT EXISTS bridge_thread_streams(thread_id TEXT PRIMARY KEY,stream TEXT NOT NULL UNIQUE,boot TEXT NOT NULL) STRICT'
      )
      // Streams opened before the idle columns existed start their stale period now.
      if (
        !options.db.database
          .prepare('PRAGMA table_info(bridge_thread_streams)')
          .all()
          .some((row) => row.name === 'last_active')
      ) {
        options.db.database.exec(
          'ALTER TABLE bridge_thread_streams ADD COLUMN last_active INTEGER NOT NULL DEFAULT 0;ALTER TABLE bridge_thread_streams ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0'
        )
        options.db.database
          .prepare('UPDATE bridge_thread_streams SET last_active=?')
          .run(options.clock.now())
      }
    })
    this.store = new Proxy(options.store, {
      get: (target, key) => {
        if (key === 'getStream')
          return (stream: StreamId) => {
            const row = this.options.db.database
              .prepare('SELECT thread_id FROM bridge_thread_streams WHERE stream=?')
              .get(stream)
            // A lookup reopens a released shared stream. A private stream is never reopened here: it
            // opens only through `openPrivate`, which the owner's checks (the block, the switches,
            // the thread or terminal being this computer's) stand in front of.
            if (row && !this.active.has(stream) && !isPrivateKey(String(row.thread_id)))
              this.activateKey(String(row.thread_id))
            return target.getStream(stream)
          }
        if (key === 'openSnapshot')
          return (stream: StreamId, options?: Parameters<StreamStore['openSnapshot']>[1]) => {
            const thread = this.active.get(stream)
            // The snapshot already published, with the records after it, is what a fresh one would show.
            if (thread && !thread.published) this.refreshSnapshot(thread)
            // Where to read from goes through: a copy of another computer's stream is read from its newest snapshot,
            // not from its oldest record.
            return target.openSnapshot(stream, options)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    this.scheduleSweep()
  }
  /**
   * Opens the thread's display stream. `holder` names the caller (a node) opening it: one holder
   * may keep only `maxThreadsPerHolder` threads open, so a single device cannot fill the shared cap.
   * When either cap is full, streams no one reads give way first; only streams in use refuse an open.
   */
  activate(threadId: string, holder?: string): StreamDescriptor {
    // A private stream is opened for its reader only (`openPrivate`); no caller names its key.
    if (typeof threadId === 'string' && isPrivateKey(threadId)) throw new NetError('bad_request')
    return this.activateKey(threadId, holder)
  }

  /**
   * Opens the thread's display stream as `activate` does. A stream not open yet first has its source read what the
   * snapshot needs off the event loop (`ThreadSourcePort.warm`); the snapshot is then built once, from that.
   */
  async open(threadId: string, holder?: string): Promise<StreamDescriptor> {
    if (
      typeof threadId === 'string' &&
      !isPrivateKey(threadId) &&
      ![...this.active.values()].some((thread) => thread.threadId === threadId)
    ) {
      try {
        await this.options.source.warm?.(threadId)
      } catch {
        // Reading ahead is only to spare the event loop; the snapshot reads what it needs itself.
      }
    }
    return this.activate(threadId, holder)
  }

  /**
   * Opens a stream only `spec.reader` may read (see `privateStreams.ts`), or returns the one that is
   * open. One computer may hold 16 thread streams, one lists, one channel and 4 terminals; together
   * the computers hold 32 thread streams. A stream left idle is released first to make room.
   */
  openPrivate(spec: PrivateSpec): StreamDescriptor {
    return this.activateKey(privateKey(spec), undefined, spec)
  }

  /**
   * Opens a private stream as `openPrivate` does. A thread stream not open yet first has its source read what the
   * snapshot needs off the event loop (`ThreadSourcePort.warm`), so the snapshot does not load the thread. What the
   * open depends on is checked again after that read: `stillAllowed` (the caller's own checks, such as the thread
   * still being one this computer shares), no close of the reader's streams in the meantime, and room for the stream.
   * A stream that is open returns at once; so do the other kinds, whose snapshots are small.
   */
  async openPrivateWarm(spec: PrivateSpec, stillAllowed?: () => void): Promise<StreamDescriptor> {
    const key = privateKey(spec)
    if (spec.kind !== 'thread' || !this.options.source.warm || this.isOpen(key))
      return this.openPrivate(spec)
    // A computer that would be refused for room is refused before anything is read.
    this.assertPrivateRoom(spec)
    const pending = { spec, cancelled: false }
    this.opening.add(pending)
    try {
      await this.options.source.warm(key)
    } catch {
      // Reading ahead is only to spare the event loop; the snapshot reads what it needs itself.
    } finally {
      this.opening.delete(pending)
    }
    if (pending.cancelled || this.closed) throw new NetError('cancelled')
    stillAllowed?.()
    return this.openPrivate(spec)
  }

  private isOpen(threadId: string): boolean {
    for (const thread of this.active.values()) if (thread.threadId === threadId) return true
    return false
  }

  /**
   * The node a private stream is bound to, what it carries, and whether it is open now. Undefined for
   * any other stream. A stream that was closed or released is not read until its computer opens it again, and an open
   * one its reader may no longer read (`ThreadStreamOptions.privateReadable`) counts as closed.
   */
  privateAccess(
    stream: StreamId
  ): { reader: NodeId; kind: PrivateStreamKind; open: boolean } | undefined {
    const live = this.active.get(stream)
    if (live) return live.spec && { reader: live.spec.reader, kind: live.spec.kind, open: this.readable(live.spec) }
    if (!this.privateBindings.has(stream)) {
      const row = this.options.db.database
        .prepare('SELECT thread_id FROM bridge_thread_streams WHERE stream=?')
        .get(stream)
      const spec = row ? parsePrivateKey(String(row.thread_id)) : undefined
      this.privateBindings.set(stream, spec && { reader: spec.reader, kind: spec.kind })
    }
    const bound = this.privateBindings.get(stream)
    return bound && { ...bound, open: false }
  }

  /**
   * The one device that may read `stream`, when it is bound to one that is not a private stream (a phone's own lists,
   * `ThreadStreamOptions.boundReader`). Read for every subscription, so a guessed stream id reads nothing.
   */
  boundReader(stream: StreamId): NodeId | undefined {
    if (!this.options.boundReader) return undefined
    if (!this.readerBindings.has(stream)) {
      const live = this.active.get(stream)
      const key = live
        ? live.threadId
        : (this.options.db.database.prepare('SELECT thread_id FROM bridge_thread_streams WHERE stream=?').get(stream)?.thread_id as string | undefined)
      // A stream this computer never made reads nothing anyway, and is not remembered.
      if (key === undefined) return undefined
      this.readerBindings.set(stream, this.options.boundReader(String(key))?.reader)
    }
    return this.readerBindings.get(stream)
  }

  private readable(spec: PrivateSpec): boolean {
    if (!this.options.privateReadable) return true
    try {
      return this.options.privateReadable(spec)
    } catch {
      return false
    }
  }

  /** The computers that have a private stream open, or one opening. */
  privateReaders(): NodeId[] {
    return [
      ...new Set([
        ...[...this.active.values()].flatMap((thread) => (thread.spec ? [thread.spec.reader] : [])),
        ...[...this.opening].map((pending) => pending.spec.reader)
      ])
    ]
  }

  /**
   * Stops serving private streams (of `reader`, of one `kind`, or all). Their stored records stay, and
   * the reader can open them again if it may. Returns the streams that were open, so the sessions
   * that serve them can be told.
   */
  closePrivate(
    filter: {
      reader?: NodeId
      kind?: PrivateStreamKind
      /** Only streams of these kinds. */
      kinds?: readonly PrivateStreamKind[]
      subject?: string
      /** Only the streams this says yes to. */
      where?: (spec: PrivateSpec) => boolean
    } = {}
  ): StreamId[] {
    const matches = (spec: PrivateSpec): boolean =>
      (!filter.reader || spec.reader === filter.reader) &&
      (!filter.kind || spec.kind === filter.kind) &&
      (!filter.kinds || filter.kinds.includes(spec.kind)) &&
      (filter.subject === undefined || spec.subject === filter.subject) &&
      (!filter.where || filter.where(spec))
    // A stream still reading ahead is not opened when it is done.
    for (const pending of this.opening) if (matches(pending.spec)) pending.cancelled = true
    const closed: StreamId[] = []
    for (const thread of [...this.active.values()]) {
      if (!thread.spec || !matches(thread.spec)) continue
      this.deactivate(thread.threadId)
      closed.push(thread.stream)
    }
    return closed
  }

  /** Where the stream `reader` holds open for `threadId` is now, if it holds one. */
  privateHead(
    reader: NodeId,
    threadId: string
  ): { stream: StreamId; epoch: number; seq: number } | undefined {
    for (const thread of this.active.values())
      if (
        thread.spec?.reader === reader &&
        thread.spec.kind === 'thread' &&
        thread.spec.subject === threadId
      ) {
        const head = this.options.store.head(thread.stream)
        return { stream: thread.stream, ...head }
      }
    return undefined
  }

  /**
   * Adds a record to the channel stream `reader` holds open (Git progress for the window that started
   * the action). Nothing happens when the reader holds none: progress is for a window that is watching.
   */
  pushChannel(
    reader: NodeId,
    type: (typeof BRIDGE_ROUTED_EVENT_TYPES)[number],
    data: unknown
  ): boolean {
    for (const thread of this.active.values())
      if (thread.spec?.reader === reader && thread.spec.kind === 'channel') {
        this.appendEvent(thread, type, data)
        return true
      }
    return false
  }

  private sharedOpen(): number {
    return [...this.active.values()].filter((thread) => !thread.spec).length
  }

  private assertPrivateRoom(spec: PrivateSpec): void {
    const count = (match: (other: PrivateSpec) => boolean): number =>
      [...this.active.values()].filter((thread) => thread.spec && match(thread.spec)).length
    // Bot streams have a room of their own: thread streams never fill what a bot's chat needs, nor the other way.
    const full = (): boolean =>
      count((other) => other.reader === spec.reader && other.kind === spec.kind) >=
        PRIVATE_STREAM_QUOTA[spec.kind] ||
      (spec.kind === 'thread' &&
        count((other) => other.kind === 'thread') >= PRIVATE_THREAD_STREAMS_TOTAL) ||
      count((other) => sameRoom(other.kind, spec.kind)) >=
        (isBotStreamKind(spec.kind) ? PRIVATE_BOT_STREAMS_TOTAL : PRIVATE_STREAMS_TOTAL)
    if (!full()) return
    // Streams no one reads any more give way before the computer is refused.
    this.releaseIdle()
    if (full()) throw new NetError('rate_limited')
  }

  private activateKey(threadId: string, holder?: string, given?: PrivateSpec): StreamDescriptor {
    if (typeof threadId !== 'string' || !threadId.length || threadId.length > 256)
      throw new NetError('bad_request')
    const spec = given ?? (isPrivateKey(threadId) ? parsePrivateKey(threadId) : undefined)
    if (isPrivateKey(threadId) && !spec) throw new NetError('bad_request')
    const now = this.options.clock.now()
    const known = [...this.active.values()].find((thread) => thread.threadId === threadId)
    if (known) {
      // Marked busy first, so making room for the holder cannot release this very stream.
      known.lastBusyAt = now
      this.admitHolder(known, holder, now)
      return known.descriptor
    }
    if (spec) this.assertPrivateRoom(spec)
    else {
      if (holder !== undefined && this.metered(threadId)) this.assertHolderRoom(holder)
      // Private streams have quotas of their own, so they do not use up what phones may open.
      const maxThreads = this.options.maxThreads ?? 64
      if (this.sharedOpen() >= maxThreads) this.releaseIdle()
      // Still full: the stream least recently in use that no one reads and no turn runs on gives way.
      while (this.sharedOpen() >= maxThreads && this.releaseLeastBusy()) {
        // Released one; check again.
      }
      if (this.sharedOpen() >= maxThreads) throw new NetError('rate_limited')
    }
    if (this.options.db.database.isTransaction)
      throw new NetError('forbidden', 'Display generations must commit before publication.')
    // The snapshot is built before a permanent stream identity is allocated, which also checks that the source
    // exists, and published once the stream is: nothing runs in between, so no event can come before it.
    const first = this.buildSnapshot(threadId)
    const self = this.options.identity.self()
    if (!self) throw new NetError('not_enrolled')
    let descriptor!: StreamDescriptor
    this.options.db.transaction(() => {
      const row = this.options.db.database
        .prepare('SELECT stream,boot FROM bridge_thread_streams WHERE thread_id=?')
        .get(threadId)
      if (row) {
        descriptor = this.options.store.getStream(row.stream as StreamId)!
        if (!descriptor || descriptor.kind !== 'node.thread' || descriptor.authority !== self.node)
          throw new NetError('storage_corrupt')
        if (row.boot !== this.boot) {
          this.options.generations.beginNodeEpoch(
            descriptor.id,
            this.options.store.head(descriptor.id).epoch + 1
          )
          this.options.db.database
            .prepare('UPDATE bridge_thread_streams SET boot=? WHERE thread_id=?')
            .run(this.boot, threadId)
        }
      } else {
        descriptor = {
          id: newId('stream'),
          kind: 'node.thread',
          authority: self.node,
          createdAt: this.options.clock.now()
        }
        this.options.store.createStream(descriptor, 1)
        this.options.db.database
          .prepare(
            'INSERT INTO bridge_thread_streams(thread_id,stream,boot,last_active,dropped) VALUES(?,?,?,?,0)'
          )
          .run(threadId, descriptor.id, this.boot, now)
      }
      this.options.db.database
        .prepare('UPDATE bridge_thread_streams SET last_active=?,dropped=0 WHERE thread_id=?')
        .run(now, threadId)
      this.options.db.charge(1)
    })
    const terminal = spec?.kind === 'terminal'
    const thread: ActiveThread = {
      threadId,
      subject: spec ? privateRecordSubject(spec) : (this.options.boundReader?.(threadId)?.subject ?? threadId),
      ...(spec ? { spec } : {}),
      ...(terminal
        ? { maxRows: PRIVATE_TERMINAL_RING_ROWS, maxBytes: PRIVATE_TERMINAL_RING_BYTES }
        : {}),
      stream: descriptor.id,
      descriptor,
      ring: [],
      bytes: 0,
      deltas: new Map(),
      holders: new Map(),
      lastBusyAt: now
    }
    if (spec) this.privateBindings.set(descriptor.id, { reader: spec.reader, kind: spec.kind })
    else if (holder !== undefined && this.metered(threadId)) thread.holders.set(holder, now)
    this.refreshSnapshot(thread, first)
    this.active.set(thread.stream, thread)
    this.scheduleSweep()
    const fail = (error: unknown): void => {
      if (this.active.get(thread.stream) !== thread) return
      this.deactivate(threadId)
      this.options.onError?.(threadId, error, thread.stream)
    }
    // A private stream sends more kinds of record than a phone's stream may, and only to its reader.
    const durableTypes: readonly string[] = spec
      ? [...THREAD_EVENT_TYPES, ...PRIVATE_DURABLE_SET]
      : THREAD_EVENT_TYPES
    const deltaTypes: readonly string[] = spec
      ? [...THREAD_DELTA_TYPES, ...PRIVATE_DELTA_SET]
      : THREAD_DELTA_TYPES
    thread.dispose = this.options.source.onThread(
      threadId,
      (event) => {
        try {
          // A fresh snapshot truncates the records before it, so no ring trim follows.
          if ('snapshot' in event) {
            this.refreshSnapshot(thread)
            return
          }
          const body = { threadId: thread.subject, type: event.type, data: event.data }
          // A terminal's output waits a few milliseconds to be stored with what comes right after it. Nothing else
          // on its stream overtakes it: anything that is not output is stored behind what is already waiting.
          if (thread.spec?.kind === 'terminal' && event.type === 'pty.data' && !event.ephemeral) {
            const size = wireSize(body)
            if (size !== undefined && size <= 48 * 1024) {
              this.queueBatch(thread, body, size)
              return
            }
          }
          this.flushBatch(thread)
          if (event.ephemeral) {
            if (!deltaTypes.includes(event.type)) throw new NetError('bad_request')
            // A delta is never stored: a reader that opens the stream later is given a fresh snapshot that has it. A
            // private note (`PRIVATE_DELTA_TYPES`) carries nothing a snapshot has: the reader fetches what it says
            // changed when it opens the thread, so the published snapshot still serves. A streaming message or the
            // pending questions are in a fresh snapshot, and a reader that missed the delta might not get another
            // for minutes (a tool call that runs long, a question that waits), so those still need one.
            if (!PRIVATE_DELTA_SET.includes(event.type)) thread.published = undefined
            const key = deltaKey(event)
            if (!key) return
            const size = wireSize(body)
            if (size !== undefined && size <= DELTA_MAX) this.queueDelta(thread, key, body)
            // A note too large to send whole still says that something changed; the reader fetches it.
            else if (PRIVATE_DELTA_SET.includes(event.type))
              this.queueDelta(thread, key, {
                threadId: thread.subject,
                type: event.type,
                data: { omitted: true, ...omittedIds(event.data) }
              })
            return
          }
          if (!durableTypes.includes(event.type)) throw new NetError('bad_request')
          // A settled record supersedes any streaming delta for the same message.
          if (event.type === 'thread.messages') this.dropDeltas(thread, isMessageKey)
          else {
            const key = deltaKey(event)
            if (key) this.dropDeltas(thread, (candidate) => candidate === key)
          }
          // Oversized display events are replaced by a fresh source snapshot, never inline oversize. One with
          // more nodes than a record may carry counts as oversized too: it would fail the stream when stored.
          const size = wireSize(body)
          if (size === undefined || size > 48 * 1024) this.refreshSnapshot(thread)
          else this.append(thread, 'thread.event', body)
          this.trim(thread)
        } catch (error) {
          fail(error)
        }
      },
      fail
    )
    return descriptor
  }

  /** A durable event record added from outside the thread's own source (the channel's progress). */
  private appendEvent(thread: ActiveThread, type: string, data: unknown): void {
    try {
      const body = { threadId: thread.subject, type, data }
      // Progress is small; one that is not is dropped rather than turned into a snapshot.
      const size = wireSize(body)
      if (size === undefined || size > 48 * 1024) return
      this.append(thread, 'thread.event', body)
      this.trim(thread)
    } catch (error) {
      this.deactivate(thread.threadId)
      this.options.onError?.(thread.threadId, error, thread.stream)
    }
  }
  /** Keeps one record of a terminal's output to be stored with the ones around it (see `BATCH_MS`). */
  private queueBatch(thread: ActiveThread, body: unknown, size: number): void {
    const batch = (thread.batch ??= { bodies: [], bytes: 0 })
    batch.bodies.push(body)
    batch.bytes += size
    if (batch.bodies.length >= BATCH_MAX_RECORDS || batch.bytes >= BATCH_MAX_BYTES)
      return this.flushBatch(thread)
    batch.timer ??= this.options.clock.setTimeout(() => {
      try {
        this.flushBatch(thread)
      } catch (error) {
        if (this.active.get(thread.stream) !== thread) return
        this.deactivate(thread.threadId)
        this.options.onError?.(thread.threadId, error, thread.stream)
      }
    }, BATCH_MS)
  }
  /** Stores what a terminal's stream is holding back, in the order it arrived. */
  private flushBatch(thread: ActiveThread): void {
    const batch = thread.batch
    if (!batch) return
    thread.batch = undefined
    batch.timer?.cancel()
    if (!batch.bodies.length) return
    this.appendMany(thread, 'thread.event', batch.bodies)
    this.trim(thread)
  }
  private queueDelta(thread: ActiveThread, key: string, body: unknown): void {
    if (!this.options.onDelta) return
    thread.deltas.delete(key)
    thread.deltas.set(key, body)
    if (thread.deltaTimer) return
    thread.deltaTimer = this.options.clock.setTimeout(
      () => this.flushDeltas(thread),
      this.options.deltaIntervalMs ?? 100
    )
  }
  private flushDeltas(thread: ActiveThread): void {
    thread.deltaTimer = undefined
    if (this.active.get(thread.stream) !== thread) return
    const pending = [...thread.deltas]
    thread.deltas.clear()
    for (const [key, body] of pending) {
      try {
        this.options.onDelta?.(thread.stream, body, key)
      } catch {
        // Deltas are best effort; the durable stream stays authoritative.
      }
    }
  }
  /** Pending deltas here and any already handed to the sessions, before the record is stored. */
  private dropDeltas(thread: ActiveThread, matches: (key: string) => boolean): void {
    for (const key of [...thread.deltas.keys()]) if (matches(key)) thread.deltas.delete(key)
    this.options.onDeltaDiscard?.(thread.stream, matches)
  }
  /** A stream that is closed does not store what it was holding back: its reader is no longer served. */
  private dropBatch(thread: ActiveThread): void {
    thread.batch?.timer?.cancel()
    thread.batch = undefined
  }
  private stopDeltas(thread: ActiveThread): void {
    thread.deltaTimer?.cancel()
    thread.deltaTimer = undefined
    thread.deltas.clear()
  }
  private append(thread: ActiveThread, type: string, body: unknown): StoredRecord {
    return this.appendMany(thread, type, [body])[0]!
  }
  private appendMany(thread: ActiveThread, type: string, bodies: readonly unknown[]): StoredRecord[] {
    return this.appendRecords(
      thread,
      bodies.map((body) => ({ type, body }))
    )
  }
  /**
   * Signs and stores records in the order given: the roster and this computer's delegation are checked once, each
   * record is signed on its own, and they are stored a transaction at a time, each within `TXN_RECORDS` and
   * `TXN_BYTES`, and published after its commit. Each body is its own record, so nothing about a record changes by
   * being stored with others.
   */
  private appendRecords(
    thread: ActiveThread,
    items: Iterable<{ type: string; body: unknown }>
  ): StoredRecord[] {
    if (this.options.db.database.isTransaction)
      throw new NetError('forbidden', 'Display records cannot escape an enclosing transaction.')
    const identity = this.options.identity,
      self = identity.self()!,
      root = identity.pinnedRootKey(self.user)!,
      signed = identity.roster()!
    if (identity.rosterState(self.user) !== 'ok') throw new NetError('roster_conflict')
    const roster = identity.verifySigned<Roster>(signed, root)
    const delegation = roster.nodes
      .map((row) => identity.verifySigned<NodeDelegation>(row, root))
      .filter((row) => row.subject === self.node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    // A clock a little behind the one that issued the delegation is allowed the engine's skew (wire.md).
    if (
      !delegation ||
      delegation.issuedAt > this.options.clock.now() + engineLimits().clockSkewMs ||
      delegation.expiresAt <= this.options.clock.now() ||
      roster.revoked.some(
        (row) => row.subject === self.node && row.throughKeyEpoch >= delegation.keyEpoch
      )
    )
      throw new NetError('bad_delegation')
    const seal = (type: string, body: unknown): { id: Envelope['id']; bytes: Uint8Array; sig: Uint8Array } => {
      const envelope: Envelope = {
        v: 1,
        minor: 0,
        id: newId('event'),
        stream: thread.stream,
        type,
        crit: false,
        author: { user: self.user, node: self.node, keyEpoch: delegation.keyEpoch },
        ts: this.options.clock.now(),
        body
      }
      const bytes = encodeEnvelope(envelope),
        sig = this.options.keys.signAsNode(bytes)
      identity.verifyAuthor(envelope.author, bytes, sig, this.options.clock.now(), 'newWork')
      return { id: envelope.id, bytes, sig }
    }
    const records: StoredRecord[] = []
    let batch: Array<ReturnType<typeof seal>> = [],
      batchBytes = 0
    const flush = (): void => {
      if (batch.length) records.push(...this.storeSealed(thread, batch))
      batch = []
      batchBytes = 0
    }
    for (const { type, body } of items) {
      const sealed = seal(type, body),
        size = sealed.bytes.byteLength + sealed.sig.byteLength
      if (batch.length >= TXN_RECORDS || (batch.length && batchBytes + size > TXN_BYTES)) flush()
      batch.push(sealed)
      batchBytes += size
    }
    flush()
    return records
  }
  /** Stores signed records in one transaction, then keeps them in the ring and publishes them. */
  private storeSealed(
    thread: ActiveThread,
    sealed: ReadonlyArray<{ id: Envelope['id']; bytes: Uint8Array; sig: Uint8Array }>
  ): StoredRecord[] {
    const records: StoredRecord[] = []
    const store = (): void => {
      for (const { id, bytes, sig } of sealed) {
        const position = this.options.store.appendAsAuthority(thread.stream, {
          id,
          envelope: bytes,
          sig,
          recvTs: this.options.clock.now()
        })
        records.push({ ...position, envelope: bytes, sig })
      }
    }
    if (sealed.length === 1) store()
    else this.options.db.transaction(store)
    for (const record of records) {
      thread.ring.push(record)
      thread.bytes += record.envelope.byteLength + record.sig.byteLength
      while (
        thread.ring.length > (thread.maxRows ?? this.options.maxRows ?? 512) ||
        thread.bytes > (thread.maxBytes ?? this.options.maxBytes ?? 1024 * 1024)
      ) {
        const dropped = thread.ring.shift()!
        thread.bytes -= dropped.envelope.byteLength + dropped.sig.byteLength
      }
      this.options.onRecord?.(thread.stream, record)
    }
    return records
  }
  /** The thread's display snapshot from its source, as the bytes its records carry. */
  private buildSnapshot(threadId: string): Uint8Array {
    const bytes = canonicalJson(this.options.source.snapshot(threadId), MAX_DISPLAY_JSON_NODES)
    if (bytes.byteLength > SNAPSHOT_MAX)
      throw new NetError('too_large', 'Display snapshot exceeds 32 MiB.')
    return bytes
  }
  /** Publishes a snapshot (`built`, or one built now) and lets go of the records before it. */
  private refreshSnapshot(thread: ActiveThread, built?: Uint8Array): void {
    // What is waiting was printed before this snapshot was read: it goes first, then the snapshot replaces it.
    this.flushBatch(thread)
    thread.published = undefined
    const bytes = built ?? this.buildSnapshot(thread.threadId)
    const snapshot = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('base64url'),
      chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)),
      previous = this.options.store.head(thread.stream).seq
    const subject = thread.subject
    // Begin, chunks and end, in order, stored a few chunks to a transaction; each chunk is encoded as it is signed.
    function* records(): Generator<{ type: string; body: unknown }> {
      yield {
        type: 'thread.snapshot.begin',
        body: { threadId: subject, snapshot, totalBytes: bytes.length, chunks, sha256 }
      }
      for (let index = 0; index < chunks; index++)
        yield {
          type: 'thread.snapshot.chunk',
          body: {
            threadId: subject,
            snapshot,
            index,
            data: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString(
              'base64url'
            )
          }
        }
      yield { type: 'thread.snapshot.end', body: { threadId: subject, snapshot, sha256 } }
    }
    const begin = this.appendRecords(thread, records())[0]!
    if (previous) this.options.store.truncate(thread.stream, previous, { forgetIds: true })
    thread.published = { begin: begin.seq }
  }
  private trim(thread: ActiveThread): void {
    if (!thread.ring.length || thread.ring[0].seq <= 1) return
    const through = thread.ring[0].seq - 1
    this.options.store.truncate(thread.stream, through, { forgetIds: true })
    // A snapshot larger than the ring loses its first records here; a reader that opens the stream needs a new one.
    if (thread.published && through >= thread.published.begin) thread.published = undefined
  }
  deactivate(threadId: string): void {
    for (const [stream, thread] of this.active)
      if (thread.threadId === threadId) {
        thread.dispose?.()
        this.stopDeltas(thread)
        this.dropBatch(thread)
        this.active.delete(stream)
        return
      }
  }
  private metered(threadId: string): boolean {
    // A private stream has quotas of its own (`assertPrivateRoom`), apart from the shared per-caller one.
    return !isPrivateKey(threadId) && !this.options.unmetered?.(threadId)
  }
  private threadsHeldBy(holder: string): number {
    let held = 0
    for (const thread of this.active.values())
      if (
        this.metered(thread.threadId) &&
        (thread.holders.has(holder) || this.options.isSubscribed?.(thread.stream, holder))
      )
        held++
    return held
  }
  private assertHolderRoom(holder: string): void {
    if (this.threadsHeldBy(holder) < (this.options.maxThreadsPerHolder ?? HOLDER_MAX_THREADS))
      return
    // Streams this caller no longer uses give way before it is refused.
    this.releaseIdle()
    const max = this.options.maxThreadsPerHolder ?? HOLDER_MAX_THREADS
    const isSubscribed = this.options.isSubscribed
    if (this.threadsHeldBy(holder) >= max && isSubscribed) {
      // Then the caller's own holds on threads it no longer reads, least recently opened first, even before
      // they are idle: a phone moving through many threads is never refused while it reads only a few.
      const unread = [...this.active.values()]
        .filter(
          (thread) =>
            this.metered(thread.threadId) &&
            thread.holders.has(holder) &&
            !isSubscribed(thread.stream, holder)
        )
        .sort((a, b) => a.holders.get(holder)! - b.holders.get(holder)!)
      for (const thread of unread) {
        if (this.threadsHeldBy(holder) < max) break
        thread.holders.delete(holder)
      }
    }
    if (this.threadsHeldBy(holder) >= max) throw new NetError('rate_limited')
  }
  private admitHolder(thread: ActiveThread, holder: string | undefined, now: number): void {
    if (holder === undefined || !this.metered(thread.threadId)) return
    if (!thread.holders.has(holder)) this.assertHolderRoom(holder)
    thread.holders.set(holder, now)
  }
  /**
   * Housekeeping runs on its own only where the host can say who is subscribed. It sweeps every
   * minute while a stream is open, and hourly while none is, so stale records go either way.
   */
  private scheduleSweep(): void {
    if (this.closed || !this.options.isSubscribed) return
    const quick = this.active.size > 0 || !this.swept
    if (this.sweepTimer) {
      if (!this.sweepSlow || !quick) return
      this.sweepTimer.cancel()
    }
    this.sweepSlow = !quick
    this.sweepTimer = this.options.clock.setTimeout(
      () => {
        this.sweepTimer = undefined
        this.swept = true
        try {
          this.releaseIdle()
          this.dropStale()
        } catch {
          // Housekeeping only; the next sweep tries again.
        }
        this.scheduleSweep()
      },
      quick ? (this.options.sweepMs ?? SWEEP_MS) : STALE_CHECK_MS
    )
  }
  /**
   * Releases streams that no session is subscribed to and no turn is running on, once they have
   * been quiet for the idle period. A released stream keeps its identity and reopens on demand.
   */
  releaseIdle(): number {
    const { isSubscribed, isTurnActive } = this.options
    if (!isSubscribed) return 0
    const now = this.options.clock.now(),
      idle = this.options.idleMs ?? IDLE_MS
    let released = 0
    for (const thread of [...this.active.values()]) {
      for (const [holder, touched] of thread.holders)
        if (now - touched >= idle && !isSubscribed(thread.stream, holder))
          thread.holders.delete(holder)
      // Only a thread's own stream is kept open by its turn; the lists, the channel and a terminal are not turns.
      const turn = (!thread.spec || thread.spec.kind === 'thread') && isTurnActive?.(thread.subject)
      if (isSubscribed(thread.stream) || turn) {
        thread.lastBusyAt = now
        continue
      }
      if (now - thread.lastBusyAt < idle) continue
      this.release(thread)
      released++
    }
    return released
  }
  /**
   * Releases the shared stream least recently in use that no session is subscribed to and no turn is running
   * on, idle or not. False when there is none, or when the host cannot say who is subscribed.
   */
  private releaseLeastBusy(): boolean {
    const { isSubscribed, isTurnActive } = this.options
    if (!isSubscribed) return false
    let oldest: ActiveThread | undefined
    for (const thread of this.active.values()) {
      if (thread.spec || isSubscribed(thread.stream) || isTurnActive?.(thread.subject)) continue
      if (!oldest || thread.lastBusyAt < oldest.lastBusyAt) oldest = thread
    }
    if (!oldest) return false
    this.release(oldest)
    return true
  }
  private release(thread: ActiveThread): void {
    this.deactivate(thread.threadId)
    this.options.db.transaction(() =>
      this.options.db.database
        .prepare('UPDATE bridge_thread_streams SET last_active=? WHERE thread_id=?')
        .run(thread.lastBusyAt, thread.threadId)
    )
  }
  /**
   * Stored display records of a stream nobody opened for the stale period go away. The stream keeps
   * its identity, and a later open publishes a fresh snapshot.
   */
  dropStale(): number {
    const now = this.options.clock.now()
    if (now - this.lastStaleCheckAt < STALE_CHECK_MS) return 0
    this.lastStaleCheckAt = now
    // Open streams are left out in SQL, so many long-lived ones cannot fill the batch.
    const open = [...this.active.keys()]
    const rows = this.options.db.database
      .prepare(
        `SELECT thread_id,stream FROM bridge_thread_streams WHERE dropped=0 AND last_active<? AND stream NOT IN (${open.map(() => '?').join(',') || "''"}) ORDER BY last_active LIMIT ?`
      )
      .all(now - (this.options.staleMs ?? STALE_MS), ...open, STALE_BATCH)
    let dropped = 0
    for (const row of rows) {
      const stream = row.stream as StreamId
      try {
        this.options.store.truncate(stream, this.options.store.head(stream).seq, {
          forgetIds: true
        })
        this.options.db.transaction(() =>
          this.options.db.database
            .prepare('UPDATE bridge_thread_streams SET dropped=1 WHERE thread_id=?')
            .run(row.thread_id)
        )
        dropped++
      } catch {
        // Retention is best effort; the next check tries again.
      }
    }
    return dropped
  }
  ringStats(stream: StreamId): { rows: number; bytes: number } {
    const thread = this.active.get(stream)
    if (!thread) throw new NetError('stream_unknown')
    return { rows: thread.ring.length, bytes: thread.bytes }
  }
  close(): void {
    this.closed = true
    this.sweepTimer?.cancel()
    this.sweepTimer = undefined
    for (const thread of this.active.values()) {
      thread.dispose?.()
      this.stopDeltas(thread)
      this.dropBatch(thread)
    }
    this.active.clear()
  }
}
