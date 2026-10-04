import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateSigningKey, signedDocument } from '../../../../src/mms/net/identity/crypto'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { MetaProjection } from '../../../../src/mms/spaces/host'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'
import type { MemberRecord, SpaceDescriptor } from '../../../../src/shared/net'
import { profile, peer, trust, signed, cleanup } from './helpers'
afterEach(cleanup)
const oracle = JSON.parse(
  readFileSync(
    new URL('../../../../test-vectors/net/security/meta-sequences.json', import.meta.url),
    'utf8'
  )
)
describe('signed materialization of frozen meta oracles', () => {
  it('fails before root pin or generation activation when a valid history exceeds the local 256-root activation guard', async () => {
    const source = await profile(),
      replica = await profile(source.clock, 'Replica'),
      space = source.host.create({ name: 'Activation guard' })
    trust(replica, source)
    for (let i = 0; i < 256; i++) {
      source.clock.advance(10001)
      source.host.postMeta(space.space, 'member.joined', {
        member: {
          user: newId('user'),
          rootKey: generateSigningKey().publicKey,
          role: 'member',
          displayName: `Member ${i}`
        }
      })
    }
    const descriptor = source.store.getStream(space.meta)!,
      target = source.store.head(space.meta),
      reader = source.store.openSnapshot(space.meta)
    replica.store.createStream(descriptor, 1)
    const stage = replica.store.beginSnapshot(space.meta, target)
    try {
      for (;;) {
        const page = reader.next(1024 * 1024, 64)
        stage.append(page.records)
        if (page.done) break
      }
    } finally {
      reader.close()
    }
    expect(() => stage.commit()).toThrow(expect.objectContaining({ code: 'too_large' }))
    expect(replica.store.cursor(space.meta).seq).toBe(0)
    expect(replica.projection.state(space.space)).toBeUndefined()
    stage.abort()
  })
  it('retains original descriptor verification after the host renews its delegation at the same key epoch', async () => {
    const source = await profile(),
      replica = await profile(source.clock, 'Replica'),
      space = source.host.create({ name: 'Original history' })
    trust(replica, source)
    source.clock.advance(6 * 86400000 + 1)
    source.identity.renewExpiring()
    trust(replica, source)
    const descriptor = source.store.getStream(space.meta)!,
      reader = source.store.openSnapshot(space.meta),
      target = source.store.head(space.meta)
    replica.store.createStream(descriptor, 1)
    const stage = replica.store.beginSnapshot(space.meta, target)
    try {
      stage.append(reader.next(1024 * 1024, 64).records)
    } finally {
      reader.close()
    }
    stage.commit()
    expect(replica.projection.state(space.space)?.settings.name).toBe('Original history')
  })
  it('matches every role/bot/channel/freeze/epoch oracle with real signed bytes and accounts invalid positions', async () => {
    const a = await profile(),
      admin = await profile(a.clock, 'Admin'),
      member = await profile(a.clock, 'Member'),
      outsider = await profile(a.clock, 'Other'),
      nextHost = await profile(a.clock, 'Next host'),
      space = a.host.create({ name: 'fixture-space' })
    const users: any = {
      [oracle.ids.owner]: a,
      [oracle.ids.admin]: admin,
      [oracle.ids.member]: member,
      [oracle.ids.joiner]: outsider
    }
    // The fixture ids define semantic principals, independently generated real
    // profiles provide their cryptographic evidence.
    const initialKeys = Object.keys(oracle.sequences[0].steps[0].expected.projection.members)
    users[initialKeys[0]] = a
    const expectedUsers = [
      ...new Set(
        oracle.sequences[0].steps.flatMap((step: any) =>
          Object.keys(step.expected.projection.members)
        )
      )
    ]
    users[expectedUsers[0] as string] = a
    users[expectedUsers[1] as string] = admin
    users[expectedUsers[2] as string] = member
    const outsiderFixture = oracle.sequences[0].steps.find(
      (s: any) => s.id === 'cannot-create-second-owner'
    ).record.body.user
    users[outsiderFixture] = outsider
    for (const p of [admin, member, outsider]) trust(a, p)
    const bot = newId('bot'),
      botKey = member.keys.createBotKey(bot),
      botDelegation = member.identity.issueBotDelegation({
        bot,
        key: botKey,
        name: 'Bot',
        hostNode: peer(member).node
      })
    trust(a, member)
    const channel = newId('stream')
    a.store.createStream(
      {
        id: channel,
        kind: 'space.channel',
        space: space.space,
        authority: peer(a).node,
        createdAt: a.clock.now()
      },
      1
    )
    const nextDelegation = a.identity.issueNodeDelegation({
      node: peer(nextHost).node,
      keys: nextHost.keys.nodeKeys(),
      name: 'New host',
      caps: ['read', 'chat', 'write']
    })
    for (const step of oracle.sequences[0].steps.slice(1)) {
      const r = step.record,
        p = users[r.author],
        before = a.projection.position(space.space)!,
        metaAuth = { metaEpoch: before.epoch, metaSeq: before.seq }
      let body: any
      switch (r.type) {
        case 'member.joined': {
          const target = users[r.body.user]
          body = {
            member: {
              user: peer(target).user,
              rootKey: target.keys.rootKey()!,
              role: r.body.role,
              displayName: peer(target).delegation.name
            }
          }
          break
        }
        case 'member.roleChanged':
          body = { user: peer(users[r.body.user]).user, role: r.body.role }
          break
        case 'member.removed':
        case 'member.left':
          body = { user: peer(users[r.body.user]).user }
          break
        case 'bot.added':
          body = {
            record: {
              bot,
              owner: peer(member).user,
              delegation: botDelegation,
              displayName: 'Bot',
              profile: r.body.profile,
              policy: { visibility: 'public', steer: { kind: r.body.steer } }
            }
          }
          break
        case 'bot.policyChanged':
          body = {
            bot,
            profile: r.body.profile,
            policy: { visibility: 'public', steer: { kind: r.body.steer } }
          }
          break
        case 'bot.removed':
          body = { bot }
          break
        case 'channel.created':
        case 'channel.renamed':
          body = { stream: channel, name: r.body.name }
          break
        case 'channel.archived':
          body = { stream: channel }
          break
        case 'settings.changed':
          body = { settings: r.body }
          break
        case 'space.descriptor':
          body = {
            descriptor: signedDocument(
              {
                v: 1,
                space: space.space,
                owner: peer(a).user,
                hostNode: peer(nextHost).node,
                hostTransportKey: nextHost.keys.nodeKeys().transport,
                routes: nextHost.routes(),
                epoch: 2,
                issuedAt: a.clock.now()
              } satisfies SpaceDescriptor,
              (b) => a.keys.signAsRoot(b)
            )
          }
          break
        default:
          body = r.body
      }
      const input = signed(p, space.meta, r.type, body, metaAuth),
        record = { ...input, epoch: r.epoch, seq: r.seq }
      if (step.expected.hostDecision === 'allow') a.projection.validate(space.space, record)
      else
        expect(() => a.projection.validate(space.space, record), step.id).toThrow(
          expect.objectContaining({ code: step.expected.code })
        )
      const result = a.projection.apply(space.space, record),
        state = a.projection.state(space.space)!
      expect(state.applied, step.id).toEqual({ epoch: r.epoch, seq: r.seq })
      expect(!!result.violation, step.id).toBe(step.expected.violation)
      expect(state.frozen, step.id).toBe(step.expected.projection.frozen)
      expect(state.settings, step.id).toEqual(step.expected.projection.settings)
      expect([...state.members.keys()].sort(), step.id).toEqual(
        Object.keys(step.expected.projection.members)
          .map((id) => peer(users[id]).user)
          .sort()
      )
      for (const [id, m] of Object.entries(step.expected.projection.members) as any)
        expect(state.members.get(peer(users[id]).user)?.role, step.id).toBe(m.role)
      expect(state.bots.size, step.id).toBe(Object.keys(step.expected.projection.bots).length)
      expect(state.channels.size, step.id).toBe(
        Object.keys(step.expected.projection.channels).length
      )
    }
    expect(a.projection.violations(space.space)).toHaveLength(
      oracle.sequences[0].steps.filter((s: any) => s.expected.violation).length
    )
    expect(nextDelegation).toHaveProperty('payload')
  })
  it('stages complete signed history incrementally with constant bounded carry and atomic activation; rejects incomplete/unknown snapshots', async () => {
    const source = await profile(),
      replica = await profile(source.clock, 'Replica'),
      space = source.host.create({ name: 'Snapshot' })
    trust(replica, source)
    for (let i = 0; i < 75; i++) {
      source.clock.advance(10001)
      source.host.postMeta(space.space, 'settings.changed', { settings: { name: `Snapshot ${i}` } })
    }
    const descriptor = source.store.getStream(space.meta)!,
      target = source.store.head(space.meta)
    replica.store.createStream(descriptor, 1)
    const stage = replica.store.beginSnapshot(space.meta, target),
      reader = source.store.openSnapshot(space.meta)
    try {
      for (;;) {
        const page = reader.next(1024 * 1024, 32)
        stage.append(page.records)
        expect(replica.projection.state(space.space)).toBeUndefined()
        if (page.done) break
      }
    } finally {
      reader.close()
    }
    const carries = replica.db.database.prepare('SELECT progress FROM net_snapshot_progress').all()
    expect(Buffer.byteLength(carries[0].progress as string)).toBeLessThan(1024)
    stage.commit()
    expect(replica.projection.state(space.space)?.settings.name).toBe('Snapshot 74')
    expect(replica.store.cursor(space.meta)).toMatchObject(target)
    const before = replica.projection.state(space.space),
      empty = replica.store.beginSnapshot(space.meta, { epoch: 1, seq: 77 })
    expect(() => empty.commit()).toThrow()
    empty.abort()
    expect(replica.projection.state(space.space)).toEqual(before)
    const unknown = signed(
        source,
        space.meta,
        'member.futureRestriction',
        {},
        { metaEpoch: 1, metaSeq: 76 }
      ),
      outcome = source.store.appendAsAuthority(space.meta, unknown)
    const bad = replica.store.beginSnapshot(space.meta, { epoch: 1, seq: 77 }),
      full = source.store.openSnapshot(space.meta)
    try {
      let blocked = false
      for (;;) {
        const page = full.next(1024 * 1024, 32)
        try {
          bad.append(page.records)
        } catch (error) {
          expect(error).toMatchObject({ code: 'upgrade_required' })
          blocked = true
          break
        }
        if (page.done) break
      }
      expect(blocked).toBe(true)
    } finally {
      full.close()
      bad.abort()
    }
    expect(replica.projection.state(space.space)).toEqual(before)
    expect(outcome.seq).toBe(77)
  })
  it('bad signatures block progress while validly signed unauthorized records only add a durable violation', async () => {
    const a = await profile(),
      b = await profile(a.clock, 'Member'),
      space = a.host.create({ name: 'Shared' })
    trust(a, b)
    const unauthorized = signed(
      b,
      space.meta,
      'settings.changed',
      { settings: { name: 'stolen' } },
      { metaEpoch: 1, metaSeq: 1 }
    )
    a.projection.apply(space.space, { ...unauthorized, epoch: 1, seq: 2 })
    expect(a.projection.position(space.space)).toMatchObject({ seq: 2, status: 'active' })
    expect(a.projection.state(space.space)?.settings.name).toBe('Shared')
    const invalid = signed(
      a,
      space.meta,
      'settings.changed',
      { settings: { name: 'wrong' } },
      { metaEpoch: 1, metaSeq: 2 }
    )
    invalid.sig[0] ^= 1
    a.projection.apply(space.space, { ...invalid, epoch: 1, seq: 3 })
    expect(a.projection.position(space.space)).toMatchObject({ seq: 2, status: 'blocked' })
    expect(a.host.canRead(space.meta, peer(a))).toBe(false)
  })
  it('authenticates a fresh unpinned admin from prior staged membership and activates every root only with the complete snapshot', async () => {
    const source = await profile(),
      admin = await profile(source.clock, 'Admin'),
      replica = await profile(source.clock, 'Replica'),
      space = source.host.create({ name: 'Fresh snapshot' })
    trust(source, admin)
    trust(replica, source)
    source.host.postMeta(space.space, 'member.joined', {
      member: {
        user: peer(admin).user,
        rootKey: admin.keys.rootKey()!,
        role: 'admin',
        displayName: 'Admin'
      }
    })
    const record = signed(
      admin,
      space.meta,
      'settings.changed',
      { settings: { name: 'Admin signed' } },
      { metaEpoch: 1, metaSeq: 2 }
    )
    source.host.append(space.meta, record.id, record.envelope, record.sig, peer(admin))
    let projection: MetaProjection
    const store = new SqliteStreamStore(replica.db, {
      maxRecordsPerAppend: 64,
      append: (...args) => projection.append(...args),
      finish: (...args) => projection.finish(...args)
    })
    projection = new MetaProjection({
      db: replica.db,
      identity: replica.identity,
      store,
      historyRoster: (author, _at, root) =>
        author.user === peer(admin).user && root === admin.keys.rootKey()
          ? admin.identity.roster()
          : undefined,
      activatePins: (roots) => replica.identity.pinUsers(roots)
    })
    const descriptor = source.store.getStream(space.meta)!,
      reader = source.store.openSnapshot(space.meta),
      target = source.store.head(space.meta)
    replica.store.createStream(descriptor, 1)
    const stage = store.beginSnapshot(space.meta, target)
    try {
      for (;;) {
        const page = reader.next(1024 * 1024, 1)
        stage.append(page.records)
        expect(replica.identity.pinnedRootKey(peer(admin).user)).toBeUndefined()
        if (page.done) break
      }
    } finally {
      reader.close()
    }
    expect(projection.state(space.space)).toBeUndefined()
    stage.commit()
    expect(store.cursor(space.meta)).toMatchObject(target)
    expect(replica.identity.pinnedRootKey(peer(admin).user)).toBe(admin.keys.rootKey())
    expect(projection.state(space.space)?.settings.name).toBe('Admin signed')
  })
})
