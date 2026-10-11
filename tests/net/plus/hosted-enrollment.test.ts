import { afterEach, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profile, cleanup } from '../chats/helpers'
import type { PlusConfiguration } from '../../../src/mms/net/plus/contracts'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'enrolls a blank protected node over sponsored hosted rendezvous with real endpoint authority',
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
        if (path === '/v1/net/challenges') {
          const { registrationId: _scope, ...body } = input
          result = await hosted.issueChallenge(actor, body)
        } else if (path === '/v1/net/bindings') result = await hosted.bind(actor, input)
        else if (path === '/v1/net/registrations') result = await hosted.register(actor, input)
        else if (path === '/v1/net/rendezvous') result = await hosted.createRendezvous(actor, input)
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
      installationId: configuration.installationId,
      audience: configuration.audience,
      credentialKey: randomBytes(32),
      accountEligible: async (id: string) => id === accountId
    })
    const gateway = new NetRelayGateway({
      audience: configuration.audience,
      installationId: configuration.installationId,
      gatewayId: configuration.gatewayId,
      policy: new HostedNetRelayPolicy(hosted)
    })
    gateway.attach(server)
    cleanup.push(() => gateway.close())
    const host = await profile(),
      joiner = await profile({ initialize: false })
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
    const invite = (await host.services.net.request('bridge.invite', {
      name: 'Hosted second device',
      ttlMs: 60000
    })) as { invite: string }
    const result = (await joiner.services.net.request('bridge.join', {
      invite: invite.invite,
      name: 'Hosted second device',
      passphrase: 'protected-sponsored-join-fixture'
    })) as any
    const owner = host.services.net.runtime().identity.self()!,
      member = joiner.services.net.runtime().identity.self()!
    expect(member.user).toBe(owner.user)
    expect(member.isAuthority).toBe(false)
    expect(member.node).not.toBe(owner.node)
    expect(joiner.services.net.runtime().keys.rootKey()).toBeUndefined()
    expect(joiner.services.net.runtime().keys.encryptedAtRest()).toBe(true)
    expect(host.services.net.runtime().identity.roster()).toBeDefined()
    const inventory = await hosted.inventory({ accountId, recentAuthAt: Date.now() })
    expect(inventory.registrations).toHaveLength(1)
    // Outer sponsorship never creates a general connector or confers root authority.
    expect(inventory.registrations.some((row: any) => row.nodeId === member.node)).toBe(false)
  },
  25000
)
