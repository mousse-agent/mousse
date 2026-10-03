import { afterEach, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profile, cleanup } from '../chats/helpers'
import type { Roster, NodeDelegation } from '../../../src/shared/net'
import type { PlusConfiguration } from '../../../src/mms/net/plus/contracts'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
// Honest-host transport qualification only. The upstream malicious-host private
// incremental-write R2 release gate is intentionally unchanged by this test.
it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'transports private messages and sealed attachments through hosted Net while denying a nonparticipant host plaintext',
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
      participantAccounts = [
        accountId,
        '409e38c9-3b96-43ce-852e-567f5709e85f',
        '89e38c9a-3b96-43ce-852e-567f5709e85f'
      ],
      accountTokens = [accountToken, 'fixture.controller.account', 'fixture.recipient.account'],
      relayIngress: Buffer[] = []
    let hosted: any
    const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []
        for await (const part of req) parts.push(Buffer.from(part))
        const input = JSON.parse(Buffer.concat(parts).toString() || '{}'),
          path = new URL(req.url!, 'http://localhost').pathname,
          token = req.headers.authorization?.slice(7),
          registrationId = input.registrationId ?? path.split('/')[4]
        const actor = accountTokens.includes(token!)
          ? {
              accountId: participantAccounts[accountTokens.indexOf(token!)],
              recentAuthAt: Date.now()
            }
          : await hosted.resolveConnectorActor(token, registrationId)
        let result: any
        if (path === '/v1/net/challenges') {
          const { registrationId: _scope, ...body } = input
          result = await hosted.issueChallenge(actor, body)
        } else if (path === '/v1/net/bindings') result = await hosted.bind(actor, input)
        else if (path === '/v1/net/registrations') result = await hosted.register(actor, input)
        else if (path === '/v1/net/routes') result = await hosted.approveRoute(actor, input)
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
    server.on('connection', (socket) =>
      socket.on('data', (bytes) => {
        if (relayIngress.reduce((n, b) => n + b.length, 0) < 4 * 1024 * 1024)
          relayIngress.push(Buffer.from(bytes))
      })
    )
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
      accountEligible: async (id: string) => participantAccounts.includes(id)
    })
    const gateway = new NetRelayGateway({
      audience: configuration.audience,
      installationId: configuration.installationId,
      gatewayId: configuration.gatewayId,
      policy: new HostedNetRelayPolicy(hosted)
    })
    gateway.attach(server)
    cleanup.push(() => gateway.close())
    const profiles = [await profile(), await profile(), await profile()]
    for (const [index, p] of profiles.entries()) {
      await p.services.net.request('net.transport.configure', {
        id: 'direct',
        enabled: false,
        settings: { host: '127.0.0.1', port: 0 }
      })
      await p.services.net.request('net.plus.bind', {
        configuration: { ...configuration, accountId: participantAccounts[index] },
        accountToken: accountTokens[index]
      })
      await p.services.net.request('net.plus.connect', { accountToken: accountTokens[index] })
      expect(
        (p.services.net.request('net.status', {}) as any).routes.map((r: any) => r.transport)
      ).toEqual(['plus-relay'])
    }
    const [host, controller, recipient] = profiles.map((p) => p.services),
      created = await host.spaces.local.request('spaces.create', {
        name: 'Hosted private transport'
      }),
      audience = [
        controller.net.runtime().identity.self()!.user,
        recipient.net.runtime().identity.self()!.user
      ]
    for (const p of [controller, recipient]) {
      const invitation = await host.spaces.local.request('spaces.invite', {
        space: created.space,
        ttlMs: 60000
      })
      await p.spaces.local.request('spaces.join', {
        invite: invitation.invite,
        name: 'Private member'
      })
      await p.spaces.client.connect(created.space)
      await p.spaces.client.subscribe(created.channel)
    }
    await vi.waitFor(() =>
      expect(controller.spaces.meta.member(created.space, audience[1])).toBeDefined()
    )
    await controller.bridge.currentIdentity.preparePrivateAudience(created.space, audience)
    const privateStream = controller.spaces.private.prepareCreation(
      created.space,
      created.channel,
      audience
    )
    await controller.spaces.private.publishCreation(privateStream.descriptor.id)
    await vi.waitFor(() =>
      expect(
        recipient.spaces.store.getById(created.channel, privateStream.parentEvent.id)
      ).toBeDefined()
    )
    await recipient.spaces.discover(created.space, privateStream.descriptor.id)
    await recipient.spaces.client.subscribe(privateStream.descriptor.id)
    const messageCanary = 'hosted-private-message-' + randomBytes(16).toString('hex'),
      attachmentCanary = 'hosted-private-attachment-' + randomBytes(16).toString('hex'),
      attachment = Buffer.from(attachmentCanary.repeat(4096)),
      blob = controller.spaces.private.sealBlob(privateStream.descriptor.id, attachment),
      session = controller.spaces.session(created.space)!
    await session.putBlob(privateStream.descriptor.id, blob.id, blob.bytes, true)
    const event = controller.spaces.private.seal(
        privateStream.descriptor.id,
        'message.posted',
        { text: messageCanary },
        undefined,
        [{ id: blob.id, bytes: blob.bytes.length, mime: 'application/octet-stream', sealed: true }]
      ),
      position = await session.append(
        privateStream.descriptor.id,
        event.id,
        event.envelope,
        event.sig
      )
    await vi.waitFor(() =>
      expect(recipient.spaces.store.getById(privateStream.descriptor.id, event.id)).toBeDefined()
    )
    const received = recipient.spaces.store.getById(privateStream.descriptor.id, event.id)!,
      hostCipher = host.spaces.store.getById(privateStream.descriptor.id, event.id)!,
      receivedBlob = await recipient.spaces
        .session(created.space)!
        .getBlob(privateStream.descriptor.id, blob.id)
    expect(recipient.spaces.private.open(privateStream.descriptor.id, received)).toEqual({
      text: messageCanary
    })
    expect(
      Buffer.from(
        recipient.spaces.private.openBlob(
          privateStream.descriptor.id,
          received,
          blob.id,
          receivedBlob
        )
      )
    ).toEqual(attachment)
    expect(position.seq).toBe(received.seq)
    expect(Buffer.from(hostCipher.envelope).includes(Buffer.from(messageCanary))).toBe(false)
    expect(
      Buffer.from(host.net.runtime().blobs.read(blob.id, 0, blob.bytes.length)).includes(
        Buffer.from(attachmentCanary)
      )
    ).toBe(false)
    expect(() => host.spaces.private.open(privateStream.descriptor.id, hostCipher)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(() =>
      host.spaces.private.openBlob(privateStream.descriptor.id, hostCipher, blob.id, blob.bytes)
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    const hostIdentity = host.net.runtime().identity,
      hostSelf = hostIdentity.self()!,
      hostRoot = hostIdentity.pinnedRootKey(hostSelf.user)!,
      hostRoster = hostIdentity.verifySigned<Roster>(hostIdentity.roster()!, hostRoot),
      hostPeer = {
        ...hostSelf,
        delegation: hostRoster.nodes
          .map((s) => hostIdentity.verifySigned<NodeDelegation>(s, hostRoot))
          .find((d) => d.subject === hostSelf.node)!
      }
    expect(host.spaces.host.canRead(privateStream.descriptor.id, hostPeer)).toBe(false)
    expect(host.spaces.host.canFetchBlob(privateStream.descriptor.id, blob.id, hostPeer)).toBe(
      false
    )
    const observed = Buffer.concat(relayIngress)
    expect(observed.length).toBeGreaterThan(attachment.length)
    expect(observed.includes(Buffer.from(messageCanary))).toBe(false)
    expect(observed.includes(Buffer.from(attachmentCanary))).toBe(false)
    const inventory = await hosted.inventory({ accountId, recentAuthAt: Date.now() })
    expect(JSON.stringify(inventory)).not.toContain(messageCanary)
    expect(JSON.stringify(inventory)).not.toContain(attachmentCanary)
  },
  30000
)
