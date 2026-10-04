import { afterEach, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'
import { profile, cleanup } from '../chats/helpers'
import { HostedProfileService } from '../../../src/mms/net/plus/HostedProfileService'
import type { PlusConfiguration } from '../../../src/mms/net/plus/contracts'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.skipIf(!process.env.MOUSSE_PLUS_ROOT)(
  'finishes actual PKCE browser approval and exact root binding without returning/storing session or grant secrets',
  async () => {
    const root = process.env.MOUSSE_PLUS_ROOT!,
      directory = mkdtempSync(join(tmpdir(), 'net-login-contract-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    await build({
      entryPoints: [resolve(root, 'apps/api/src/net/login.ts')],
      outfile: join(directory, 'login.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm'
    })
    const { NetLoginService, NetLoginStore } = await import(
        pathToFileURL(join(directory, 'login.mjs')).href
      ),
      { NetHostedService, MemoryNetHostedStore } = await import(
        pathToFileURL(resolve(root, 'packages/net-hosted/dist/index.js')).href
      )
    const configuration: PlusConfiguration = {
      apiOrigin: 'http://127.0.0.1:23456',
      audience: 'ws://127.0.0.1:23456/v1/net/relay',
      installationId: '7e1dc3ea-9146-4a0d-9e83-4a332ef2cbe1',
      gatewayId: 'gateway-one',
      accountId: '08e9bdf6-81f3-4497-815e-7d3d4c398119'
    }
    const actor = { accountId: configuration.accountId, recentAuthAt: Date.now() },
      p = await profile(),
      rt = p.services.net.runtime(),
      self = rt.identity.self()!,
      hello = rt.enrollment.localHello(),
      login = new NetLoginService({
        store: new NetLoginStore(),
        audience: configuration.audience,
        installationId: configuration.installationId,
        dashboardOrigin: configuration.apiOrigin,
        key: randomBytes(32)
      }),
      hosted = new NetHostedService({
        store: new MemoryNetHostedStore(),
        audience: configuration.audience,
        installationId: configuration.installationId,
        credentialKey: randomBytes(32),
        accountEligible: async (id: string) => id === actor.accountId
      })
    let observedGrant = ''
    const fakeFetch: typeof fetch = async (url, input) => {
      const path = new URL(String(url)).pathname,
        body = JSON.parse(String(input?.body ?? '{}'))
      try {
        if (path === '/v1/net/config')
          return Response.json({
            installationId: configuration.installationId,
            gatewayId: configuration.gatewayId,
            relayAudience: configuration.audience,
            approvalOrigin: configuration.apiOrigin
          })
        if (path === '/v1/net/login') return Response.json(await login.start(body))
        if (path.endsWith('/exchange')) {
          const grant = await login.exchange(path.split('/')[4], body)
          observedGrant = grant.accessToken
          return Response.json(grant)
        }
        if (path.startsWith('/v1/net/login/'))
          return Response.json(
            await login.poll(path.split('/')[4], new Headers(input?.headers).get('x-net-poll'))
          )
        const token = new Headers(input?.headers).get('authorization')!.slice(7),
          account = await login.authorize(token, path, body)
        if (path === '/v1/net/challenges')
          return Response.json(await hosted.issueChallenge(account, body))
        if (path === '/v1/net/bindings') return Response.json(await hosted.bind(account, body))
        if (path === '/v1/net/registrations')
          return Response.json(await hosted.register(account, body))
        throw new Error('Unexpected request')
      } catch (error) {
        return Response.json(
          { code: (error as { code?: string }).code ?? 'forbidden' },
          { status: 403 }
        )
      }
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
    const pending = await service.beginLogin(publicConfiguration, 'Protected native profile', true)
    expect(Object.keys(pending).sort()).toEqual([
      'expiresAt',
      'id',
      'pollIntervalMs',
      'userCode',
      'verificationUri'
    ])
    await expect(service.finishLogin(pending.id)).rejects.toMatchObject({ code: 'peer_offline' })
    const approval = await login.approval(pending.userCode, actor, 'approve')
    await new Promise((resolve) => setTimeout(resolve, 2050))
    expect(approval.nodeId).toBe(self.node)
    const status = await service.finishLogin(pending.id)
    expect(status.connected).toBe(true)
    expect(status.accountId).toBe(actor.accountId)
    expect(JSON.stringify(status)).not.toContain(observedGrant)
    expect(Buffer.from(rt.keys.getSecret('plus/connector')!).toString()).not.toContain(
      observedGrant
    )
    const inventory = await hosted.inventory(actor)
    expect(inventory.bindings).toHaveLength(1)
    expect(inventory.registrations).toHaveLength(1)
  },
  20000
)
