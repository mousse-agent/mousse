import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { mousseIdNetModule } from '../../../src/mms/net/plus/HostedNetController'
import type { NetStatus } from '../../../src/shared/net'

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

/** Mousse ID's sign-in routes, enough to begin a sign-in; records each sign-in's claims. */
function fakeMousseId(): { logins: Array<Record<string, unknown>> } {
  const logins: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path === '/v1/net/config')
      return Response.json({
        installationId: configuration.installationId,
        gatewayId: configuration.gatewayId,
        relayAudience: configuration.audience
      })
    if (path === '/v1/net/login') {
      logins.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json({
        id: `login-${logins.length}`,
        pollToken: 'p'.repeat(40),
        userCode: 'ABCDEF-123456',
        verificationUri: `${configuration.apiOrigin}/net-approve?code=ABCDEF-123456`,
        expiresAt: Date.now() + 300000,
        pollIntervalMs: 2000
      })
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  })
  return { logins }
}

function service(composeRuntime?: ConstructorParameters<typeof NetService>[0]['composeRuntime']): {
  net: NetService
  path: string
} {
  const path = mkdtempSync(join(tmpdir(), 'net-removed-')),
    net = new NetService({ profileDir: path, hosted: mousseIdNetModule, composeRuntime })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { net, path }
}

/** The owner computer and a second computer that joined it with an invite. */
async function devices(composeMini?: Parameters<typeof service>[0]) {
  const owner = service(),
    mini = service(composeMini)
  await owner.net.request('net.init', { name: 'Desk', listen: true, port: 0 })
  await owner.net.request('net.protect', { passphrase: 'test-owner-protection' })
  const invite = (await owner.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await mini.net.request('bridge.join', { invite: invite.invite, name: 'Mac mini' })) as {
    node: string
  }
  await mini.net.request('net.protect', { passphrase: 'test-mini-protection' })
  // Threads and other profile data live beside `net`; none of it may move.
  writeFileSync(join(mini.path, 'threads.json'), 'kept')
  return { owner, mini, node: joined.node }
}

/** Removes the computer on the owner, then hands it the roster that says so. */
async function removed(owner: NetService, mini: NetService, node: string): Promise<void> {
  await owner.request('bridge.revoke', { node })
  const identity = owner.runtime().identity
  mini.runtime().identity.acceptRoster(identity.roster()!, identity.pinnedRootKey(identity.self()!.user)!)
}

const asideOf = (path: string) => readdirSync(path).filter((name) => /^net\.removed-\d+/.test(name))

it('a removed computer sets its old identity aside when it signs in, and joins as a new computer', async () => {
  const { owner, mini, node } = await devices()
  await removed(owner.net, mini.net, node)
  expect((mini.net.request('net.status', {}) as NetStatus).self).toMatchObject({ node, removed: true })
  const { logins } = fakeMousseId()

  const pending = (await mini.net.request('net.plus.login.begin', {
    configuration,
    deviceName: 'Mac mini'
  })) as { id: string; userCode: string }

  expect(pending).toMatchObject({ id: 'login-1', userCode: 'ABCDEF-123456' })
  // The join sign-in: proven with a key held in memory, and naming no network identity.
  expect(logins).toHaveLength(1)
  expect(logins[0]).not.toHaveProperty('nodeId')
  expect(logins[0]).toMatchObject({ deviceName: 'Mac mini' })
  // `net` moved aside whole; nothing was deleted and nothing outside it moved.
  const [aside, ...more] = asideOf(mini.path)
  expect(more).toEqual([])
  expect(existsSync(join(mini.path, aside, 'net.db'))).toBe(true)
  expect(existsSync(join(mini.path, aside, 'keys.json'))).toBe(true)
  expect(readFileSync(join(mini.path, 'threads.json'), 'utf8')).toBe('kept')
  // This computer now has no identity, as a new one: finishing the sign-in is the join's.
  const status = mini.net.request('net.status', {}) as NetStatus
  expect(status.self).toBeUndefined()
  expect(status.error).toBeUndefined()
  await expect(mini.net.request('net.plus.login.finish', { id: pending.id })).rejects.toMatchObject({
    code: 'forbidden'
  })

  // Signing in again sets nothing else aside: it is the join of a computer with no identity.
  await expect(
    mini.net.request('net.plus.login.begin', { configuration, deviceName: 'Mac mini' })
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(asideOf(mini.path)).toEqual([aside])
}, 30000)

it('a computer that was not removed signs in with its own identity and keeps it', async () => {
  const { mini, node } = await devices()
  expect((mini.net.request('net.status', {}) as NetStatus).self).not.toHaveProperty('removed')
  const { logins } = fakeMousseId()

  await mini.net.request('net.plus.login.begin', { configuration, deviceName: 'Mac mini' })

  expect(logins).toHaveLength(1)
  expect(logins[0]).toMatchObject({ nodeId: node })
  expect(asideOf(mini.path)).toEqual([])
  expect(mini.net.runtime().identity.self()).toMatchObject({ node })
}, 30000)

it('the owner computer is never set aside, even when signing in', async () => {
  const { owner, mini, node } = await devices()
  await removed(owner.net, mini.net, node)
  const self = owner.net.runtime().identity.self()!
  const { logins } = fakeMousseId()

  await owner.net.request('net.plus.login.begin', { configuration, deviceName: 'Desk', bindRoot: true })

  expect(logins[0]).toMatchObject({ nodeId: self.node })
  expect(asideOf(owner.path)).toEqual([])
  expect(owner.net.runtime().identity.self()).toMatchObject({ node: self.node, isAuthority: true })
}, 30000)

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a set-aside that cannot move the folder keeps the old identity loaded and says so',
  async () => {
    const { owner, mini, node } = await devices()
    await removed(owner.net, mini.net, node)
    const { logins } = fakeMousseId()
    // The profile folder refuses the rename.
    chmodSync(mini.path, 0o555)
    cleanups.push(() => chmodSync(mini.path, 0o755))

    await expect(
      mini.net.request('net.plus.login.begin', { configuration, deviceName: 'Mac mini' })
    ).rejects.toMatchObject({ code: 'internal' })

    chmodSync(mini.path, 0o755)
    expect(logins).toEqual([])
    expect(asideOf(mini.path)).toEqual([])
    // The runtime was loaded again from the same folder, still removed, so a later sign-in can retry.
    expect((mini.net.request('net.status', {}) as NetStatus).self).toMatchObject({ node, removed: true })
    await mini.net.request('net.plus.login.begin', { configuration, deviceName: 'Mac mini' })
    expect(asideOf(mini.path)).toHaveLength(1)
    expect(logins[0]).not.toHaveProperty('nodeId')
  },
  30000
)

it('setting the identity aside closes what ran on the old runtime and composes the next one afresh', async () => {
  const composed: Array<{ runtime: unknown; close: ReturnType<typeof vi.fn> }> = []
  const { owner, mini, node } = await devices((runtime) => {
    const close = vi.fn(async () => undefined)
    composed.push({ runtime, close })
    return { close }
  })
  await removed(owner.net, mini.net, node)
  const before = composed.length
  fakeMousseId()

  await mini.net.request('net.plus.login.begin', { configuration, deviceName: 'Mac mini' })

  expect(composed.at(-1)!.close).toHaveBeenCalledOnce()
  // The next runtime is loaded from the new, empty `net` folder, with a domain of its own.
  const next = mini.net.runtime()
  expect(composed).toHaveLength(before + 1)
  expect(composed.at(-1)!.runtime).toBe(next)
  expect(next.identity.self()).toBeUndefined()
}, 30000)
