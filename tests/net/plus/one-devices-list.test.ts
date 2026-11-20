import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { mousseIdNetModule } from '../../../src/mms/net/plus/HostedNetController'
import { registerNetMethods } from '../../../src/mms/net/registerMethods'
import { canonicalJson } from '../../../src/mms/net/sync/codec'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../../src/mms/protocol/handlers'
import type { NetStatus } from '../../../src/shared/net'

/*
 * Mousse ID keeps one devices list per account and refuses a second one with `account_network`
 * (HTTP 409), at bind and on the connector calls of a computer whose list it folded. The service
 * here is a stand-in written by hand from that contract; tests/net/plus/hosted-computer-join.test.ts
 * runs the real one.
 *
 * Inputs:
 * - who signs in: an owner computer with another live device (keeps its network), an owner alone
 *   on its network (may leave it), an owner still holding an earlier sign-in;
 * - where the refusal comes: bind with its own identity, bind with a join sign-in when no owner
 *   computer of the account's list is signed in, renewal of a registration whose list was folded.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const configuration = {
  apiOrigin: 'http://127.0.0.1:23456',
  audience: 'ws://127.0.0.1:23456/v1/net/relay',
  installationId: '7e1dc3ea-9146-4a0d-9e83-4a332ef2cbe1',
  gatewayId: 'gateway-one'
}
const accountId = '08e9bdf6-81f3-4497-815e-7d3d4c398119'

/** Mousse ID's net routes, enough to sign in, bind, register and renew; refuses on request. */
function fakeMousseId() {
  const state = {
    logins: [] as Array<Record<string, unknown>>,
    calls: [] as string[],
    refuseBind: false,
    refuseRenew: false
  }
  const statements = new Map<string, Record<string, unknown>>()
  const refuse = () =>
    Response.json(
      { error: { code: 'account_network', message: 'account_network', requestId: 'req-1' } },
      { status: 409 }
    )
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname,
      body = init?.body ? JSON.parse(String(init.body)) : {}
    state.calls.push(path)
    if (path === '/v1/net/config')
      return Response.json({
        installationId: configuration.installationId,
        gatewayId: configuration.gatewayId,
        relayAudience: configuration.audience
      })
    if (path === '/v1/net/login') {
      state.logins.push(body)
      return Response.json({
        id: `login-${state.logins.length}`,
        pollToken: 'p'.repeat(40),
        userCode: 'ABCDEF-123456',
        verificationUri: `${configuration.apiOrigin}/net-approve?code=ABCDEF-123456`,
        expiresAt: Date.now() + 300000,
        pollIntervalMs: 2000
      })
    }
    if (/^\/v1\/net\/login\/[^/]+$/.test(path)) return Response.json({ status: 'approved' })
    if (path.endsWith('/exchange'))
      return Response.json({ accessToken: 'nl_' + 'a'.repeat(40), accountId, expiresAt: Date.now() + 300000 })
    if (path === '/v1/net/challenges') {
      const statement = {
        v: 1,
        domain: 'mousse-plus/net-control/v1',
        installationId: configuration.installationId,
        audience: configuration.audience,
        challengeId: randomBytes(16).toString('hex'),
        nonce: randomBytes(32).toString('base64url'),
        accountId,
        userId: body.userId,
        rootKey: body.rootKey,
        nodeId: body.purpose === 'bind' ? null : body.nodeId,
        purpose: body.purpose,
        operationId: body.operationId,
        intentHash: createHash('sha256').update(canonicalJson(body.intent)).digest('base64url'),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000
      }
      statements.set(statement.challengeId, statement)
      return Response.json(statement)
    }
    if (path === '/v1/net/bindings') return state.refuseBind ? refuse() : Response.json({})
    const registration = () => {
      const signed = statements.get(body.challengeId)!
      return {
        id: 'registration-one',
        accountId,
        userId: signed.userId,
        nodeId: signed.nodeId,
        generation: 1,
        expiresAt: Date.now() + 600000
      }
    }
    if (path === '/v1/net/registrations')
      return Response.json({
        registration: registration(),
        connectorToken: 'c'.repeat(48),
        relayAudience: configuration.audience
      })
    if (path.endsWith('/renew')) return state.refuseRenew ? refuse() : Response.json(registration())
    if (path === '/v1/net/inventory')
      return Response.json({ bindings: [], registrations: [], devices: { used: 1, limit: 5 } })
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  })
  return state
}

type Spaces = Array<{ name: string; host: boolean }>

function service(spaces: Spaces = []): { net: NetService; path: string } {
  const path = mkdtempSync(join(tmpdir(), 'net-one-list-')),
    net = new NetService({
      profileDir: path,
      hosted: mousseIdNetModule,
      composeRuntime: () => ({ close: () => undefined, spaces: () => spaces })
    })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { net, path }
}

/** An owner computer with networking on, alone on its network. */
async function lone(name = 'Desk', spaces: Spaces = []) {
  const device = service(spaces)
  await device.net.request('net.init', { name, listen: true, port: 0 })
  await device.net.request('net.protect', { passphrase: 'test-owner-protection' })
  return device
}

/** Settings → Account's sign-in calls, as the local IPC carries them to the window. */
function ipc(net: NetService) {
  const registry = new DomainHandlerRegistry()
  registerNetMethods(registry, () => net)
  const context = {
    connection: {
      id: 'local-owner',
      binding: { profileId: 'selected-profile', epoch: 1 },
      capabilities: new Set(['net.v1'])
    }
  } as unknown as HandlerContext
  return (method: string, params: Record<string, unknown> = {}) =>
    registry.dispatch(context, method as never, { profileId: 'selected-profile', ...params })
}

/** Begins and finishes a sign-in approved at once, polling while a join runs. */
async function signIn(net: NetService, deviceName = 'Desk') {
  const call = ipc(net)
  const self = (net.request('net.status', {}) as NetStatus).self
  const pending = (await call('net.plus.login.begin', {
    configuration,
    deviceName,
    bindRoot: !!self?.isAuthority
  })) as { id: string }
  for (let attempt = 0; ; attempt++) {
    try {
      return await call('net.plus.login.finish', { id: pending.id })
    } catch (error) {
      if ((error as { code?: string }).code !== 'peer_offline' || attempt > 100) throw error
      await new Promise((done) => setTimeout(done, 50))
    }
  }
}

const asideOf = (path: string) => readdirSync(path).filter((name) => name.startsWith('net.'))
const relayRows = (net: NetService) =>
  (net.request('net.transport.list', {}) as { transports: Array<{ id: string }> }).transports.filter(
    (row) => row.id === 'plus-relay'
  )

it('an owner computer with other devices, refused a second devices list, keeps its network and says why', async () => {
  const owner = await lone(),
    mini = service()
  const invite = (await owner.net.request('bridge.invite', {})) as { invite: string }
  await mini.net.request('bridge.join', { invite: invite.invite, name: 'Mac mini' })
  const self = owner.net.runtime().identity.self()!
  const mousseId = fakeMousseId()
  mousseId.refuseBind = true

  await expect(signIn(owner.net)).rejects.toMatchObject({
    code: 'conflict',
    details: { reason: 'account_network_kept' }
  })

  // It signed in with its own identity, since leaving would strand its other device.
  expect(mousseId.logins[0]).toMatchObject({ nodeId: self.node })
  expect(mousseId.calls).toContain('/v1/net/bindings')
  // Nothing of the refused sign-in is kept, and it works on its own as before.
  expect(owner.net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
  expect(owner.net.runtime().identity.self()).toMatchObject({ node: self.node, isAuthority: true })
  expect(asideOf(owner.path)).toEqual([])
}, 30000)

it('a computer alone on its network keeps it when the account’s list has no owner computer signed in to join', async () => {
  const desk = await lone()
  const self = desk.net.runtime().identity.self()!
  const mousseId = fakeMousseId()
  mousseId.refuseBind = true

  await expect(signIn(desk.net)).rejects.toMatchObject({ code: 'authority_offline' })

  expect(mousseId.logins[0]).not.toHaveProperty('nodeId')
  expect(desk.net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
  expect(desk.net.runtime().identity.self()).toMatchObject({ node: self.node, isAuthority: true })
  expect(asideOf(desk.path)).toEqual([])
}, 30000)

it('a computer whose devices list was folded drops its sign-in, says so, and joins at its next sign-in', async () => {
  const desk = await lone()
  const mousseId = fakeMousseId()
  expect(await signIn(desk.net)).toMatchObject({ connected: true })
  expect(relayRows(desk.net)).toHaveLength(1)

  mousseId.refuseRenew = true
  await expect(ipc(desk.net)('net.plus.renew')).rejects.toMatchObject({ code: 'conflict' })

  // Signed out, as with Sign out, and the account row can say why.
  expect(desk.net.request('net.plus.status', {})).toEqual({
    configured: false,
    connected: false,
    reason: 'list_merged'
  })
  // The hosted relay goes too, once the transports restart without it.
  await vi.waitFor(() => expect(relayRows(desk.net)).toEqual([]))
  // Not an error of this computer's network.
  expect((desk.net.request('net.status', {}) as NetStatus).error).toBeUndefined()

  // The next sign-in is a join sign-in: it joins the account's list when Mousse ID shows one.
  const logins = mousseId.logins.length
  await ipc(desk.net)('net.plus.login.begin', { configuration, deviceName: 'Desk', bindRoot: true })
  expect(mousseId.logins).toHaveLength(logins + 1)
  expect(mousseId.logins.at(-1)).not.toHaveProperty('nodeId')
}, 30000)

it('a computer still holding an earlier sign-in, refused a second devices list, is told to sign in again to join', async () => {
  const desk = await lone()
  const mousseId = fakeMousseId()
  expect(await signIn(desk.net)).toMatchObject({ connected: true })
  mousseId.refuseBind = true

  // Signed in already, it signs in with its own identity, which binds its own list.
  await expect(signIn(desk.net)).rejects.toMatchObject({
    code: 'conflict',
    details: { reason: 'account_network' }
  })
  expect(mousseId.logins.at(-1)).toHaveProperty('nodeId')

  expect(desk.net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
  await ipc(desk.net)('net.plus.login.begin', { configuration, deviceName: 'Desk', bindRoot: true })
  expect(mousseId.logins.at(-1)).not.toHaveProperty('nodeId')
}, 30000)

it.each([
  { role: 'belongs to', spaces: [{ name: 'Team', host: false }], joins: true },
  { role: 'hosts', spaces: [{ name: 'Team', host: true }], joins: false }
])('an owner computer alone on its network that $role a Space signs in to join the account’s list: $joins', async ({ spaces, joins }) => {
  const desk = await lone('Desk', spaces)
  const self = desk.net.runtime().identity.self()!
  const mousseId = fakeMousseId()

  await ipc(desk.net)('net.plus.login.begin', { configuration, deviceName: 'Desk', bindRoot: true })

  // A Space it only belongs to is joined again afterwards; a Space it hosts would be stranded.
  if (joins) expect(mousseId.logins[0]).not.toHaveProperty('nodeId')
  else expect(mousseId.logins[0]).toMatchObject({ nodeId: self.node })
}, 30000)
