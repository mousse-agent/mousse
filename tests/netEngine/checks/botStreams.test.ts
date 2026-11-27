/**
 * The bot streams over an engine pairing, with "Work on threads" off on the owner: the paired device opens the bots
 * feed and a bot's chat on the owner and reads both, and loses both at once when its bot level goes to Off. The v1
 * side of the same streams is `tests/net/bridge/remote/botStreams.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type StreamDescriptor, type StreamId } from '../../../src/shared/net'
import { BOT_STREAM_EVENT_TYPES } from '../../../src/shared/net/envelope'
import { ThreadDisplayProjection } from '../../../src/mms/bridge/remote/ThreadDisplayProjection'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { Fabric, type Computer } from './harness'

describe('bot streams over an engine pairing', () => {
  const fabric = new Fabric()
  let owner: Computer, caller: Computer
  let callerOnOwner: NodeId, ownerOnCaller: NodeId
  let botId: string

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    caller = await fabric.computer('caller')
    ;({ callerOnOwner, ownerOnCaller } = await fabric.pair(owner, caller))
    await fabric.settle()
    await fabric.connect(caller, ownerOnCaller)
    // A real bot starts its first turn on the computer's own providers; what is tested here is what crosses the wire.
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    const made = await owner.mms.personalBots!.service.create({
      look: { colour: 'teal', accessory: 'cap' },
      name: 'Server keeper',
      description: 'Keep the servers up',
      clientRequestId: 'engine-bot-1'
    })
    botId = made.bot.id
    owner.mms.botDeviceAccess.set(botId, { mode: 'chosen', nodes: [callerOnOwner] })
    await owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)
    expect((await owner.dispatch('netEngine.status', {}, true)).workOnThreads).toBe(false)
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  /** Opens a bot stream on the owner and keeps reading it: whether it caught up, and the error that ended it. */
  async function open(method: 'bridge.bots.open' | 'bridge.bot.open', params: unknown) {
    const client = caller.mms.netEngine.client(ownerOnCaller)
    const opened = (await client.rpc(method, params, { id: newId('rpc'), deadlineMs: 10_000 })) as { descriptor: StreamDescriptor }
    const stream = opened.descriptor.id as StreamId
    const store = caller.mms.bridge.threads.store
    if (!store.getStream(stream)) store.createStream({ ...opened.descriptor, authority: ownerOnCaller }, 1)
    caller.mms.netEngine.bind(stream, ownerOnCaller)
    const seen = { ready: false, error: undefined as string | undefined }
    const subscription = client.subscribe(stream, {
      onRecord: () => undefined,
      onCaughtUp: () => { seen.ready = true },
      onSnapshotInstalled: () => { seen.ready = true },
      onError: (code) => { seen.error = code }
    })
    await vi.waitFor(() => expect(seen.ready || seen.error).toBeTruthy(), { timeout: 20_000 })
    return { stream, seen, close: () => subscription.close() }
  }

  it('reads the bots feed and a bot\'s chat with thread sharing off, and loses both when its bot level goes to Off', async () => {
    const feed = await open('bridge.bots.open', {})
    const chat = await open('bridge.bot.open', { botId })
    expect(feed.seen).toEqual({ ready: true, error: undefined })
    expect(chat.seen).toEqual({ ready: true, error: undefined })
    // Both are the device's own, open while it reaches the bot.
    expect(owner.mms.bridge.threads.privateAccess(feed.stream)).toMatchObject({ reader: callerOnOwner, kind: 'bots', open: true })
    expect(owner.mms.bridge.threads.privateAccess(chat.stream)).toMatchObject({ reader: callerOnOwner, kind: 'bot', open: true })
    // The feed the owner serves it, from the real bots: the bot, how far its chat is read, and its newest message.
    const reader = owner.mms.bridge.threads.store.openSnapshot(feed.stream)
    const projection = new ThreadDisplayProjection('mousse:bots', BOT_STREAM_EVENT_TYPES)
    let served: any
    try {
      for (;;) {
        const page = reader.next(4 * 1024 * 1024)
        for (const record of page.records) {
          const update = projection.accept(decodeEnvelope(record.envelope).envelope)
          if (update?.kind === 'snapshot') served = update.value
        }
        if (page.done) break
      }
    } finally {
      reader.close()
    }
    expect(served).toMatchObject({ kind: 'mousse.bots', version: 1, bots: [{ id: botId, name: 'Server keeper', readSeq: expect.any(Number), telling: { attention: [] } }] })
    expect(served.bots).toHaveLength(1)

    await owner.dispatch('bridge.policy', { node: callerOnOwner, bots: 'off' }, true)
    await vi.waitFor(() => expect(chat.seen.error).toBe('forbidden'), { timeout: 20_000 })
    await vi.waitFor(() => expect(feed.seen.error).toBe('forbidden'), { timeout: 20_000 })
    feed.close()
    chat.close()
  }, 120_000)
})
