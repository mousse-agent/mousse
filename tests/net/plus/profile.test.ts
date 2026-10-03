import { afterEach, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profile, cleanup } from '../chats/helpers'
import { HostedProfileService } from '../../../src/mms/net/plus/HostedProfileService'
import { canonicalJson } from '../../../src/mms/net/sync/codec'
import { verifyBytes } from '../../../src/mms/net/identity/crypto'
const configuration = {
  apiOrigin: 'http://127.0.0.1:23456',
  audience: 'ws://127.0.0.1:23456/v1/net/relay',
  installationId: 'local-installation',
  gatewayId: 'gateway-one',
  accountId: '08e9bdf6-81f3-4497-815e-7d3d4c398119'
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(
  options: {
    member?: boolean
    plain?: boolean
    tamper?: boolean
    now?: () => number
    routeOffline?: boolean
  } = {}
) {
  const p = await profile({ protect: !options.plain }),
    rt = p.services.net.runtime(),
    self = rt.identity.self()!,
    hello = rt.enrollment.localHello()
  const accountToken = 'ONE_SHOT_ACCOUNT_SECRET',
    connectorToken = 'PROFILE_ONLY_CONNECTOR_SECRET_'.repeat(3),
    bodies: any[] = [],
    statements = new Map<string, any>()
  const signal = new AbortController()
  const registration = {
    id: 'registration-one',
    accountId: configuration.accountId,
    userId: self.user,
    nodeId: self.node,
    generation: 1,
    expiresAt: (options.now?.() ?? Date.now()) + 60000
  }
  const fakeFetch: typeof fetch = async (url, input) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(input!.body))
    bodies.push({ path, body, auth: new Headers(input!.headers).get('authorization') })
    if (path === '/v1/net/challenges') {
      const statement = {
        v: 1,
        domain: 'mousse-plus/net-control/v1',
        installationId: configuration.installationId,
        audience: configuration.audience,
        challengeId: randomBytes(16).toString('hex'),
        nonce: randomBytes(32).toString('base64url'),
        accountId: options.tamper ? 'different-account' : configuration.accountId,
        userId: self.user,
        rootKey: rt.keys.rootKey()!,
        nodeId: body.purpose === 'bind' ? null : self.node,
        purpose: body.purpose,
        operationId: body.operationId,
        intentHash: createHash('sha256').update(canonicalJson(body.intent)).digest('base64url'),
        issuedAt: options.now?.() ?? Date.now(),
        expiresAt: (options.now?.() ?? Date.now()) + 60000
      }
      statements.set(statement.challengeId, statement)
      return Response.json(statement)
    }
    if (body.proof) {
      const statement = statements.get(body.challengeId)!
      verifyBytes(
        canonicalJson(statement),
        Buffer.from(body.proof, 'base64url'),
        statement.purpose === 'bind' ? rt.keys.rootKey()! : rt.keys.nodeKeys().sign
      )
    }
    if (path === '/v1/net/registrations')
      return Response.json({ registration, connectorToken, relayAudience: configuration.audience })
    if (path.endsWith('/renew'))
      return Response.json({ ...registration, expiresAt: (options.now?.() ?? Date.now()) + 60000 })
    if (path === '/v1/net/routes' && options.routeOffline) return Response.json({}, { status: 503 })
    return Response.json({})
  }
  const service = new HostedProfileService({
    keys: rt.keys,
    now: options.now,
    signal: signal.signal,
    fetch: fakeFetch,
    identity: () => ({
      ...self,
      isAuthority: !options.member,
      rootKey: rt.keys.rootKey()!,
      roster: hello.roster!,
      delegation: hello.delegation!
    })
  })
  return { ...p, rt, service, signal, bodies, accountToken, connectorToken }
}
it('binds exact account root proof, keeps account bearer one-shot, and renews/revokes through profile connector only', async () => {
  const p = await fixture()
  await p.service.bind(configuration, p.accountToken)
  const status = await p.service.connect(p.accountToken)
  expect(status.connected).toBe(true)
  expect(JSON.stringify(status)).not.toContain(p.connectorToken)
  expect(JSON.stringify(status)).not.toContain(p.accountToken)
  expect(Buffer.from(p.rt.keys.getSecret('plus/connector')!).toString()).not.toContain(
    p.accountToken
  )
  expect(readFileSync(join(p.home, 'net', 'keys.json'), 'utf8')).not.toContain(p.connectorToken)
  await p.service.renew()
  const renewal = p.bodies.filter((row) => row.path.endsWith('/renew'))[0]
  expect(renewal.auth).toBe(`Bearer ${p.connectorToken}`)
  expect(p.bodies.at(-2).body.registrationId).toBe('registration-one')
  await p.service.revoke()
  expect(p.service.status()).toEqual({ configured: false, connected: false })
})
it.each([{ member: true }, { plain: true }])(
  'rejects a member/account session or unprotected store as binding authority (%j)',
  async (options) => {
    const p = await fixture(options)
    await expect(p.service.bind(configuration, p.accountToken)).rejects.toMatchObject({
      code: options.plain ? 'keystore_locked' : 'forbidden'
    })
    expect(p.bodies).toEqual([])
  }
)
it('refuses to sign an account-substituted challenge and stops hosted work after disable', async () => {
  const p = await fixture({ tamper: true })
  await expect(p.service.bind(configuration, p.accountToken)).rejects.toMatchObject({
    code: 'forbidden'
  })
  expect(p.bodies).toHaveLength(1)
  p.signal.abort()
  await expect(p.service.connect(p.accountToken)).rejects.toMatchObject({ code: 'cancelled' })
})

it('drops an expired uncertain route after lease recovery and signs fresh current consent', async () => {
  let now = Date.now()
  const options = { now: () => now, routeOffline: false },
    p = await fixture(options)
  await p.service.bind(configuration, p.accountToken)
  await p.service.connect(p.accountToken)
  const self = p.rt.identity.self()!
  p.service.rememberSpaceRoute(self.node, self.user)
  options.routeOffline = true
  await expect(p.service.reconcileSpaceRoutes(() => true)).rejects.toMatchObject({
    code: 'route_unreachable'
  })
  const original = p.bodies.find((row) => row.path === '/v1/net/routes').body.operationId
  now += 180000
  options.routeOffline = false
  await p.service.renew()
  await p.service.reconcileSpaceRoutes(() => true)
  const routes = p.bodies.filter((row) => row.path === '/v1/net/routes')
  expect(routes).toHaveLength(2)
  expect(routes[1].body.operationId).not.toBe(original)
  expect(routes[1].body.expiresAt).toBe(now + 120000)
  expect(p.service.managedSpaceRoutes()[0].expiresAt).toBe(now + 120000)
})
