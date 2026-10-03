import { afterEach, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profile, cleanup } from '../chats/helpers'
import type { PlusConfiguration } from '../../../src/mms/net/plus/contracts'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'joins a hosted Space across accounts through signed discovery and automatic endpoint consent',
  async () => {
    const root = process.env.MOUSSE_PLUS_ROOT!,
      { NetRelayGateway } = await import(
        pathToFileURL(resolve(root, 'packages/net-relay/dist/index.js')).href
      ),
      { NetHostedService, MemoryNetHostedStore, HostedNetRelayPolicy } = await import(
        pathToFileURL(resolve(root, 'packages/net-hosted/dist/index.js')).href
      )
    const accountId = '08e9bdf6-81f3-4497-815e-7d3d4c398119',
      accountToken = 'qualified-fixture.account.session',
      guestAccount = '409e38c9-3b96-43ce-852e-567f5709e85f',
      guestToken = 'qualified-fixture.guest.session',
      thirdAccount = '106d3de4-116d-4479-928c-3f363877b552',
      thirdToken = 'qualified-fixture.third.session'
    let hosted: any,
      routeOffline = false
    const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []
        for await (const part of req) parts.push(Buffer.from(part))
        const input = JSON.parse(Buffer.concat(parts).toString() || '{}'),
          path = new URL(req.url!, 'http://localhost').pathname,
          token = req.headers.authorization?.slice(7),
          registrationId = input.registrationId ?? path.split('/')[4]
        const actor = [accountToken, guestToken, thirdToken].includes(token!)
          ? {
              accountId:
                token === accountToken
                  ? accountId
                  : token === guestToken
                    ? guestAccount
                    : thirdAccount,
              recentAuthAt: Date.now()
            }
          : await hosted.resolveConnectorActor(token, registrationId)
        let result: any
        if (path === '/v1/net/challenges') {
          const { registrationId: _scope, ...body } = input
          result = await hosted.issueChallenge(actor, body)
        } else if (path === '/v1/net/bindings') result = await hosted.bind(actor, input)
        else if (path === '/v1/net/registrations') result = await hosted.register(actor, input)
        else if (path === '/v1/net/routes') {
          if (routeOffline) {
            res.statusCode = 503
            res.end('{}')
            return
          }
          result = await hosted.approveRoute(actor, input)
        } else if (path === '/v1/net/rendezvous')
          result = await hosted.createRendezvous(actor, input)
        else if (path.endsWith('/renew')) result = await hosted.renewRegistration(actor, input)
        else if (path.endsWith('/revoke')) {
          await hosted.revokeRegistration(actor, registrationId, input.generation)
          result = {}
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
    const configuration: PlusConfiguration = {
      apiOrigin: `http://127.0.0.1:${port}`,
      audience: `ws://127.0.0.1:${port}/v1/net/relay`,
      installationId: 'qualified-local-installation',
      gatewayId: 'gateway-one',
      accountId
    }
    hosted = new NetHostedService({
      store: new MemoryNetHostedStore(),
      now: () => Date.now(),
      installationId: configuration.installationId,
      audience: configuration.audience,
      credentialKey: randomBytes(32),
      accountEligible: async (id: string) => [accountId, guestAccount, thirdAccount].includes(id)
    })
    const gateway = new NetRelayGateway({
      audience: configuration.audience,
      installationId: configuration.installationId,
      gatewayId: configuration.gatewayId,
      policy: new HostedNetRelayPolicy(hosted),
      now: () => Date.now()
    })
    gateway.attach(server)
    cleanup.push(() => gateway.close())
    const host = await profile(),
      joiner = await profile(),
      third = await profile()
    await host.services.net.request('net.transport.configure', {
      id: 'direct',
      enabled: false,
      settings: { host: '127.0.0.1', port: 0 }
    })
    await host.services.net.request('net.plus.bind', { configuration, accountToken })
    await host.services.net.request('net.plus.connect', { accountToken })
    const status = host.services.net.request('net.status', {}) as any
    expect(status.routes).toHaveLength(1)
    expect(status.routes[0].transport).toBe('plus-relay')
    await joiner.services.net.request('net.transport.configure', {
      id: 'direct',
      enabled: false,
      settings: { host: '127.0.0.1', port: 0 }
    })
    await joiner.services.net.request('net.plus.bind', {
      configuration: { ...configuration, accountId: guestAccount },
      accountToken: guestToken
    })
    await joiner.services.net.request('net.plus.connect', { accountToken: guestToken })
    const created = await host.services.spaces.local.request('spaces.create', {
      name: 'Hosted human Space'
    })
    const invitation = await host.services.spaces.local.request('spaces.invite', {
      space: created.space,
      ttlMs: 60000
    })
    await third.services.net.request('net.transport.configure', {
      id: 'direct',
      enabled: false,
      settings: { host: '127.0.0.1', port: 0 }
    })
    await third.services.net.request('net.plus.bind', {
      configuration: { ...configuration, accountId: thirdAccount },
      accountToken: thirdToken
    })
    await third.services.net.request('net.plus.connect', { accountToken: thirdToken })
    const second = await third.services.spaces.local.request('spaces.create', {
      name: 'Second endpoint host'
    })
    const secondInvite = await third.services.spaces.local.request('spaces.invite', {
      space: second.space,
      ttlMs: 60000
    })
    const { parseSpaceInvite, encodeSpaceInvite, spaceInviteRendezvous } =
      await import('../../../src/mms/spaces/host/invite')
    const parsed = parseSpaceInvite(invitation.invite),
      rv = spaceInviteRendezvous(parsed.container)!
    expect(rv.transport).toBe('plus-relay')
    expect(JSON.stringify(parsed.authorization)).not.toContain(rv.ticket)
    const tampered = {
      ...parsed.container,
      rendezvous: { ...parsed.container.rendezvous!, sig: Buffer.alloc(64).toString('base64url') }
    }
    expect(() => parseSpaceInvite(encodeSpaceInvite(tampered))).toThrow()
    parsed.token.fill(0)
    const [joined, secondJoined] = await Promise.all([
      joiner.services.spaces.local.request('spaces.join', {
        invite: invitation.invite,
        name: 'Guest'
      }),
      joiner.services.spaces.local.request('spaces.join', {
        invite: secondInvite.invite,
        name: 'Guest'
      })
    ])
    expect(secondJoined).toMatchObject({ space: second.space })
    expect(joined).toMatchObject({ space: created.space })
    const inventory = await hosted.inventory({ accountId, recentAuthAt: Date.now() })
    expect(
      inventory.routes.some(
        (row: any) => row.source === joiner.services.net.runtime().identity.self()!.node
      )
    ).toBe(true)
    const journal = joiner.services.net
      .runtime()
      .db.database.prepare('SELECT journal FROM net_space_client_join')
      .get()!
    expect(String(journal.journal)).not.toContain(rv.ticket)
    const posted = await joiner.services.spaces.local.request('spaces.post', {
      stream: created.channel,
      text: 'hosted public message'
    })
    expect(posted.state).toBe('sent')
    expect(
      (
        await host.services.spaces.local.request('spaces.tail', { stream: created.channel })
      ).records.map((r: any) => r.envelope.body)
    ).toContainEqual({ text: 'hosted public message' })
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    now += 25 * 60 * 60 * 1000
    await joiner.services.net.request('net.plus.renew', {})
    await Promise.all([
      host.services.net.request('net.plus.renew', {}),
      third.services.net.request('net.plus.renew', {})
    ])
    const renewed = await hosted.inventory({ accountId, recentAuthAt: now })
    expect(
      renewed.routes.find(
        (row: any) => row.source === joiner.services.net.runtime().identity.self()!.node
      ).expiresAt
    ).toBeGreaterThan(now)
    await expect
      .poll(
        async () =>
          (await joiner.services.spaces.local.request('spaces.list', {})).spaces.filter(
            (row) => !row.offline
          ).length,
        { timeout: 15000 }
      )
      .toBe(2)
    const afterDay = await joiner.services.spaces.local.request('spaces.post', {
      stream: second.channel,
      text: 'reconnected after25hours'
    })
    expect(afterDay.state).toBe('sent')
    routeOffline = true
    host.services.spaces.host.postMeta(created.space, 'member.removed', {
      user: joiner.services.net.runtime().identity.self()!.user
    })
    await expect(host.services.net.request('net.plus.renew', {})).rejects.toBeDefined()
    expect(
      (host.services.net.request('net.status', {}) as any).routes.some(
        (route: any) => route.transport === 'plus-relay'
      )
    ).toBe(false)
    routeOffline = false
    await host.services.net.request('net.plus.renew', {})
    const removed = await hosted.inventory({ accountId, recentAuthAt: now })
    expect(
      removed.routes.find(
        (row: any) => row.source === joiner.services.net.runtime().identity.self()!.node
      ).revokedAt
    ).not.toBeNull()
    const hostIdentity = host.services.net.runtime().identity.self()!
    await expect(
      joiner.services.net.connectChannel(
        {
          user: hostIdentity.user,
          node: hostIdentity.node,
          transportKey: host.services.net.runtime().keys.nodeKeys().transport,
          routes: (host.services.net.request('net.status', {}) as any).routes
        },
        new AbortController().signal
      )
    ).rejects.toBeDefined()
    expect(
      (
        await joiner.services.spaces.local.request('spaces.post', {
          stream: second.channel,
          text: 'otherSpace stillauthorized'
        })
      ).state
    ).toBe('sent')
  },
  45000
)
