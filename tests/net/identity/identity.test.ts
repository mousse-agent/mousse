import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { encodeMessage } from '../../../src/mms/net/sync/codec'
import { signedDocument } from '../../../src/mms/net/identity/crypto'
import { NetError } from '../../../src/shared/net/errors'
import { newId } from '../../../src/shared/net/ids'
import { NODE_DELEGATION_TTL_MS, PREAUTH_MAX_BYTES } from '../../../src/shared/net/limits'
import type { Roster, NodeDelegation } from '../../../src/shared/net'
import type { Clock } from '../../../src/mms/net/contracts'

const directories: string[] = [],
  databases: DatabaseSync[] = []
function profile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-identity-')))
  directories.push(dir)
  return dir
}
function database(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'net', 'net.db'))
  db.exec('PRAGMA journal_mode=WAL')
  databases.push(db)
  return db
}
function time() {
  let now = 1700000000000
  const clock: Clock = { now: () => now, monotonic: () => now, setTimeout: () => ({ cancel() {} }) }
  return {
    clock,
    advance: (ms: number) => {
      now += ms
    }
  }
}
async function authority() {
  const dir = profile(),
    keys = new FileKeyStore(dir),
    timer = time()
  await keys.initialize({ asAuthority: true })
  const db = database(dir),
    identity = new NetIdentityService({ database: db, keys, clock: timer.clock })
  const roster = await identity.bootstrapAuthority('Authority')
  return { dir, keys, timer, db, identity, roster }
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      /* Already closed by restart scenario. */
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const bytes = Buffer.from('{"signed":"original exact bytes"}')

describe('NetIdentityService durable security foundation', () => {
  it('pins a snapshot root batch atomically and preserves every existing root', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      root = a.keys.rootKey()!,
      foreign = newId('user')
    expect(() =>
      a.identity.pinUsers([
        { user: foreign, rootKey: root },
        { user: self.user, rootKey: a.keys.nodeKeys().agree }
      ])
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(a.identity.pinnedRootKey(foreign)).toBeUndefined()
    expect(() =>
      a.identity.pinUsers([
        { user: foreign, rootKey: root },
        { user: foreign, rootKey: a.keys.nodeKeys().agree }
      ])
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(a.identity.pinnedRootKey(foreign)).toBeUndefined()
    expect(() =>
      a.identity.pinUsers(
        Array.from({ length: 257 }, () => ({ user: newId('user'), rootKey: root }))
      )
    ).toThrow(expect.objectContaining({ code: 'too_large' }))
    const updates: string[] = [],
      prepare = a.db.prepare.bind(a.db)
    const original = a.db.prepare
    a.db.prepare = ((sql: string) => {
      updates.push(sql)
      return prepare(sql)
    }) as typeof a.db.prepare
    try {
      a.identity.pinUsers([
        { user: foreign, rootKey: root },
        { user: self.user, rootKey: root }
      ])
    } finally {
      a.db.prepare = original
    }
    expect(updates.filter((sql) => sql.includes('INSERT INTO net_identity'))).toHaveLength(1)
    a.db.close()
    const reopened = new NetIdentityService({
      database: database(a.dir),
      keys: new FileKeyStore(a.dir),
      clock: a.timer.clock
    })
    expect(reopened.pinnedRootKey(foreign)).toBe(root)
    expect(reopened.pinnedRootKey(self.user)).toBe(root)
  })
  it('boots stable random IDs and verifies exact signatures after keys/database reopen', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      signature = a.keys.signAsNode(bytes)
    expect(self.isAuthority).toBe(true)
    const expected = a.identity.verifyAuthor(
      { user: self.user, node: self.node, keyEpoch: 1 },
      bytes,
      signature,
      a.timer.clock.now(),
      'newWork'
    )
    expect(expected.kind).toBe('node')
    expect(expected.verifyOnly).toBe(false)
    a.db.close()
    const reopened = new NetIdentityService({
      database: database(a.dir),
      keys: new FileKeyStore(a.dir),
      clock: a.timer.clock
    })
    expect(reopened.self()).toEqual(self)
    expect(reopened.roster()).toEqual(a.roster)
    expect(
      reopened.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        bytes,
        signature,
        a.timer.clock.now(),
        'newWork'
      )
    ).toEqual(expected)
    expect(() =>
      reopened.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        Buffer.from('modified'),
        signature,
        a.timer.clock.now(),
        'newWork'
      )
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }))
    expect(() => reopened.pinUser(self.user, new FileKeyStore(a.dir).nodeKeys().agree)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
  })

  it('returns current capability restrictions for new work while preserving original historical delegation', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      root = a.keys.rootKey()!,
      originalAt = a.timer.clock.now()
    const initial = a.identity.verifySigned<Roster>(a.roster, root),
      old = a.identity.verifySigned<NodeDelegation>(initial.nodes[0], root)
    a.timer.advance(1)
    const restricted: NodeDelegation = {
      ...old,
      caps: ['read'],
      issuedAt: a.timer.clock.now(),
      expiresAt: a.timer.clock.now() + NODE_DELEGATION_TTL_MS
    }
    const signed = signedDocument(restricted, (bytes) => a.keys.signAsRoot(bytes))
    a.identity.acceptRoster(
      signedDocument(
        {
          ...initial,
          version: 2,
          nodes: [...initial.nodes, signed],
          issuedAt: a.timer.clock.now()
        },
        (bytes) => a.keys.signAsRoot(bytes)
      ),
      root
    )
    const author = { user: self.user, node: self.node, keyEpoch: 1 },
      signature = a.keys.signAsNode(bytes)
    expect(
      a.identity.verifyAuthor(author, bytes, signature, originalAt, 'history').delegation
    ).toMatchObject({ caps: ['read', 'chat', 'write'] })
    expect(
      a.identity.verifyAuthor(author, bytes, signature, originalAt, 'newWork').delegation
    ).toMatchObject({ caps: ['read'] })
  })

  it('rejects a roster issuance before it exceeds the real bounded normal hello', async () => {
    const a = await authority(),
      root = a.keys.rootKey()!
    let rejected = false
    for (let n = 0; n < 22; n++) {
      const keys = new FileKeyStore(profile())
      await keys.initialize({ asAuthority: false })
      const before = a.identity.roster()!
      try {
        a.identity.issueNodeDelegation({
          node: newId('node'),
          keys: keys.nodeKeys(),
          name: `Peer ${n}`,
          caps: ['read']
        })
      } catch (error) {
        expect(error).toMatchObject({ code: 'too_large' })
        expect(a.identity.roster()).toEqual(before)
        rejected = true
        break
      }
      const signed = a.identity.roster()!,
        roster = a.identity.verifySigned<Roster>(signed, root),
        delegation = roster.nodes.at(-1)!,
        node = a.identity.verifySigned<NodeDelegation>(delegation, root).subject
      expect(
        encodeMessage({
          t: 'hello',
          protoMajor: 1,
          protoMinor: 0,
          caps: ['streams.v1'],
          node,
          delegation,
          roster: signed,
          now: a.timer.clock.now()
        }).byteLength + 16
      ).toBeLessThan(PREAUTH_MAX_BYTES)
    }
    expect(rejected).toBe(true)
  })

  it('never reuses a historical key epoch when a removed node is delegated again', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      root = a.keys.rootKey()!,
      peer = newId('node')
    const oldKeys = new FileKeyStore(profile())
    await oldKeys.initialize({ asAuthority: false })
    a.identity.issueNodeDelegation({
      node: peer,
      keys: oldKeys.nodeKeys(),
      name: 'Original',
      caps: ['read']
    })
    const originalAt = a.timer.clock.now(),
      signature = oldKeys.signAsNode(bytes),
      current = a.identity.verifySigned<Roster>(a.identity.roster()!, root)
    const removed = signedDocument(
      {
        ...current,
        version: current.version + 1,
        nodes: current.nodes.filter(
          (row) => a.identity.verifySigned<NodeDelegation>(row, root).subject !== peer
        )
      },
      (bytes) => a.keys.signAsRoot(bytes)
    )
    a.identity.acceptRoster(removed, root)
    const replacement = new FileKeyStore(profile())
    await replacement.initialize({ asAuthority: false })
    const reissued = a.identity.issueNodeDelegation({
      node: peer,
      keys: replacement.nodeKeys(),
      name: 'Replacement',
      caps: ['read']
    })
    expect(a.identity.verifySigned<NodeDelegation>(reissued, root).keyEpoch).toBe(2)
    expect(
      a.identity.verifyAuthor(
        { user: self.user, node: peer, keyEpoch: 1 },
        bytes,
        signature,
        originalAt,
        'history'
      )
    ).toMatchObject({ verifyOnly: true })
    expect(() =>
      a.identity.verifyAuthor(
        { user: self.user, node: peer, keyEpoch: 1 },
        bytes,
        signature,
        originalAt,
        'newWork'
      )
    ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
  })

  it('retains old-epoch verification while only current delegated keys author new work', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      peer = newId('node')
    const oldKeys = new FileKeyStore(profile())
    await oldKeys.initialize({ asAuthority: false })
    const old = a.identity.issueNodeDelegation({
      node: peer,
      keys: oldKeys.nodeKeys(),
      name: 'Peer',
      caps: ['read']
    })
    const issued = a.identity.verifySigned<NodeDelegation>(old, a.keys.rootKey()!)
    const originalAt = a.timer.clock.now(),
      signature = oldKeys.signAsNode(bytes)
    const newKeys = new FileKeyStore(profile())
    await newKeys.initialize({ asAuthority: false })
    a.timer.advance(10)
    a.identity.issueNodeDelegation({
      node: peer,
      keys: newKeys.nodeKeys(),
      name: 'Rotated peer',
      caps: ['read', 'chat']
    })
    const author = { user: self.user, node: peer, keyEpoch: issued.keyEpoch }
    expect(a.identity.verifyAuthor(author, bytes, signature, originalAt, 'history')).toMatchObject({
      verifyOnly: true,
      revoked: false
    })
    expect(() => a.identity.verifyAuthor(author, bytes, signature, originalAt, 'newWork')).toThrow(
      expect.objectContaining({ code: 'bad_delegation' })
    )
    const current = a.identity.verifyAuthor(
      { ...author, keyEpoch: 2 },
      bytes,
      newKeys.signAsNode(bytes),
      a.timer.clock.now(),
      'newWork'
    )
    expect(current).toMatchObject({ verifyOnly: false, delegation: { caps: ['read', 'chat'] } })
  })

  it('persists revocation, notifies after commit and preserves historical signatures after expiry', async () => {
    const a = await authority(),
      peer = newId('node'),
      keys = new FileKeyStore(profile())
    await keys.initialize({ asAuthority: false })
    const self = a.identity.self()!,
      originalAt = a.timer.clock.now(),
      author = { user: self.user, node: peer, keyEpoch: 1 }
    a.identity.issueNodeDelegation({
      node: peer,
      keys: keys.nodeKeys(),
      name: 'Peer',
      caps: ['read']
    })
    const signature = keys.signAsNode(bytes),
      received: Roster[] = []
    a.identity.onRosterChanged((user) => {
      received.push(a.identity.verifySigned<Roster>(a.identity.roster(user)!, a.keys.rootKey()!))
    })
    a.identity.revoke(peer)
    expect(received.at(-1)?.revoked).toContainEqual({
      subject: peer,
      throughKeyEpoch: 1,
      revokedAt: originalAt
    })
    expect(() => a.identity.verifyAuthor(author, bytes, signature, originalAt, 'newWork')).toThrow(
      expect.objectContaining({ code: 'revoked' })
    )
    a.timer.advance(NODE_DELEGATION_TTL_MS + 1)
    a.db.close()
    const reopened = new NetIdentityService({
      database: database(a.dir),
      keys: new FileKeyStore(a.dir),
      clock: a.timer.clock
    })
    expect(reopened.verifyAuthor(author, bytes, signature, originalAt, 'history')).toMatchObject({
      revoked: true,
      verifyOnly: true
    })
    expect(() =>
      reopened.verifyAuthor(author, bytes, signature, a.timer.clock.now(), 'history')
    ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
  })

  it('detects same-position/lineage conflicts across restarts and clears only with higher recovery epoch', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      root = a.keys.rootKey()!
    const original = a.identity.verifySigned<Roster>(a.roster, root)
    const fork = signedDocument({ ...original, issuedAt: original.issuedAt + 1 }, (input) =>
      a.keys.signAsRoot(input)
    )
    expect(a.identity.acceptRoster(fork, root)).toEqual({ changed: true, state: 'conflict' })
    expect(a.identity.self()?.isAuthority).toBe(false)
    expect(() =>
      a.identity.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        bytes,
        a.keys.signAsNode(bytes),
        a.timer.clock.now(),
        'newWork'
      )
    ).toThrow(expect.objectContaining({ code: 'roster_conflict' }))
    expect(
      a.identity.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        bytes,
        a.keys.signAsNode(bytes),
        a.timer.clock.now(),
        'history'
      )
    ).toMatchObject({ kind: 'node' })
    const higherVersion = signedDocument({ ...original, version: 2 }, (input) =>
      a.keys.signAsRoot(input)
    )
    expect(a.identity.acceptRoster(higherVersion, root)).toEqual({
      changed: false,
      state: 'conflict'
    })
    a.db.close()
    const reopened = new NetIdentityService({
      database: database(a.dir),
      keys: new FileKeyStore(a.dir),
      clock: a.timer.clock
    })
    expect(reopened.rosterState(self.user)).toBe('conflict')
    const recovered = reopened.becomeAuthorityFromRecovery(),
      document = reopened.verifySigned<Roster>(recovered, root)
    expect(document).toMatchObject({ recoveryEpoch: 1, version: 1, authorityNode: self.node })
    expect(document.lineage).not.toBe(original.lineage)
    expect(reopened.rosterState(self.user)).toBe('ok')
    expect(reopened.acceptRoster(fork, root)).toEqual({ changed: false, state: 'ok' })
    expect(reopened.acceptRoster(higherVersion, root)).toEqual({ changed: false, state: 'ok' })
    expect(reopened.self()?.isAuthority).toBe(true)
    expect(reopened.roster()).toEqual(recovered)
    const secondLineage = signedDocument(
      { ...document, lineage: 'different-valid-lineage', version: 2 },
      (input) => a.keys.signAsRoot(input)
    )
    expect(reopened.acceptRoster(secondLineage, root).state).toBe('conflict')
  })

  it('keeps repeated same-key renewals within the preauth hello bound and preserves local history', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      root = a.keys.rootKey()!,
      originalAt = a.timer.clock.now(),
      signature = a.keys.signAsNode(bytes)
    const sizes: number[] = []
    for (let renewal = 1; renewal <= 18; renewal++) {
      a.timer.advance(6 * 86400000)
      const signed = a.identity.renewExpiring()!,
        roster = a.identity.verifySigned<Roster>(signed, root)
      const delegation = roster.nodes.at(-1)!
      sizes.push(
        encodeMessage({
          t: 'hello',
          protoMajor: 1,
          protoMinor: 0,
          caps: ['streams.v1'],
          node: self.node,
          delegation,
          roster: signed,
          now: a.timer.clock.now()
        }).byteLength + 16
      )
    }
    const firstOver = sizes.findIndex((size) => size > PREAUTH_MAX_BYTES)
    expect(
      Math.max(...sizes),
      `hello sizes ${sizes.join(',')}; first over limit at renewal ${firstOver + 1}`
    ).toBeLessThan(PREAUTH_MAX_BYTES)
    expect(a.identity.verifySigned<Roster>(a.identity.roster()!, root).nodes).toHaveLength(1)
    a.db.close()
    const reopened = new NetIdentityService({
      database: database(a.dir),
      keys: new FileKeyStore(a.dir),
      clock: a.timer.clock
    })
    const author = { user: self.user, node: self.node, keyEpoch: 1 }
    expect(reopened.verifyAuthor(author, bytes, signature, originalAt, 'history')).toMatchObject({
      kind: 'node',
      revoked: false
    })
    const subscriberDir = profile(),
      subscriberKeys = new FileKeyStore(subscriberDir)
    await subscriberKeys.initialize({ asAuthority: false })
    const subscriber = new NetIdentityService({
      database: database(subscriberDir),
      keys: subscriberKeys,
      clock: a.timer.clock
    })
    subscriber.pinUser(self.user, root)
    subscriber.acceptRoster(reopened.roster()!, root)
    const current = subscriber.roster(self.user)
    expect(() => subscriber.verifyAuthor(author, bytes, signature, originalAt, 'history')).toThrow(
      expect.objectContaining({ code: 'bad_delegation' })
    )
    const evidence = reopened.historicalRosterFor(author, originalAt)!
    expect(evidence).toEqual(a.roster)
    expect(subscriber.acceptRoster(evidence, root)).toEqual({ changed: false, state: 'ok' })
    expect(subscriber.roster(self.user)).toEqual(current)
    expect(subscriber.verifyAuthor(author, bytes, signature, originalAt, 'history')).toMatchObject({
      kind: 'node',
      revoked: false
    })
    expect(reopened.historicalRosterFor({ ...author, keyEpoch: 999 }, originalAt)).toBeUndefined()
    expect(reopened.historicalRosterFor(author, originalAt - 1)).toBeUndefined()
  })

  it('rechecks local delegated key binding after accepting a roster while locked', async () => {
    const dir = profile(),
      keys = new FileKeyStore(dir, { passphrase: 'unlock phrase' }),
      timer = time()
    await keys.initialize({ asAuthority: true })
    const db = database(dir),
      identity = new NetIdentityService({ database: db, keys, clock: timer.clock })
    const initial = await identity.bootstrapAuthority('Locked authority'),
      self = identity.self()!,
      root = keys.rootKey()!
    const replacement = new FileKeyStore(profile())
    await replacement.initialize({ asAuthority: false })
    const original = identity.verifySigned<Roster>(initial, root)
    const changed: NodeDelegation = {
      ...identity.verifySigned<NodeDelegation>(original.nodes[0], root),
      keyEpoch: 2,
      keys: replacement.nodeKeys()
    }
    const successor = signedDocument(
      {
        ...original,
        version: 2,
        nodes: [...original.nodes, signedDocument(changed, (bytes) => keys.signAsRoot(bytes))]
      },
      (bytes) => keys.signAsRoot(bytes)
    )
    db.close()
    const locked = new FileKeyStore(dir),
      reopened = new NetIdentityService({
        database: database(dir),
        keys: locked,
        clock: timer.clock
      })
    expect(locked.state()).toBe('locked')
    reopened.acceptRoster(successor, root)
    await locked.unlock('unlock phrase')
    expect(reopened.self()?.isAuthority).toBe(false)
    expect(() =>
      reopened.issueNodeDelegation({
        node: newId('node'),
        keys: replacement.nodeKeys(),
        name: 'Blocked',
        caps: ['read']
      })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    const recovered = reopened.becomeAuthorityFromRecovery()
    expect(reopened.self()?.isAuthority).toBe(true)
    expect(reopened.verifySigned<Roster>(recovered, root)).toMatchObject({
      recoveryEpoch: 1,
      authorityNode: self.node
    })
  })

  it('recovery import does not make a follower an authority until explicit recovery promotion', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      dir = profile(),
      keys = new FileKeyStore(dir)
    await keys.initialize({ asAuthority: false })
    const node = newId('node'),
      db = database(dir),
      follower = new NetIdentityService({
        database: db,
        keys,
        clock: a.timer.clock,
        self: { user: self.user, node }
      })
    follower.pinUser(self.user, a.keys.rootKey()!)
    follower.acceptRoster(a.roster, a.keys.rootKey()!)
    const recovery = await a.keys.exportRecovery('root import passphrase')
    await keys.importRecovery(recovery, 'root import passphrase')
    expect(follower.self()?.isAuthority).toBe(false)
    expect(() =>
      follower.issueNodeDelegation({
        node: newId('node'),
        keys: keys.nodeKeys(),
        name: 'unauthorized',
        caps: ['read']
      })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    const recovered = follower.becomeAuthorityFromRecovery()
    expect(follower.self()?.isAuthority).toBe(true)
    expect(follower.verifySigned<Roster>(recovered, a.keys.rootKey()!).recoveryEpoch).toBe(1)
    a.identity.acceptRoster(recovered, a.keys.rootKey()!)
    expect(a.identity.self()?.isAuthority).toBe(false)
    expect(() => a.identity.transferAuthority(node)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
  })

  it('rejects invalid nested delegations and revocation regression without mutating current roster', async () => {
    const a = await authority(),
      peer = newId('node'),
      keys = new FileKeyStore(profile())
    await keys.initialize({ asAuthority: false })
    a.identity.issueNodeDelegation({
      node: peer,
      keys: keys.nodeKeys(),
      name: 'Peer',
      caps: ['read']
    })
    a.identity.revoke(peer)
    const root = a.keys.rootKey()!,
      before = a.identity.roster()!,
      held = a.identity.verifySigned<Roster>(before, root)
    const regressed = signedDocument({ ...held, version: held.version + 1, revoked: [] }, (data) =>
      a.keys.signAsRoot(data)
    )
    expect(() => a.identity.acceptRoster(regressed, root)).toThrow(
      expect.objectContaining({ code: 'bad_delegation' })
    )
    expect(a.identity.roster()).toEqual(before)
    const corrupt = structuredClone(held)
    corrupt.version++
    corrupt.nodes[0].sig = Buffer.alloc(64).toString('base64url')
    expect(() =>
      a.identity.acceptRoster(
        signedDocument(corrupt, (data) => a.keys.signAsRoot(data)),
        root
      )
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }))
    expect(a.identity.roster()).toEqual(before)
  })

  it('restricts bot placement, rejects node signature claiming bot, and refuses unacknowledged active transfer', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      bot = newId('bot'),
      key = a.keys.createBotKey(bot)
    a.identity.issueBotDelegation({ bot, key, name: 'Bot', hostNode: self.node })
    const author = { bot, node: self.node, keyEpoch: 1 }
    expect(
      a.identity.verifyAuthor(
        author,
        bytes,
        a.keys.signAsBot(bot, bytes),
        a.timer.clock.now(),
        'newWork'
      )
    ).toMatchObject({ kind: 'bot', user: self.user, bot })
    expect(() =>
      a.identity.verifyAuthor(
        author,
        bytes,
        a.keys.signAsNode(bytes),
        a.timer.clock.now(),
        'newWork'
      )
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }))
    expect(() =>
      a.identity.verifyAuthor(
        { ...author, node: newId('node') },
        bytes,
        a.keys.signAsBot(bot, bytes),
        a.timer.clock.now(),
        'newWork'
      )
    ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
    const target = newId('node'),
      targetKeys = new FileKeyStore(profile())
    await targetKeys.initialize({ asAuthority: false })
    a.identity.issueNodeDelegation({
      node: target,
      keys: targetKeys.nodeKeys(),
      name: 'Target',
      caps: ['read']
    })
    expect(() =>
      a.identity.issueBotDelegation({ bot, key, name: 'Bot', hostNode: target })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
  })

  it('renews independently of sessions without making old signatures unverifiable', async () => {
    const a = await authority(),
      self = a.identity.self()!,
      originalAt = a.timer.clock.now(),
      signature = a.keys.signAsNode(bytes)
    expect(a.identity.renewExpiring()).toBeUndefined()
    a.timer.advance(NODE_DELEGATION_TTL_MS - 12 * 3600000)
    const renewed = a.identity.renewExpiring()!
    expect(a.identity.verifySigned<Roster>(renewed, a.keys.rootKey()!).version).toBe(2)
    expect(
      a.identity.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        bytes,
        signature,
        originalAt,
        'history'
      ).kind
    ).toBe('node')
    a.timer.advance(24 * 3600000)
    expect(
      a.identity.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: 1 },
        bytes,
        a.keys.signAsNode(bytes),
        a.timer.clock.now(),
        'newWork'
      ).verifyOnly
    ).toBe(false)
  })

  it('does not let an observer error roll back committed identity mutation', async () => {
    const a = await authority(),
      peer = newId('node'),
      keys = new FileKeyStore(profile())
    await keys.initialize({ asAuthority: false })
    a.identity.onRosterChanged(() => {
      throw new NetError('internal', 'observer failure')
    })
    a.identity.issueNodeDelegation({
      node: peer,
      keys: keys.nodeKeys(),
      name: 'Peer',
      caps: ['read']
    })
    expect(a.identity.verifySigned<Roster>(a.identity.roster()!, a.keys.rootKey()!).version).toBe(2)
  })
})

it('refuses bot work after its host node is revoked while retained bot history still verifies', async () => {
  const a = await authority(),
    host = newId('node'),
    keys = new FileKeyStore(profile())
  await keys.initialize({ asAuthority: false })
  a.identity.issueNodeDelegation({
    node: host,
    keys: keys.nodeKeys(),
    name: 'Bot host',
    caps: ['read']
  })
  const bot = newId('bot'),
    key = keys.createBotKey(bot),
    at = a.timer.clock.now()
  a.identity.issueBotDelegation({ bot, key, name: 'Hosted bot', hostNode: host })
  const author = { bot, node: host, keyEpoch: 1 },
    signature = keys.signAsBot(bot, bytes)
  expect(a.identity.verifyAuthor(author, bytes, signature, at, 'newWork').kind).toBe('bot')
  a.identity.revoke(host)
  expect(() => a.identity.verifyAuthor(author, bytes, signature, at, 'newWork')).toThrow(
    expect.objectContaining({ code: 'revoked' })
  )
  expect(a.identity.verifyAuthor(author, bytes, signature, at, 'history').kind).toBe('bot')
})

it('refuses a higher-version roster that reinstates an older signing epoch without revocation', async () => {
  const a = await authority(),
    peer = newId('node'),
    first = new FileKeyStore(profile()),
    second = new FileKeyStore(profile())
  await first.initialize({ asAuthority: false })
  await second.initialize({ asAuthority: false })
  a.identity.issueNodeDelegation({
    node: peer,
    keys: first.nodeKeys(),
    name: 'Peer',
    caps: ['read']
  })
  const old = a.identity.roster()!,
    oldDocument = a.identity.verifySigned<Roster>(old, a.keys.rootKey()!)
  a.identity.issueNodeDelegation({
    node: peer,
    keys: second.nodeKeys(),
    name: 'Peer rotation',
    caps: ['read']
  })
  const before = a.identity.roster()!,
    held = a.identity.verifySigned<Roster>(before, a.keys.rootKey()!)
  const replay = signedDocument({ ...oldDocument, version: held.version + 1 }, (input) =>
    a.keys.signAsRoot(input)
  )
  expect(() => a.identity.acceptRoster(replay, a.keys.rootKey()!)).toThrow(
    expect.objectContaining({ code: 'bad_delegation' })
  )
  expect(a.identity.roster()).toEqual(before)
})

it('rejects cryptographically signed duplicate-key JSON before interpreting its identity fields', async () => {
  const a = await authority(),
    ambiguous = Buffer.from('{"role":"member","role":"owner"}')
  const wrapper = {
    payload: ambiguous.toString('base64url'),
    sig: Buffer.from(a.keys.signAsNode(ambiguous)).toString('base64url')
  }
  expect(() => a.identity.verifySigned(wrapper, a.keys.nodeKeys().sign)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
})
