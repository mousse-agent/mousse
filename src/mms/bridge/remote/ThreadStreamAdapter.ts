import { createHash, randomUUID } from 'node:crypto'
import type {
  Envelope,
  NodeDelegation,
  Roster,
  StreamId,
  StreamDescriptor,
  StoredRecord
} from '../../../shared/net'
import { BRIDGE_THREAD_EVENT_TYPES, NetError, newId } from '../../../shared/net'
import type { Clock, IdentityService, KeyStore, StreamStore } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'
import { canonicalJson, encodeEnvelope } from '../../net/sync/codec'

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
export interface ThreadDisplayEvent {
  type: (typeof THREAD_EVENT_TYPES)[number]
  data: unknown
  ephemeral?: boolean
}
export interface ThreadDeltaEvent {
  type: (typeof THREAD_DELTA_TYPES)[number]
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
  threadId: string
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
  DELTA_MAX = 32 * 1024
/** Streaming message deltas coalesce per message; question updates per thread. */
function deltaKey(event: ThreadDisplayEvent | ThreadDeltaEvent): string | undefined {
  if (event.type === 'questions.updated') return 'questions'
  const message = (event.data as { message?: { id?: unknown } } | undefined)?.message
  return typeof message?.id === 'string' ? 'message:' + message.id : undefined
}
const isMessageKey = (key: string): boolean => key.startsWith('message:')
/** Display-only adapter. ThreadDataStore remains authoritative; no received wrapper can execute. */
export class ThreadStreamAdapter {
  readonly store: StreamStore
  private readonly active = new Map<StreamId, ActiveThread>()
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
            if (row && !this.active.has(stream)) this.activate(String(row.thread_id))
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
    if (typeof threadId !== 'string' || !threadId.length || threadId.length > 256)
      throw new NetError('bad_request')
    const now = this.options.clock.now()
    const known = [...this.active.values()].find((thread) => thread.threadId === threadId)
    if (known) {
      // Marked busy first, so making room for the holder cannot release this very stream.
      known.lastBusyAt = now
      this.admitHolder(known, holder, now)
      return known.descriptor
    }
    if (holder !== undefined && this.metered(threadId)) this.assertHolderRoom(holder)
    if (this.active.size >= (this.options.maxThreads ?? 64)) this.releaseIdle()
    if (this.active.size >= (this.options.maxThreads ?? 64)) throw new NetError('rate_limited')
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
    const thread: ActiveThread = {
      threadId,
      stream: descriptor.id,
      descriptor,
      ring: [],
      bytes: 0,
      deltas: new Map(),
      holders: new Map(),
      lastBusyAt: now
    }
    if (holder !== undefined && this.metered(threadId)) thread.holders.set(holder, now)
    this.refreshSnapshot(thread)
    this.active.set(thread.stream, thread)
    this.scheduleSweep()
    const fail = (error: unknown): void => {
      if (this.active.get(thread.stream) !== thread) return
      this.deactivate(threadId)
      this.options.onError?.(threadId, error, thread.stream)
    }
    thread.dispose = this.options.source.onThread(
      threadId,
      (event) => {
        try {
          // A fresh snapshot truncates the records before it, so no ring trim follows.
          if ('snapshot' in event) {
            this.refreshSnapshot(thread)
            return
          }
          const body = { threadId, type: event.type, data: event.data }
          if (event.ephemeral) {
            if (!(THREAD_DELTA_TYPES as readonly string[]).includes(event.type))
              throw new NetError('bad_request')
            const key = deltaKey(event)
            if (key && canonicalJson(body).byteLength <= DELTA_MAX)
              this.queueDelta(thread, key, body)
            return
          }
          if (!(THREAD_EVENT_TYPES as readonly string[]).includes(event.type))
            throw new NetError('bad_request')
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
  private stopDeltas(thread: ActiveThread): void {
    thread.deltaTimer?.cancel()
    thread.deltaTimer = undefined
    thread.deltas.clear()
  }
  private append(thread: ActiveThread, type: string, body: unknown): void {
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
    const position = this.options.store.appendAsAuthority(thread.stream, {
      id: envelope.id,
      envelope: bytes,
      sig,
      recvTs: this.options.clock.now()
    })
    const record: StoredRecord = { ...position, envelope: bytes, sig }
    thread.ring.push(record)
    thread.bytes += bytes.byteLength + sig.byteLength
    while (
      thread.ring.length > (this.options.maxRows ?? 512) ||
      thread.bytes > (this.options.maxBytes ?? 1024 * 1024)
    ) {
      const dropped = thread.ring.shift()!
      thread.bytes -= dropped.envelope.byteLength + dropped.sig.byteLength
    }
    this.options.onRecord?.(thread.stream, record)
  }
  private refreshSnapshot(thread: ActiveThread): void {
    const bytes = canonicalJson(this.options.source.snapshot(thread.threadId))
    if (bytes.byteLength > SNAPSHOT_MAX)
      throw new NetError('too_large', 'Display snapshot exceeds32MiB.')
    const snapshot = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('base64url'),
      chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)),
      previous = this.options.store.head(thread.stream).seq
    this.append(thread, 'thread.snapshot.begin', {
      threadId: thread.threadId,
      snapshot,
      totalBytes: bytes.length,
      chunks,
      sha256
    })
    for (let index = 0; index < chunks; index++)
      this.append(thread, 'thread.snapshot.chunk', {
        threadId: thread.threadId,
        snapshot,
        index,
        data: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString(
          'base64url'
        )
      })
    this.append(thread, 'thread.snapshot.end', { threadId: thread.threadId, snapshot, sha256 })
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
        this.active.delete(stream)
        return
      }
  }
  private metered(threadId: string): boolean {
    return !this.options.unmetered?.(threadId)
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
      if (isSubscribed(thread.stream) || isTurnActive?.(thread.threadId)) {
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
    }
    this.active.clear()
  }
}
