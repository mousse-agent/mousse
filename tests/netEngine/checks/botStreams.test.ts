/**
 * The bot streams over engine pairings, with "Work on threads" off on the owner: a paired device opens the bots feed
 * and a bot's chat on the owner and reads both, records and display-only deltas alike, and loses both at once when its
 * bot level goes to Off, when it is blocked (which leaves the pairing a narrower role, still connected), and when it is
 * unpaired. The v1 side of the same streams is `tests/net/bridge/remote/botStreams.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type StreamDescriptor, type StreamId } from '../../../src/shared/net'
import { BOT_STREAM_EVENT_TYPES } from '../../../src/shared/net/envelope'
import { ThreadDisplayProjection } from '../../../src/mms/bridge/remote/ThreadDisplayProjection'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { Fabric, type Computer } from './harness'

describe('bot streams over an engine pairing', () => {
  const fabric = new Fabric()
  let owner: Computer
  /** One caller per way of losing the bots, each paired with the owner. */
  const callers: Record<'off' | 'blocked' | 'removed', { computer: Computer; onOwner: NodeId; ownerOn: NodeId }> = {} as never
  let botId: string

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    for (const name of ['off', 'blocked', 'removed'] as const) {
      const computer = await fabric.computer(name)
      const { callerOnOwner, ownerOnCaller } = await fabric.pair(owner, computer)
      callers[name] = { computer, onOwner: callerOnOwner, ownerOn: ownerOnCaller }
    }
    await fabric.settle()
    for (const { computer, ownerOn } of Object.values(callers)) await fabric.connect(computer, ownerOn)
    // A real bot starts its first turn on the computer's own providers; what is tested here is what crosses the wire.
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    const made = await owner.mms.personalBots!.service.create({
      look: { colour: 'teal', accessory: 'cap' },
      name: 'Server keeper',
      description: 'Keep the servers up',
      clientRequestId: 'engine-bot-1'
    })
    botId = made.bot.id
    owner.mms.botDeviceAccess.set(botId, { mode: 'chosen', nodes: Object.values(callers).map((caller) => caller.onOwner) })
    await owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)
    expect((await owner.dispatch('netEngine.status', {}, true)).workOnThreads).toBe(false)
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  /**
   * Opens a bot stream on the owner and keeps reading it: what the caller stored from it, the deltas it was sent,
   * whether it caught up, and the error that ended it.
   */
  async function open(caller: { computer: Computer; ownerOn: NodeId }, method: 'bridge.bots.open' | 'bridge.bot.open', params: unknown) {
    const client = caller.computer.mms.netEngine.client(caller.ownerOn)
    const opened = (await client.rpc(method, params, { id: newId('rpc'), deadlineMs: 10_000 })) as { descriptor: StreamDescriptor; subject: string }
    const stream = opened.descriptor.id as StreamId
    const store = caller.computer.mms.bridge.threads.store
    if (!store.getStream(stream)) store.createStream({ ...opened.descriptor, authority: caller.ownerOn }, 1)
    caller.computer.mms.netEngine.bind(stream, caller.ownerOn)
    const seen = { ready: false, error: undefined as string | undefined }
    const deltas: Array<{ type: string; data: any }> = []
    const offDeltas = client.onEphemeral((message) => {
      if (message.stream !== stream) return
      const body = message.data as { threadId: string; type: string; data: unknown }
      if (body.threadId === opened.subject) deltas.push({ type: body.type, data: body.data })
    })
    const subscription = client.subscribe(stream, {
      onRecord: () => undefined,
      onCaughtUp: () => { seen.ready = true },
      onSnapshotInstalled: () => { seen.ready = true },
      onError: (code) => { seen.error = code }
    })
    await vi.waitFor(() => expect(seen.ready || seen.error).toBeTruthy(), { timeout: 20_000 })
    /** What the caller holds of the stream: the newest snapshot it received. */
    const received = () => {
      const reader = store.openSnapshot(stream)
      const projection = new ThreadDisplayProjection(opened.subject, BOT_STREAM_EVENT_TYPES)
      let snapshot: any
      try {
        for (;;) {
          const page = reader.next(4 * 1024 * 1024)
          for (const record of page.records) {
            const update = projection.accept(decodeEnvelope(record.envelope).envelope)
            if (update?.kind === 'snapshot') snapshot = update.value
          }
          if (page.done) return snapshot
        }
      } finally {
        reader.close()
      }
    }
    return { stream, seen, deltas, received, close: () => { offDeltas(); subscription.close() } }
  }

  it('reads the bots feed and a bot\'s chat with thread sharing off, and loses both when its bot level goes to Off', async () => {
    const caller = callers.off
    const feed = await open(caller, 'bridge.bots.open', {})
    const chat = await open(caller, 'bridge.bot.open', { botId })
    expect(feed.seen).toEqual({ ready: true, error: undefined })
    expect(chat.seen).toEqual({ ready: true, error: undefined })
    // What the caller received, from the real bots: the bot, how far its chat is read, and its telling metadata.
    expect(feed.received()).toMatchObject({ kind: 'mousse.bots', version: 1, bots: [{ id: botId, name: 'Server keeper', readSeq: expect.any(Number), telling: { attention: [] } }] })
    expect(feed.received().bots).toHaveLength(1)
    expect(chat.received()).toMatchObject({ kind: 'mousse.bot', version: 1, bot: { id: botId } })
    // The bot's live chip, display-only.
    const chip = { kind: 'tool', label: 'Reading the logs' }
    owner.mms.personalBots!.events.emit('activity', { botId, activationId: 'act_engine', chip })
    await vi.waitFor(() => expect(chat.deltas).toContainEqual({ type: 'bots.activity', data: { botId, activationId: 'act_engine', chip } }), { timeout: 20_000 })

    await owner.dispatch('bridge.policy', { node: caller.onOwner, bots: 'off' }, true)
    await vi.waitFor(() => expect(chat.seen.error).toBe('forbidden'), { timeout: 20_000 })
    await vi.waitFor(() => expect(feed.seen.error).toBe('forbidden'), { timeout: 20_000 })
    feed.close()
    chat.close()
  }, 120_000)

  it('a blocked pairing, still connected in a narrower role, loses both at once', async () => {
    const caller = callers.blocked
    const feed = await open(caller, 'bridge.bots.open', {})
    const chat = await open(caller, 'bridge.bot.open', { botId })
    expect([feed.seen.error, chat.seen.error]).toEqual([undefined, undefined])
    await owner.dispatch('bridge.policy', { node: caller.onOwner, blocked: true }, true)
    await vi.waitFor(() => expect(chat.seen.error).toBe('forbidden'), { timeout: 20_000 })
    await vi.waitFor(() => expect(feed.seen.error).toBe('forbidden'), { timeout: 20_000 })
    expect(owner.mms.bridge.threads.privateReaders()).not.toContain(caller.onOwner)
    feed.close()
    chat.close()
  }, 120_000)

  it('an unpaired device loses both, and nothing is kept for it', async () => {
    const caller = callers.removed
    const feed = await open(caller, 'bridge.bots.open', {})
    const chat = await open(caller, 'bridge.bot.open', { botId })
    expect([feed.seen.error, chat.seen.error]).toEqual([undefined, undefined])
    await owner.dispatch('netEngine.remove', { node: caller.onOwner }, true)
    await vi.waitFor(() => expect(chat.seen.error).toBeDefined(), { timeout: 20_000 })
    await vi.waitFor(() => expect(feed.seen.error).toBeDefined(), { timeout: 20_000 })
    await vi.waitFor(() => expect(owner.mms.bridge.threads.privateReaders()).not.toContain(caller.onOwner), { timeout: 20_000 })
    feed.close()
    chat.close()
  }, 120_000)
})
