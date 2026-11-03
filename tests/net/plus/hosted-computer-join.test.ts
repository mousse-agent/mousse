import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { profile, cleanup } from '../chats/helpers'
import { openRequestSeal } from '../../../src/mms/net/plus/enrollmentSeal'
import { rawPublicKey } from '../../../src/mms/net/identity/crypto'

// An OS vault stand-in, so new network keys are protected without a passphrase as on a desktop.
vi.mock('../../../src/mms/providers/secretCodec', () => ({
  createSecretCodec: () => ({
    encryptionRequired: false,
    canEncrypt: () => true,
    encrypt: (plain: string) => Buffer.from('vault:' + plain),
    decrypt: (stored: Buffer) => {
      const text = stored.toString()
      return text.startsWith('vault:') ? text.slice(6) : null
    }
  })
}))

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

type Profile = Awaited<ReturnType<typeof profile>>

/**
 * Runs Mousse ID's own net routes, sign-in service and relay gateway from MOUSSE_PLUS_ROOT (a built
 * mousse-plus checkout), with an in-memory store. The browser approval is made by the test.
 */
async function mousseId(root: string) {
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href)
  const [{ NetRelayGateway }, { NetHostedService, MemoryNetHostedStore, HostedNetRelayPolicy }, { netRoutes }, { NetLoginService, NetLoginStore }] =
    await Promise.all([
      load('packages/net-relay/dist/index.js'),
      load('packages/net-hosted/dist/index.js'),
      load('apps/api/dist/net/routes.js'),
      load('apps/api/dist/net/login.js')
    ])
  const accountId = '08e9bdf6-81f3-4497-815e-7d3d4c398119',
    installationId = '5b0f8a4e-1d2c-4c6a-9f3e-2a7b9c1d0e4f'
  let app: { fetch(request: Request): Promise<Response> } | undefined
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const part of req) parts.push(Buffer.from(part))
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(name, value)
    const response = await app!.fetch(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(parts) })
      })
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
  const apiOrigin = `http://127.0.0.1:${port}`,
    audience = `ws://127.0.0.1:${port}/v1/net/relay`
  const service = new NetHostedService({
    store: new MemoryNetHostedStore(),
    installationId,
    audience,
    credentialKey: randomBytes(32),
    accountEligible: async (id: string) => id === accountId
  })
  const login = new NetLoginService({
    store: new NetLoginStore(),
    audience,
    installationId,
    dashboardOrigin: apiOrigin,
    key: randomBytes(32)
  })
  app = netRoutes({
    config: {
      INSTALLATION_ID: installationId,
      GATEWAY_ID: 'gateway-one',
      netRelayUrl: audience,
      dashboardOrigin: apiOrigin,
      MOUSSE_STUN_URLS: [],
      MOUSSE_DIRECT_WEBRTC: false,
      MONETIZATION_ENABLED: false
    },
    services: {
      net: { service, login },
      clock: { now: () => Date.now() },
      hosted: { entitlements: { get: async () => undefined } }
    }
  } as never)
  const gateway = new NetRelayGateway({
    audience,
    installationId,
    gatewayId: 'gateway-one',
    policy: new HostedNetRelayPolicy(service)
  })
  gateway.attach(server)
  cleanup.push(() => gateway.close())
  return { apiOrigin, accountId, service, login }
}

/** Signs a profile in as Settings → Account does, approving in "the browser" at once. */
async function signIn(fixture: Awaited<ReturnType<typeof mousseId>>, device: Profile, deviceName: string) {
  const net = device.services.net
  const configuration = await net.request('net.plus.discover', { apiOrigin: fixture.apiOrigin })
  const self = (net.request('net.status', {}) as { self?: { isAuthority?: boolean } }).self
  const pending = (await net.request('net.plus.login.begin', {
    configuration,
    deviceName,
    bindRoot: !!self?.isAuthority
  })) as { id: string; userCode: string }
  await fixture.login.approval(pending.userCode, { accountId: fixture.accountId, recentAuthAt: Date.now() }, 'approve', 'ada@example.test')
  for (let attempt = 0; ; attempt++) {
    try {
      return (await net.request('net.plus.login.finish', { id: pending.id })) as { connected: boolean }
    } catch (error) {
      if ((error as { code?: string }).code !== 'peer_offline' || attempt > 120) throw error
      await new Promise((done) => setTimeout(done, 500))
    }
  }
}

it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'a computer signed in to the same Mousse ID joins the account network without a code',
  async () => {
    const fixture = await mousseId(process.env.MOUSSE_PLUS_ROOT!)
    // The account's first computer has no identity either: signing in creates its network.
    const desk = await profile({ initialize: false }),
      mini = await profile({ initialize: false })
    expect(await signIn(fixture, desk, 'Desk')).toMatchObject({ connected: true })
    const owner = desk.services.net.runtime().identity.self()!
    expect(owner.isAuthority).toBe(true)

    expect(await signIn(fixture, mini, 'Mac mini')).toMatchObject({ connected: true })
    const member = mini.services.net.runtime().identity.self()!
    expect(member.user).toBe(owner.user)
    expect(member.isAuthority).toBe(false)
    expect(mini.services.net.runtime().keys.rootKey()).toBeUndefined()

    // The owner added it as a computer, with no question asked and no phone-style request left.
    const nodes = ((await desk.services.net.request('bridge.nodes', {})) as { nodes: Array<{ node: string; name: string; kind?: string }> }).nodes
    expect(nodes.find((row) => row.node === member.node)).toMatchObject({ name: 'Mac mini', kind: 'computer' })
    expect(desk.services.net.request('net.plus.enrollment.requests', {})).toEqual({ requests: [] })
    const inventory = await fixture.service.inventory({ accountId: fixture.accountId, recentAuthAt: Date.now() })
    expect(inventory.bindings).toHaveLength(1)
    expect(
      inventory.registrations.filter((row: { revokedAt: unknown }) => row.revokedAt === null).map((row: { nodeId: string }) => row.nodeId).sort()
    ).toEqual([owner.node, member.node].sort())
  },
  90000
)

it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'a phone signed in to the same Mousse ID is added without a question or a match code',
  async () => {
    const fixture = await mousseId(process.env.MOUSSE_PLUS_ROOT!)
    const desk = await profile({ initialize: false })
    expect(await signIn(fixture, desk, 'Desk')).toMatchObject({ connected: true })
    const owner = desk.services.net.runtime().identity.self()!
    // The phone asks with its account session, as the phone app does after signing in.
    const box = generateKeyPairSync('x25519').privateKey
    const actor = { accountId: fixture.accountId, recentAuthAt: Date.now() }
    const request = await fixture.service.createEnrollmentRequest(actor, {
      targetNodeId: owner.node,
      deviceName: 'Pixel',
      kind: 'phone',
      boxPublicKey: rawPublicKey(box),
      transportFingerprint: randomBytes(32).toString('base64url')
    })
    let sealed: string | undefined
    for (let attempt = 0; attempt < 60 && !sealed; attempt++) {
      sealed = (await fixture.service.readEnrollmentRequest(actor, request.id)).sealedInvite
      if (!sealed) await new Promise((done) => setTimeout(done, 500))
    }
    expect(openRequestSeal(sealed!, box.export({ type: 'pkcs8', format: 'der' }).subarray(-32), request.id)).toMatch(/^mj1_/)
    // Nothing waits for the person to approve.
    expect(desk.services.net.request('net.plus.enrollment.requests', {})).toEqual({ requests: [] })
  },
  90000
)
