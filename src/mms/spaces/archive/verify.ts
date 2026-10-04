import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetError, isCritical, isKnownEventType } from '../../../shared/net'
import type { ArchiveManifest, VerifiedSpaceArchive } from './contracts'
import type {
  Envelope,
  MemberRecord,
  NodeDelegation,
  Roster,
  Signed,
  StoredRecord,
  StreamDescriptor,
  UserId
} from '../../../shared/net'
import { decodeBase64, verifyDocument } from '../../net/identity/crypto'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import { NetDatabase, json } from '../../net/store/database'
import { SqliteStreamStore } from '../../net/store/streams'
import { SqliteOutbox } from '../../net/store/outbox'
import { FileKeyStore, NetIdentityService } from '../../net/identity'
import type { PrivateStreamKeys, StreamStore } from '../../net/contracts'
import { MetaProjection } from '../host/meta'
import { PrivateSpaceService } from '../private/service'
import { openSpaceArchive } from './container'
import { ArchiveHistoryPlacement } from './history'
import { ArchiveBotReceiptVerifier } from './BotReceiptVerifier'
import type { PrivateState } from '../private'

export interface ArchiveVerificationOptions {
  /** Explicit operator/current owner trust, never inferred from the archive. */
  owner: { user: UserId; rootKey: string }
  /** Optional additional denial policy after mandatory isolated receipt proof. */
  verifyBotRecord?(
    record: StoredRecord,
    descriptor: StreamDescriptor,
    meta: MetaProjection,
    privateControl?: PrivateState
  ): void
}
export function verifyArchiveAuthorization(
  manifest: ArchiveManifest,
  signed: Signed,
  rosters: Iterable<Signed>,
  owner: ArchiveVerificationOptions['owner']
): void {
  if (manifest.owner.user !== owner.user || manifest.owner.rootKey !== owner.rootKey)
    throw new NetError('forbidden')
  let valid = false
  for (const evidence of rosters) {
    const raw = JSON.parse(decodeBase64(evidence.payload).toString()) as Roster
    if (raw.owner !== owner.user || raw.rootKey !== owner.rootKey) continue
    const roster = verifyDocument<Roster>(evidence, owner.rootKey, 'roster')
    for (const row of roster.nodes) {
      const node = verifyDocument<NodeDelegation>(row, owner.rootKey, 'nodeDelegation')
      if (
        node.subject !== manifest.exporter ||
        node.owner !== owner.user ||
        node.issuedAt > manifest.exportedAt ||
        manifest.exportedAt >= node.expiresAt
      )
        continue
      if (
        roster.revoked.some(
          (r) =>
            r.subject === node.subject &&
            r.throughKeyEpoch >= node.keyEpoch &&
            r.revokedAt <= manifest.exportedAt
        )
      )
        continue
      const payload = verifyDocument<ArchiveManifest>(signed, node.keys.sign)
      if (json(payload) !== json(manifest)) throw new NetError('bad_signature')
      valid = true
    }
  }
  if (!valid) throw new NetError('bad_delegation')
}

/** Replay into an isolated real ledger. No destination pins, private key adoption,
 * execution replay or provider credentials are used to establish archive validity. */
export function verifyArchiveHistory(
  archive: VerifiedSpaceArchive,
  options: ArchiveVerificationOptions
): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-space-archive-verify-')))
  const db = new NetDatabase({ profileDir: directory }),
    keys = new FileKeyStore(directory)
  const identity = new NetIdentityService({
    database: db.database,
    keys,
    clock: db.clock,
    coordinator: db
  })
  const store = new SqliteStreamStore(db)
  try {
    const evidence: Array<{ signed: Signed; roster: Roster }> = []
    for (const signed of archive.rosters()) {
      const raw = JSON.parse(decodeBase64(signed.payload).toString()) as Roster
      const roster = verifyDocument<Roster>(signed, raw.rootKey, 'roster')
      identity.pinUser(roster.owner, roster.rootKey)
      identity.acceptRoster(signed, roster.rootKey)
      evidence.push({ signed, roster })
    }
    if (identity.pinnedRootKey(options.owner.user) !== options.owner.rootKey)
      throw new NetError('forbidden')
    const placement = new ArchiveHistoryPlacement(archive)
    const streams = [...archive.streams()],
      metaStream = streams.find((s) => s.descriptor.kind === 'space.meta')!
    const meta = new MetaProjection({ db, identity, store }),
      receipts = new ArchiveBotReceiptVerifier({ db, identity, store, meta, placement })
    const deniedKeys = new Proxy({} as PrivateStreamKeys, {
      get: () => () => {
        throw new NetError('forbidden', 'Archive validation cannot adopt or use private keys.')
      }
    })
    let validatingControl: NonNullable<Envelope<'participants.changed'>['body']> | undefined
    const privateService = new PrivateSpaceService({
      db,
      identity,
      keys,
      privateKeys: deniedKeys,
      store,
      meta,
      botAt: (...args) => meta.botAt(...args),
      outbox: new SqliteOutbox(db),
      rosterAt: (_space, user, at, root) => {
        const values = evidence.filter(
          (e) => e.roster.owner === user && e.roster.rootKey === root && e.roster.issuedAt <= at
        )
        const owned = new Set(
          values.flatMap((e) =>
            e.roster.nodes.map(
              (row) => verifyDocument<NodeDelegation>(row, root, 'nodeDelegation').subject
            )
          )
        )
        const expected = validatingControl?.wrapped.filter((w) => owned.has(w.node))
        return values
          .sort(
            (a, b) =>
              b.roster.issuedAt - a.roster.issuedAt ||
              b.roster.recoveryEpoch - a.roster.recoveryEpoch ||
              b.roster.version - a.roster.version
          )
          .find((e) => {
            const latest = new Map<string, NodeDelegation>()
            for (const row of e.roster.nodes) {
              const node = verifyDocument<NodeDelegation>(row, root, 'nodeDelegation'),
                before = latest.get(node.subject)
              if (
                !before ||
                node.keyEpoch > before.keyEpoch ||
                (node.keyEpoch === before.keyEpoch && node.issuedAt > before.issuedAt)
              )
                latest.set(node.subject, node)
            }
            const eligible = [...latest.values()].filter(
              (node) =>
                node.issuedAt <= at &&
                at < node.expiresAt &&
                !e.roster.revoked.some(
                  (r) =>
                    r.subject === node.subject &&
                    r.throughKeyEpoch >= node.keyEpoch &&
                    r.revokedAt <= at
                )
            )
            return (
              !expected ||
              (eligible.length === expected.length &&
                eligible.every((node) =>
                  expected.some(
                    (w) => w.node === node.subject && w.recipientAgreementKey === node.keys.agree
                  )
                ))
            )
          })?.signed
      },
      verifyBotRecord: () => {
        // Deferred only within this isolated first pass. Mandatory complete
        // receipt verification below runs before this archive can become valid.
      }
    })
    db.database.exec(
      'CREATE TABLE archive_validation_content(stream TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,meta_epoch INTEGER NOT NULL,meta_seq INTEGER NOT NULL,PRIMARY KEY(stream,epoch,seq)) STRICT; CREATE INDEX archive_validation_position ON archive_validation_content(epoch,stream,seq)'
    )
    let contentCount = 0,
      checked = 0
    for (const s of streams) {
      store.createStream(s.descriptor, s.head.epoch)
      const gen = db.database
        .prepare('SELECT active_generation FROM net_streams WHERE id=?')
        .get(s.descriptor.id)!.active_generation!
      for (const r of archive.records(s.descriptor.id)) {
        const e = decodeEnvelope(r.envelope).envelope
        if (e.stream !== s.descriptor.id || !e.auth || r.sig.length !== 64)
          throw new NetError('bad_request')
        identity.verifyAuthor(e.author, r.envelope, r.sig, r.recvTs, 'history')
        receipts.index(r, s.descriptor)
        db.transaction(() => {
          db.charge(1, r.envelope.length + r.sig.length)
          db.database
            .prepare('INSERT INTO net_records VALUES(?,?,?,?,?,?,?)')
            .run(gen, r.epoch, r.seq, e.id, r.recvTs, r.envelope, r.sig)
          if (s.descriptor.kind !== 'space.meta') {
            db.charge(1)
            db.database
              .prepare('INSERT INTO archive_validation_content VALUES(?,?,?,?,?)')
              .run(s.descriptor.id, r.epoch, r.seq, e.auth!.metaEpoch, e.auth!.metaSeq)
            contentCount++
          }
        })
      }
      db.transaction(() => {
        db.charge(1)
        db.database
          .prepare('UPDATE net_streams SET head=?,cursor=?,retained=? WHERE id=?')
          .run(s.head.seq, s.head.seq, s.retained, s.descriptor.id)
      })
    }
    const privateCarry = new Map<string, unknown>(),
      chain: Signed[] = []
    let epoch: number | undefined, frozenAt: number | undefined
    const content = () => {
      if (epoch === undefined) return
      // Authored cached meta positions need not be monotonic across writers.
      // Preserve the original stream sequence and validate against the complete
      // signed history of this authority epoch before moving to the next epoch.
      for (const position of db.database
        .prepare('SELECT * FROM archive_validation_content WHERE epoch=? ORDER BY stream,seq')
        .iterate(epoch)) {
        const stream = streams.find((s) => s.descriptor.id === position.stream)!,
          gen = db.database
            .prepare('SELECT active_generation FROM net_streams WHERE id=?')
            .get(position.stream!)!.active_generation!
        const row = db.database
          .prepare('SELECT * FROM net_records WHERE generation=? AND epoch=? AND seq=?')
          .get(gen, position.epoch!, position.seq!)!
        const r: StoredRecord = {
            epoch: Number(row.epoch),
            seq: Number(row.seq),
            recvTs: Number(row.recv_ts),
            envelope: new Uint8Array(row.envelope as Uint8Array),
            sig: new Uint8Array(row.sig as Uint8Array)
          },
          e = decodeEnvelope(r.envelope).envelope
        if (
          !e.auth ||
          e.auth.metaEpoch !== epoch ||
          e.auth.metaSeq > meta.position(archive.manifest.space)!.seq ||
          (frozenAt !== undefined && e.auth.metaSeq >= frozenAt)
        )
          throw new NetError('forbidden')
        if (isCritical(e, false) && (!isKnownEventType(e.type) || e.minor > 0))
          throw new NetError('upgrade_required')
        if (stream.descriptor.kind === 'space.private') {
          const historical = placement.descriptor(stream.descriptor, r.epoch),
            priorStore = privateService.options.store
          privateService.options.store = placement.store(store, r.epoch)
          try {
            validatingControl =
              e.type === 'participants.changed'
                ? (e.body as NonNullable<Envelope<'participants.changed'>['body']>)
                : undefined
            if (r.epoch === 1 && r.seq === 1) {
              const parent =
                stream.descriptor.parent &&
                streams.find((s) => s.descriptor.id === stream.descriptor.parent)
              if (!parent) throw new NetError('forbidden')
              const rows = db.database
                .prepare(
                  "SELECT r.* FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? AND json_extract(CAST(r.envelope AS TEXT),'$.type')='thread.opened' AND json_extract(CAST(r.envelope AS TEXT),'$.body.stream')=? LIMIT 2"
                )
                .all(parent.descriptor.id, stream.descriptor.id)
              if (rows.length !== 1) throw new NetError('forbidden')
              const row = rows[0],
                opening: StoredRecord = {
                  epoch: Number(row.epoch),
                  seq: Number(row.seq),
                  recvTs: Number(row.recv_ts),
                  envelope: new Uint8Array(row.envelope as Uint8Array),
                  sig: new Uint8Array(row.sig as Uint8Array)
                }
              const original = privateService.options.store
              privateService.options.store = new Proxy(original, {
                get: (target, name: keyof StreamStore) => {
                  if (name === 'getStream')
                    return (id: string) =>
                      id === stream.descriptor.id
                        ? undefined
                        : target.getStream(id as StreamDescriptor['id'])
                  const value = target[name]
                  return typeof value === 'function' ? value.bind(target) : value
                }
              })
              try {
                privateService.validateCreation(
                  { descriptor: historical, controllerEvent: r, parentOpenEvent: opening },
                  'history'
                )
              } finally {
                privateService.options.store = original
              }
            }
            const key = stream.descriptor.id
            db.transaction(() => {
              privateCarry.set(
                key,
                privateService.appendArchiveHistory(
                  [r],
                  historical,
                  { epoch: r.epoch, seq: stream.head.seq },
                  privateCarry.get(key)
                )
              )
              if (e.type === 'participants.changed') receipts.retainControl(r, historical)
            })
          } finally {
            privateService.options.store = priorStore
          }
        } else if (e.author.bot) {
          // Signed receipt identity is indexed already; exact actor/trigger/audience
          // proof must settle in the mandatory second pass below.
        } else {
          const member =
            e.author.user && meta.memberAt(archive.manifest.space, e.author.user, e.auth!)
          if (!member) throw new NetError('forbidden')
          if (
            stream.descriptor.kind === 'space.channel' &&
            !meta.channel(archive.manifest.space, stream.descriptor.id)
          )
            throw new NetError('forbidden')
          if (e.type === 'message.edited' || e.type === 'message.deleted') {
            const original = e.refs?.subject && store.getById(stream.descriptor.id, e.refs.subject)
            if (
              !original ||
              (decodeEnvelope(original.envelope).envelope.author.user !== e.author.user &&
                !['owner', 'admin'].includes((member as MemberRecord).role))
            )
              throw new NetError('forbidden')
          }
        }
        checked++
      }
    }
    for (const record of archive.records(metaStream.descriptor.id)) {
      if (epoch !== undefined && record.epoch !== epoch) {
        content()
        frozenAt = undefined
      }
      epoch = record.epoch
      const envelope = decodeEnvelope(record.envelope).envelope
      const prior = meta.options.store
      meta.options.store = placement.store(store, record.epoch)
      try {
        meta.applyRecord(
          placement.descriptor(metaStream.descriptor, record.epoch),
          record,
          'history'
        )
      } finally {
        meta.options.store = prior
      }
      if (
        meta.violations(archive.manifest.space).length ||
        !['active', 'frozen'].includes(meta.position(archive.manifest.space)?.status ?? '')
      )
        throw new NetError('forbidden', 'Archive meta history did not replay without violations.')
      if (['space.created', 'space.descriptor'].includes(envelope.type))
        chain.push((envelope.body as { descriptor: Signed }).descriptor)
      if (envelope.type === 'space.frozen' && frozenAt === undefined) frozenAt = record.seq
    }
    content()
    for (const stream of streams.filter((s) => s.descriptor.kind === 'space.private'))
      db.transaction(() =>
        privateService.appendArchiveHistory(
          [],
          stream.descriptor,
          stream.head,
          privateCarry.get(stream.descriptor.id)
        )
      )
    receipts.verifyAll((record, descriptor, control) =>
      options.verifyBotRecord?.(record, descriptor, meta, control)
    )
    const state = meta.position(archive.manifest.space)
    if (
      checked !== contentCount ||
      state?.status !== 'frozen' ||
      state.owner !== options.owner.user ||
      state.epoch !== archive.manifest.frozen.epoch ||
      state.seq !== archive.manifest.frozen.seq ||
      json(chain) !== json(archive.manifest.descriptors)
    )
      throw new NetError('forbidden')
    const last = JSON.parse(decodeBase64(state.descriptor!.payload).toString())
    if (last.hostNode !== archive.manifest.exporter) throw new NetError('forbidden')
    const generation = db.database
      .prepare('SELECT generation FROM net_space_meta_active WHERE space_id=?')
      .get(archive.manifest.space)!.generation!
    const members = new Set(
      db.database
        .prepare(
          'SELECT DISTINCT user FROM net_space_meta_roles WHERE generation=? AND value IS NOT NULL'
        )
        .all(generation)
        .map((row) => row.user)
    )
    for (const signed of archive.rosters())
      if (!members.has((JSON.parse(decodeBase64(signed.payload).toString()) as Roster).owner))
        throw new NetError(
          'forbidden',
          'Archive includes roster evidence outside the authenticated Space membership history.'
        )
  } finally {
    store.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

export function readVerifiedSpaceArchive(
  directory: string,
  options: ArchiveVerificationOptions
): VerifiedSpaceArchive {
  // Container structural checks precede every cryptographic replay callback.
  let authorization: { manifest: ArchiveManifest; signed: Signed } | undefined
  return openSpaceArchive(directory, {
    authorization: (manifest, signed) => {
      authorization = { manifest, signed }
    },
    history: (archive) => {
      verifyArchiveAuthorization(
        authorization!.manifest,
        authorization!.signed,
        archive.rosters(),
        options.owner
      )
      verifyArchiveHistory(archive, options)
    }
  })
}
