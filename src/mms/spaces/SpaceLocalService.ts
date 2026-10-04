import type { OutboxEntry, SyncSession } from '../net/contracts'
import { decodeEnvelope } from '../net/sync/codec'
import { verifyDocument } from '../net/identity/crypto'
import {
  NetError,
  type EventId,
  type MemberRecord,
  type NodeDelegation,
  type Roster,
  type SpaceDescriptor,
  type SpaceId,
  type StreamDescriptor,
  type StreamId
} from '../../shared/net'
import type {
  SpaceLocalChannel,
  SpaceLocalDelivery,
  SpaceLocalSummary,
  SpaceLocalTail,
  SpacesLocalMethod,
  SpacesLocalParams,
  SpacesLocalResults
} from '../../shared/spaces/local'
import type { SpaceProfileService } from './SpaceProfileService'
import { validateSpacesLocal } from './registerMethods'
import { parseSpaceInvite, encodeSpaceInvite, spaceInviteDigest } from './host/invite'
import { settleArchiveWork } from './archive/lifecycle'

const MAX_SPACES = 128,
  MAX_SELECTED_CHANNELS = 256,
  TAIL_BYTES = 512 * 1024
/** Local owner IPC front door. Public display reads never execute bots or decrypt private streams. */
export class SpaceLocalService {
  private stopped = false
  private requests = new Set<Promise<unknown>>()
  private mutation: Promise<unknown> = Promise.resolve()
  private jobs = new Map<SpaceId, { controller: AbortController; promise: Promise<void> }>()
  private joining = new Set<SpaceId>()
  private selected = new Set<StreamId>()
  private retry?: ReturnType<typeof setTimeout>
  private errors = new Map<SpaceId, NetError['code']>()
  private archiveFences = new Set<SpaceId>()
  constructor(readonly profile: SpaceProfileService) {
    profile.options.runtime.db.transaction(() =>
      profile.options.runtime.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_space_local_leave(space_id TEXT PRIMARY KEY,event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_space_local_channels(stream TEXT PRIMARY KEY,space_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS net_space_local_outbox_stream ON net_outbox(stream);
      CREATE INDEX IF NOT EXISTS net_space_local_outbox_states ON net_outbox(stream,state);
    `)
    )
  }
  request<K extends SpacesLocalMethod>(
    method: K,
    input: SpacesLocalParams[K]
  ): Promise<SpacesLocalResults[K]> {
    this.profile.options.net.assertFeature('netSpaces')
    const params = validateSpacesLocal(method, input)
    if (this.stopped) return Promise.reject(new NetError('cancelled'))
    if (this.requests.size >= 128) return Promise.reject(new NetError('rate_limited'))
    this.resume()
    let work: Promise<SpacesLocalResults[K]>
    if (
      [
        'spaces.create',
        'spaces.invite',
        'spaces.join',
        'spaces.channels',
        'spaces.post',
        'spaces.leave'
      ].includes(method)
    ) {
      work = this.mutation.then(() => {
        if (this.stopped) throw new NetError('cancelled')
        return this.execute(method, params)
      })
      this.mutation = work.catch(() => {})
    } else work = this.execute(method, params)
    this.requests.add(work)
    void work.then(
      () => this.requests.delete(work),
      () => this.requests.delete(work)
    )
    return work
  }
  activeCount(): number {
    return this.jobs.size + this.requests.size
  }
  private async execute<K extends SpacesLocalMethod>(
    method: K,
    params: SpacesLocalParams[K]
  ): Promise<SpacesLocalResults[K]> {
    const p = params as unknown as Record<string, any>,
      rt = this.profile.options.runtime
    let result: unknown
    switch (method) {
      case 'spaces.create': {
        this.writable()
        this.capacity()
        const created = this.profile.host.create({ name: p.name }),
          channel = this.profile.host.createChannel(created.space, p.channelName ?? 'general')
        result = { space: created.space, meta: created.meta, channel }
        break
      }
      case 'spaces.invite':
        this.guardWrite(p.space)
        result = this.profile.host.invite(p.space, p)
        if (this.profile.options.net.prepareSpaceRendezvous) {
          const original = result as { text: string; expiresAt: number }
          const rendezvous = await this.profile.options.net.prepareSpaceRendezvous(
            original.expiresAt,
            p.uses ?? 1
          )
          if (rendezvous) {
            const parsed = parseSpaceInvite(original.text)
            try {
              const signed = rt.identity.signAsNode({
                v: 1,
                kind: 'spaceRelayDiscovery',
                node: parsed.descriptor.hostNode,
                authorizationHash: spaceInviteDigest(parsed.container.authorization),
                descriptorHash: spaceInviteDigest(parsed.container.descriptor),
                rendezvous
              })
              original.text = encodeSpaceInvite({ ...parsed.container, rendezvous: signed })
            } finally {
              parsed.token.fill(0)
            }
          }
        }
        result = {
          invite: (result as { text: string }).text,
          inviteId: (result as { invite: string }).invite,
          expiresAt: (result as { expiresAt: number }).expiresAt
        }
        break
      case 'spaces.join': {
        this.writable()
        const invite = parseSpaceInvite(p.invite),
          space = invite.descriptor.space,
          previous = this.profile.client.binding(space),
          leaving = this.leave(space),
          leaveEntry = leaving ? rt.outbox.get(leaving) : undefined
        if (!this.spaces().includes(space)) this.capacity()
        if (leaving) {
          if (!leaveEntry) throw new NetError('storage_corrupt')
          if (leaveEntry.state === 'pending' || leaveEntry.state === 'unknown')
            throw new NetError(
              'outcome_uncertain',
              'Wait for the original leave receipt before rejoining.'
            )
          const old = rt.db.database
            .prepare('SELECT journal FROM net_space_client_join WHERE invite=?')
            .get(invite.authorization.invite)
          if (old && JSON.parse(old.journal as string).state === 'joined')
            throw new NetError('conflict', 'Rejoining requires a fresh invitation receipt.')
        }
        // The durable receipt can become visible before this request opens its
        // first session. Background recovery must not replace that connection.
        this.joining.add(space)
        try {
          const id = this.profile.client.prepareJoin(p.invite, p.name),
            binding = await this.profile.client.join(id)
          if (leaving && previous) {
            const prior = leaveEntry?.position ?? previous.receipt
            if (
              binding.receipt.epoch < prior.epoch ||
              (binding.receipt.epoch === prior.epoch && binding.receipt.seq <= prior.seq)
            )
              throw new NetError('conflict', 'The join receipt predates the leave.')
          }
          if (this.stopped) throw new NetError('cancelled')
          await this.profile.client.connect(binding.space)
          // A fresh signed receipt, followed by authenticated meta, is the only reactivation path.
          if (!this.profile.meta.member(binding.space, this.self().user))
            throw new NetError('not_member')
          rt.db.transaction(() => {
            rt.db.charge(1)
            rt.db.database
              .prepare('DELETE FROM net_space_local_leave WHERE space_id=?')
              .run(binding.space)
          })
          this.errors.delete(binding.space)
          result = this.summary(binding.space)
          break
        } finally {
          this.joining.delete(space)
        }
      }
      case 'spaces.list':
        result = { spaces: this.spaces().map((space) => this.summary(space)) }
        break
      case 'spaces.channels': {
        this.known(p.space)
        let created: StreamId | undefined
        if (p.name !== undefined) {
          this.guardWrite(p.space)
          created = this.profile.host.createChannel(p.space, p.name)
        }
        result = { channels: this.channels(p.space), ...(created ? { created } : {}) }
        break
      }
      case 'spaces.members':
        this.known(p.space)
        this.profile.meta.assertUsable(p.space)
        result = { members: this.entities<MemberRecord>(p.space, 'member') }
        break
      case 'spaces.post': {
        const descriptor = this.channel(p.stream)
        this.guardWrite(descriptor.space!)
        // SqliteOutbox validates the actual encoded envelope's 64 KiB bound
        // before durable enqueue, including JSON escapes and mention references.
        const id = this.profile.client.post(
          descriptor.id,
          p.text,
          p.mentions ? { mentions: p.mentions } : undefined
        )
        await this.flush(descriptor.space!)
        result = this.delivery(rt.outbox.get(id)!)
        break
      }
      case 'spaces.tail':
        result = await this.tail(p as SpacesLocalParams['spaces.tail'])
        break
      case 'spaces.outbox': {
        this.channel(p.stream)
        const states = p.states as string[] | undefined,
          filter = states ? ` AND state IN (${states.map(() => '?').join(',')})` : '',
          args = states ?? []
        const total = Number(
          rt.db.database
            .prepare(`SELECT count(*) AS n FROM net_outbox WHERE stream=?${filter}`)
            .get(p.stream, ...args)!.n
        )
        if (p.id) {
          const entry = rt.outbox.get(p.id)
          if (!entry || entry.stream !== p.stream) throw new NetError('bad_request')
          result = { entries: [this.delivery(entry)], total }
        } else {
          const rows = rt.db.database
              .prepare(
                `SELECT rowid AS ordinal,id FROM net_outbox WHERE stream=?${filter} AND rowid>? ORDER BY rowid LIMIT ?`
              )
              .all(p.stream, ...args, p.after ?? 0, p.limit ?? 256),
            entries = rows.map((row) => this.delivery(rt.outbox.get(row.id as EventId)!))
          result = {
            entries,
            total,
            ...(rows.length === (p.limit ?? 256) ? { nextAfter: Number(rows.at(-1)!.ordinal) } : {})
          }
        }
        break
      }
      case 'spaces.leave': {
        this.known(p.space)
        this.writable()
        const old = this.leave(p.space)
        if (old) {
          result = this.delivery(rt.outbox.get(old)!)
          break
        }
        this.guardWrite(p.space)
        if (this.profile.meta.member(p.space, this.self().user)?.role === 'owner')
          throw new NetError('forbidden')
        const id = rt.db.transaction(() => {
          const id = this.profile.client.queue(
            this.profile.client.binding(p.space)!.meta,
            'member.left',
            { user: this.self().user }
          )
          rt.db.charge(1)
          rt.db.database.prepare('INSERT INTO net_space_local_leave VALUES(?,?)').run(p.space, id)
          return id
        })
        // Stop normal display subscriptions immediately; the durable leave itself may still need delivery.
        this.jobs.get(p.space)?.controller.abort()
        this.selectedFor(p.space).forEach((stream) => this.selected.delete(stream))
        await this.flush(p.space)
        const entry = rt.outbox.get(id)!
        if (entry.state === 'sent' || entry.state === 'failed')
          this.profile.client.disconnect(p.space)
        result = this.delivery(entry)
        break
      }
      default:
        throw new NetError('bad_request')
    }
    return result as SpacesLocalResults[K]
  }
  private self() {
    const self = this.profile.options.runtime.identity.self()
    if (!self) throw new NetError('not_enrolled')
    return self
  }
  private writable(): void {
    this.self()
    if (this.profile.options.runtime.keys.state() !== 'unlocked')
      throw new NetError('keystore_locked')
    if (!this.profile.options.net.status().enabled) throw new NetError('route_unreachable')
  }
  private spaces(): SpaceId[] {
    const ids = new Set<SpaceId>(this.profile.client.list().map((b) => b.space))
    for (const stream of this.profile.store.listStreams({ kind: 'space.meta' }))
      if (stream.space) ids.add(stream.space)
    if (ids.size > MAX_SPACES) throw new NetError('too_large')
    return [...ids].sort()
  }
  private capacity(): void {
    if (this.spaces().length >= MAX_SPACES) throw new NetError('too_large')
  }
  private known(space: SpaceId): void {
    if (!this.spaces().includes(space)) throw new NetError('stream_unknown')
  }
  private leave(space: SpaceId): EventId | undefined {
    return this.profile.options.runtime.db.database
      .prepare('SELECT event FROM net_space_local_leave WHERE space_id=?')
      .get(space)?.event as EventId | undefined
  }
  private isHost(space: SpaceId): boolean {
    const state = this.profile.meta.position(space),
      self = this.profile.options.runtime.identity.self()
    if (!state?.descriptor || !self || !state.owner) return false
    const root = this.profile.options.runtime.identity.pinnedRootKey(state.owner)
    if (!root) return false
    return (
      verifyDocument<SpaceDescriptor>(state.descriptor, root, 'spaceDescriptor').hostNode ===
      self.node
    )
  }
  private summary(space: SpaceId): SpaceLocalSummary {
    const p = this.profile.meta.position(space),
      self = this.self(),
      member = !!this.profile.meta.member(space, self.user),
      leave = this.leave(space),
      host = this.isHost(space),
      binding = this.profile.client.binding(space)
    let error = this.errors.get(space)
    try {
      this.profile.meta.assertUsable(space)
    } catch (e) {
      if (e instanceof NetError) error = e.code
      else throw e
    }
    return {
      space,
      name: p?.settings?.name ?? 'Space',
      host,
      member,
      offline: !host && (!binding || this.profile.session(space)?.state() !== 'open'),
      readonly: !!leave || !member || p?.status !== 'active',
      ...(leave ? { leave: this.delivery(this.profile.options.runtime.outbox.get(leave)!) } : {}),
      ...(error ? { error } : {})
    }
  }
  private guardWrite(space: SpaceId): void {
    this.known(space)
    this.writable()
    this.profile.meta.assertUsable(space, true)
    if (this.leave(space) || !this.profile.meta.member(space, this.self().user))
      throw new NetError('not_member')
  }
  private entities<T>(space: SpaceId, kind: 'member' | 'channel'): T[] {
    this.profile.meta.assertUsable(space)
    const db = this.profile.options.runtime.db.database
    const count = Number(
      db
        .prepare(
          'SELECT count(*) AS n FROM net_space_meta_entities e JOIN net_space_meta_active a ON a.generation=e.generation WHERE a.space_id=? AND e.kind=? AND e.value IS NOT NULL'
        )
        .get(space, kind)!.n
    )
    if (count > 256)
      throw new NetError('too_large', 'This local display is limited to 256 entries.')
    return this.profile.meta.entities<T>(space, kind)
  }
  private channels(space: SpaceId): SpaceLocalChannel[] {
    this.profile.meta.assertUsable(space)
    const channels = this.entities<SpaceLocalChannel>(space, 'channel')
    for (const channel of channels) this.registerChannel(space, channel.stream)
    return channels
  }
  private registerChannel(space: SpaceId, stream: StreamId): StreamDescriptor {
    if (!this.profile.meta.channel(space, stream)) throw new NetError('stream_unknown')
    let descriptor = this.profile.store.getStream(stream)
    if (!descriptor) {
      const p = this.profile.meta.position(space)!,
        root = this.profile.options.runtime.identity.pinnedRootKey(p.owner!)!,
        signed = verifyDocument<SpaceDescriptor>(p.descriptor!, root, 'spaceDescriptor')
      this.profile.store.createStream(
        {
          id: stream,
          kind: 'space.channel',
          space,
          authority: signed.hostNode,
          createdAt: signed.issuedAt
        },
        signed.epoch
      )
      descriptor = this.profile.store.getStream(stream)!
    }
    if (descriptor.kind !== 'space.channel' || descriptor.space !== space)
      throw new NetError('forbidden')
    return descriptor
  }
  private channel(stream: StreamId): StreamDescriptor {
    let descriptor = this.profile.store.getStream(stream)
    if (!descriptor)
      for (const space of this.spaces())
        if (this.profile.meta.channel(space, stream)) {
          descriptor = this.registerChannel(space, stream)
          break
        }
    if (!descriptor?.space || descriptor.kind !== 'space.channel') throw new NetError('forbidden')
    this.known(descriptor.space)
    this.profile.meta.assertUsable(descriptor.space)
    if (!this.profile.meta.channel(descriptor.space, stream)) throw new NetError('stream_unknown')
    return descriptor
  }
  private delivery(entry: OutboxEntry): SpaceLocalDelivery {
    if (!entry) throw new NetError('storage_corrupt')
    return {
      id: entry.id,
      stream: entry.stream,
      state: entry.state,
      attempts: entry.attempts,
      createdAt: entry.createdAt,
      ...(entry.position ? { position: entry.position } : {}),
      ...(entry.error ? { error: entry.error } : {})
    }
  }
  private async tail(input: SpacesLocalParams['spaces.tail']): Promise<SpaceLocalTail> {
    const descriptor = this.channel(input.stream),
      space = descriptor.space!,
      summary = this.summary(space)
    if (
      !summary.host &&
      !summary.readonly &&
      !this.archiveFences.has(space) &&
      this.profile.canStartSpaceWork(space)
    ) {
      this.select(space, descriptor.id)
      if (this.profile.session(space)?.state() === 'open' && !this.selected.has(descriptor.id)) {
        await this.profile.client.subscribe(descriptor.id)
        if (!this.archiveFences.has(space)) this.selected.add(descriptor.id)
      }
    }
    if (this.stopped) throw new NetError('cancelled')
    const head = this.profile.store.head(descriptor.id),
      after = input.after ?? { epoch: head.epoch, seq: 0 },
      page = this.profile.store.read(descriptor.id, after, head.seq, TAIL_BYTES),
      records: SpaceLocalTail['records'] = []
    let bytes = 0
    for (const record of page.records.slice(0, input.limit ?? 128)) {
      const item = {
          epoch: record.epoch,
          seq: record.seq,
          recvTs: record.recvTs,
          envelope: decodeEnvelope(record.envelope).envelope
        },
        size = Buffer.byteLength(JSON.stringify(item))
      if (bytes + size > TAIL_BYTES - 4096) break
      bytes += size
      records.push(item)
    }
    const cursor = records.length ? { epoch: head.epoch, seq: records.at(-1)!.seq } : after
    return {
      stream: descriptor.id,
      head,
      cursor,
      records,
      done: cursor.seq === head.seq,
      offline: summary.offline,
      readonly: summary.readonly
    }
  }
  private select(space: SpaceId, stream: StreamId): void {
    const db = this.profile.options.runtime.db
    if (db.database.prepare('SELECT 1 FROM net_space_local_channels WHERE stream=?').get(stream))
      return
    if (
      Number(db.database.prepare('SELECT count(*) AS n FROM net_space_local_channels').get()!.n) >=
      MAX_SELECTED_CHANNELS
    )
      throw new NetError('too_large')
    db.transaction(() => {
      db.charge(1)
      db.database.prepare('INSERT INTO net_space_local_channels VALUES(?,?)').run(stream, space)
    })
  }
  private selectedFor(space: SpaceId): StreamId[] {
    return this.profile.options.runtime.db.database
      .prepare('SELECT stream FROM net_space_local_channels WHERE space_id=? ORDER BY stream')
      .all(space)
      .map((row) => row.stream as StreamId)
  }
  private peer(): SyncSession['peer'] {
    const rt = this.profile.options.runtime,
      self = this.self(),
      root = rt.identity.pinnedRootKey(self.user)!,
      roster = verifyDocument<Roster>(rt.identity.roster(self.user)!, root, 'roster'),
      delegation = roster.nodes
        .map((s) => verifyDocument<NodeDelegation>(s, root, 'nodeDelegation'))
        .filter((d) => d.subject === self.node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!delegation) throw new NetError('bad_delegation')
    return { user: self.user, node: self.node, delegation }
  }
  private async flush(space: SpaceId): Promise<void> {
    if (this.archiveFences.has(space) || !this.profile.canStartSpaceWork(space))
      throw new NetError('space_frozen')
    if (!this.isHost(space)) {
      await this.profile.client.flush(space)
      return
    }
    const rt = this.profile.options.runtime,
      peer = this.peer()
    for (const stream of this.profile.store.listStreams({ space, kind: 'space.channel' }))
      for (const entry of rt.outbox.due(stream.id)) {
        rt.outbox.markAttempt(entry.id)
        try {
          const position = this.profile.host.append(
            stream.id,
            entry.id,
            entry.envelope,
            entry.sig,
            peer
          )
          rt.outbox.markSent(entry.id, position)
        } catch (error) {
          if (
            error instanceof NetError &&
            !error.retryable &&
            !['internal', 'cancelled'].includes(error.code)
          )
            rt.outbox.markFailed(entry.id, error.code)
          else break
        }
      }
  }
  /** Called after net activation; retries durable originals with at most four concurrent spaces. */
  resume(): void {
    if (
      this.stopped ||
      !this.profile.options.runtime.identity.self() ||
      this.profile.options.runtime.keys.state() !== 'unlocked' ||
      !this.profile.options.net.status().enabled
    )
      return
    if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined
        this.resume()
      }, 3000)
      this.retry.unref()
    }
    let spaces: SpaceId[]
    try {
      spaces = this.spaces()
    } catch {
      return
    }
    for (const space of spaces) {
      if (this.jobs.size >= 4) break
      if (this.joining.has(space)) continue
      if (this.archiveFences.has(space) || !this.profile.canStartSpaceWork(space)) continue
      // A join owns admission and the initial meta connection. A resume tick
      // must not replace that in-flight connection and cancel the local request.
      if (this.joining.has(space) || this.jobs.has(space)) continue
      const leave = this.leave(space),
        entry = leave ? this.profile.options.runtime.outbox.get(leave) : undefined
      if (leave && (!entry || entry.state === 'sent' || entry.state === 'failed')) continue
      if (!leave && this.profile.session(space)?.state() === 'open') {
        void this.flush(space).catch(() => {})
        continue
      }
      if (!this.isHost(space) && !this.profile.client.binding(space)) continue
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 10000)
      const promise = (async () => {
        if (!this.isHost(space)) {
          for (const stream of this.selectedFor(space)) this.selected.delete(stream)
          await this.profile.client.connect(space, controller.signal)
          if (this.archiveFences.has(space) || !this.profile.canStartSpaceWork(space))
            throw new NetError('space_frozen')
          if (!leave)
            for (const stream of this.selectedFor(space)) {
              this.channel(stream)
              await this.profile.client.subscribe(stream)
              this.selected.add(stream)
            }
        }
        await this.flush(space)
        this.errors.delete(space)
      })()
        .catch((error) => {
          if (error instanceof NetError) this.errors.set(space, error.code)
        })
        .finally(() => {
          clearTimeout(timer)
          if (leave) this.profile.client.disconnect(space)
          this.jobs.delete(space)
        })
      this.jobs.set(space, { controller, promise })
    }
  }
  /** New archive calls live outside this catalogue, so any active request here
   * is conservatively unknown ownership and cannot be pronounced drained. */
  async quiesceForArchive(space: SpaceId, signal: AbortSignal): Promise<void> {
    this.fenceForArchive(space)
    const job = this.jobs.get(space)
    job?.controller.abort()
    this.profile.client.disconnect(space)
    for (const stream of this.selectedFor(space)) this.selected.delete(stream)
    if (job) await settleArchiveWork([job.promise], signal)
    if (this.requests.size || this.jobs.has(space)) throw new NetError('outcome_uncertain')
    if (signal.aborted) throw new NetError('cancelled')
  }
  fenceForArchive(space: SpaceId): void {
    this.archiveFences.add(space)
    this.jobs.get(space)?.controller.abort()
  }
  resumeAfterArchive(space: SpaceId): void {
    if (!this.profile.canStartSpaceWork(space)) throw new NetError('space_frozen')
    this.archiveFences.delete(space)
    this.resume()
  }
  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([
      this.mutation,
      ...this.requests,
      ...[...this.jobs.values()].map((job) => job.promise)
    ])
    this.jobs.clear()
  }
}
