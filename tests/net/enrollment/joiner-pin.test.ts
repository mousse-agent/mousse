import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { systemClock } from '../../../src/mms/net/clock'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { EnrollmentService } from '../../../src/mms/net/enrollment'
import { memoryPair } from '../harness/MemoryTransport'
import type { RoutesRecord } from '../../../src/shared/net'

const resources: Array<() => void | Promise<void>> = [],
  paths: string[] = []
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
async function profile(authority: boolean) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-pin-')))
  paths.push(path)
  const clock = systemClock,
    db = new NetDatabase({ profileDir: path, clock })
  resources.push(() => db.close())
  const keys = new FileKeyStore(path, { passphrase: 'joiner-pin-test-master' }),
    identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db })
  if (authority) await identity.bootstrapAuthority('Inviter')
  else await keys.initialize({ asAuthority: false })
  const routes = () =>
    identity.signAsNode({
      v: 1,
      node: identity.self()!.node,
      version: 1,
      issuedAt: clock.now(),
      routes: [{ transport: 'direct', address: '127.0.0.1:4000', priority: 1 }]
    } satisfies RoutesRecord)
  return { db, keys, identity, service: new EnrollmentService({ db, identity, keys, clock, routes }) }
}
type Profile = Awaited<ReturnType<typeof profile>>
async function channels(a: Profile, b: Profile) {
  const pair = memoryPair()
  resources.push(() => pair.cut())
  const [server, client] = await Promise.all([
    openSecureChannel(pair.b, { role: 'server', credentials: a.keys.tlsCredentials(), deadlineMs: 1000 }),
    openSecureChannel(pair.a, {
      role: 'client',
      credentials: b.keys.tlsCredentials(),
      expectedPeerFingerprint: fingerprint(Buffer.from(a.keys.nodeKeys().transport, 'base64url')),
      deadlineMs: 1000
    })
  ])
  resources.push(
    () => server.close(),
    () => client.close()
  )
  return { server, client }
}
const pinOf = (p: Profile) => fingerprint(Buffer.from(p.keys.nodeKeys().transport, 'base64url'))

describe('joiner transport pin', () => {
  it('rejects a malformed pin before issuing', async () => {
    const a = await profile(true)
    expect(() => a.service.issueNodeInvite({ joinerTransportFingerprint: 'nope' })).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it('refuses any other transport key and leaves the invite unused', async () => {
    const a = await profile(true),
      b = await profile(false),
      outsider = await profile(false),
      invite = a.service.issueNodeInvite({ joinerTransportFingerprint: pinOf(outsider) })
    await b.service.prepareNodeJoin(invite.text, 'Phone')
    const c = await channels(a, b),
      before = a.identity.roster()
    expect(() => a.service.redeemNode(b.service.nodeJoinRequest(c.client), c.server)).toThrow(
      expect.objectContaining({ code: 'peer_key_mismatch' })
    )
    expect(a.identity.roster()).toEqual(before)
    expect(
      (
        a.db.database
          .prepare('SELECT state FROM net_enrollment_invites WHERE id=?')
          .get(invite.invite) as { state: string }
      ).state
    ).toBe('active')
  })

  it('enrolls the pinned joiner as a leaf node of the same user', async () => {
    const a = await profile(true),
      b = await profile(false),
      invite = a.service.issueNodeInvite({ joinerTransportFingerprint: pinOf(b), name: 'Phone' })
    await b.service.prepareNodeJoin(invite.text, 'Phone')
    const c = await channels(a, b),
      result = a.service.redeemNode(b.service.nodeJoinRequest(c.client), c.server)
    b.service.verifyAuthorityHello(a.service.authorityHello(), c.client)
    b.service.acceptNodeJoin(result, c.client)
    expect(b.identity.self()).toMatchObject({ user: a.identity.self()!.user, isAuthority: false })
  })
})
