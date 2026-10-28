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
  BRIDGE_ROUTED_EVENT_TYPES,
  BRIDGE_THREAD_EVENT_TYPES,
  NetError,
  newId,
  type NodeId
} from '../../../shared/net'
import type { RoutedStreamKind } from '../../../shared/bridge/routed'
import type { Clock, IdentityService, KeyStore, StreamStore } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'
import { canonicalJson, encodeEnvelope, MAX_DISPLAY_JSON_NODES } from '../../net/sync/codec'
import {
  PRIVATE_STREAM_QUOTA,
  PRIVATE_TERMINAL_RING_BYTES,
  PRIVATE_TERMINAL_RING_ROWS,
  PRIVATE_STREAMS_TOTAL,
  PRIVATE_THREAD_STREAMS_TOTAL,
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
  'thread.title-generation-failed'
] as const
export interface ThreadDisplayEvent {
  type: (typeof THREAD_EVENT_TYPES)[number] | (typeof BRIDGE_ROUTED_EVENT_TYPES)[number]
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
  BATCH_MAX_BYTES = 256 * 1024
const PRIVATE_DELTA_SET: readonly string[] = PRIVATE_DELTA_TYPES
const PRIVATE_DURABLE_SET: readonly string[] = BRIDGE_ROUTED_EVENT_TYPES

/**
 * Streaming message deltas coalesce per message; question updates per thread; the notes only a
 * private stream sends coalesce per kind (and per subagent parent or action, which are many).
 */
function deltaKey(event: ThreadDisplayEvent | ThreadDeltaEvent): string | undefined {
  if (event.type === 'questions.updated') return 'questions'
  if (PRIVATE_DELTA_SET.includes(event.type)) {
    const data = (event.data ?? {}) as { parentThreadId?: unknown; action?: { id?: unknown } }
    const part = data.parentThreadId ?? data.action?.id
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
  /** Which streams are private to a reader, kept so the check that runs for every record is not a query. */
  private readonly privateBindings = new Map<
    StreamId,
    { reader: NodeId; kind: RoutedStreamKind } | undefined
  >()
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
          return (stream: StreamId) => {
            const thread = this.active.get(stream)
            if (thread) this.refreshSnapshot(thread)
            return target.openSnapshot(stream)
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
   */
  activate(threadId: string, holder?: string): StreamDescriptor {
    // A private stream is opened for its reader only (`openPrivate`); no caller names its key.
    if (typeof threadId === 'string' && isPrivateKey(threadId)) throw new NetError('bad_request')
    return this.activateKey(threadId, holder)
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
   * The node a private stream is bound to, what it carries, and whether it is open now. Undefined for
   * any other stream. A stream that was closed or released is not read until its computer opens it again.
   */
  privateAccess(
    stream: StreamId
  ): { reader: NodeId; kind: RoutedStreamKind; open: boolean } | undefined {
    const live = this.active.get(stream)
    if (live) return live.spec && { reader: live.spec.reader, kind: live.spec.kind, open: true }
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

  /** The computers that have a private stream open. */
  privateReaders(): NodeId[] {
    return [
      ...new Set(
        [...this.active.values()].flatMap((thread) => (thread.spec ? [thread.spec.reader] : []))
      )
    ]
  }

  /**
   * Stops serving private streams (of `reader`, of one `kind`, or all). Their stored records stay, and
   * the reader can open them again if it may. Returns the streams that were open, so the sessions
   * that serve them can be told.
   */
  closePrivate(
    filter: { reader?: NodeId; kind?: RoutedStreamKind; subject?: string } = {}
  ): StreamId[] {
    const closed: StreamId[] = []
    for (const thread of [...this.active.values()]) {
      const spec = thread.spec
      if (!spec || (filter.reader && spec.reader !== filter.reader)) continue
      if (filter.kind && spec.kind !== filter.kind) continue
      if (filter.subject !== undefined && spec.subject !== filter.subject) continue
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
    const full = (): boolean =>
      count((other) => other.reader === spec.reader && other.kind === spec.kind) >=
        PRIVATE_STREAM_QUOTA[spec.kind] ||
      (spec.kind === 'thread' &&
        count((other) => other.kind === 'thread') >= PRIVATE_THREAD_STREAMS_TOTAL) ||
      count(() => true) >= PRIVATE_STREAMS_TOTAL
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
      if (this.sharedOpen() >= (this.options.maxThreads ?? 64)) this.releaseIdle()
      if (this.sharedOpen() >= (this.options.maxThreads ?? 64)) throw new NetError('rate_limited')
    }
    if (this.options.db.database.isTransaction)
      throw new NetError('forbidden', 'Display generations must commit before publication.')
    // Validate the actual source exists before allocating a permanent stream identity.
    this.options.source.snapshot(threadId)
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
      subject: spec ? privateRecordSubject(spec) : threadId,
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
    this.refreshSnapshot(thread)
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
            const size = canonicalJson(body).byteLength
            if (size <= 48 * 1024) {
              this.queueBatch(thread, body, size)
              return
            }
          }
          this.flushBatch(thread)
          if (event.ephemeral) {
            if (!deltaTypes.includes(event.type)) throw new NetError('bad_request')
            const key = deltaKey(event)
            if (!key) return
            if (canonicalJson(body).byteLength <= DELTA_MAX) this.queueDelta(thread, key, body)
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
          // Oversized display events are replaced by a fresh source snapshot, never inline oversize.
          if (canonicalJson(body).byteLength > 48 * 1024) this.refreshSnapshot(thread)
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
      if (canonicalJson(body).byteLength > 48 * 1024) return
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
  private append(thread: ActiveThread, type: string, body: unknown): void {
    this.appendMany(thread, type, [body])
  }
  /**
   * Signs and stores records, one after another in one transaction: the roster and this computer's delegation are
   * checked once, each record is signed on its own, and the records are published after the commit. Each body is
   * its own record, in the order given, so nothing about a record changes by being stored with others.
   */
  private appendMany(thread: ActiveThread, type: string, bodies: readonly unknown[]): void {
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
    if (
      !delegation ||
      delegation.issuedAt > this.options.clock.now() ||
      delegation.expiresAt <= this.options.clock.now() ||
      roster.revoked.some(
        (row) => row.subject === self.node && row.throughKeyEpoch >= delegation.keyEpoch
      )
    )
      throw new NetError('bad_delegation')
    const sealed = bodies.map((body) => {
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
    })
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
  }
  private refreshSnapshot(thread: ActiveThread): void {
    // What is waiting was printed before this snapshot was read: it goes first, then the snapshot replaces it.
    this.flushBatch(thread)
    const bytes = canonicalJson(this.options.source.snapshot(thread.threadId), MAX_DISPLAY_JSON_NODES)
    if (bytes.byteLength > SNAPSHOT_MAX)
      throw new NetError('too_large', 'Display snapshot exceeds32MiB.')
    const snapshot = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('base64url'),
      chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)),
      previous = this.options.store.head(thread.stream).seq
    this.append(thread, 'thread.snapshot.begin', {
      threadId: thread.subject,
      snapshot,
      totalBytes: bytes.length,
      chunks,
      sha256
    })
    for (let index = 0; index < chunks; index++)
      this.append(thread, 'thread.snapshot.chunk', {
        threadId: thread.subject,
        snapshot,
        index,
        data: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString(
          'base64url'
        )
      })
    this.append(thread, 'thread.snapshot.end', { threadId: thread.subject, snapshot, sha256 })
    if (previous) this.options.store.truncate(thread.stream, previous, { forgetIds: true })
  }
  private trim(thread: ActiveThread): void {
    if (thread.ring.length && thread.ring[0].seq > 1)
      this.options.store.truncate(thread.stream, thread.ring[0].seq - 1, { forgetIds: true })
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
    if (this.threadsHeldBy(holder) >= (this.options.maxThreadsPerHolder ?? HOLDER_MAX_THREADS))
      throw new NetError('rate_limited')
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
      this.deactivate(thread.threadId)
      this.options.db.transaction(() =>
        this.options.db.database
          .prepare('UPDATE bridge_thread_streams SET last_active=? WHERE thread_id=?')
          .run(thread.lastBusyAt, thread.threadId)
      )
      released++
    }
    return released
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
