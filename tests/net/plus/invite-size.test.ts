import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { EnrollmentService } from '../../../src/mms/net/enrollment'
import { encodeMessage } from '../../../src/mms/net/sync/codec'
import { SEALED_INVITE_MAX_BYTES, sealInviteForRequest } from '../../../src/mms/net/plus/enrollmentSeal'
import { FakeClock } from '../harness/FakeClock'
import {
  ENROLLMENT_JOINER_MAX_BYTES,
  NET_PROTO_MAJOR,
  NET_PROTO_MINOR,
  PREAUTH_MAX_BYTES,
  SESSION_CAPABILITIES,
  newId,
  type NodeDelegation,
  type NodeId,
  type Roster,
  type RoutesRecord,
  type Signed
} from '../../../src/shared/net'

/** What Mousse ID and phones accepted before the sealed-invite limit was raised. */
const LEGACY_SEALED_INVITE_MAX_BYTES = 16 * 1024
const RELAY = 'wss://id.mousse.example/v1/net/relay'
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function deviceKeys() {
  const raw = (pair: { publicKey: { export(o: object): Buffer } }) =>
    pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  return {
    sign: raw(generateKeyPairSync('ed25519')),
    agree: raw(generateKeyPairSync('x25519')),
    transport: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url')
  }
}
const boxPublicKey = () =>
  generateKeyPairSync('x25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url')

async function computer() {
  const directory = await mkdtemp(join(tmpdir(), 'mousse-invite-size-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const clock = new FakeClock(),
    db = new NetDatabase({ profileDir: directory, clock })
  cleanup.push(() => db.close())
  const keys = new FileKeyStore(directory, { passphrase: 'invite-size-secret' })
  await keys.initialize({ asAuthority: true })
  const identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db })
  await identity.bootstrapAuthority("Aeon's ThinkPad X1 Carbon")
  const self = identity.self()!
  const routes = () =>
    identity.signAsNode({
      v: 1,
      node: self.node,
      version: 1,
      issuedAt: clock.now(),
      routes: [{ transport: 'plus-relay', address: `${RELAY}?node=${self.node}`, priority: 30 }]
    } satisfies RoutesRecord)
  const service = new EnrollmentService({ db, keys, identity, clock, routes })
  const addPhone = (name = 'Agimobile'): NodeId => {
    const node = newId('node')
    identity.issueNodeDelegation({ node, keys: deviceKeys(), name, caps: ['read', 'chat', 'write'] })
    return node
  }
  const claims = (): Roster => identity.verifySigned<Roster>(identity.roster()!, keys.rootKey()!)
  return { identity, keys, service, clock, self, addPhone, claims }
}
type Computer = Awaited<ReturnType<typeof computer>>

/** Sealed size of a phone invite, without the desktop guard so sizes past it can be read. */
async function sealedInviteBytes(c: Computer): Promise<number> {
  const invite = await c.service.issueNodeInviteWithRendezvous(
    { name: 'CPH2585', joinerTransportFingerprint: randomBytes(32).toString('base64url') },
    async (expiresAt) => ({
      transport: 'plus-relay',
      relay: RELAY,
      ticket: randomBytes(32).toString('base64url'),
      expiresAt
    })
  )
  const text = Buffer.byteLength(invite.text)
  // base64url(ephemeral key 32 + nonce 12 + ciphertext + tag 16), unpadded.
  const sealed = Math.ceil(((32 + 12 + text + 16) * 4) / 3)
  if (sealed <= SEALED_INVITE_MAX_BYTES)
    expect(Buffer.byteLength(sealInviteForRequest(invite.text, boxPublicKey(), 'req_size'))).toBe(
      sealed
    )
  return sealed
}
/** Bytes a joiner receives during enrollment: the authority hello, its ack and the result. */
function enrollmentBytes(c: Computer, joined: Signed): number {
  const ack = encodeMessage({ t: 'helloAck', protoMinor: 0, caps: ['enroll.v1'], now: 0 })
  return (
    encodeMessage(c.service.authorityHello()).byteLength +
    ack.byteLength +
    encodeMessage({ t: 'enroll.result', delegation: joined, roster: c.identity.roster()! })
      .byteLength +
    3 * 16
  )
}
function helloBytes(c: Computer): number {
  const roster = c.identity.roster()!,
    claims = c.claims()
  const delegation = claims.nodes.find(
    (row) => c.identity.verifySigned<NodeDelegation>(row, claims.rootKey).subject === c.self.node
  )!
  return encodeMessage({
    t: 'hello',
    protoMajor: NET_PROTO_MAJOR,
    protoMinor: NET_PROTO_MINOR,
    caps: [...SESSION_CAPABILITIES],
    node: c.self.node,
    delegation,
    roster,
    now: c.clock.now()
  }).byteLength
}

describe('enrollment invite size against the roster', () => {
  it('fits every roster a hello can carry, though 16 KiB fit only four devices', async () => {
    const c = await computer(),
      rows: Array<{ devices: number; sealed: number; enrollment: number; hello: number }> = []
    for (;;) {
      const devices = c.claims().nodes.length,
        sealed = await sealedInviteBytes(c),
        hello = helloBytes(c)
      let joined: Signed
      try {
        joined = c.identity.issueNodeDelegation({
          node: newId('node'),
          keys: deviceKeys(),
          name: 'CPH2585',
          caps: ['read', 'chat', 'write']
        })
      } catch (error) {
        // The authority refuses a roster that the bounded hello cannot carry.
        expect(error).toMatchObject({ code: 'too_large' })
        break
      }
      rows.push({ devices, sealed, hello, enrollment: enrollmentBytes(c, joined) })
    }
    // Approving a fifth device used to fail with too_large; the sealed invite grows ~2.3 KB per device.
    expect(rows.find((row) => row.devices === 4)!.sealed).toBeLessThan(
      LEGACY_SEALED_INVITE_MAX_BYTES
    )
    expect(rows.find((row) => row.devices === 5)!.sealed).toBeGreaterThan(
      LEGACY_SEALED_INVITE_MAX_BYTES
    )
    // Enrolling an eighth device used to exceed the joiner's 16 KiB preauth budget.
    expect(rows.find((row) => row.devices === 7)!.enrollment).toBeGreaterThan(PREAUTH_MAX_BYTES)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const row of rows) {
      expect(row.sealed).toBeLessThanOrEqual(SEALED_INVITE_MAX_BYTES)
      expect(row.enrollment).toBeLessThanOrEqual(ENROLLMENT_JOINER_MAX_BYTES)
      expect(row.hello).toBeLessThan(PREAUTH_MAX_BYTES)
    }
  }, 60_000)

  it('does not grow the delegations with revocations and keeps revocation evidence', async () => {
    // The roster that failed: this computer, three phones and one revoked phone.
    const c = await computer(),
      revoked: NodeId[] = []
    for (const name of ['CPH2585', 'Agimobile', 'Agimobile']) c.addPhone(name)
    revoked.push(c.addPhone())
    c.identity.revoke(revoked[0])
    expect(c.claims().nodes).toHaveLength(4)
    // Four live devices fit Mousse ID and phones that still accept only 16 KiB.
    expect(await sealedInviteBytes(c)).toBeLessThan(LEGACY_SEALED_INVITE_MAX_BYTES)
    const hello = helloBytes(c)
    for (let index = 0; index < 40; index++) {
      const node = c.addPhone()
      c.identity.revoke(node)
      revoked.push(node)
    }
    const roster = c.claims()
    expect(roster.nodes).toHaveLength(4)
    expect(roster.revoked.map((row) => row.subject).sort()).toEqual([...revoked].sort())
    // Each revocation keeps only its entry, about 121 bytes of hello instead of 983 for a delegation.
    expect((helloBytes(c) - hello) / 40).toBeLessThan(130)
    expect(await sealedInviteBytes(c)).toBeLessThan(SEALED_INVITE_MAX_BYTES)
    // A revoked node cannot come back under an epoch the revocation covers.
    expect(c.identity.isKnownNode(revoked[0])).toBe(true)
  }, 60_000)

  it('can still revoke a device when the roster is as large as the hello allows', async () => {
    const c = await computer(),
      phones: NodeId[] = []
    for (;;) {
      try {
        phones.push(c.addPhone())
      } catch (error) {
        expect(error).toMatchObject({ code: 'too_large' })
        break
      }
    }
    const before = c.claims().nodes.length
    c.identity.revoke(phones[0])
    expect(c.claims().nodes).toHaveLength(before - 1)
    phones.push(c.addPhone())
    expect(c.claims().nodes).toHaveLength(before)
  }, 60_000)

  it('drops revoked delegations a roster from before pruning still carries before an invite', async () => {
    const c = await computer(),
      identity = c.identity as unknown as { pruneNodes(roster: Roster): void },
      prune = identity.pruneNodes
    identity.pruneNodes = () => {}
    const stale = c.addPhone()
    c.addPhone('CPH2585')
    c.identity.revoke(stale)
    expect(c.claims().nodes).toHaveLength(3)
    identity.pruneNodes = prune
    const version = c.claims().version
    await sealedInviteBytes(c)
    expect(c.claims().nodes).toHaveLength(2)
    expect(c.claims().version).toBe(version + 1)
    expect(c.claims().revoked.map((row) => row.subject)).toEqual([stale])
    expect(c.identity.compactRoster()).toBeUndefined()
  }, 60_000)
})
