import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  NetError,
  isId,
  newId,
  validateStreamDescriptor,
  DEFAULT_MAX_BLOB_BYTES
} from '../../../shared/net'
import type { BlobId, EventId, NodeId, RpcId, StreamDescriptor } from '../../../shared/net'
import type { BridgeDispatchInput, BridgeHubRequestOptions } from '../../../shared/bridge'
import type { SyncSession } from '../../net/contracts'
import { canonicalJson, encodeEnvelope } from '../../net/sync/codec'
import { json } from '../../net/store/database'
import { validateHubParams } from './validation'
import type { BridgeHub } from './service'
interface InputPlan {
  id: RpcId
  target: NodeId
  user: string
  caller: NodeId
  idem: string
  digest: string
  params: Omit<BridgeDispatchInput, 'inputBundle'>
  blob: BlobId
  bytes: number
  open: RpcId
  event: EventId
  deadlineMs: number
  descriptor?: StreamDescriptor
  envelope?: string
  sig?: string
  createdAt: number
  updatedAt: number
  phase: 'preparing' | 'ready' | 'publishing' | 'published' | 'cancelled'
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const fail = (code: ConstructorParameters<typeof NetError>[0]): never => {
  throw new NetError(code)
}
/** Local bundle spool. SQL chooses every remote effect identifier before any I/O. */
export class DispatchInputJournal {
  private readonly active = new Map<
    RpcId,
    {
      promise: Promise<unknown>
      controller: AbortController
    }
  >()
  constructor(
    private readonly hub: BridgeHub,
    private readonly session: (target: NodeId) => SyncSession
  ) {
    hub.options.db.database.exec(
      `CREATE TABLE IF NOT EXISTS net_bridge_hub_inputs(id TEXT PRIMARY KEY,target TEXT NOT NULL,idem TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(target,idem));CREATE TABLE IF NOT EXISTS net_bridge_hub_input_aliases(id TEXT PRIMARY KEY,original TEXT NOT NULL);`
    )
  }
  private original(id: RpcId): RpcId {
    return (this.hub.options.db.database
      .prepare('SELECT original FROM net_bridge_hub_input_aliases WHERE id=?')
      .get(id)?.original ?? id) as RpcId
  }
  private load(id: RpcId): InputPlan {
    if (!isId('rpc', id)) return fail('bad_request')
    const row = this.hub.options.db.database
      .prepare('SELECT record FROM net_bridge_hub_inputs WHERE id=?')
      .get(this.original(id))
    if (!row) return fail('bad_request')
    const plan = JSON.parse(String(row.record)) as InputPlan,
      self = this.hub.options.identity.self()
    if (!self || plan.user !== self.user || plan.caller !== self.node) return fail('forbidden')
    return plan
  }
  ownsRequest(id: RpcId, method: string, target: NodeId): boolean {
    return this.canonicalRequest(id, method, target) !== undefined
  }
  canonicalRequest(id: RpcId, method: string, target: NodeId): RpcId | undefined {
    try {
      const plan = this.load(id)
      return method === 'bridge.dispatch' && plan.target === target ? plan.id : undefined
    } catch {
      return undefined
    }
  }
  assertBoundRequest(
    id: RpcId,
    target: NodeId,
    method: string,
    params: unknown,
    idem: string | null
  ): void {
    let plan: InputPlan
    try {
      plan = this.load(id)
    } catch (error) {
      if (error instanceof NetError && error.code === 'bad_request') return
      throw error
    }
    const expected = plan.descriptor && {
      ...plan.params,
      inputBundle: { stream: plan.descriptor.id, event: plan.event, blob: plan.blob }
    }
    if (
      plan.phase !== 'published' ||
      method !== 'bridge.dispatch' ||
      plan.target !== target ||
      plan.idem !== idem ||
      json(params) !== json(expected)
    )
      return fail('conflict')
  }
  status(id: RpcId): import('../../../shared/bridge').BridgeHubRequestStatus {
    const plan = this.load(id)
    return {
      id,
      original: plan.id,
      target: plan.target,
      method: 'bridge.dispatch',
      state: plan.phase === 'cancelled' ? 'cancelRequested' : 'prepared',
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    }
  }
  query(id: RpcId): Promise<never> {
    const plan = this.load(id)
    return Promise.reject(
      new NetError(plan.phase === 'cancelled' ? 'cancelled' : 'outcome_uncertain')
    )
  }
  cancel(id: RpcId): void {
    const plan = this.load(id)
    this.hub.options.db.transaction(() => {
      plan.phase = 'cancelled'
      this.save(plan)
    })
    this.active.get(plan.id)?.controller.abort()
  }
  private save(plan: InputPlan): void {
    const db = this.hub.options.db
    plan.updatedAt = db.clock.now()
    const record = json(plan)
    db.charge(1, Buffer.byteLength(record))
    db.database
      .prepare(
        'INSERT INTO net_bridge_hub_inputs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record'
      )
      .run(plan.id, plan.target, plan.idem, record)
  }
  prepare(
    target: NodeId,
    value: Omit<BridgeDispatchInput, 'inputBundle'>,
    bytes: Uint8Array,
    options: BridgeHubRequestOptions
  ): RpcId {
    if (!value || Object.hasOwn(value, 'inputBundle') || !(bytes instanceof Uint8Array))
      return fail('bad_request')
    if (bytes.length > DEFAULT_MAX_BLOB_BYTES) return fail('too_large')
    const params = validateHubParams('bridge.dispatch', value) as Omit<
      BridgeDispatchInput,
      'inputBundle'
    >
    const id = options.id ?? newId('rpc'),
      idem = options.idem ?? id
    if (!isId('rpc', id) || typeof idem !== 'string' || !idem.length || idem.length > 256)
      return fail('bad_request')
    const self = this.hub.options.identity.self()
    if (!self) return fail('not_enrolled')
    const blob = `blb_${hash(bytes)}` as BlobId,
      digest = hash(canonicalJson({ params, blob, bytes: bytes.length })),
      db = this.hub.options.db
    const plan = db.transaction(() => {
      const byId = db.database
          .prepare('SELECT record FROM net_bridge_hub_inputs WHERE id=?')
          .get(this.original(id)),
        byKey = db.database
          .prepare('SELECT record FROM net_bridge_hub_inputs WHERE target=? AND idem=?')
          .get(target, idem),
        found = byId ?? byKey
      if (found) {
        const prior = JSON.parse(String(found.record)) as InputPlan
        if (prior.phase === 'cancelled') return fail('cancelled')
        if (
          prior.target !== target ||
          prior.user !== self.user ||
          prior.caller !== self.node ||
          prior.idem !== idem ||
          prior.digest !== digest ||
          (byId && byKey && byId.record !== byKey.record)
        )
          return fail('conflict')
        // Validate present delegation/capability without transmitting anything.
        this.hub.prepare(
          target,
          'bridge.artifacts.open',
          { forRpcId: prior.id, forMethod: 'bridge.dispatch' },
          { id: prior.open, idem: prior.open, deadlineMs: prior.deadlineMs }
        )
        if (id !== prior.id) {
          const held = db.database
            .prepare('SELECT original FROM net_bridge_hub_input_aliases WHERE id=?')
            .get(id)
          if (
            (held && held.original !== prior.id) ||
            db.database.prepare('SELECT 1 FROM net_bridge_hub_requests WHERE id=?').get(id) ||
            db.database.prepare('SELECT 1 FROM net_bridge_hub_aliases WHERE id=?').get(id)
          )
            return fail('conflict')
          if (
            !held &&
            Number(
              db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_input_aliases').get()!.n
            ) >= (this.hub.options.maxJournalRecords ?? 16384)
          )
            return fail('too_large')
          db.charge(1)
          db.database
            .prepare('INSERT OR IGNORE INTO net_bridge_hub_input_aliases VALUES(?,?)')
            .run(id, prior.id)
        }
        return prior
      }
      if (
        db.database.prepare('SELECT 1 FROM net_bridge_hub_requests WHERE id=?').get(id) ||
        db.database.prepare('SELECT 1 FROM net_bridge_hub_aliases WHERE id=?').get(id)
      )
        return fail('conflict')
      const usage = db.database
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(json_extract(record,'$.bytes')),0) AS bytes FROM net_bridge_hub_inputs"
        )
        .get()!
      if (
        Number(usage.n) >= (this.hub.options.maxJournalRecords ?? 16384) ||
        Number(usage.bytes) + bytes.length > 100 * 1024 * 1024
      )
        return fail('too_large')
      const plan: InputPlan = {
        id,
        target,
        user: self.user,
        caller: self.node,
        idem,
        digest,
        params,
        blob,
        bytes: bytes.length,
        open: newId('rpc'),
        event: newId('event'),
        deadlineMs: options.deadlineMs ?? 30000,
        createdAt: db.clock.now(),
        updatedAt: db.clock.now(),
        phase: 'preparing'
      }
      this.hub.prepare(
        target,
        'bridge.artifacts.open',
        { forRpcId: id, forMethod: 'bridge.dispatch' },
        { id: plan.open, idem: plan.open, deadlineMs: plan.deadlineMs }
      )
      this.save(plan)
      db.checkpoint('bridge.hub.input.prepare.beforeCommit')
      return plan
    })
    // A pre-commit failure above produces neither a file nor a network effect.
    this.write(plan, bytes)
    if (plan.phase === 'preparing')
      db.transaction(() => {
        plan.phase = 'ready'
        this.save(plan)
        db.checkpoint('bridge.hub.input.ready.beforeCommit')
      })
    return id
  }
  private directory(): string {
    const directory = join(this.hub.options.db.directory, 'bridge-hub-inputs')
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) return fail('forbidden')
    mkdirSync(directory, { mode: 0o700, recursive: true })
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
      return fail('forbidden')
    return directory
  }
  private file(plan: InputPlan): string {
    return join(this.directory(), plan.id)
  }
  private read(plan: InputPlan): Uint8Array {
    const file = this.file(plan),
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = lstatSync(file)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== plan.bytes ||
        stat.size > DEFAULT_MAX_BLOB_BYTES
      )
        return fail('forbidden')
      const bytes = readFileSync(fd)
      if (`blb_${hash(bytes)}` !== plan.blob) return fail('conflict')
      return bytes
    } finally {
      closeSync(fd)
    }
  }
  private write(plan: InputPlan, bytes: Uint8Array): void {
    const file = this.file(plan)
    if (existsSync(file)) {
      this.read(plan)
      return
    }
    const temp = `${file}.${newId('event')}.tmp`,
      fd = openSync(temp, 'wx', 0o600)
    try {
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes.subarray(at))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    const directoryFd = openSync(this.directory(), 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  }
  resume(id: RpcId, signal?: AbortSignal): Promise<unknown> {
    const plan = this.load(id)
    if (plan.phase === 'cancelled') return Promise.reject(new NetError('cancelled'))
    const held = this.active.get(plan.id)
    if (held) return held.promise
    if (this.active.size >= 8) return Promise.reject(new NetError('rate_limited'))
    const controller = new AbortController(),
      combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const promise = this.resumeNow(plan, combined).finally(() => this.active.delete(plan.id))
    this.active.set(plan.id, { promise, controller })
    return promise
  }
  activeCount(): number {
    return this.active.size
  }
  close(): void {
    for (const value of this.active.values()) value.controller.abort()
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((value) => value.promise))
  }
  private async resumeNow(plan: InputPlan, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return fail('cancelled')
    if (plan.phase === 'cancelled') return fail('cancelled')
    const bytes = this.read(plan),
      db = this.hub.options.db
    if (plan.phase !== 'published') {
      const opened = (await this.hub.submit(plan.open, signal)) as StreamDescriptor,
        session = this.session(plan.target),
        self = this.hub.options.identity.self()!
      if (
        !validateStreamDescriptor(opened) ||
        opened.kind !== 'node.artifact' ||
        opened.authority !== plan.target ||
        !opened.artifact ||
        opened.artifact.user !== plan.user ||
        opened.artifact.caller !== plan.caller ||
        opened.artifact.rpc !== plan.id ||
        opened.artifact.method !== 'bridge.dispatch' ||
        opened.artifact.capability !== 'write'
      )
        return fail('forbidden')
      if (plan.descriptor && json(plan.descriptor) !== json(opened)) return fail('conflict')
      if (!plan.envelope) {
        const root = this.hub.options.identity.pinnedRootKey(self.user),
          signedRoster = this.hub.options.identity.roster()
        if (!root || !signedRoster) return fail('not_enrolled')
        const roster = this.hub.options.identity.verifySigned<import('../../../shared/net').Roster>(
          signedRoster,
          root
        )
        const delegation = roster.nodes
          .map((row) =>
            this.hub.options.identity.verifySigned<import('../../../shared/net').NodeDelegation>(
              row,
              root
            )
          )
          .filter((row) => row.subject === self.node)
          .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
        if (!delegation) return fail('bad_delegation')
        const envelope = encodeEnvelope({
          v: 1,
          minor: 0,
          id: plan.event,
          stream: opened.id,
          type: 'artifact.published',
          crit: false,
          author: { user: self.user, node: self.node, keyEpoch: delegation.keyEpoch },
          ts: db.clock.now(),
          body: { rpc: plan.id, purpose: 'input' },
          blobs: [{ id: plan.blob, bytes: plan.bytes, mime: 'application/x-git-bundle' }]
        })
        db.transaction(() => {
          plan.descriptor = opened
          plan.envelope = Buffer.from(envelope).toString('base64url')
          plan.sig = Buffer.from(this.hub.options.keys.signAsNode(envelope)).toString('base64url')
          plan.phase = 'publishing'
          this.save(plan)
          db.checkpoint('bridge.hub.input.publication.beforeCommit')
        })
      }
      if (signal?.aborted) return fail('cancelled')
      await session.putBlob(opened.id, plan.blob, bytes, false)
      if (signal?.aborted) return fail('cancelled')
      // Identical signed publication bytes are safe to repeat; agent execution is not.
      await session.append(
        opened.id,
        plan.event,
        Buffer.from(plan.envelope!, 'base64url'),
        Buffer.from(plan.sig!, 'base64url')
      )
      db.transaction(() => {
        plan.phase = 'published'
        this.save(plan)
        db.checkpoint('bridge.hub.input.published.beforeCommit')
      })
    }
    const request = this.hub.prepare(
      plan.target,
      'bridge.dispatch',
      {
        ...plan.params,
        inputBundle: { stream: plan.descriptor!.id, event: plan.event, blob: plan.blob }
      },
      { id: plan.id, idem: plan.idem, deadlineMs: plan.deadlineMs }
    )
    return this.hub.submit(request, signal)
  }
}
