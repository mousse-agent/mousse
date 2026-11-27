/**
 * The bot streams over real sessions: an owner computer with its real profile services and Bridge, and phones that
 * joined it. Thread sharing ("Work on threads") stays off throughout: the bots feed (`bridge.bots.open`) and one bot's
 * chat (`bridge.bot.open`) are the device's own, admitted by its bot level and each bot's Devices alone. A device that
 * no longer reaches a bot loses that bot's chat at once, and the feed drops the bot.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { MmsProfileServices } from '../../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../../src/mms/bridge/BridgeProfileService'
import { ThreadDisplayProjection } from '../../../../src/mms/bridge/remote/ThreadDisplayProjection'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import type { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { BOT_STREAM_EVENT_TYPES } from '../../../../src/shared/net/envelope'
import { NetError, newId, type NodeId, type StreamDescriptor, type StreamId } from '../../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => { try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the temp folder */ } })
  return path
}

function profileAt(home: string) {
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  return services
}

const KEEPER = 'bot-0123456789ab'
const WRITER = 'bot-ba9876543210'
/** The thread the keeper's chat turns run in, where its reply is written. */
const KEEPER_HOME = 'thr_keeper_home'

/**
 * The profile's bots as the Bridge reads them, two of them. A real bot starts its first turn on the computer's own
 * providers; what is tested here is what crosses the wire, not the bot.
 */
function stubBots() {
  const bots = [
    { id: KEEPER, name: 'Server keeper', stateText: 'Idle', homeThreadId: KEEPER_HOME },
    { id: WRITER, name: 'Writer', stateText: 'Idle' }
  ]
  const find = (botId: string) => {
    const bot = bots.find((row) => row.id === botId)
    if (!bot) throw Object.assign(new Error('No such bot.'), { code: 'bot_not_found' })
    return bot
  }
  const service = {
    list: () => ({ bots: [...bots] }),
    get: (botId: string) => ({ summary: find(botId), permissions: [], runs: [] }),
    summary: (botId: string) => find(botId),
    chatList: (botId: string) => { find(botId); return { messages: [] } },
    withdrawQueued: async () => 0
  }
  const events = new EventEmitter()
  return {
    events,
    remove: (botId: string) => bots.splice(bots.findIndex((row) => row.id === botId), 1),
    port: {
      service,
      events,
      liveActivity: () => undefined,
      feedTelling: () => ({ readSeq: 0, attention: [] }),
      botIds: () => bots.map((row) => row.id)
    }
  }
}

async function owner() {
  const home = directory('bot-streams-owner-')
  const services = profileAt(home)
  const bots = stubBots()
  Object.defineProperty(services, 'personalBots', { value: bots.port, configurable: true })
  let bridge: BridgeProfileService | undefined
  const net = new NetService({
    profileDir: home,
    composeRuntime: (runtime) => (bridge = new BridgeProfileService({ services, runtime, net })).composition()
  })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'desk', listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'bot-streams-protection' })
  // "Work on threads" off: no thread is shared with another device.
  expect(await net.request('bridge.workOnThreads', { enabled: false })).toEqual({ enabled: false })
  const self = net.runtime().identity.self()!
  /** What a device received on a stream, as its own store holds it: the newest snapshot and the events after it. */
  const read = (store: Pick<SqliteStreamStore, 'openSnapshot'>, stream: StreamId, threadId: string) => {
    const reader = store.openSnapshot(stream)
    const projection = new ThreadDisplayProjection(threadId, BOT_STREAM_EVENT_TYPES)
    let snapshot: any
    const events: Array<{ type: string; data: any }> = []
    try {
      for (;;) {
        const page = reader.next(4 * 1024 * 1024)
        for (const record of page.records) {
          const update = projection.accept(decodeEnvelope(record.envelope).envelope)
          if (update?.kind === 'snapshot') { snapshot = update.value; events.length = 0 }
          if (update?.kind === 'event') events.push({ type: update.type, data: update.data })
        }
        if (page.done) return { snapshot, events }
      }
    } finally {
      reader.close()
    }
  }
  const phone = async (name: string) => {
    // A phone reads display-only deltas (`presence.v1`), as the phone app does.
    const device = new NetService({
      profileDir: directory('bot-streams-phone-'),
      composeRuntime: () => ({ session: { capabilities: ['streams.v1', 'blobs.v1', 'rpc.v1', 'presence.v1'], verifyPresence: () => false } })
    })
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
    /**
     * Opens a bot stream and reads it until it is caught up: what the phone stored from it, the display-only deltas it
     * was sent, whether it caught up and the error that ended it.
     */
    const open = async (method: 'bridge.bots.open' | 'bridge.bot.open', params: unknown) => {
      const opened = (await rpc(method, params)) as { descriptor: StreamDescriptor; subject: string }
      const { descriptor } = opened
      if (!device.runtime().streams.getStream(descriptor.id)) device.runtime().streams.createStream(descriptor, 1)
      const seen = { ready: false, error: undefined as string | undefined }
      const deltas: Array<{ type: string; data: any }> = []
      const offDeltas = device.session(self.node).onEphemeral((message) => {
        if (message.t !== 'ephemeral' || message.stream !== descriptor.id) return
        const body = message.data as { threadId: string; type: string; data: unknown }
        if (body.threadId === opened.subject) deltas.push({ type: body.type, data: body.data })
      })
      const subscription = device.session(self.node).subscribe(descriptor.id, {
        onRecord: () => undefined,
        onCaughtUp: () => { seen.ready = true },
        onSnapshotInstalled: () => { seen.ready = true },
        onError: (code) => { seen.error = code }
      })
      cleanup.push(() => { offDeltas(); subscription.close() })
      await vi.waitFor(() => expect(seen.ready || seen.error).toBeTruthy(), { timeout: 15_000 })
      expect(seen.error).toBeUndefined()
      return { stream: descriptor.id, subject: opened.subject, seen, deltas, read: () => read(device.runtime().streams, descriptor.id, opened.subject) }
    }
    return { node: joined.node, answer, open }
  }
  const choose = (botId: string, nodes: NodeId[]) => services.botDeviceAccess.set(botId, { mode: 'chosen', nodes })
  return { services, net, bots, phone, choose, bridge: () => bridge! }
}

const feedIds = (feed: { read(): { snapshot: any } }): string[] => feed.read().snapshot.bots.map((bot: { id: string }) => bot.id)

it('with thread sharing off, a Use phone and a Full phone each read the feed of the bots they reach and a bot\'s chat; an Off phone reads neither', async () => {
  const o = await owner()
  const pocket = await o.phone('pocket')
  const tablet = await o.phone('tablet')
  const watch = await o.phone('watch')
  await o.net.request('bridge.policy', { node: tablet.node, bots: 'full' })
  await o.net.request('bridge.policy', { node: watch.node, bots: 'off' })
  o.choose(KEEPER, [pocket.node, tablet.node, watch.node])
  o.choose(WRITER, [tablet.node])
  // Use: the feed holds the one bot it reaches, with its read state and telling metadata.
  const pocketFeed = await pocket.open('bridge.bots.open', {})
  expect(pocketFeed.read().snapshot).toEqual({
    kind: 'mousse.bots',
    version: 1,
    bots: [{ id: KEEPER, name: 'Server keeper', stateText: 'Idle', homeThreadId: KEEPER_HOME, readSeq: 0, telling: { attention: [] } }]
  })
  // Full: both bots.
  expect(feedIds(await tablet.open('bridge.bots.open', {}))).toEqual([KEEPER, WRITER])
  // Off: no feed and no chat, even for a bot whose Devices include it.
  expect(await watch.answer('bridge.bots.open', {})).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
  expect(await watch.answer('bridge.bot.open', { botId: KEEPER })).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })

  // A bot's chat: its row and its newest messages, then each message and its live reply as they come.
  const chat = await pocket.open('bridge.bot.open', { botId: KEEPER })
  expect(chat.read().snapshot).toMatchObject({ kind: 'mousse.bot', version: 1, bot: { id: KEEPER }, page: { messages: [] } })
  const message = { id: 'bm_1', seq: 1, at: new Date().toISOString(), author: 'bot', kind: 'reply', text: 'The servers are up.' }
  o.bots.events.emit('message', { botId: KEEPER, message, botName: 'Server keeper', quiet: false })
  await vi.waitFor(() => expect(chat.read().events).toContainEqual({ type: 'bots.message', data: { botId: KEEPER, message } }))
  // Its live chip and its reply as the chat turn writes it, display-only: sent, never stored.
  const chip = { kind: 'tool', label: 'Reading the logs' }
  o.bots.events.emit('activity', { botId: KEEPER, activationId: 'act_1', chip })
  await vi.waitFor(() => expect(chat.deltas).toContainEqual({ type: 'bots.activity', data: { botId: KEEPER, activationId: 'act_1', chip } }))
  o.services.orchestrator.emit('thread-message-updated', { threadId: KEEPER_HOME, message: { id: 'msg_reply', role: 'assistant', content: 'The servers' } })
  await vi.waitFor(() =>
    expect(chat.deltas).toContainEqual({ type: 'bots.reply', data: { botId: KEEPER, messageId: 'msg_reply', role: 'assistant', text: 'The servers', added: false } })
  )
  // A reply whose text grows with escaping (20 000 quotes, 40 000 bytes encoded) is cut to fit, not dropped.
  const quotes = '"'.repeat(20_000)
  o.services.orchestrator.emit('thread-message-updated', { threadId: KEEPER_HOME, message: { id: 'msg_quotes', role: 'assistant', content: quotes } })
  await vi.waitFor(() => expect(chat.deltas.some((delta) => delta.data.messageId === 'msg_quotes')).toBe(true))
  const cut = chat.deltas.find((delta) => delta.data.messageId === 'msg_quotes')!
  expect(cut).toMatchObject({ type: 'bots.reply', data: { botId: KEEPER, role: 'assistant', added: false } })
  expect(cut.data.text.length).toBeGreaterThan(10_000)
  expect(quotes.startsWith(cut.data.text)).toBe(true)
  expect(chat.read().events.map((event) => event.type)).toEqual(['bots.message'])
  // A bot it does not reach answers as one that is not there.
  expect(await pocket.answer('bridge.bot.open', { botId: WRITER })).toMatchObject({ code: 'stream_unknown' })

  // Thread sharing turned on and off again lets go of every thread stream, not of the bot streams.
  await o.net.request('bridge.workOnThreads', { enabled: true })
  await o.net.request('bridge.workOnThreads', { enabled: false })
  const later = { ...message, id: 'bm_2', seq: 2, text: 'Still up.' }
  o.bots.events.emit('message', { botId: KEEPER, message: later, botName: 'Server keeper', quiet: false })
  await vi.waitFor(() => expect(chat.read().events).toContainEqual({ type: 'bots.message', data: { botId: KEEPER, message: later } }))
  expect(chat.seen.error).toBeUndefined()
  expect(pocketFeed.seen.error).toBeUndefined()
}, 180_000)

/** Each way a phone stops reaching the bot, what its chat ends with, and whether its whole feed goes with it. */
const causes: Array<{ name: string; code: string; feedEnds: boolean; lose(o: Awaited<ReturnType<typeof owner>>, phone: NodeId): Promise<void> | void }> = [
  { name: 'its bot level set to Off', code: 'forbidden', feedEnds: true, lose: (o, phone) => o.net.request('bridge.policy', { node: phone, bots: 'off' }).then(() => undefined) },
  { name: 'left out of the bot\'s Devices', code: 'forbidden', feedEnds: false, lose: (o) => o.choose(KEEPER, []) },
  { name: 'the bot kept to this computer', code: 'forbidden', feedEnds: false, lose: (o) => o.services.botDeviceAccess.set(KEEPER, { mode: 'this_computer' }) },
  {
    name: 'the bot deleted',
    code: 'stream_unknown',
    feedEnds: false,
    lose: (o) => {
      o.bots.remove(KEEPER)
      o.bots.events.emit('changed', { botId: KEEPER })
    }
  }
]

for (const cause of causes)
  it(`a phone ${cause.name} loses the bot's chat at once, and the feed ${cause.feedEnds ? 'ends' : 'drops the bot'}`, async () => {
    const o = await owner()
    const pocket = await o.phone('pocket')
    o.choose(KEEPER, [pocket.node])
    o.choose(WRITER, [pocket.node])
    const feed = await pocket.open('bridge.bots.open', {})
    const chat = await pocket.open('bridge.bot.open', { botId: KEEPER })
    const other = await pocket.open('bridge.bot.open', { botId: WRITER })
    expect(feedIds(feed)).toEqual([KEEPER, WRITER])

    await cause.lose(o, pocket.node)
    await vi.waitFor(() => expect(chat.seen.error).toBe(cause.code), { timeout: 15_000 })
    if (cause.feedEnds) {
      await vi.waitFor(() => expect(feed.seen.error).toBe('forbidden'), { timeout: 15_000 })
      expect(await pocket.answer('bridge.bots.open', {})).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
    } else {
      await vi.waitFor(() => expect(feedIds(feed)).toEqual([WRITER]), { timeout: 15_000 })
      expect(feed.seen.error).toBeUndefined()
      // The other bot's chat goes on.
      expect(other.seen.error).toBeUndefined()
      expect(await pocket.answer('bridge.bot.open', { botId: KEEPER })).toMatchObject({ code: 'stream_unknown' })
    }
  }, 120_000)

it('a phone removed from the account loses its feed and every bot\'s chat', async () => {
  const o = await owner()
  const pocket = await o.phone('pocket')
  o.choose(KEEPER, [pocket.node])
  const feed = await pocket.open('bridge.bots.open', {})
  const chat = await pocket.open('bridge.bot.open', { botId: KEEPER })
  await o.net.request('bridge.revoke', { node: pocket.node })
  await vi.waitFor(() => expect(chat.seen.error).toBeDefined(), { timeout: 15_000 })
  await vi.waitFor(() => expect(feed.seen.error).toBeDefined(), { timeout: 15_000 })
  // Nothing is kept open for it on this computer.
  expect(o.bridge().threads.privateReaders()).not.toContain(pocket.node)
}, 120_000)

it('a phone blocked here loses its feed and every bot\'s chat', async () => {
  const o = await owner()
  const pocket = await o.phone('pocket')
  o.choose(KEEPER, [pocket.node])
  const feed = await pocket.open('bridge.bots.open', {})
  const chat = await pocket.open('bridge.bot.open', { botId: KEEPER })
  await o.net.request('bridge.policy', { node: pocket.node, blocked: true })
  await vi.waitFor(() => expect(chat.seen.error).toBeDefined(), { timeout: 15_000 })
  await vi.waitFor(() => expect(feed.seen.error).toBeDefined(), { timeout: 15_000 })
}, 120_000)
