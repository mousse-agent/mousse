import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { EnrollmentService } from '../../../src/mms/net/enrollment'
import { RelayTransport } from '../../../src/mms/net/transports/relay'
import { RelayServer } from '../../../src/mms/net/relay/server'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { FakeClock } from '../harness/FakeClock'
import type { SecureChannel } from '../../../src/mms/net/contracts'
import type { NodeDelegation, Roster, RoutesRecord } from '../../../src/shared/net'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('retrieves the exact consumed core enrollment receipt over relay after all stores restart and the invite expires', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mousse-relay-enroll-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const clock = new FakeClock(), profile = async (path: string, authority = false, reopen = false) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const db = new NetDatabase({ profileDir: path, clock }); cleanup.push(() => db.close())
    const keys = new FileKeyStore(path, { passphrase: reopen ? undefined : 'relay-enrollment-secret' })
    if (reopen) await keys.unlock('relay-enrollment-secret')
    const identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db })
    if (authority && !reopen) await identity.bootstrapAuthority('Relay authority')
    let routes: RoutesRecord['routes'] = []
    const service = new EnrollmentService({ db, keys, identity, clock, routes: () => identity.signAsNode({ v: 1, node: identity.self()!.node, version: 1, issuedAt: clock.now(), routes } satisfies RoutesRecord) })
    return { path, db, keys, identity, service, setRoutes(value: RoutesRecord['routes']) { routes = value } }
  }
  let authority = await profile(join(directory, 'authority'), true), follower = await profile(join(directory, 'follower'))
  const rootKey = authority.keys.rootKey()!, user = authority.identity.self()!.user
  const relayOptions = { databasePath: join(directory, 'relay.sqlite'), clock, allowUsers: [{ user, rootKey }] }
  let relay = new RelayServer(relayOptions); cleanup.push(() => relay.close()); await relay.listen()
  let serverChannel!: (channel: SecureChannel) => void, failedChannel!: (error: unknown) => void
  const transportAuthority = () => {
    const value = new RelayTransport({ settings: { address: relay.address() }, clock, identity: () => {
      const roster = authority.identity.roster()!, claims = authority.identity.verifySigned<Roster>(roster, rootKey)
      const delegation = claims.nodes.find(signed => authority.identity.verifySigned<NodeDelegation>(signed, rootKey).subject === authority.identity.self()!.node)!
      return { node: authority.identity.self()!.node, signKey: authority.keys.nodeKeys().sign, sign: (bytes: Uint8Array) => authority.keys.signAsNode(bytes), delegation, roster }
    } }); cleanup.push(() => value.teardown()); return value
  }
  let host = transportAuthority(); await host.provision(); await host.listen(raw => {
    void openSecureChannel(raw, { role: 'server', credentials: authority.keys.tlsCredentials(), deadlineMs: 2000 }).then(serverChannel, failedChannel)
  })
  authority.setRoutes(host.status().routes)
  const invite = authority.service.issueNodeInvite({ ttlMs: 1000 }), rendezvous = await host.prepareEnrollmentRendezvous({ expiresAt: invite.expiresAt })
  const prepared = await follower.service.prepareNodeJoin(invite.text, 'Follower')
  const transportFollower = () => {
    const value = new RelayTransport({ settings: { address: relay.address() }, clock, enrollment: rendezvous, identity: () => ({ node: prepared.node, signKey: follower.keys.nodeKeys().sign, sign: (bytes: Uint8Array) => follower.keys.signAsNode(bytes) }) }); cleanup.push(() => value.teardown()); return value
  }
  let client = transportFollower(); await client.provision()
  async function channels() {
    const incoming = new Promise<SecureChannel>((resolve, reject) => { serverChannel = resolve; failedChannel = reject })
    const raw = await client.dial(host.status().routes[0], new AbortController().signal)
    const [right, left] = await Promise.all([incoming, openSecureChannel(raw, { role: 'client', credentials: follower.keys.tlsCredentials(), expectedPeerFingerprint: fingerprint(Buffer.from(authority.keys.nodeKeys().transport, 'base64url')), deadlineMs: 2000 })])
    cleanup.push(() => left.close(), () => right.close()); return { left, right }
  }
  const first = await channels(), firstRequest = follower.service.nodeJoinRequest(first.left), original = authority.service.redeemNode(firstRequest, first.right)
  const originalRosterVersion = authority.identity.verifySigned<Roster>(original.roster, rootKey).version
  first.left.close(); first.right.close()
  const port = Number(new URL(relay.address()).port)
  await client.teardown(); await host.teardown(); await relay.close(); authority.db.close(); follower.db.close()
  authority = await profile(authority.path, true, true); follower = await profile(follower.path, false, true); clock.advance(1001)
  relay = new RelayServer({ ...relayOptions, port }); cleanup.push(() => relay.close()); await relay.listen()
  host = transportAuthority(); await host.provision(); await host.listen(raw => { void openSecureChannel(raw, { role: 'server', credentials: authority.keys.tlsCredentials(), deadlineMs: 2000 }).then(serverChannel, failedChannel) }); authority.setRoutes(host.status().routes)
  client = transportFollower(); await client.provision()
  const retry = await channels(), freshRequest = follower.service.nodeJoinRequest(retry.left)
  expect(freshRequest.proof).not.toBe(firstRequest.proof)
  expect(() => authority.service.redeemNode(firstRequest, retry.right)).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
  const recovered = authority.service.redeemNode(freshRequest, retry.right)
  expect(recovered).toEqual(original)
  follower.service.verifyAuthorityHello(authority.service.authorityHello(), retry.left)
  follower.service.acceptNodeJoin(recovered, retry.left)
  expect(follower.identity.self()).toMatchObject({ user, node: prepared.node, isAuthority: false })
  expect(authority.identity.verifySigned<Roster>(authority.identity.roster()!, rootKey).version).toBe(originalRosterVersion)
})
