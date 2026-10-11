import { createHash } from 'node:crypto'
import { NetError, isId, newId, validateStreamDescriptor } from '../../../shared/net'
import type {
  NetErrorCode,
  NodeDelegation,
  NodeId,
  Roster,
  RpcId,
  StreamDescriptor,
  StoredRecord,
  Signed
} from '../../../shared/net'
import type {
  BridgeEntityRef,
  BridgeMethod,
  BridgeRemoteParams,
  BridgeHubRequestOptions,
  BridgeHubRequestStatus,
  BridgeThreadOpenResult,
  BridgeDispatchInput
} from '../../../shared/bridge'
import type {
  Clock,
  IdentityService,
  KeyStore,
  StreamStore,
  SyncSession
} from '../../net/contracts'
import { NetDatabase, json } from '../../net/store/database'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import { systemClock } from '../../net/clock'
import { ThreadDisplayProjection, type ThreadDisplayUpdate } from '../remote'
import { HUB_METHODS, validateHubParams } from './validation'
import { verifyDispatchResult } from '../dispatch/result'
import type { NetIdentityService } from '../../net/identity/NetIdentityService'
import { decodeBase64 } from '../../net/identity/crypto'
import type { BridgeDisplayPosition } from '../../../shared/bridge'
import { DispatchInputJournal } from './inputs'
interface Request extends BridgeHubRequestStatus {
  caller: NodeId
  user: string
  params: unknown
  hash: string
  idem: string | null
  deadlineMs: number
  wireResult?: unknown
}
interface DisplayListener {
  update: (value: ThreadDisplayUpdate, position: BridgeDisplayPosition) => void | Promise<void>
  error?: (code: NetErrorCode) => void
}
interface Attachment {
  ref: BridgeEntityRef
  descriptor: StreamDescriptor
  projection: ThreadDisplayProjection
  subscription?: {
    close(): void
  }
  pending: Promise<void>
  queued: number
  bytes: number
  stopped: boolean
  offClosed?: () => void
  listeners: Set<DisplayListener>
}
export interface BridgeHubOptions {
  db: NetDatabase
  identity: IdentityService
  keys: KeyStore
  store: StreamStore
  clock?: Clock
  session(target: NodeId): SyncSession
  resolveResult?(
    value: unknown,
    session: SyncSession,
    rpc: RpcId,
    method: BridgeMethod,
    signal?: AbortSignal
  ): Promise<unknown>
  maxActiveRequests?: number
  maxStreams?: number
  maxJournalRecords?: number
  maxJournalBytes?: number
}
const fail = (code: NetErrorCode): never => {
  throw new NetError(code)
}
const same = (a: unknown, b: unknown): boolean => json(a) === json(b)
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex')
/** Trusted local caller journal. A sent mutation is never resubmitted by recovery. */
export class BridgeHub {
  private readonly clock: Clock
  private readonly active = new Map<
    RpcId,
    {
      controller: AbortController
      promise: Promise<unknown>
    }
  >()
  private readonly attachments = new Map<string, Attachment>()
  private readonly ownerPending = new Map<
    string,
    {
      owner: string
      cancelled: boolean
    }
  >()
  private readonly ownerAttachments = new Map<
    string,
    {
      owner: string
      ref: BridgeEntityRef
      close: () => void
    }
  >()
  private readonly cleanup = new Set<Promise<void>>()
  private readonly attaching = new Set<string>()
  private readonly inputs: DispatchInputJournal
  private readonly listeners = new Set<(status: BridgeHubRequestStatus) => void>()
  private stopped = false
  constructor(readonly options: BridgeHubOptions) {
    this.clock = options.clock ?? systemClock
    for (const [key, maximum] of [
      ['maxActiveRequests', 32],
      ['maxStreams', 8],
      ['maxJournalRecords', 16384],
      ['maxJournalBytes', 16 * 1024 * 1024]
    ] as const) {
      const value = options[key]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
        throw new NetError('bad_request')
    }
    options.db.transaction(() =>
      options.db.database.exec(
        `CREATE TABLE IF NOT EXISTS net_bridge_hub_requests(id TEXT PRIMARY KEY,target TEXT NOT NULL,method TEXT NOT NULL,idem TEXT,hash TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(target,method,idem));CREATE TABLE IF NOT EXISTS net_bridge_hub_aliases(id TEXT PRIMARY KEY,original TEXT NOT NULL);CREATE TABLE IF NOT EXISTS net_bridge_hub_threads(target TEXT NOT NULL,entity TEXT NOT NULL,descriptor TEXT NOT NULL,PRIMARY KEY(target,entity));`
      )
    )
    this.inputs = new DispatchInputJournal(this, (target) =>
      this.session(target, 'bridge.dispatch')
    )
  }
  onChanged(listener: (status: BridgeHubRequestStatus) => void): () => void {
    if (this.listeners.size >= 64) return fail('rate_limited')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  activeCount(): number {
    return this.active.size + this.inputs.activeCount() + this.cleanup.size + this.attaching.size
  }
  private guard(): void {
    if (this.stopped) return fail('cancelled')
  }
  private self(capability?: string) {
    const self = this.options.identity.self()
    if (!self) return fail('not_enrolled')
    const delegation = this.current(self.node)
    if (
      !same(delegation.keys, this.options.keys.nodeKeys()) ||
      (capability && !delegation.caps.includes(capability as any))
    )
      return fail('forbidden')
    return { ...self, delegation }
  }
  private current(node: NodeId): NodeDelegation {
    const self = this.options.identity.self()
    if (!self) return fail('not_enrolled')
    const identity = this.options.identity,
      root = identity.pinnedRootKey(self.user),
      signed = identity.roster(self.user)
    if (!root || !signed || identity.rosterState(self.user) !== 'ok') return fail('roster_conflict')
    const roster = identity.verifySigned<Roster>(signed, root),
      latest = roster.nodes
        .map((s) => identity.verifySigned<NodeDelegation>(s, root))
        .filter((d) => d.subject === node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (
      !latest ||
      latest.owner !== self.user ||
      latest.issuedAt > this.clock.now() ||
      this.clock.now() >= latest.expiresAt
    )
      return fail('bad_delegation')
    if (roster.revoked.some((r) => r.subject === node && r.throughKeyEpoch >= latest.keyEpoch))
      return fail('revoked')
    return latest
  }
  private session(target: NodeId, method: BridgeMethod): SyncSession {
    this.guard()
    const self = this.self(HUB_METHODS[method].capability),
      session = this.options.session(target)
    if (session.state() !== 'open') return fail('peer_offline')
    if (
      session.peer.node !== target ||
      session.peer.user !== self.user ||
      !same(this.current(target), session.peer.delegation)
    )
      return fail('bad_delegation')
    return session
  }
  private original(id: RpcId): RpcId {
    return (this.options.db.database
      .prepare('SELECT original FROM net_bridge_hub_aliases WHERE id=?')
      .get(id)?.original ??
      this.options.db.database
        .prepare('SELECT original FROM net_bridge_hub_input_aliases WHERE id=?')
        .get(id)?.original ??
      id) as RpcId
  }
  private load(id: RpcId): Request {
    if (!isId('rpc', id)) return fail('bad_request')
    const row = this.options.db.database
      .prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?')
      .get(this.original(id))
    if (!row) return fail('bad_request')
    const request = JSON.parse(row.record as string) as Request,
      self = this.options.identity.self()
    if (!self || request.caller !== self.node || request.user !== self.user)
      return fail('forbidden')
    return request
  }
  private save(request: Request): void {
    const value = json(request)
    const usage = this.options.db.database
      .prepare(
        'SELECT coalesce(sum(length(record)),0) AS bytes FROM net_bridge_hub_requests WHERE id<>?'
      )
      .get(request.id)!
    if (
      Number(usage.bytes) + Buffer.byteLength(value) >
      (this.options.maxJournalBytes ?? 16 * 1024 * 1024)
    )
      return fail('too_large')
    this.options.db.charge(1, Buffer.byteLength(value))
    this.options.db.database
      .prepare(
        'INSERT INTO net_bridge_hub_requests VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record'
      )
      .run(request.id, request.target, request.method, request.idem, request.hash, value)
    this.options.db.afterCommit(() => {
      for (const listener of this.listeners) {
        try {
          listener(this.status(request.id))
        } catch {
          /* Independent trusted local subscribers. */
        }
      }
    })
  }
  private alias(id: RpcId, request: Request): void {
    if (id === request.id) return
    const prior = this.options.db.database
      .prepare('SELECT original FROM net_bridge_hub_aliases WHERE id=?')
      .get(id)
    if (
      (prior && prior.original !== request.id) ||
      this.options.db.database.prepare('SELECT 1 FROM net_bridge_hub_requests WHERE id=?').get(id)
    )
      return fail('conflict')
    if (
      !prior &&
      Number(
        this.options.db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_aliases').get()!
          .n
      ) >= (this.options.maxJournalRecords ?? 16384)
    )
      return fail('too_large')
    this.options.db.charge(1)
    this.options.db.database
      .prepare('INSERT OR IGNORE INTO net_bridge_hub_aliases VALUES(?,?)')
      .run(id, request.id)
  }
  prepare<M extends BridgeMethod>(
    target: NodeId,
    method: M,
    params: BridgeRemoteParams[M],
    options: BridgeHubRequestOptions = {}
  ): RpcId {
    this.guard()
    if (!isId('node', target) || !Object.hasOwn(HUB_METHODS, method)) return fail('bad_request')
    const self = this.self(HUB_METHODS[method].capability)
    this.current(target)
    if (target === self.node) return fail('bad_request')
    const validated = validateHubParams(method, params),
      digest = hash({ method, params: validated }),
      id = options.id ?? newId('rpc'),
      idem = options.idem ?? (HUB_METHODS[method].mutating ? id : null),
      deadlineMs = options.deadlineMs ?? 10000
    if (
      !isId('rpc', id) ||
      (idem !== null && (typeof idem !== 'string' || !idem.length || idem.length > 256)) ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 86400000
    )
      return fail('bad_request')
    this.inputs.assertBoundRequest(id, target, method, validated, idem)
    return this.options.db.transaction(() => {
      const byId = this.options.db.database
          .prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?')
          .get(this.original(id)),
        byKey =
          idem === null
            ? undefined
            : this.options.db.database
                .prepare(
                  'SELECT record FROM net_bridge_hub_requests WHERE target=? AND method=? AND idem=?'
                )
                .get(target, method, idem),
        found = byId ?? byKey
      if (found) {
        const request = JSON.parse(found.record as string) as Request
        if (
          request.target !== target ||
          request.method !== method ||
          request.hash !== digest ||
          request.idem !== idem ||
          request.caller !== self.node ||
          request.user !== self.user ||
          (byId && byKey && byId.record !== byKey.record)
        )
          return fail('conflict')
        this.alias(id, request)
        return id
      }
      const usage = this.options.db.database
        .prepare(
          'SELECT count(*) AS rows,coalesce(sum(length(record)),0) AS bytes FROM net_bridge_hub_requests'
        )
        .get()!
      if (
        Number(usage.rows) >= (this.options.maxJournalRecords ?? 16384) ||
        Number(usage.bytes) + Buffer.byteLength(json(validated)) + 1024 >
          (this.options.maxJournalBytes ?? 16 * 1024 * 1024)
      )
        return fail('too_large')
      const now = this.clock.now(),
        request: Request = {
          id,
          original: id,
          target,
          method,
          params: validated,
          hash: digest,
          idem,
          deadlineMs,
          caller: self.node,
          user: self.user,
          state: 'prepared',
          createdAt: now,
          updatedAt: now
        }
      this.save(request)
      this.options.db.checkpoint('bridge.hub.prepare.beforeCommit')
      return id
    })
  }
  status(id: RpcId): BridgeHubRequestStatus {
    let request: Request
    try {
      request = this.load(id)
    } catch (error) {
      if (error instanceof NetError && error.code === 'bad_request') return this.inputs.status(id)
      throw error
    }
    return {
      id,
      original: request.id,
      target: request.target,
      method: request.method,
      state: request.state,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      ...(request.error ? { error: request.error } : {})
    }
  }
  requests(target?: NodeId): BridgeHubRequestStatus[] {
    if (target !== undefined && !isId('node', target)) return fail('bad_request')
    const rows = this.options.db.database
      .prepare(
        `SELECT id, json_extract(record,'$.createdAt') AS created FROM net_bridge_hub_requests WHERE (? IS NULL OR target=?) UNION ALL SELECT id,json_extract(record,'$.createdAt') AS created FROM net_bridge_hub_inputs WHERE (? IS NULL OR target=?) AND NOT EXISTS(SELECT 1 FROM net_bridge_hub_requests r WHERE r.id=net_bridge_hub_inputs.id) ORDER BY created DESC LIMIT 256`
      )
      .all(target ?? null, target ?? null, target ?? null, target ?? null)
    return rows.map((row) => this.status(row.id as RpcId))
  }
  ownsRequest(id: RpcId, method: string, target: NodeId): boolean {
    try {
      const request = this.load(id)
      return request.method === method && request.target === target
    } catch {
      return this.inputs.ownsRequest(id, method, target)
    }
  }
  canonicalRequest(id: RpcId, method: string, target: NodeId): RpcId | undefined {
    try {
      const request = this.load(id)
      return request.method === method && request.target === target ? request.id : undefined
    } catch {
      return this.inputs.canonicalRequest(id, method, target)
    }
  }
  submit(id: RpcId, signal?: AbortSignal): Promise<unknown> {
    const request = this.load(id)
    return this.perform(request, signal, false)
  }
  query(id: RpcId, signal?: AbortSignal): Promise<unknown> {
    try {
      return this.perform(this.load(id), signal, true)
    } catch (error) {
      if (error instanceof NetError && error.code === 'bad_request') return this.inputs.query(id)
      throw error
    }
  }
  private perform(
    request: Request,
    signal: AbortSignal | undefined,
    queryOnly: boolean
  ): Promise<unknown> {
    this.guard()
    if (signal?.aborted) return Promise.reject(new NetError('cancelled'))
    const held = this.active.get(request.id)
    if (held) return held.promise
    if (this.active.size >= (this.options.maxActiveRequests ?? 32))
      return Promise.reject(new NetError('rate_limited'))
    const controller = new AbortController(),
      abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const promise = this.performNow(request, queryOnly, controller.signal).finally(() => {
      signal?.removeEventListener('abort', abort)
      this.active.delete(request.id)
    })
    this.active.set(request.id, { controller, promise })
    return promise
  }
  private async performNow(
    request: Request,
    queryOnly: boolean,
    signal: AbortSignal
  ): Promise<unknown> {
    const session = this.session(request.target, request.method)
    if (request.state === 'failed') return fail(request.error ?? 'internal')
    if (request.state === 'completed')
      return this.resolve(request.wireResult, session, request, signal)
    const first = request.state === 'prepared' && !queryOnly
    if (first)
      this.options.db.transaction(() => {
        request.state = 'unknown'
        request.updatedAt = this.clock.now()
        this.save(request)
        this.options.db.checkpoint('bridge.hub.attempt.beforeCommit')
      })
    let terminalCommitted = false
    try {
      const value = first
        ? await session.rpc(request.method, request.params, {
            id: request.id,
            ...(request.idem ? { idem: request.idem } : {}),
            deadlineMs: request.deadlineMs,
            signal
          })
        : await session.rpcResult(request.id, {
            deadlineMs: Math.min(request.deadlineMs, 30000),
            signal
          })
      if (canonicalJson(value).length > 64 * 1024) return fail('too_large')
      this.session(request.target, request.method)
      this.options.db.transaction(() => {
        request.state = 'completed'
        request.wireResult = value
        delete request.error
        request.updatedAt = this.clock.now()
        this.save(request)
        this.options.db.checkpoint('bridge.hub.result.beforeCommit')
      })
      terminalCommitted = true
      return await this.resolve(value, session, request, signal)
    } catch (error) {
      if (
        error instanceof NetError &&
        error.code !== 'outcome_uncertain' &&
        !error.retryable &&
        !['cancelled', 'internal', 'storage_full', 'storage_corrupt'].includes(error.code) &&
        !terminalCommitted
      )
        this.options.db.transaction(() => {
          request.state = 'failed'
          request.error = error.code
          request.updatedAt = this.clock.now()
          this.save(request)
        })
      throw error
    }
  }
  private async resolve(
    value: unknown,
    session: SyncSession,
    request: Request,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) return fail('cancelled')
    const kind =
      value && typeof value === 'object'
        ? (
            value as {
              kind?: unknown
            }
          ).kind
        : undefined
    if (kind === 'bridge.artifact.result.v1' && !this.options.resolveResult)
      return fail('forbidden')
    const result = this.options.resolveResult
      ? await this.options.resolveResult(value, session, request.id, request.method, signal)
      : value
    this.session(request.target, request.method)
    if (signal?.aborted) return fail('cancelled')
    if (canonicalJson(result).length > 25 * 1024 * 1024) return fail('too_large')
    if (request.method === 'bridge.dispatch') {
      const signed = result as Signed
      if (!signed || typeof signed.payload !== 'string') return fail('bad_request')
      const body = JSON.parse(Buffer.from(decodeBase64(signed.payload)).toString('utf8')) as {
        execution: string
      }
      const params = request.params as BridgeDispatchInput
      return verifyDispatchResult(this.options.identity as NetIdentityService, signed, {
        node: request.target,
        user: this.self().user,
        rpc: request.id,
        execution: body.execution,
        repoId: params.repoId,
        baseCommit: params.baseCommit,
        requestHash: hash(params)
      })
    }
    return result
  }
  async cancel(id: RpcId): Promise<void> {
    let request: Request
    try {
      request = this.load(id)
    } catch (error) {
      if (error instanceof NetError && error.code === 'bad_request') {
        this.inputs.cancel(id)
        return
      }
      throw error
    }
    this.guard()
    this.self(HUB_METHODS[request.method].capability)
    if (request.state === 'completed' || request.state === 'failed') return
    this.options.db.transaction(() => {
      request.state = 'cancelRequested'
      request.updatedAt = this.clock.now()
      this.save(request)
    })
    this.active.get(request.id)?.controller.abort()
    const session = this.session(request.target, request.method)
    await session.rpcCancel(request.id)
  }
  async call<M extends BridgeMethod>(
    target: NodeId,
    method: M,
    params: BridgeRemoteParams[M],
    options: BridgeHubRequestOptions = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.submit(this.prepare(target, method, params, options), signal)
  }
  projects(target: NodeId): Promise<unknown> {
    return this.call(target, 'projects.list', {})
  }
  threads(target: NodeId, projectId?: string): Promise<unknown> {
    return this.call(target, 'threads.list', projectId ? { projectId } : {})
  }
  get(ref: BridgeEntityRef): Promise<unknown> {
    return this.call(ref.nodeId, 'threads.get', { threadId: ref.entityId })
  }
  search(target: NodeId, query: string, limit?: number): Promise<unknown> {
    return this.call(target, 'threads.search', { query, ...(limit ? { limit } : {}) })
  }
  create(
    target: NodeId,
    name: string,
    options: BridgeHubRequestOptions = {},
    projectId?: string
  ): Promise<unknown> {
    return this.call(
      target,
      'threads.create',
      { name, ...(projectId ? { projectId } : {}) },
      options
    )
  }
  send(
    ref: BridgeEntityRef,
    content: string,
    options: BridgeHubRequestOptions = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.call(
      ref.nodeId,
      'orchestrator.send',
      { threadId: ref.entityId, content },
      options,
      signal
    )
  }
  steer(
    ref: BridgeEntityRef,
    run: RpcId,
    text: string,
    options: BridgeHubRequestOptions = {}
  ): Promise<unknown> {
    return this.call(
      ref.nodeId,
      'orchestrator.steer',
      { threadId: ref.entityId, run, text },
      options
    )
  }
  abort(ref: BridgeEntityRef, run: RpcId, options: BridgeHubRequestOptions = {}): Promise<unknown> {
    return this.call(ref.nodeId, 'orchestrator.abort', { threadId: ref.entityId, run }, options)
  }
  prepareDispatchWithBundle(
    target: NodeId,
    input: Omit<BridgeDispatchInput, 'inputBundle'>,
    bytes: Uint8Array,
    options: BridgeHubRequestOptions = {}
  ): RpcId {
    return this.inputs.prepare(target, input, bytes, options)
  }
  resumeDispatchWithBundle(id: RpcId, signal?: AbortSignal): Promise<unknown> {
    return this.inputs.resume(id, signal)
  }
  dispatch(
    target: NodeId,
    input: BridgeDispatchInput,
    options: BridgeHubRequestOptions = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.call(target, 'bridge.dispatch', input, options, signal)
  }
  private attachmentKey(ref: BridgeEntityRef): string {
    return json([ref.nodeId, ref.entityId])
  }
  async attach(
    ref: BridgeEntityRef,
    update: (value: ThreadDisplayUpdate, position: BridgeDisplayPosition) => void | Promise<void>,
    error?: (code: NetErrorCode) => void
  ): Promise<{
    close(): void
    descriptor: StreamDescriptor
  }> {
    this.guard()
    validateHubParams('bridge.thread.open', { threadId: ref.entityId })
    if (!isId('node', ref.nodeId)) return fail('bad_request')
    const key = this.attachmentKey(ref),
      listener: DisplayListener = { update, error },
      existing = this.attachments.get(key)
    if (existing) {
      this.session(ref.nodeId, 'bridge.thread.open')
      existing.listeners.add(listener)
      try {
        await this.rebuild({
          ...existing,
          projection: new ThreadDisplayProjection(ref.entityId),
          listeners: new Set([listener])
        })
      } catch (error) {
        existing.listeners.delete(listener)
        throw error
      }
      return { descriptor: existing.descriptor, close: () => this.release(ref, listener) }
    }
    if (this.attaching.has(key)) return fail('conflict')
    this.detach(ref)
    if (this.attachments.size + this.attaching.size >= (this.options.maxStreams ?? 8))
      return fail('rate_limited')
    this.attaching.add(key)
    try {
      const opened = (await this.call(ref.nodeId, 'bridge.thread.open', {
          threadId: ref.entityId
        })) as BridgeThreadOpenResult,
        session = this.session(ref.nodeId, 'bridge.thread.open')
      this.guard()
      if (
        !opened ||
        Object.keys(opened).sort().join(',') !== 'descriptor,head' ||
        !validateStreamDescriptor(opened.descriptor) ||
        opened.descriptor.kind !== 'node.thread' ||
        opened.descriptor.authority !== ref.nodeId ||
        !opened.head ||
        Object.keys(opened.head).sort().join(',') !== 'epoch,seq' ||
        !Number.isSafeInteger(opened.head.epoch) ||
        opened.head.epoch < 1 ||
        !Number.isSafeInteger(opened.head.seq) ||
        opened.head.seq < 0
      )
        return fail('forbidden')
      const known = this.options.store.getStream(opened.descriptor.id)
      if (known && !same(known, opened.descriptor)) return fail('conflict')
      this.options.db.transaction(() => {
        const row = this.options.db.database
          .prepare('SELECT descriptor FROM net_bridge_hub_threads WHERE target=? AND entity=?')
          .get(ref.nodeId, ref.entityId)
        if (row && !same(JSON.parse(row.descriptor as string), opened.descriptor))
          return fail('conflict')
        if (!known) this.options.store.createStream(opened.descriptor, opened.head.epoch)
        this.options.db.charge(1, Buffer.byteLength(json(opened.descriptor)))
        this.options.db.database
          .prepare(
            'INSERT INTO net_bridge_hub_threads VALUES(?,?,?) ON CONFLICT(target,entity) DO UPDATE SET descriptor=excluded.descriptor'
          )
          .run(ref.nodeId, ref.entityId, json(opened.descriptor))
      })
      const attachment: Attachment = {
        ref: { ...ref },
        descriptor: opened.descriptor,
        projection: new ThreadDisplayProjection(ref.entityId),
        pending: Promise.resolve(),
        queued: 0,
        bytes: 0,
        stopped: false,
        listeners: new Set([listener])
      }
      this.attachments.set(key, attachment)
      try {
        await this.rebuild(attachment)
        if (attachment.stopped) return fail('cancelled')
        attachment.subscription = session.subscribe(opened.descriptor.id, {
          onRecord: (record) => this.enqueue(attachment, record),
          onCaughtUp() {},
          onSnapshotInstalled: () => {
            attachment.pending = attachment.pending
              .then(() => this.rebuild(attachment))
              .catch((e) => this.attachmentError(attachment, e))
          },
          onError: (code) => {
            if (
              session.state() !== 'open' &&
              ['cancelled', 'peer_offline', 'deadline_exceeded'].includes(code)
            ) {
              attachment.projection.reset()
              return
            }
            this.attachmentError(attachment, new NetError(code))
          }
        })
        attachment.offClosed = session.onClosed(() => {
          attachment.subscription?.close()
          attachment.projection.reset()
        })
        return { descriptor: opened.descriptor, close: () => this.release(ref, listener) }
      } catch (e) {
        this.detach(ref)
        throw e
      }
    } finally {
      this.attaching.delete(key)
    }
  }
  private release(ref: BridgeEntityRef, listener: DisplayListener): void {
    const attachment = this.attachments.get(this.attachmentKey(ref))
    if (!attachment) return
    attachment.listeners.delete(listener)
    if (!attachment.listeners.size) this.detach(ref)
  }
  async attachFor(
    owner: string,
    ref: BridgeEntityRef,
    update: (value: ThreadDisplayUpdate, position: BridgeDisplayPosition) => void | Promise<void>,
    error?: (code: NetErrorCode) => void
  ): Promise<{
    descriptor: StreamDescriptor
  }> {
    if (typeof owner !== 'string' || !owner.length || owner.length > 256) return fail('bad_request')
    const key = json([owner, ref.nodeId, ref.entityId])
    if (this.ownerPending.has(key)) return fail('conflict')
    this.detachFor(owner, ref)
    if (this.ownerAttachments.size + this.ownerPending.size >= 64) return fail('rate_limited')
    const pending = { owner, cancelled: false }
    this.ownerPending.set(key, pending)
    try {
      const attachment = await this.attach(ref, update, error)
      if (pending.cancelled || this.stopped) {
        attachment.close()
        return fail('cancelled')
      }
      this.ownerAttachments.set(key, { owner, ref: { ...ref }, close: attachment.close })
      return { descriptor: attachment.descriptor }
    } finally {
      this.ownerPending.delete(key)
    }
  }
  detachFor(owner: string, ref: BridgeEntityRef): void {
    const key = json([owner, ref.nodeId, ref.entityId])
    const pending = this.ownerPending.get(key)
    if (pending) pending.cancelled = true
    const held = this.ownerAttachments.get(key)
    if (held) {
      this.ownerAttachments.delete(key)
      held.close()
    }
  }
  detachOwner(owner: string): void {
    for (const pending of this.ownerPending.values())
      if (pending.owner === owner) pending.cancelled = true
    for (const held of [...this.ownerAttachments.values()])
      if (held.owner === owner) this.detachFor(owner, held.ref)
  }
  async reconnect(target: NodeId): Promise<void> {
    const held = [...this.attachments.values()].filter((a) => a.ref.nodeId === target)
    for (const previous of held) {
      if (this.stopped) return
      const listeners = [...previous.listeners],
        first = listeners[0]
      if (!first) continue
      this.detach(previous.ref)
      try {
        await this.attach(previous.ref, first.update, first.error)
        const fresh = this.attachments.get(this.attachmentKey(previous.ref))
        if (fresh) {
          fresh.listeners = new Set(listeners)
        }
      } catch (error) {
        for (const listener of listeners) {
          try {
            listener.error?.(error instanceof NetError ? error.code : 'internal')
          } catch {
            /* Independent local subscribers. */
          }
        }
      }
    }
  }
  canReceive(descriptor: StreamDescriptor, peer: SyncSession['peer']): boolean {
    try {
      const self = this.self('read')
      if (
        descriptor.kind !== 'node.thread' ||
        peer.user !== self.user ||
        descriptor.authority !== peer.node ||
        !same(this.current(peer.node), peer.delegation)
      )
        return false
      const row = this.options.db.database
        .prepare(
          "SELECT descriptor FROM net_bridge_hub_threads WHERE target=? AND json_extract(descriptor,'$.id')=?"
        )
        .get(peer.node, descriptor.id)
      return !!row && same(JSON.parse(String(row.descriptor)), descriptor)
    } catch {
      return false
    }
  }
  verifyRecord(record: StoredRecord, descriptor: StreamDescriptor): void {
    const env = decodeEnvelope(record.envelope).envelope,
      self = this.self('read')
    if (
      descriptor.kind !== 'node.thread' ||
      env.stream !== descriptor.id ||
      env.author.node !== descriptor.authority ||
      env.author.user !== self.user ||
      env.author.bot ||
      env.minor > 0
    )
      return fail('forbidden')
    this.options.identity.verifyAuthor(env.author, record.envelope, record.sig, env.ts, 'history')
  }
  private rebuild(attachment: Attachment): Promise<void> {
    const pending = this.rebuildNow(attachment)
    this.cleanup.add(pending)
    void pending.then(
      () => this.cleanup.delete(pending),
      () => this.cleanup.delete(pending)
    )
    return pending
  }
  private async rebuildNow(attachment: Attachment): Promise<void> {
    attachment.projection.reset()
    const reader = this.options.store.openSnapshot(attachment.descriptor.id)
    try {
      for (;;) {
        if (attachment.stopped || this.stopped) return
        const page = reader.next(1024 * 1024, 64)
        for (const record of page.records) await this.display(attachment, record)
        if (page.done) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      reader.close()
    }
  }
  private async display(attachment: Attachment, record: StoredRecord): Promise<void> {
    if (attachment.stopped || this.stopped) return
    this.verifyRecord(record, attachment.descriptor)
    const value = attachment.projection.accept(decodeEnvelope(record.envelope).envelope)
    if (value) {
      for (const listener of attachment.listeners) {
        try {
          await listener.update(value, {
            stream: attachment.descriptor.id,
            epoch: record.epoch,
            seq: record.seq
          })
        } catch {
          attachment.listeners.delete(listener)
          try {
            listener.error?.('internal')
          } catch {
            /* Independent local subscribers. */
          }
        }
      }
    }
  }
  private enqueue(attachment: Attachment, record: StoredRecord): void {
    const bytes = record.envelope.length + record.sig.length
    if (attachment.queued >= 64 || attachment.bytes + bytes > 1024 * 1024) {
      this.attachmentError(attachment, new NetError('too_large'))
      return
    }
    attachment.queued++
    attachment.bytes += bytes
    attachment.pending = attachment.pending
      .then(() => this.display(attachment, record))
      .catch((error) => this.attachmentError(attachment, error))
      .finally(() => {
        attachment.queued--
        attachment.bytes -= bytes
      })
  }
  private attachmentError(attachment: Attachment, error: unknown): void {
    if (attachment.stopped) return
    const code = error instanceof NetError ? error.code : 'internal'
    if (this.attachments.get(this.attachmentKey(attachment.ref)) === attachment)
      this.detach(attachment.ref)
    for (const listener of attachment.listeners) {
      try {
        listener.error?.(code)
      } catch {
        /* Independent local subscribers. */
      }
    }
  }
  detach(ref: BridgeEntityRef): void {
    const key = this.attachmentKey(ref),
      attachment = this.attachments.get(key)
    if (attachment) {
      attachment.stopped = true
      attachment.subscription?.close()
      attachment.offClosed?.()
      attachment.projection.reset()
      this.attachments.delete(key)
      const pending = attachment.pending
      this.cleanup.add(pending)
      void pending.finally(() => this.cleanup.delete(pending))
    }
  }
  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.inputs.close()
    this.ownerAttachments.clear()
    for (const pending of this.ownerPending.values()) pending.cancelled = true
    for (const active of this.active.values()) active.controller.abort()
    for (const attachment of [...this.attachments.values()]) this.detach(attachment.ref)
  }
  async drain(): Promise<void> {
    await this.inputs.drain()
    await Promise.allSettled([...this.active.values()].map((value) => value.promise))
    await Promise.allSettled(
      [...this.attachments.values()].map((value) => value.pending).concat([...this.cleanup])
    )
  }
}
