import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  linkSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  NetError,
  spaceMetaStream,
  type Signed,
  type SpaceDescriptor,
  type SpaceId,
  type StreamId
} from '../../../shared/net'
import type {
  SpaceArchiveMethod,
  SpaceArchiveParams,
  SpaceArchiveStatus
} from '../../../shared/spaces/archive'
import type { BotProfileService } from '../../bots/BotProfileService'
import type { SpaceProfileService } from '../SpaceProfileService'
import { json } from '../../net/store/database'
import { signedDocument } from '../../net/identity/crypto'
import { canonicalJson, parseProtocolJson } from '../../net/sync/codec'
import { ArchiveJournal, type ArchiveOperation } from './journal'
import { SpaceArchiveHost } from './SpaceArchiveHost'
import { SpaceImportCoordinator } from './ImportCoordinator'
import { SpaceImportStage } from './ImportStage'
import { readVerifiedSpaceArchive } from './verify'
import { retireSpaceAuthority, verifySpaceRetirement } from './retirement'
import { SpaceArchiveRecovery } from './SpaceArchiveRecovery'
import { validateSpaceArchive } from './registerMethods'
import type { VerifiedSpaceArchive } from './contracts'
interface NetArchivePort {
  fenceSpaceArchive(space: SpaceId, streams: readonly StreamId[]): void
  quiesceSpaceStreams(
    space: SpaceId,
    streams: readonly StreamId[],
    signal: AbortSignal
  ): Promise<void>
  resumeSpaceStreams(space: SpaceId): void
  signedRoutes(): Signed
}
interface Reference {
  space: SpaceId
  path: string
  digest: string
  mode: 'source' | 'restore' | 'move'
  operation?: string
  target?: Pick<SpaceDescriptor, 'space' | 'owner' | 'hostNode' | 'hostTransportKey' | 'epoch'>
}
/** Installation-local archive operator. No RPC, received callbacks, caller
 * assertions or archive-provided key material can enter this composition. */
export class SpaceArchiveService {
  readonly source: SpaceArchiveHost
  readonly journal: ArchiveJournal
  private readonly importer: SpaceImportCoordinator
  private readonly active = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private currentArchive?: VerifiedSpaceArchive
  private stopped = false
  constructor(
    readonly options: {
      spaces: SpaceProfileService
      bots: BotProfileService
      net: NetArchivePort
      unscopedActive?(): number
    }
  ) {
    const db = options.spaces.options.runtime.db
    db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_space_archive_local_refs(space TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT'
    )
    this.source = new SpaceArchiveHost({
      host: options.spaces.host,
      quiesce: (space, signal) => this.quiesce(space, signal)
    })
    this.journal = this.source.journal
    this.importer = new SpaceImportCoordinator({
      host: options.spaces.host,
      store: options.spaces.store,
      quiesce: (space, signal) => this.quiesce(space, signal),
      prepareRecovery: (input) => {
        if (!this.currentArchive) throw new NetError('forbidden')
        return new SpaceArchiveRecovery(options.spaces, this.currentArchive).prepare(input)
      },
      verifyRetirement: verifySpaceRetirement
    })
    this.seedFences()
  }
  activeCount(): number {
    return this.active.size
  }
  seedFences(): void {
    const rows = this.options.spaces.options.runtime.db.database
      .prepare(
        'SELECT o.value FROM net_space_archive_active a JOIN net_space_archive_operations o ON o.id=a.operation ORDER BY a.space LIMIT 129'
      )
      .all()
    if (rows.length > 128) throw new NetError('too_large')
    for (const row of rows) {
      const op = JSON.parse(row.value as string) as ArchiveOperation
      if (op.state !== 'activeNew') this.fence(op.space)
      if (op.state === 'exported') this.options.net.resumeSpaceStreams(op.space)
    }
  }
  async close(): Promise<void> {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.active])
  }
  request<K extends SpaceArchiveMethod>(
    method: K,
    params: SpaceArchiveParams[K]
  ): Promise<unknown> {
    validateSpaceArchive(method, params)
    if (this.stopped) throw new NetError('cancelled')
    if (method === 'spaces.archive.status')
      return Promise.resolve(this.status(params as SpaceArchiveParams['spaces.archive.status']))
    if (this.active.size) throw new NetError('rate_limited')
    const controller = new AbortController()
    this.controllers.add(controller)
    let expired = false
    const timer = this.options.spaces.options.runtime.db.clock.setTimeout(() => {
      expired = true
      controller.abort()
    }, 5000)
    // Own the operation before any Host, key-store or composition callback.
    const work = Promise.resolve()
      .then(() => this.execute(method, params, controller.signal))
      .catch((error) => {
        if (expired && error instanceof NetError && error.code === 'cancelled')
          throw new NetError('outcome_uncertain')
        throw error
      })
    this.active.add(work)
    void work
      .finally(() => {
        timer.cancel()
        this.active.delete(work)
        this.controllers.delete(controller)
      })
      .catch(() => {})
    return work
  }
  private owner(): { user: import('../../../shared/net').UserId; rootKey: string } {
    const rt = this.options.spaces.options.runtime,
      self = rt.identity.self(),
      keys = rt.keys as typeof rt.keys & { encryptedAtRest?(): boolean },
      root = self && rt.identity.pinnedRootKey(self.user)
    if (keys.state() === 'locked') throw new NetError('keystore_locked')
    if (!self?.isAuthority || !root) throw new NetError('forbidden')
    if (keys.state() !== 'unlocked' || keys.encryptedAtRest?.() !== true)
      throw new NetError('keystore_locked')
    if (keys.rootKey() !== root) throw new NetError('forbidden')
    return { user: self.user, rootKey: root }
  }
  private ref(space: SpaceId): Reference | undefined {
    const row = this.options.spaces.options.runtime.db.database
      .prepare('SELECT value FROM net_space_archive_local_refs WHERE space=?')
      .get(space)
    return row ? JSON.parse(row.value as string) : undefined
  }
  private save(ref: Reference): void {
    const db = this.options.spaces.options.runtime.db,
      value = json(ref)
    if (Buffer.byteLength(value) > 8192) throw new NetError('too_large')
    db.transaction(() => {
      if (
        !this.ref(ref.space) &&
        Number(
          db.database.prepare('SELECT count(*) AS n FROM net_space_archive_local_refs').get()!.n
        ) >= 128
      )
        throw new NetError('too_large')
      db.charge(1, Buffer.byteLength(value))
      db.database
        .prepare(
          'INSERT INTO net_space_archive_local_refs VALUES(?,?) ON CONFLICT(space) DO UPDATE SET value=excluded.value'
        )
        .run(ref.space, value)
    })
  }
  private streams(space: SpaceId): StreamId[] {
    const spaces = this.options.spaces,
      ids = new Set([
        spaceMetaStream(space),
        ...spaces.store.listStreams({ space }).map((s) => s.id)
      ]),
      op = this.journal.forSpace(space)
    if (op?.digest && ['importedFrozen', 'activating'].includes(op.state))
      for (const stream of SpaceImportStage.resume(
        spaces.options.runtime.db,
        op.id,
        op.digest
      ).descriptors())
        ids.add(stream.id)
    if (this.currentArchive?.manifest.space === space)
      for (const stream of this.currentArchive.manifest.streams) ids.add(stream.descriptor.id)
    if (ids.size > 128) throw new NetError('too_large')
    return [...ids]
  }
  private fence(space: SpaceId): void {
    this.options.spaces.fenceForArchive(space)
    this.options.bots.fenceForArchive(space)
    this.options.net.fenceSpaceArchive(space, this.streams(space))
  }
  private assertCertain(space: SpaceId): void {
    if (
      this.options.spaces.options.runtime.db.database
        .prepare("SELECT 1 FROM net_executions WHERE scope=? AND state='uncertain' LIMIT 1")
        .get(space)
    )
      throw new NetError('outcome_uncertain')
  }
  private async quiesce(space: SpaceId, signal: AbortSignal): Promise<void> {
    this.fence(space)
    // A settled provider Promise is not a proven execution outcome. Preserve
    // its actual uncertain receipt before creating an import journal/stage.
    this.assertCertain(space)
    if (this.options.unscopedActive?.()) throw new NetError('outcome_uncertain')
    await this.options.bots.quiesceForArchive(space, signal)
    await this.options.spaces.quiesceForArchive(space, signal)
    // Include hidden imported descriptors: cancelling them never grants serving.
    await this.options.net.quiesceSpaceStreams(space, this.streams(space), signal)
    this.assertCertain(space)
    if (this.options.unscopedActive?.()) throw new NetError('outcome_uncertain')
  }
  private open(path: string): VerifiedSpaceArchive {
    try {
      return readVerifiedSpaceArchive(path, { owner: this.owner() })
    } catch (error) {
      if (error instanceof NetError) throw error
      throw new NetError('bad_request')
    }
  }
  private referenceArchive(space: SpaceId): VerifiedSpaceArchive {
    const ref = this.ref(space),
      op = this.journal.forSpace(space)
    if (!ref || !op?.digest || ref.digest !== op.digest) throw new NetError('conflict')
    const archive = this.open(ref.path)
    if (archive.manifest.space !== space || archive.digest !== ref.digest) {
      archive.close()
      throw new NetError('conflict')
    }
    return archive
  }
  private view(op: ArchiveOperation): SpaceArchiveStatus {
    const epoch = this.options.spaces.meta.position(op.space)?.epoch
    return {
      space: op.space,
      operation: op.id,
      state: op.state,
      mode: op.mode,
      frozen: op.frozen,
      ...(op.digest ? { digest: op.digest } : {}),
      ...(epoch ? { epoch } : {})
    }
  }
  private status(params: SpaceArchiveParams['spaces.archive.status']): unknown {
    if (params.space) {
      const op = this.journal.forSpace(params.space)
      return { operation: op ? this.view(op) : null }
    }
    const limit = params.limit ?? 16,
      rows = this.options.spaces.options.runtime.db.database
        .prepare(
          'SELECT o.value FROM net_space_archive_active a JOIN net_space_archive_operations o ON o.id=a.operation WHERE a.space>? ORDER BY a.space LIMIT ?'
        )
        .all(params.after ?? '', limit + 1),
      more = rows.length > limit
    if (more) rows.pop()
    const operations = rows.map((row) => this.view(JSON.parse(row.value as string)))
    return { operations, ...(more ? { nextAfter: operations.at(-1)!.space } : {}) }
  }
  private async execute<K extends SpaceArchiveMethod>(
    method: K,
    params: SpaceArchiveParams[K],
    signal: AbortSignal
  ): Promise<unknown> {
    const owner = this.owner(),
      spaces = this.options.spaces,
      rt = spaces.options.runtime
    switch (method) {
      case 'spaces.archive.freeze': {
        const p = params as SpaceArchiveParams['spaces.archive.freeze'],
          record = this.source.freeze(p.space, p.reason)
        this.fence(p.space)
        return {
          ...this.view(this.journal.forSpace(p.space)!),
          position: { epoch: record.epoch, seq: record.seq }
        }
      }
      case 'spaces.archive.export': {
        const p = params as SpaceArchiveParams['spaces.archive.export'],
          prior = this.journal.forSpace(p.space)
        if (prior?.state === 'exported') {
          const archive = this.open(p.path)
          try {
            if (archive.digest !== prior.digest || archive.manifest.space !== p.space)
              throw new NetError('conflict')
            this.save({
              space: p.space,
              path: realpathSync(p.path),
              digest: archive.digest,
              mode: 'source',
              operation: prior.id
            })
          } finally {
            archive.close()
          }
        } else {
          const result = await this.source.export(p.space, p.path, signal)
          this.save({
            space: p.space,
            path: realpathSync(p.path),
            digest: result.digest,
            mode: 'source',
            operation: this.journal.forSpace(p.space)!.id
          })
        }
        this.options.net.resumeSpaceStreams(p.space)
        return this.view(this.journal.forSpace(p.space)!)
      }
      case 'spaces.archive.retire': {
        const p = params as SpaceArchiveParams['spaces.archive.retire'],
          archive = this.referenceArchive(p.space)
        try {
          const evidence = await retireSpaceAuthority(this.source, archive, signal)
          this.proofFile(this.ref(p.space)!.path, evidence)
          return this.view(this.journal.forSpace(p.space)!)
        } finally {
          archive.close()
        }
      }
      case 'spaces.archive.import': {
        const p = params as SpaceArchiveParams['spaces.archive.import'],
          archive = this.open(p.path)
        try {
          const space = archive.manifest.space,
            prior = this.journal.forSpace(space),
            path = realpathSync(p.path),
            held = this.ref(space)
          // Refuse before replacing even the local archive reference.
          this.assertCertain(space)
          if (prior?.state === 'importedFrozen') {
            if (prior.digest !== archive.digest || prior.mode !== p.mode)
              throw new NetError('conflict')
            this.save({
              ...held,
              space,
              path,
              digest: archive.digest,
              mode: p.mode,
              operation: prior.id
            })
            return this.view(prior)
          }
          if (
            prior &&
            !['frozen', 'failedFrozen', 'exported', 'retired', 'activeNew', 'importing'].includes(
              prior.state
            )
          )
            throw new NetError('conflict')
          if (spaces.meta.position(space) && spaces.meta.position(space)!.status !== 'frozen')
            throw new NetError('space_frozen')
          const retirement = p.mode === 'move' ? this.readProof(path) : undefined
          if (retirement) verifySpaceRetirement(archive, retirement)
          this.save({ space, path, digest: archive.digest, mode: p.mode })
          this.currentArchive = archive
          const coordinator = this.importer
          await coordinator.import(archive, p.mode, signal, retirement)
          this.save({ ...this.ref(space)!, operation: coordinator.journal.forSpace(space)!.id })
          this.fence(space)
          return this.view(coordinator.journal.forSpace(space)!)
        } finally {
          this.currentArchive = undefined
          archive.close()
        }
      }
      case 'spaces.archive.activate': {
        const p = params as SpaceArchiveParams['spaces.archive.activate'],
          op = this.journal.forSpace(p.space),
          ref = this.ref(p.space)
        if (!op || !ref || op.digest !== ref.digest) throw new NetError('conflict')
        if (op.state === 'activeNew') {
          this.resume(p.space)
          return this.view(op)
        }
        const archive = this.referenceArchive(p.space)
        try {
          const self = rt.identity.self()!,
            held = rt.db.database
              .prepare(
                'SELECT max(r.epoch) AS epoch FROM net_records r JOIN net_generations g ON g.id=r.generation JOIN net_streams s ON s.id=g.stream WHERE s.space_id=?'
              )
              .get(p.space),
            epoch =
              ref.operation === op.id && ref.target
                ? ref.target.epoch
                : Math.max(op.frozen.epoch, Number(held?.epoch ?? 0)) + 1
          const target = {
            space: p.space,
            owner: owner.user,
            hostNode: self.node,
            hostTransportKey: rt.keys.nodeKeys().transport,
            epoch
          }
          if (ref.operation === op.id && ref.target && json(ref.target) !== json(target))
            throw new NetError('conflict')
          this.save({ ...ref, operation: op.id, target })
          const descriptor = signedDocument(
            {
              ...target,
              v: 1,
              routes: this.options.net.signedRoutes(),
              issuedAt: rt.db.clock.now()
            } satisfies SpaceDescriptor,
            (bytes) => rt.keys.signAsRoot(bytes)
          )
          this.currentArchive = archive
          await this.importer.activate(p.space, descriptor, signal)
          this.resume(p.space)
          return this.view(this.journal.forSpace(p.space)!)
        } finally {
          this.currentArchive = undefined
          archive.close()
        }
      }
      default:
        throw new NetError('bad_request')
    }
  }
  private resume(space: SpaceId): void {
    this.options.spaces.resumeAfterArchive(space)
    this.options.bots.resumeAfterArchive(space)
  }
  private proofFile(directory: string, evidence: Signed): void {
    const path = join(directory, 'retirement.json'),
      bytes = canonicalJson(evidence)
    if (bytes.length > 1024 * 1024) throw new NetError('too_large')
    if (existsSync(path)) {
      if (
        !Buffer.from(this.readProof(directory).payload).equals(Buffer.from(evidence.payload)) ||
        this.readProof(directory).sig !== evidence.sig
      )
        throw new NetError('conflict')
      return
    }
    const temporary = join(directory, `.retirement-${randomUUID()}.tmp`),
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
    try {
      try {
        for (let offset = 0; offset < bytes.length;)
          offset += writeSync(fd, bytes, offset, bytes.length - offset)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // Hard-link publication is atomic and cannot overwrite an existing file.
      linkSync(temporary, path)
    } finally {
      unlinkSync(temporary)
    }
    const folder = openSync(directory, 'r')
    try {
      fsyncSync(folder)
    } finally {
      closeSync(folder)
    }
  }
  private readProof(directory: string): Signed {
    const path = join(directory, 'retirement.json'),
      stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new NetError('bad_request')
    return parseProtocolJson(readFileSync(path)) as Signed
  }
}
