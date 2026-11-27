/**
 * The bots of another computer on the viewing computer, over two real daemons paired through the engine: the viewer
 * lists the owner's bot under a qualified id from the owner's bots feed, fills the copy of its chat from its stream
 * (display-only notes never written), keeps both while the owner is out of reach, and loses both, on disk too, when
 * the owner takes the bot from its Devices or sets the viewer's bot level to Off. "Work on threads" stays off on the
 * owner throughout. The same rules with a scripted Bridge are `tests/net/bridge/routed/remoteBotRegistry.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { SqliteRemoteBots } from '../../../src/mms/bridge/routed/remoteBotStore'
import type { RemoteBotRegistry } from '../../../src/mms/bridge/routed/RemoteBotRegistry'
import { Fabric, type Computer } from './harness'

describe('bots of another computer on the viewing computer', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  let writer: string
  const registry = (): RemoteBotRegistry => viewer.mms.bridge.remoteBots
  const listed = (): Array<[string, boolean]> => registry().rows().map((row) => [row.id, row.offline === true])
  /** What the viewer keeps on disk: what its next start would read. */
  const disk = () => {
    const store = new SqliteRemoteBots(registry().copyPath)
    try {
      return { feeds: store.feeds().map((entry) => JSON.parse(entry.snapshot).bots.map((bot: { id: string }) => bot.id)), chats: store.chats().map((chat) => [chat.bot, chat.messages]) }
    } finally {
      store.close()
    }
  }
  /** The viewer's Bridge copies of the owner's bot streams (the bots feed and each chat), in its `net.db`. */
  const streamCopies = (): string[] =>
    (viewer.mms.net.runtime().db.database
      .prepare("SELECT entity FROM net_bridge_hub_threads WHERE target=? AND entity LIKE 'private:mousse:bot%'")
      .all(ownerOnViewer) as Array<{ entity: string }>)
      .map((row) => row.entity)
      .sort()
  const say = (botId: string, seq: number, text: string) =>
    owner.mms.personalBots!.events.emit('message', {
      botId,
      message: { id: `bm_${botId}_${seq}`, seq, at: new Date().toISOString(), author: 'bot', kind: 'reply', text, chips: [] },
      botName: 'bot',
      quiet: false
    })

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    await fabric.connect(viewer, ownerOnViewer)
    // A real bot starts its first turn on the computer's own providers; what is tested here is what crosses the wire.
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    const make = async (name: string, request: string) =>
      (await owner.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name, description: name, clientRequestId: request })).bot.id
    keeper = await make('Server keeper', 'copies-bot-1')
    writer = await make('Writer', 'copies-bot-2')
    for (const botId of [keeper, writer]) owner.mms.botDeviceAccess.set(botId, { mode: 'chosen', nodes: [viewerOnOwner] })
    await owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('lists the owner’s bots, copies an open chat without its display-only notes, and keeps both while the owner is away', async () => {
    await vi.waitFor(() => expect(listed().sort()).toEqual([[`${ownerOnViewer}:${keeper}`, false], [`${ownerOnViewer}:${writer}`, false]].sort()), { timeout: 30_000 })

    const notes: string[] = []
    await registry().chats.open(ownerOnViewer, keeper, { delta: (type) => notes.push(type) })
    say(keeper, 1, 'The servers are up.')
    await vi.waitFor(() => expect(registry().chats.messages(ownerOnViewer, keeper).map((message) => message.text)).toContain('The servers are up.'), { timeout: 20_000 })
    const before = registry().chats.messages(ownerOnViewer, keeper)
    owner.mms.personalBots!.events.emit('activity', { botId: keeper, activationId: 'act_copies', chip: { kind: 'tool', label: 'Reading the logs' } })
    await vi.waitFor(() => expect(notes).toContain('bots.activity'), { timeout: 20_000 })
    expect(registry().chats.messages(ownerOnViewer, keeper)).toEqual(before)

    // The owner goes out of reach: the bots stay listed from the copy, marked offline, and the chat copy stays.
    await fabric.restartHelper(owner)
    await vi.waitFor(() => expect(listed().every(([, offline]) => offline)).toBe(true), { timeout: 30_000 })
    expect(listed()).toHaveLength(2)
    expect(disk().feeds.flat().sort()).toEqual([keeper, writer].sort())
    expect(disk().chats).toEqual([[keeper, before.length]])
    expect(registry().chats.messages(ownerOnViewer, keeper)).toEqual(before)

    // Back: listed live again.
    await fabric.connect(viewer, ownerOnViewer)
    await vi.waitFor(() => expect(listed().every(([, offline]) => !offline)).toBe(true), { timeout: 30_000 })
  }, 180_000)

  it('loses a bot the owner takes from its Devices: row and chat copy, on disk too', async () => {
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, writer)).toBeDefined(), { timeout: 30_000 })
    await registry().chats.open(ownerOnViewer, writer)
    say(writer, 1, 'A draft is ready.')
    await vi.waitFor(() => expect(disk().chats.map(([bot]) => bot)).toContain(writer), { timeout: 20_000 })
    await vi.waitFor(() => expect(streamCopies()).toContain(`private:mousse:bot:${writer}`), { timeout: 20_000 })

    owner.mms.botDeviceAccess.set(writer, { mode: 'chosen', nodes: [] })
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, writer)).toBeUndefined(), { timeout: 30_000 })
    expect(registry().chats.messages(ownerOnViewer, writer)).toEqual([])
    expect(disk().feeds.flat()).toEqual([keeper])
    expect(disk().chats.map(([bot]) => bot)).toEqual([keeper])
    await vi.waitFor(() => expect(streamCopies()).not.toContain(`private:mousse:bot:${writer}`), { timeout: 20_000 })
  }, 120_000)

  it('loses every bot of the owner when its bot level for the viewer goes to Off: rows, chat copies and stream copies', async () => {
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, keeper)?.offline).toBeUndefined(), { timeout: 30_000 })
    expect(disk().chats.map(([bot]) => bot)).toEqual([keeper])

    await owner.dispatch('bridge.policy', { node: viewerOnOwner, bots: 'off' }, true)
    await vi.waitFor(() => expect(registry().rows()).toEqual([]), { timeout: 30_000 })
    expect(registry().chats.messages(ownerOnViewer, keeper)).toEqual([])
    expect(disk()).toEqual({ feeds: [], chats: [] })
    await vi.waitFor(() => expect(streamCopies()).toEqual([]), { timeout: 20_000 })
  }, 120_000)
})
