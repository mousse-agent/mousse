/**
 * The bots of other computers on the viewing computer (`RemoteBotRegistry`, `RemoteBotChats`), over the real copy on
 * disk (`SqliteRemoteBots`) and a scripted Bridge, so each feed snapshot, each chat record and each way a stream ends
 * is under the test's control. What the disk holds is read through a second store on the same file, as a restart
 * would read it. The same flows over two real daemons are `tests/netEngine/checks/remoteBotCopies.test.ts`.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBotRegistry } from '../../../../src/mms/bridge/routed/RemoteBotRegistry'
import { botChatSubject } from '../../../../src/mms/bridge/routed/RemoteBotChats'
import { REMOTE_BOT_COPY_LIMITS, SqliteRemoteBots, type RemoteBotCopyLimits } from '../../../../src/mms/bridge/routed/remoteBotStore'
import { PRIVATE_BOTS_SUBJECT } from '../../../../src/mms/bridge/remote/privateStreams'
import { NetError, newId, type NodeId } from '../../../../src/shared/net'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

const KEEPER = 'bot-keeper'
const WRITER = 'bot-writer'
const row = (id: string, name = id) => ({ id, name, stateText: 'Idle', readSeq: 0, telling: { attention: [] } })
const feedOf = (...ids: string[]) => ({ kind: 'mousse.bots', version: 1, bots: ids.map((id) => row(id)) })
const message = (seq: number, text = `message ${seq}`) => ({ id: `bm_${seq}`, seq, at: new Date(1_700_000_000_000 + seq).toISOString(), author: 'bot', kind: 'reply', text, chips: [] })
const chatOf = (botId: string, messages: unknown[]) => ({ kind: 'mousse.bot', version: 1, bot: row(botId), page: { messages } })

interface Attached {
  update(value: { kind: 'snapshot'; value: unknown } | { kind: 'event'; type: string; data: unknown }): void
  error(code: string): void
  delta?(type: string, data: unknown): void
  close: ReturnType<typeof vi.fn>
}

function harness(options: { limits?: Partial<RemoteBotCopyLimits> } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-bots-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const path = join(dir, 'bots', 'other-computers.db')
  const node = newId('node') as NodeId
  const roster: { list: Array<{ node: NodeId; name: string }> | undefined } = { list: [{ node, name: 'Mac mini' }] }
  const online = new Set<NodeId>([node])
  /** The Bridge's attachments, by `<node> <subject>`, and what the bot's computer answers to an open. */
  const attached = new Map<string, Attached>()
  const refuse = { feed: undefined as NetError | undefined }
  const hub = {
    attach: vi.fn(async (ref: { nodeId: NodeId; entityId: string }, update: Attached['update'], error: Attached['error'], _options: unknown, delta?: Attached['delta']) => {
      if (ref.entityId === PRIVATE_BOTS_SUBJECT && refuse.feed) throw refuse.feed
      const close = vi.fn()
      attached.set(`${ref.nodeId} ${ref.entityId}`, { update, error, delta, close })
      return { close, descriptor: {} as never }
    }),
    dropCopy: vi.fn(async () => true)
  }
  const client = { rpc: vi.fn(async () => ({})) }
  const stores: SqliteRemoteBots[] = []
  const open = (): RemoteBotRegistry => {
    const store = new SqliteRemoteBots(path, Date, options.limits)
    stores.push(store)
    const registry = new RemoteBotRegistry({
      hub: hub as never,
      client: () => client as never,
      store,
      computers: () => roster.list,
      online: (each) => online.has(each),
      enabled: () => true,
      // Long enough that a test sees what is written at once, not on the timer.
      saveSettleMs: 60_000
    })
    cleanups.push(() => registry.close())
    return registry
  }
  /** What a restart would read from disk: a second store on the same file. */
  const disk = () => {
    const store = new SqliteRemoteBots(path)
    try {
      return { feeds: store.feeds().map((entry) => ({ node: entry.node, bots: JSON.parse(entry.snapshot).bots.map((bot: { id: string }) => bot.id) })), chats: store.chats() }
    } finally {
      store.close()
    }
  }
  const feed = () => attached.get(`${node} ${PRIVATE_BOTS_SUBJECT}`)!
  const chat = (botId: string) => attached.get(`${node} ${botChatSubject(botId)}`)!
  /** The computer goes away: what it last sent is written to disk. */
  const away = (registry: RemoteBotRegistry) => {
    online.delete(node)
    registry.nodeOffline(node)
  }
  /** It is reached again (its streams stay attached through the Bridge). */
  const back = async (registry: RemoteBotRegistry) => {
    online.add(node)
    await registry.reconcile()
  }
  /**
   * Connects, reads the feed with KEEPER and WRITER, opens KEEPER's chat with two messages, and leaves the computer
   * away, so the feed is on disk as a long session would have it by then.
   */
  const listed = async (registry: RemoteBotRegistry) => {
    await registry.reconcile()
    await vi.waitFor(() => expect(feed()).toBeDefined())
    feed().update({ kind: 'snapshot', value: feedOf(KEEPER, WRITER) })
    await registry.chats.open(node, KEEPER)
    chat(KEEPER).update({ kind: 'snapshot', value: chatOf(KEEPER, [message(1), message(2)]) })
    away(registry)
  }
  return { node, roster, online, hub, refuse, open, disk, feed, chat, listed, away, back, path }
}

describe('the bots of another computer', () => {
  it('are listed under qualified ids, with the computer they live on', async () => {
    const h = harness()
    const registry = h.open()
    await registry.reconcile()
    await vi.waitFor(() => expect(h.feed()).toBeDefined())
    h.feed().update({ kind: 'snapshot', value: feedOf(KEEPER) })
    expect(registry.rows()).toEqual([expect.objectContaining({ id: `${h.node}:${KEEPER}`, botId: KEEPER, node: h.node, computerName: 'Mac mini', name: KEEPER })])
    expect(registry.rows()[0]!.offline).toBeUndefined()
  })

  it('stay listed from the copy, marked offline, while their computer is away; the chat copy stays readable', async () => {
    const h = harness()
    const registry = h.open()
    await h.listed(registry)
    expect(registry.rows().map((bot) => [bot.botId, bot.offline])).toEqual([[KEEPER, true], [WRITER, true]])
    expect(registry.chats.messages(h.node, KEEPER).map((each) => each.id)).toEqual(['bm_1', 'bm_2'])
    expect(h.disk()).toEqual({ feeds: [{ node: h.node, bots: [KEEPER, WRITER] }], chats: [expect.objectContaining({ node: h.node, bot: KEEPER, messages: 2 })] })
    // Nothing was dropped: offline is not a no.
    expect(h.hub.dropCopy).not.toHaveBeenCalled()
  })

  it('are listed after a restart from the copy on disk, offline, before their computer is reached, with their chat', async () => {
    const h = harness()
    await h.listed(h.open())
    const after = h.open()
    // Read on first use, without asking the computer.
    expect(after.rows().map((bot) => [bot.id, bot.offline])).toEqual([[`${h.node}:${KEEPER}`, true], [`${h.node}:${WRITER}`, true]])
    expect(after.chats.messages(h.node, KEEPER).map((each) => each.id)).toEqual(['bm_1', 'bm_2'])
    expect(h.hub.attach).toHaveBeenCalledTimes(2)
    // Its chat can't be opened while the computer is away; nothing is queued for it.
    await expect(after.chats.open(h.node, KEEPER)).rejects.toMatchObject({ code: 'peer_offline' })
  })
})

/**
 * Every way this computer loses bots of another computer (rule 10), and which it loses. Each drops the rows and the
 * chat copies at once, on disk too, and the Bridge's copy of their streams.
 */
const losses: Array<{ name: string; lost: string[]; lose(h: ReturnType<typeof harness>, registry: RemoteBotRegistry): Promise<void> | void }> = [
  {
    name: 'its bots feed is refused (its bot level for this one is Off)',
    lost: [KEEPER, WRITER],
    lose: (h, registry) => {
      // The feed is opened again (it ended while the session stayed up), and the computer refuses it now.
      h.feed().error('cancelled')
      h.refuse.feed = new NetError('forbidden', 'Bots are off for this device.', { details: { reason: 'bots_off' } })
      registry.nodeOnline(h.node)
    }
  },
  { name: 'its bots feed ends with forbidden', lost: [KEEPER, WRITER], lose: (h) => h.feed().error('forbidden') },
  { name: 'it leaves the user’s computers', lost: [KEEPER, WRITER], lose: async (h, registry) => { h.roster.list = []; await registry.reconcile() } },
  { name: 'its feed no longer lists the bot', lost: [KEEPER], lose: (h) => h.feed().update({ kind: 'snapshot', value: feedOf(WRITER) }) },
  { name: 'the bot’s chat ends with forbidden', lost: [KEEPER], lose: (h) => h.chat(KEEPER).error('forbidden') },
  { name: 'the bot’s chat ends as a stream that is not there (the bot was deleted)', lost: [KEEPER], lose: (h) => h.chat(KEEPER).error('stream_unknown') }
]

describe('losing bots of another computer', () => {
  for (const loss of losses)
    it(`drops ${loss.lost.length > 1 ? 'every bot' : 'the bot'}, row and chat copy, on disk too, when ${loss.name}`, async () => {
      const h = harness()
      const registry = h.open()
      await h.listed(registry)
      await h.back(registry)
      expect(h.disk().chats).toHaveLength(1)

      await loss.lose(h, registry)
      const kept = [KEEPER, WRITER].filter((id) => !loss.lost.includes(id))
      await vi.waitFor(() => expect(registry.rows().map((bot) => bot.botId)).toEqual(kept))
      expect(registry.chats.messages(h.node, KEEPER)).toEqual([])
      // On disk, at once: what a restart would read.
      const disk = h.disk()
      expect(disk.chats).toEqual([])
      expect(disk.feeds.flatMap((entry) => entry.bots)).toEqual(kept)
      expect(h.open().rows().map((bot) => bot.botId)).toEqual(kept)
      // The Bridge's copy of the lost chat's stream goes too, and of the feed's when the whole feed was refused.
      expect(h.hub.dropCopy).toHaveBeenCalledWith({ nodeId: h.node, entityId: botChatSubject(KEEPER) }, expect.anything())
      if (!kept.length) expect(h.hub.dropCopy).toHaveBeenCalledWith({ nodeId: h.node, entityId: PRIVATE_BOTS_SUBJECT }, expect.anything())
    })
})

describe('the copy of a bot’s chat', () => {
  it('takes the stream’s snapshot and its messages, and never a display-only note', async () => {
    const h = harness()
    const registry = h.open()
    await h.listed(registry)
    await h.back(registry)
    const heard: Array<[string, unknown]> = []
    await registry.chats.open(h.node, KEEPER, { delta: (type, data) => heard.push([type, data]) })
    h.chat(KEEPER).update({ kind: 'event', type: 'bots.message', data: { botId: KEEPER, message: message(3) } })
    // A changed message takes the place of the one kept.
    h.chat(KEEPER).update({ kind: 'event', type: 'bots.message', data: { botId: KEEPER, message: message(2, 'edited') } })
    const before = h.disk()
    h.chat(KEEPER).delta!('bots.activity', { botId: KEEPER, activationId: 'act_1', chip: { kind: 'tool', label: 'Reading' } })
    h.chat(KEEPER).delta!('bots.reply', { botId: KEEPER, messageId: 'msg_1', role: 'assistant', text: 'The servers', added: false })
    // The window hears them; the copy does not change.
    expect(heard.map(([type]) => type)).toEqual(['bots.activity', 'bots.reply'])
    expect(h.disk()).toEqual(before)
    expect(registry.chats.messages(h.node, KEEPER).map((each) => [each.id, each.text])).toEqual([['bm_1', 'message 1'], ['bm_2', 'edited'], ['bm_3', 'message 3']])
  })

  it('keeps the newest messages of a bot within its count and size, and leaves out a message too large', async () => {
    const limits = { chatMessages: 5, messageBytes: 2_000, chatBytes: 4 * 1_000 }
    const h = harness({ limits })
    const registry = h.open()
    await h.listed(registry)
    await h.back(registry)
    h.chat(KEEPER).update({ kind: 'snapshot', value: chatOf(KEEPER, Array.from({ length: 8 }, (_, at) => message(at + 1))) })
    expect(registry.chats.messages(h.node, KEEPER).map((each) => each.seq)).toEqual([4, 5, 6, 7, 8])
    h.chat(KEEPER).update({ kind: 'event', type: 'bots.message', data: { botId: KEEPER, message: message(9, 'x'.repeat(3_000)) } })
    expect(registry.chats.messages(h.node, KEEPER).map((each) => each.seq)).toEqual([4, 5, 6, 7, 8])
    // Four of about 1 100 bytes are more than the bot's 4 000: the oldest go until the rest fit.
    for (let seq = 10; seq <= 13; seq++)
      h.chat(KEEPER).update({ kind: 'event', type: 'bots.message', data: { botId: KEEPER, message: message(seq, 'y'.repeat(1_000)) } })
    expect(h.disk().chats[0]!.bytes).toBeLessThanOrEqual(limits.chatBytes)
    expect(registry.chats.messages(h.node, KEEPER).map((each) => each.seq)).toEqual([11, 12, 13])
  })

  it('keeps every chat together within the total: another chat goes, whole, never the one being written', async () => {
    const limits = { totalChatBytes: 3_000 }
    const h = harness({ limits })
    const registry = h.open()
    await h.listed(registry)
    await h.back(registry)
    // About 1 100 bytes each.
    const big = (seq: number) => message(seq, 'z'.repeat(1_000))
    await registry.chats.open(h.node, WRITER)
    h.chat(WRITER).update({ kind: 'snapshot', value: chatOf(WRITER, [big(1), big(2)]) })
    expect(h.disk().chats.map((chat) => chat.bot).sort()).toEqual([KEEPER, WRITER])
    h.chat(KEEPER).update({ kind: 'snapshot', value: chatOf(KEEPER, [big(1)]) })
    h.chat(KEEPER).update({ kind: 'event', type: 'bots.message', data: { botId: KEEPER, message: big(2) } })
    const chats = h.disk().chats
    expect(chats.map((chat) => chat.bot)).toEqual([KEEPER])
    expect(chats.reduce((sum, chat) => sum + chat.bytes, 0)).toBeLessThanOrEqual(limits.totalChatBytes)
  })

  it('has named defaults for every cap', () => {
    // The plan's numbers: the newest ~200 messages per bot, within a total.
    expect(REMOTE_BOT_COPY_LIMITS.chatMessages).toBe(200)
    expect(REMOTE_BOT_COPY_LIMITS.totalChatBytes).toBeGreaterThanOrEqual(REMOTE_BOT_COPY_LIMITS.chatBytes)
  })
})

describe('a feed', () => {
  it('lists at most the rows kept for one computer', async () => {
    const h = harness({ limits: { feedRows: 3 } })
    const registry = h.open()
    await registry.reconcile()
    await vi.waitFor(() => expect(h.feed()).toBeDefined())
    h.feed().update({ kind: 'snapshot', value: feedOf('bot-a', 'bot-b', 'bot-c', 'bot-d', 'bot-e') })
    expect(registry.rows().map((bot) => bot.botId)).toEqual(['bot-a', 'bot-b', 'bot-c'])
  })

  it('too large for its copy is not kept on disk, so a restart does not list bots that may be gone', async () => {
    const h = harness({ limits: { feedBytes: 300 } })
    const registry = h.open()
    await registry.reconcile()
    await vi.waitFor(() => expect(h.feed()).toBeDefined())
    h.feed().update({ kind: 'snapshot', value: feedOf(KEEPER) })
    h.away(registry)
    expect(h.disk().feeds).toHaveLength(1)
    await h.back(registry)
    h.feed().update({ kind: 'snapshot', value: feedOf(KEEPER, 'bot-a', 'bot-b', 'bot-c') })
    h.away(registry)
    expect(h.disk().feeds).toEqual([])
  })
})
