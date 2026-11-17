import { afterEach, expect, it } from 'vitest'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService, type NetRuntime } from '../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../src/mms/net/clock'
import { SpaceProfileService } from '../../src/mms/spaces/SpaceProfileService'
import type { Clock } from '../../src/mms/net/contracts'
import type { NetError, NodeId, NetStatus } from '../../src/shared/net'
import type { NetStartOverCheck } from '../../src/shared/net/local'

/**
 * Start over sets this computer's network folder aside so it can join or start other devices. It is
 * allowed when this computer was removed, when no other device holds an unexpired pass in its list,
 * or when its own pass lapsed past renewal; refused while it hosts a Space, is signed in to Mousse ID,
 * or other devices still rely on its list.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  shift.ms = 0
})

/** Every computer shares one clock, moved forward to let passes lapse. */
const shift = { ms: 0 }
const clock: Clock = { ...systemClock, now: () => Date.now() + shift.ms }
const DAY = 24 * 60 * 60 * 1000

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mousse-start-over-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(path: string, withSpaces = false): NetService {
  const net: NetService = new NetService({ profileDir: path, clock, ...(withSpaces ? { composeRuntime: (rt) => composeSpaces(net, rt) } : {}) })
  cleanups.push(() => net.shutdown())
  return net
}
/** The real Spaces composition, as the app wires it. */
const spaceProfiles = new Map<NetService, SpaceProfileService>()
function composeSpaces(net: NetService, rt: NetRuntime) {
  const spaces = new SpaceProfileService({ runtime: rt, net })
  spaceProfiles.set(net, spaces)
  return spaces.composition(new NodeStreamAuthority(rt.identity, spaces.store, rt.blobs, systemClock))
}
async function computer(name: string, options: { spaces?: boolean } = {}) {
  const path = directory(),
    net = service(path, options.spaces)
  await net.request('net.init', { name, listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'start over protection' })
  return { path, net }
}
/** A keeper and a member that joined it with a link. */
async function pair() {
  const keeper = await computer('Studio Mac')
  const path = directory(),
    member = service(path)
  const link = (await keeper.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await member.request('bridge.join', { invite: link.invite, name: 'Laptop' })) as { node: NodeId }
  return { keeper, member: { path, net: member, node: joined.node } }
}
const check = (net: NetService) => net.request('net.startOver.check', {}) as Promise<NetStartOverCheck>
const asides = (path: string) => readdirSync(path).filter((entry) => entry.startsWith('net.start-over-'))
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: NetError) => error
  )

it('a computer with no other devices starts over, keeps the old folder and the rest of the profile, and starts afresh after a restart', async () => {
  const solo = await computer('Studio Mac')
  const before = solo.net.status().self!
  // Bot device choices live outside the network folder, so starting over never widens them.
  mkdirSync(join(solo.path, 'bots'))
  writeFileSync(join(solo.path, 'bots', 'device-access.json'), '{"bots":{}}')

  expect(await check(solo.net)).toEqual({ allowed: 'alone', keeper: true, spaces: [] })
  const status = (await solo.net.request('net.startOver', {})) as NetStatus
  expect(status).toMatchObject({ enabled: false })
  expect(status.self).toBeUndefined()
  expect(asides(solo.path)).toHaveLength(1)
  expect(existsSync(join(solo.path, asides(solo.path)[0], 'keys.json'))).toBe(true)
  expect(readFileSync(join(solo.path, 'bots', 'device-access.json'), 'utf8')).toBe('{"bots":{}}')

  // Stopped before a new identity: the next start is a fresh computer.
  await solo.net.shutdown()
  const restarted = service(solo.path)
  await restarted.start()
  expect(restarted.status().self).toBeUndefined()
  const fresh = (await restarted.request('net.init', { name: 'Studio Mac' })) as NetStatus
  expect(fresh.self).toMatchObject({ isAuthority: true })
  expect(fresh.self!.node).not.toBe(before.node)
  expect(fresh.self!.user).not.toBe(before.user)
}, 30_000)

it('is refused while other devices hold a pass in the list, naming them, on the keeper and on the member', async () => {
  const { keeper, member } = await pair()
  expect(await check(keeper.net)).toEqual({ refused: 'live_devices', keeper: true, live: ['Laptop'], spaces: [] })
  expect(await check(member.net)).toEqual({ refused: 'live_devices', keeper: false, live: ['Studio Mac'], spaces: [] })
  const refused = await rejection(keeper.net.request('net.startOver', {}))
  expect(refused).toMatchObject({ code: 'conflict', details: { reason: 'live_devices' } })
  expect(asides(keeper.path)).toEqual([])
  expect(keeper.net.status().self?.isAuthority).toBe(true)
}, 30_000)

it('a removed computer starts over', async () => {
  const { keeper, member } = await pair()
  await keeper.net.request('bridge.revoke', { node: member.node })
  // The member learns of its removal from the keeper's list.
  await expect.poll(() => member.net.status().self?.removed, { timeout: 10_000 }).toBe(true)
  expect(await check(member.net)).toMatchObject({ allowed: 'removed', keeper: false })
  await member.net.request('net.startOver', {})
  expect(member.net.status().self).toBeUndefined()
}, 30_000)

it('a member whose keeper is gone starts over once the passes lapse: alone after a week, lapsed past renewal after a month', async () => {
  const { keeper, member } = await pair()
  await keeper.net.shutdown()
  shift.ms = 8 * DAY
  expect(await check(member.net)).toMatchObject({ allowed: 'alone', keeper: false })
  shift.ms = 38 * DAY
  expect(await check(member.net)).toMatchObject({ allowed: 'lapsed', keeper: false })
  await member.net.request('net.startOver', {})
  expect(member.net.status().self).toBeUndefined()
}, 30_000)

it('is refused on a computer that hosts a Space, naming it; a member names the Spaces to join again', async () => {
  const host = await computer('Studio Mac', { spaces: true }),
    guest = await computer('Laptop', { spaces: true })
  const spaces = spaceProfiles.get(host.net)!,
    space = spaces.host.create({ name: 'Design review' })
  const visitor = spaceProfiles.get(guest.net)!
  await visitor.client.join(visitor.client.prepareJoin(spaces.host.invite(space.space).text))
  await visitor.client.connect(space.space)

  expect(await check(host.net)).toMatchObject({ refused: 'space_host', hosted: ['Design review'] })
  const refused = await rejection(host.net.request('net.startOver', {}))
  expect(refused).toMatchObject({ code: 'conflict', details: { reason: 'space_host' } })
  expect(asides(host.path)).toEqual([])
  expect(await check(guest.net)).toEqual({ allowed: 'alone', keeper: true, spaces: ['Design review'] })
}, 30_000)

it('is refused while signed in to Mousse ID', async () => {
  const path = directory()
  // Signed in, as the Mousse ID module reports it; every other part of the module does nothing.
  const signedIn = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) =>
      name === 'status'
        ? () => ({ configured: true, connected: true, accountId: 'acct_one' })
        : name === 'transports'
          ? undefined
          : ['connected', 'consentFenced', 'handlesJoin'].includes(String(name))
            ? () => false
            : async () => undefined
  })
  const net = new NetService({ profileDir: path, clock, hosted: { create: () => signedIn as never } })
  cleanups.push(() => net.shutdown())
  await net.request('net.init', { name: 'Studio Mac' })
  expect(await check(net)).toMatchObject({ refused: 'mousse_id' })
  await expect(net.request('net.startOver', {})).rejects.toMatchObject({ details: { reason: 'mousse_id' } })
  expect(asides(path)).toEqual([])
}, 30_000)

it('a join queued after Start over joins as a fresh computer', async () => {
  const solo = await computer('Laptop'),
    other = await computer('Studio Mac')
  const link = (await other.net.request('bridge.invite', {})) as { invite: string }
  const starting = solo.net.request('net.startOver', {}),
    joining = solo.net.request('bridge.join', { invite: link.invite, name: 'Laptop' }) as Promise<{ node: NodeId }>
  await starting
  const joined = await joining
  expect(solo.net.status().self).toMatchObject({ node: joined.node, isAuthority: false })
  expect(asides(solo.path)).toHaveLength(1)
}, 30_000)

it.runIf(process.platform === 'win32')(
  'a folder Windows will not move, with a file in it held open, keeps the identity loaded and says so',
  async () => {
    const solo = await computer('Studio Mac')
    const before = solo.net.status().self!
    const held = openSync(join(solo.path, 'net', 'keys.json'), 'r')
    cleanups.push(() => closeSync(held))
    const failed = await rejection(solo.net.request('net.startOver', {}))
    expect(failed.code).toBe('internal')
    expect(asides(solo.path)).toEqual([])
    // Loaded again from the same folder; keys protected by a passphrase wait to be unlocked again.
    expect(solo.net.status().self).toMatchObject({ node: before.node, user: before.user })
  },
  30_000
)
