import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profile, cleanup } from '../chats/helpers'
import { HostedProfileService } from '../../../src/mms/net/plus/HostedProfileService'
import type { PlusConfiguration } from '../../../src/mms/net/plus/contracts'
import {
  enrollmentMatchCode,
  openOfferSeal,
  openRequestSeal
} from '../../../src/mms/net/plus/enrollmentSeal'
import { canonicalJson } from '../../../src/mms/net/sync/codec'
import { fingerprint } from '../../../src/mms/net/link/selfSignedCert'

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const configuration: PlusConfiguration = {
  apiOrigin: 'http://127.0.0.1:23456',
  audience: 'ws://127.0.0.1:23456/v1/net/relay',
  installationId: 'local-installation',
  gatewayId: 'gateway-one',
  accountId: '08e9bdf6-81f3-4497-815e-7d3d4c398119'
}
function phoneBox() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return {
    privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(-32),
    publicKey: Buffer.from(publicKey.export({ format: 'der', type: 'spki' }))
      .subarray(-32)
      .toString('base64url')
  }
}
const b64 = (n: number) => randomBytes(n).toString('base64url')

/** A fake Plus that answers sign-in, registration and the phone mailbox. */
async function fixture(grantExtras: Record<string, unknown> = {}) {
  const p = await profile(),
    rt = p.services.net.runtime(),
    self = rt.identity.self()!,
    hello = rt.enrollment.localHello(),
    connectorToken = 'PROFILE_ONLY_CONNECTOR_SECRET_'.repeat(3),
    calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [],
    mailbox: unknown[] = [],
    reject: { status?: number } = {}
  const fakeFetch: typeof fetch = async (url, input) => {
    const path = new URL(String(url)).pathname,
      method = input?.method ?? 'GET',
      body = input?.body ? JSON.parse(String(input.body)) : undefined
    calls.push({ method, path, auth: new Headers(input?.headers).get('authorization'), body })
    if (path === '/v1/net/config')
      return Response.json({
        installationId: configuration.installationId,
        gatewayId: configuration.gatewayId,
        relayAudience: configuration.audience
      })
    if (path === '/v1/net/login')
      return Response.json({
        id: 'login-one',
        pollToken: 'p'.repeat(40),
        userCode: 'ABCD-EFGH',
        verificationUri: `${configuration.apiOrigin}/net/approve?code=ABCD-EFGH`,
        expiresAt: Date.now() + 600000,
        pollIntervalMs: 1000
      })
    if (path === '/v1/net/login/login-one') return Response.json({ status: 'approved' })
    if (path === '/v1/net/login/login-one/exchange')
      return Response.json({
        accessToken: 'nl_' + 'a'.repeat(40),
        accountId: configuration.accountId,
        expiresAt: Date.now() + 60000,
        ...grantExtras
      })
    if (path === '/v1/net/challenges')
      return Response.json({
        v: 1,
        domain: 'mousse-plus/net-control/v1',
        installationId: configuration.installationId,
        audience: configuration.audience,
        challengeId: b64(16),
        nonce: b64(32),
        accountId: configuration.accountId,
        userId: self.user,
        rootKey: rt.keys.rootKey()!,
        nodeId: body.purpose === 'bind' ? null : self.node,
        purpose: body.purpose,
        operationId: body.operationId,
        intentHash: createHash('sha256').update(canonicalJson(body.intent)).digest('base64url'),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000
      })
    if (path === '/v1/net/bindings') return Response.json({})
    if (path === '/v1/net/registrations')
      return Response.json({
        registration: {
          id: 'registration-one',
          accountId: configuration.accountId,
          userId: self.user,
          nodeId: self.node,
          generation: 1,
          expiresAt: Date.now() + 60000
        },
        connectorToken,
        relayAudience: configuration.audience
      })
    if (path === '/v1/net/registrations/registration-one/enrollment-requests')
      return Response.json({ requests: mailbox })
    if (reject.status && /\/enrollment-(requests\/[^/]+\/(approve|deny)|offers)$/.test(path))
      return Response.json({ error: { code: 'rejected' } }, { status: reject.status })
    if (/\/enrollment-requests\/[^/]+\/(approve|deny)$/.test(path))
      return new Response(null, { status: 204 })
    if (path === '/v1/net/registrations/registration-one/enrollment-offers')
      return Response.json({ id: 'offer-one', expiresAt: Date.now() + 600000 }, { status: 201 })
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  }
  const service = new HostedProfileService({
    keys: rt.keys,
    signal: new AbortController().signal,
    fetch: fakeFetch,
    identity: () => ({
      ...self,
      rootKey: rt.keys.rootKey()!,
      roster: hello.roster!,
      delegation: hello.delegation!
    })
  })
  const { accountId: _account, ...publicConfiguration } = configuration
  return { service, calls, mailbox, reject, connectorToken, publicConfiguration }
}

describe('Mousse Plus phone mailbox', () => {
  it('shows display-only account details from the grant and lets a cancelled sign-in restart', async () => {
    const p = await fixture({ email: 'ada@example.test', plan: 'Plus' })
    await p.service.beginLogin(p.publicConfiguration, 'Desk', true)
    await expect(p.service.beginLogin(p.publicConfiguration, 'Desk', true)).rejects.toMatchObject({
      code: 'conflict'
    })
    p.service.cancelLogin()
    const pending = await p.service.beginLogin(p.publicConfiguration, 'Desk', true)
    const status = await p.service.finishLogin(pending.id)
    expect(status).toMatchObject({ connected: true, email: 'ada@example.test', plan: 'Plus' })
  })

  it('ignores malformed account details', async () => {
    const p = await fixture({ email: 'x\u0000y', plan: 42 })
    const pending = await p.service.beginLogin(p.publicConfiguration, 'Desk', false)
    const status = await p.service.finishLogin(pending.id)
    expect(status.connected).toBe(true)
    expect(status).not.toHaveProperty('email')
    expect(status).not.toHaveProperty('plan')
  })

  it('reads, approves and denies requests with the connector token only', async () => {
    const p = await fixture()
    const pending = await p.service.beginLogin(p.publicConfiguration, 'Desk', true)
    await p.service.finishLogin(pending.id)
    const box = phoneBox(),
      good = {
        id: 'req-one',
        deviceName: 'Ada’s phone',
        kind: 'phone',
        boxPublicKey: box.publicKey,
        transportFingerprint: b64(32),
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000
      }
    p.mailbox.push(
      good,
      { ...good, id: 'expired', expiresAt: Date.now() - 1 },
      { ...good, id: 'bad-box', boxPublicKey: 'short' },
      { ...good, id: 'bad-name', deviceName: 'a\nb' },
      'junk'
    )
    expect(await p.service.enrollmentRequests()).toEqual([good])
    await p.service.approveEnrollmentRequest('req-one', 'sealed')
    await p.service.denyEnrollmentRequest('req-two')
    await expect(p.service.denyEnrollmentRequest('../escape')).rejects.toMatchObject({
      code: 'bad_request'
    })
    const offer = await p.service.enrollmentOffer('sealed-offer')
    expect(offer).toMatchObject({ id: 'offer-one', apiOrigin: configuration.apiOrigin })
    const mailboxCalls = p.calls.filter((row) => row.path.includes('enrollment-'))
    expect(mailboxCalls.map((row) => [row.method, row.path, row.body])).toEqual([
      ['GET', '/v1/net/registrations/registration-one/enrollment-requests', undefined],
      [
        'POST',
        '/v1/net/registrations/registration-one/enrollment-requests/req-one/approve',
        { sealedInvite: 'sealed' }
      ],
      ['POST', '/v1/net/registrations/registration-one/enrollment-requests/req-two/deny', {}],
      [
        'POST',
        '/v1/net/registrations/registration-one/enrollment-offers',
        { sealedInvite: 'sealed-offer' }
      ]
    ])
    expect(mailboxCalls.every((row) => row.auth === `Bearer ${p.connectorToken}`)).toBe(true)
  })

  it('maps decided, expired and over-quota mailbox answers', async () => {
    const p = await fixture()
    const pending = await p.service.beginLogin(p.publicConfiguration, 'Desk', true)
    await p.service.finishLogin(pending.id)
    for (const [status, code] of [
      [404, 'invite_invalid'],
      [410, 'invite_invalid'],
      [409, 'conflict']
    ] as const) {
      p.reject.status = status
      await expect(p.service.approveEnrollmentRequest('req-one', 'sealed')).rejects.toMatchObject({
        code
      })
    }
    p.reject.status = 429
    await expect(p.service.enrollmentOffer('sealed-offer')).rejects.toMatchObject({
      code: 'quota_exceeded'
    })
  })

  it('requires a registration before touching the mailbox', async () => {
    const p = await fixture()
    await expect(p.service.enrollmentRequests()).rejects.toMatchObject({ code: 'not_enrolled' })
    expect(p.calls).toEqual([])
  })
})

it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'enrolls a phone-like node as a leaf of the same user through an approved request and a QR offer',
  async () => {
    const root = process.env.MOUSSE_PLUS_ROOT!,
      { NetRelayGateway } = await import(
        pathToFileURL(resolve(root, 'packages/net-relay/dist/index.js')).href
      ),
      { NetHostedService, MemoryNetHostedStore, HostedNetRelayPolicy } = await import(
        pathToFileURL(resolve(root, 'packages/net-hosted/dist/index.js')).href
      )
    const accountId = '08e9bdf6-81f3-4497-815e-7d3d4c398119',
      accountToken = 'qualified-fixture.account.session'
    let hosted: any
    // Minimal stand-in for the Plus mailbox (contract §3/§4); the hosted package covers the rest.
    const requests = new Map<string, any>(),
      offers = new Map<string, string>()
    const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []
        for await (const part of req) parts.push(Buffer.from(part))
        const input = JSON.parse(Buffer.concat(parts).toString() || '{}'),
          path = new URL(req.url!, 'http://localhost').pathname,
          token = req.headers.authorization?.slice(7),
          registrationId = input.registrationId ?? path.split('/')[4]
        const actor =
          token === accountToken
            ? { accountId, recentAuthAt: Date.now() }
            : await hosted.resolveConnectorActor(token, registrationId)
        let result: any
        const approve = path.match(/\/enrollment-requests\/([^/]+)\/(approve|deny)$/)
        if (path === '/v1/net/challenges') {
          const { registrationId: _scope, ...body } = input
          result = await hosted.issueChallenge(actor, body)
        } else if (path === '/v1/net/bindings') result = await hosted.bind(actor, input)
        else if (path === '/v1/net/registrations') result = await hosted.register(actor, input)
        else if (path === '/v1/net/rendezvous') result = await hosted.createRendezvous(actor, input)
        else if (path.endsWith('/renew')) result = await hosted.renewRegistration(actor, input)
        else if (path.endsWith('/enrollment-requests'))
          result = { requests: [...requests.values()].filter((row) => !row.sealedInvite) }
        else if (approve) {
          const row = requests.get(approve[1])
          if (approve[2] === 'approve') row.sealedInvite = input.sealedInvite
          else requests.delete(approve[1])
          res.statusCode = 204
          res.end()
          return
        } else if (path.endsWith('/enrollment-offers')) {
          const id = 'offer-' + randomBytes(8).toString('hex')
          offers.set(id, input.sealedInvite)
          res.statusCode = 201
          result = { id, expiresAt: Date.now() + 600000 }
        } else throw new Error('Unexpected fixture request')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (error) {
        res.statusCode = 403
        res.end(JSON.stringify({ code: (error as { code?: string }).code ?? 'forbidden' }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
    const live: PlusConfiguration = {
      apiOrigin: `http://127.0.0.1:${port}`,
      audience: `ws://127.0.0.1:${port}/v1/net/relay`,
      installationId: 'qualified-local-installation',
      gatewayId: 'gateway-one',
      accountId
    }
    hosted = new NetHostedService({
      store: new MemoryNetHostedStore(),
      installationId: live.installationId,
      audience: live.audience,
      credentialKey: randomBytes(32),
      accountEligible: async (id: string) => id === accountId
    })
    const gateway = new NetRelayGateway({
      audience: live.audience,
      installationId: live.installationId,
      gatewayId: live.gatewayId,
      policy: new HostedNetRelayPolicy(hosted)
    })
    gateway.attach(server)
    cleanup.push(() => gateway.close())
    const host = await profile()
    await host.services.net.request('net.transport.configure', {
      id: 'direct',
      enabled: false,
      settings: { host: '127.0.0.1', port: 0 }
    })
    await host.services.net.request('net.plus.bind', { configuration: live, accountToken })
    await host.services.net.request('net.plus.connect', { accountToken })
    const owner = host.services.net.runtime().identity.self()!

    // Request path: the phone already holds its keys, so the desktop can pin its transport key.
    const phone = await profile({ initialize: false }),
      phoneKeys = phone.services.net.runtime().keys
    await phoneKeys.initialize({ asAuthority: false })
    const box = phoneBox(),
      transportFingerprint = fingerprint(Buffer.from(phoneKeys.nodeKeys().transport, 'base64url'))
    requests.set('req-phone', {
      id: 'req-phone',
      deviceName: 'Ada phone',
      kind: 'phone',
      boxPublicKey: box.publicKey,
      transportFingerprint,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000
    })
    let listed: any
    for (let i = 0; i < 50; i++) {
      listed = host.services.net.request('net.plus.enrollment.requests', {})
      if (listed.requests.length) break
      await new Promise((done) => setTimeout(done, 100))
    }
    expect(listed.requests).toHaveLength(1)
    expect(listed.requests[0].matchCode).toBe(
      enrollmentMatchCode(box.publicKey, transportFingerprint)
    )
    await host.services.net.request('net.plus.enrollment.approve', { id: 'req-phone' })
    const invite = openRequestSeal(requests.get('req-phone').sealedInvite, box.privateKey, 'req-phone')
    await phone.services.net.request('bridge.join', {
      invite,
      name: 'Ada phone',
      passphrase: 'protected-phone-join-fixture'
    })
    const member = phone.services.net.runtime().identity.self()!
    expect(member).toMatchObject({ user: owner.user, isAuthority: false })
    expect(phone.services.net.runtime().keys.rootKey()).toBeUndefined()

    // Offer path: anyone holding the QR key can open the sealed invite exactly once.
    const offer = (await host.services.net.request('net.plus.enrollment.offer', {})) as {
      url: string
      offerId: string
    }
    const url = new URL(offer.url)
    expect(url.protocol).toBe('mousse:')
    expect(url.searchParams.get('plus')).toBe(live.apiOrigin)
    const second = await profile({ initialize: false })
    await second.services.net.request('bridge.join', {
      invite: openOfferSeal(
        offers.get(url.searchParams.get('offer')!)!,
        Buffer.from(url.searchParams.get('key')!, 'base64url')
      ),
      name: 'Second phone',
      passphrase: 'protected-phone-join-fixture'
    })
    expect(second.services.net.runtime().identity.self()).toMatchObject({
      user: owner.user,
      isAuthority: false
    })
  },
  40000
)
