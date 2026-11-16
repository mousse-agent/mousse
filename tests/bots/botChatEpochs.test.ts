import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../src/shared/settings'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotMemoryAdmin } from '../../src/mms/bots/memory/admin'
import { BOT_MEMORY_PROTOCOL, createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { botFixture, createBot, finish, PI, start, type BotFixture } from './botFixture'

/**
 * Chat epochs (docs/plans/bot-context.md §14), at the engine, with the real pack provider: with the Labs setting on and
 * a runtime that resumes a thread's conversation, a bot's chat turn after the first of its epoch is not cleared and runs
 * on the thread's history, with the same system text and tool list, so what the runtime already sent stays byte for
 * byte the start of its next request. A failed turn, /clear, a forget, a model change, a full conversation and a cold
 * one past the mid mark each start the next turn from a cleared context. The pack's side is in
 * tests/bots/memory/botChatEpochPack.test.ts.
 */

describe('a bot chat on epochs', () => {
  let f: BotFixture
  let botId: string
  let memory: BotMemoryStore
  let on = true
  beforeEach(async () => {
    on = true
    f = botFixture()
    const defaults = getDefaultSettings()
    f.host.settings = { get: () => ({ ...defaults, experimental: { ...defaults.experimental, botChatEpochs: on } }), set: () => defaults } as never
    f.host.chatResumes = (instanceId) => instanceId === PI.instanceId
    memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now })
    f.host.context = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} } })
    ;({ botId } = await createBot(f, { reply: 'Hello! I am ready.' }))
  })
  afterEach(() => f.close())

  async function chatTurn(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  it('a later turn resumes the conversation: nothing cleared or rebuilt, and the same system text and tools, a memory save between them included', async () => {
    const cleared = f.cleared.length
    const first = await chatTurn('What is on today?', 'u1')
    await finish(f, first.payload, 'completed', { text: 'Two meetings.' })
    memory.save(botId, { lane: 'chat', kind: 'owner', text: 'The owner likes short replies.', activationId: first.activation.id })
    const second = await chatTurn('And tomorrow?', 'u2')
    expect(f.cleared.length).toBe(cleared)
    expect(second.prepared.history).toBe('thread')
    // Only what is new: no protocol, memory or recent chat again.
    expect(second.prepared.preamble).not.toContain(BOT_MEMORY_PROTOCOL)
    // The runtime's next request starts with every byte its last one sent: the same system text and tool list, then
    // the first turn's conversation, resumed (not cleared: `thread`).
    expect(second.prepared.instructions).toBe(first.prepared.instructions)
    expect(second.prepared.policy.tools).toEqual(first.prepared.policy.tools)
    // The turn's usage row names the epoch, as the first turn's does.
    expect(f.store.turnUsage(second.activation.id, 1)!.contextGen).toBe(f.store.turnUsage(first.activation.id, 1)!.contextGen)
    expect(f.store.turnUsage(second.activation.id, 1)!.freshContext).toBe(false)
    await finish(f, second.payload, 'completed', { text: 'Free.' })

    // The control: with the setting off, every chat turn starts from a cleared context and the whole pack again.
    on = false
    const off = await chatTurn('And Friday?', 'u3')
    expect(f.cleared.length).toBe(cleared + 1)
    expect(off.prepared.history).toBe('cleared')
    expect(off.prepared.preamble).toContain(BOT_MEMORY_PROTOCOL)
  })

  it('a runtime that does not resume a thread\'s conversation keeps today\'s cleared context', async () => {
    f.host.chatResumes = () => false
    const cleared = f.cleared.length
    const turn = await chatTurn('Hi', 'u1')
    expect(turn.prepared.history).toBe('cleared')
    expect(f.cleared.length).toBe(cleared + 1)
  })

  it.each([
    ['a failed turn', async (turn: Awaited<ReturnType<typeof chatTurn>>) => { await finish(f, turn.payload, 'failed') }],
    ['/clear', async (turn: Awaited<ReturnType<typeof chatTurn>>) => {
      await finish(f, turn.payload, 'completed', { text: 'OK.' })
      await f.bots.clearChat(botId)
    }],
    ['a forget', async (turn: Awaited<ReturnType<typeof chatTurn>>) => {
      memory.save(botId, { lane: 'chat', kind: 'owner', text: 'My PIN hint is the dog.', activationId: turn.activation.id })
      await finish(f, turn.payload, 'completed', { text: 'Saved.' })
      createBotMemoryAdmin({ store: memory }).forget(botId, 'm1')
    }],
    ['a model change', async (turn: Awaited<ReturnType<typeof chatTurn>>) => {
      await finish(f, turn.payload, 'completed', { text: 'OK.' })
      f.candidates = [{ instanceId: PI.instanceId, model: 'some/other-model' }]
    }],
    ['a full conversation', async (turn: Awaited<ReturnType<typeof chatTurn>>) => {
      turn.prepared.metrics!({ totalResponseTimeMs: 1, context: { input: 2_000, cacheRead: 18_000 + 48_000, cacheWrite: 0, contextWindow: 400_000 } })
      await finish(f, turn.payload, 'completed', { text: 'OK.' })
    }],
    ['a cold conversation past the mid mark', async (turn: Awaited<ReturnType<typeof chatTurn>>) => {
      turn.prepared.metrics!({ totalResponseTimeMs: 1, context: { input: 2_000, cacheRead: 18_000 + 30_000, cacheWrite: 0, contextWindow: 400_000 }, promptCache: { at: f.clock.now, ttlMs: 3_600_000 } })
      await finish(f, turn.payload, 'completed', { text: 'OK.' })
      f.clock.now += 3_600_000 + 1
    }]
  ] as const)('%s starts the next turn from a cleared context', async (_name, between) => {
    const first = await chatTurn('Hi', 'u1')
    first.prepared.metrics!({ totalResponseTimeMs: 1, context: { input: 2_000, cacheRead: 18_000, cacheWrite: 0, contextWindow: 400_000 } })
    await finish(f, first.payload, 'completed', { text: 'Hi.' })
    const turn = await chatTurn('Go on', 'u2')
    expect(turn.prepared.history).toBe('thread')
    await between(turn)
    const cleared = f.cleared.length
    const next = await chatTurn('And now?', 'u3')
    expect(next.prepared.history).toBe('cleared')
    expect(f.cleared.length).toBe(cleared + 1)
    expect(next.prepared.preamble).toContain(BOT_MEMORY_PROTOCOL)
  })

  it('a runtime compaction on a later turn gives the whole memory again, not the turn\'s update, and ends the epoch', async () => {
    const first = await chatTurn('Hi', 'u1')
    memory.save(botId, { lane: 'chat', kind: 'owner', text: 'The owner likes short replies.', activationId: first.activation.id })
    await finish(f, first.payload, 'completed', { text: 'Hi.' })
    const turn = await chatTurn('Go on', 'u2')
    expect(turn.prepared.preamble).not.toContain(BOT_MEMORY_PROTOCOL)
    turn.prepared.steer!.compacted()
    const regive = turn.prepared.steer!.peek()!
    expect(regive).toContain('Your context was just summarised')
    expect(regive).toContain(BOT_MEMORY_PROTOCOL)
    expect(regive).toContain('The owner likes short replies.')
    await finish(f, turn.payload, 'completed', { text: 'OK.' })
    expect((await chatTurn('And now?', 'u3')).prepared.history).toBe('cleared')
  })

  it('a warm conversation past the mid mark goes on', async () => {
    const first = await chatTurn('Hi', 'u1')
    first.prepared.metrics!({ totalResponseTimeMs: 1, context: { input: 2_000, cacheRead: 18_000, cacheWrite: 0, contextWindow: 400_000 } })
    await finish(f, first.payload, 'completed', { text: 'Hi.' })
    const turn = await chatTurn('Go on', 'u2')
    turn.prepared.metrics!({ totalResponseTimeMs: 1, context: { input: 2_000, cacheRead: 18_000 + 30_000, cacheWrite: 0, contextWindow: 400_000 }, promptCache: { at: f.clock.now, ttlMs: 3_600_000 } })
    await finish(f, turn.payload, 'completed', { text: 'OK.' })
    f.clock.now += 10 * 60_000
    expect((await chatTurn('And now?', 'u3')).prepared.history).toBe('thread')
  })
})
