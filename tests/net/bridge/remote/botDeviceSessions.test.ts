/**
 * Which devices reach a bot, over real sessions: an owner computer with its real profile services and Bridge, and two
 * phones that joined it. What crosses the wire is checked here: an earlier build's "every device" reaches no phone
 * until the one-time snapshot, which gives it the devices linked then (none on a computer with no networking set up, so
 * a phone linked later reaches no bot); a bot left out of a phone's list is not there for that phone, a phone whose
 * switch is off reaches no bot, and each phone's lists stream is its own.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { PeerDirectory } from '../../../../src/mms/bridge/peers'
import { MmsProfileServices } from '../../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../../src/mms/bridge/BridgeProfileService'
import { NetError, newId, type NodeId, type StreamDescriptor } from '../../../../src/shared/net'
import { EventEmitter } from 'node:events'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  // Windows may hold a database file a moment after it closes; what is left goes with the temporary folder.
  cleanup.push(() => { try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the temp folder */ } })
  return path
}

/** The owner's profile services over `home`, as the app opens them. */
function profileAt(home: string, profileId: string) {
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId, allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  return services
}

/** A real bot in the profile's `bots.db`, made by an earlier build: its first turn is not what is tested. */
async function oldBot(home: string, profileId: string, name: string): Promise<string> {
  const services = profileAt(home, profileId)
  vi.spyOn(services.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
  const made = await services.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name, description: 'Keep the servers up', clientRequestId: `old-${name}` })
  await services.stop()
  // What the earlier build stored for it: every device.
  mkdirSync(join(home, 'bots'), { recursive: true })
  writeFileSync(join(home, 'bots', 'device-access.json'), JSON.stringify({ version: 1, bots: { [made.bot.id]: { mode: 'all' } } }))
  return made.bot.id
}

async function owner(at?: { home: string; profileId: string }) {
  const home = at?.home ?? directory('bot-devices-owner-')
  const services = profileAt(home, at?.profileId ?? randomUUID())
  let bridge: BridgeProfileService | undefined
  const net = new NetService({
    profileDir: home,
    composeRuntime: (runtime) => (bridge = new BridgeProfileService({ services, runtime, net })).composition()
  })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'desk', listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'bot-devices-protection' })
  const self = net.runtime().identity.self()!
  const phone = async (name: string) => {
    const device = new NetService({ profileDir: directory('bot-devices-phone-') })
    cleanup.push(() => device.shutdown())
    const invite = net.runtime().enrollment.issueNodeInvite({ name, kind: 'phone' }).text
    const joined = (await device.request('bridge.join', { invite, name })) as { node: NodeId }
    await vi.waitFor(() => expect(net.status().peers).toContainEqual({ node: joined.node, state: 'open' }), { timeout: 15_000 })
    await vi.waitFor(() => expect(device.status().peers).toContainEqual({ node: self.node, state: 'open' }), { timeout: 15_000 })
    const rpc = (method: string, params: unknown) => device.session(self.node).rpc(method, params, { id: newId('rpc'), deadlineMs: 10_000 })
    const answer = async (method: string, params: unknown): Promise<{ ok: unknown } | { code: string; details?: unknown }> => {
      try {
        return { ok: await rpc(method, params) }
      } catch (error) {
        expect(error).toBeInstanceOf(NetError)
        return { code: (error as NetError).code, ...((error as NetError).details ? { details: (error as NetError).details } : {}) }
      }
    }
    const watch = (descriptor: StreamDescriptor) => {
      if (!device.runtime().streams.getStream(descriptor.id)) device.runtime().streams.createStream(descriptor, 1)
      const seen = { ready: false, error: undefined as string | undefined }
      const subscription = device.session(self.node).subscribe(descriptor.id, {
        onRecord: () => undefined,
        onCaughtUp: () => { seen.ready = true },
        onSnapshotInstalled: () => { seen.ready = true },
        onError: (code) => { seen.error = code }
      })
      cleanup.push(() => subscription.close())
      return seen
    }
    return { node: joined.node, rpc, answer, watch }
  }
  return { services, net, phone, bridge: () => bridge! }
}

it('a phone left out of a bot\'s list finds no such bot, a phone switched off finds none, and each phone reads only its own lists', async () => {
  // The profile's bots as the bridge reads them, with one bot. A real bot would start its first turn on the computer's
  // own providers; what is tested here is what crosses the wire, not the bot.
  const bot = { id: 'bot-0123456789ab', name: 'Server keeper' }
  const o = await owner()
  const reached: string[] = []
  const service = {
    list: () => ({ bots: [bot] }),
    get: (botId: string) => {
      if (botId !== bot.id) throw Object.assign(new Error('No such bot.'), { code: 'bot_not_found' })
      reached.push('get')
      return { summary: bot, permissions: [], runs: [] }
    },
    chatList: () => { reached.push('chatList'); return { messages: [] } },
    memoryList: () => { reached.push('memoryList'); return { entries: [], gauge: '' } },
    chatSend: async () => { reached.push('chatSend'); return { message: {} } },
    update: () => { reached.push('update'); return { bot } },
    withdrawQueued: async () => 0
  }
  Object.defineProperty(o.services, 'personalBots', { value: { service, liveActivity: () => undefined, events: new EventEmitter() }, configurable: true })
  const mine = await o.phone('pocket')
  const sisters = await o.phone('tablet')

  // A bot without a choice reaches this computer alone: neither phone finds it.
  const missing = await sisters.answer('bots.get', { botId: 'bot-ffffffffffff' })
  expect(missing).toMatchObject({ code: 'stream_unknown' })
  expect(await mine.answer('bots.get', { botId: bot.id })).toEqual(missing)
  expect(await sisters.answer('bots.get', { botId: bot.id })).toEqual(missing)

  // About → Devices: both phones turned on.
  o.services.botDeviceAccess.set(bot.id, { mode: 'chosen', nodes: [mine.node, sisters.node] })
  expect(await mine.answer('bots.get', { botId: bot.id })).toMatchObject({ ok: { summary: { id: bot.id, name: 'Server keeper' } } })
  expect(await sisters.answer('bots.get', { botId: bot.id })).toMatchObject({ ok: { summary: { id: bot.id } } })

  // About → Devices: only the owner's phone.
  o.services.botDeviceAccess.set(bot.id, { mode: 'chosen', nodes: [mine.node] })
  const before = reached.length
  for (const [method, params] of [
    ['bots.get', { botId: bot.id }],
    ['bots.chat.list', { botId: bot.id }],
    ['bots.memory.list', { botId: bot.id }],
    ['bots.chat.send', { botId: bot.id, text: 'Shut the servers down', clientRequestId: 'tablet-1' }],
    ['bots.update', { botId: bot.id, name: 'Mine now' }]
  ] as const)
    expect(await sisters.answer(method, params), method).toEqual(missing)
  // Nothing the hidden bot holds was read or changed for the tablet: no call reached the bot at all.
  expect(reached.length).toBe(before)
  expect(await mine.answer('bots.get', { botId: bot.id })).toMatchObject({ ok: { summary: { name: 'Server keeper' } } })

  // Settings → Devices → Bots on this computer, off for the owner's own phone: it reaches no bot either.
  await o.net.request('bridge.policy', { node: mine.node, bots: false })
  expect(await mine.answer('bots.get', { botId: bot.id })).toMatchObject({ code: 'forbidden', details: { reason: 'setting_off' } })
  await o.net.request('bridge.policy', { node: mine.node, bots: true })
  expect(await mine.answer('bots.get', { botId: bot.id })).toMatchObject({ ok: { summary: { id: bot.id } } })

  // Each phone opens lists of its own; the other phone can't read them, even knowing the stream's id.
  const ownLists = (await mine.rpc('bridge.lists.open', {})) as { descriptor: StreamDescriptor }
  const theirLists = (await sisters.rpc('bridge.lists.open', {})) as { descriptor: StreamDescriptor }
  expect(ownLists.descriptor.id).not.toBe(theirLists.descriptor.id)
  const reading = mine.watch(ownLists.descriptor)
  const guessing = sisters.watch(ownLists.descriptor)
  await vi.waitFor(() => expect(reading.ready).toBe(true), { timeout: 15_000 })
  await vi.waitFor(() => expect(guessing.error).toBe('forbidden'), { timeout: 15_000 })
  expect(guessing.ready).toBe(false)
  // The lists each phone reads carry the bots it reaches.
  const listed = (node: NodeId) => (o.services.botReach!.hiddenFor(node)?.(bot.id) ? [] : [bot.id])
  expect(listed(mine.node)).toEqual([bot.id])
  expect(listed(sisters.node)).toEqual([])
}, 120_000)

const storedAt = (home: string) => JSON.parse(readFileSync(join(home, 'bots', 'device-access.json'), 'utf8')) as { version: number; bots: Record<string, unknown> }

it('on a computer with networking set up, an old bot reaches no phone until the account\'s devices can be read, then the devices linked then', async () => {
  const home = directory('bot-devices-owner-')
  const profileId = randomUUID()
  const botId = await oldBot(home, profileId, 'Server keeper')
  // Networking was set up before the update.
  const earlier = new NetService({ profileDir: home })
  await earlier.request('net.init', { name: 'desk', listen: true, port: 0 })
  await earlier.shutdown()
  // The engine is still starting: the account's devices can't be read yet.
  const unread = vi.spyOn(PeerDirectory.prototype, 'accountDevices').mockReturnValue(undefined)
  const o = await owner({ home, profileId })
  const mine = await o.phone('pocket')
  const missing = await mine.answer('bots.get', { botId: 'bot-ffffffffffff' })
  expect(missing).toMatchObject({ code: 'stream_unknown' })
  expect(storedAt(home).version).toBe(1)
  expect(await mine.answer('bots.get', { botId })).toEqual(missing)

  // The devices can be read: the next time Bridge reads them (here a second phone joining), every old bot gets them.
  unread.mockRestore()
  const sisters = await o.phone('tablet')
  await vi.waitFor(() => expect(storedAt(home).version).toBe(2))
  expect((storedAt(home).bots[botId] as { nodes: string[] }).nodes.sort()).toEqual([mine.node, sisters.node].sort())
  expect(await mine.answer('bots.get', { botId })).toMatchObject({ ok: { summary: { id: botId } } })
  expect(await sisters.answer('bots.get', { botId })).toMatchObject({ ok: { summary: { id: botId } } })
}, 120_000)

it('on a computer with no networking set up, an old bot becomes this computer\'s alone when the bots open, and a phone linked later never reaches it', async () => {
  const home = directory('bot-devices-owner-')
  const profileId = randomUUID()
  const botId = await oldBot(home, profileId, 'Server keeper')
  // Networking is set up after the update, on an account that already has a device: the first list Bridge reads holds it.
  const already = newId('node')
  const joined = vi.spyOn(PeerDirectory.prototype, 'accountDevices').mockReturnValue([already as NodeId])
  const o = await owner({ home, profileId })
  expect(storedAt(home)).toEqual({ version: 2, bots: { [botId]: { mode: 'this_computer' } } })
  expect(o.services.botReach!.canReach(botId, already)).toBe(false)
  joined.mockRestore()
  const mine = await o.phone('pocket')
  expect(storedAt(home)).toEqual({ version: 2, bots: { [botId]: { mode: 'this_computer' } } })
  const missing = await mine.answer('bots.get', { botId: 'bot-ffffffffffff' })
  expect(missing).toMatchObject({ code: 'stream_unknown' })
  expect(await mine.answer('bots.get', { botId })).toEqual(missing)
}, 120_000)
