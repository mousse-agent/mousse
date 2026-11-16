import { afterEach, describe, expect, it } from 'vitest'
import { estimateTokens } from '../../../src/shared/bots/personal/memory'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { BOT_EPOCH_PROTOCOL_LINE, BOT_MEMORY_PROTOCOL, CHAT_EPOCH_KEY, createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { BOT_CHAT_EPOCH_MARKS, chatEpochEnd, contextBudget, type BotChatDigestState, type BotChatEpoch, type BotChatEpochEnd, type BotChatEpochVerdict } from '../../../src/mms/bots/memory/contextBudget'
import type { BotTurnUsageRow } from '../../../src/mms/bots/store/BotStore'
import { BOT_CHANGELOG_LATEST } from '../../../src/mms/bots/changelog'
import { disposeFixtures, HOUR, memoryFixture, type MemoryFixture } from './memoryFixture'

/**
 * Chat epochs (docs/plans/bot-context.md §14), at the pack: a new epoch's base folds the window to its tail in one step,
 * a running epoch's turn gets only what its conversation does not hold yet, and whatever could leave the runtime's
 * conversation out of step with the journal (a failed or stopped turn, /clear, a forget) ends the epoch. The engine
 * side (no clear, the thread's history, the same system text and tools) is in tests/bots/botChatEpochs.test.ts.
 */

afterEach(disposeFixtures)

const SEL = { instanceId: 'claude', model: 'claude-opus' }

function setup() {
  const fx = memoryFixture()
  fx.store.write(() => fx.store.setState('ada', 'changelog_seen', BOT_CHANGELOG_LATEST))
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  const packs = createBotContextProvider({ store: fx.store, journal })
  const turn = (activationId: string, keep: BotChatEpochEnd | undefined = undefined, start = true) =>
    packs.chatContext({ botId: 'ada', activationId, start, selection: SEL, keep: () => keep })
  const settle = (activationId: string, endedBy: 'settled' | 'failed' | 'stopped' | 'wall' = 'settled') =>
    packs.afterDispatch({ botId: 'ada', activationId, dispatchId: `${activationId}:1`, lane: 'chat', memoryLane: 'chat', threadId: 'home', endedBy })
  const epoch = () => fx.store.getState<BotChatEpoch>('ada', CHAT_EPOCH_KEY)
  return { fx, packs, turn, settle, epoch }
}

/** One exchange of the chat: the owner's message and the bot's reply, both of `activationId`. */
function exchange(fx: MemoryFixture, n: number, activationId = `a${n}`, size = 40) {
  fx.message({ botId: 'ada', id: `o${n}`, author: 'owner', text: `Owner message ${n}. ${'q'.repeat(size * 4)}`, activationId })
  fx.message({ botId: 'ada', id: `b${n}`, author: 'bot', text: `Bot reply ${n}. ${'a'.repeat(size * 4)}`, activationId })
}

describe('a running epoch', () => {
  it('sends only what its conversation does not hold: work\'s report, not the chat\'s own rows nor the owner\'s new message', async () => {
    const { fx, turn, settle } = setup()
    fx.message({ botId: 'ada', id: 'o1', author: 'owner', text: 'Owner message 1.', activationId: 'a1' })
    const first = await turn('a1')
    expect(first).toMatchObject({ fresh: true, reason: 'none' })
    expect(first.text).toContain(BOT_EPOCH_PROTOCOL_LINE)
    fx.message({ botId: 'ada', id: 'b1', author: 'bot', text: 'Bot reply 1.', activationId: 'a1' })
    await settle('a1')
    fx.message({ botId: 'ada', id: 'r1', author: 'bot', kind: 'run_report', text: 'Work report: the flat is booked.', activationId: 'w1' })
    fx.message({ botId: 'ada', id: 'o2', author: 'owner', text: 'Owner message 2.', activationId: 'a2' })
    const second = await turn('a2')
    expect(second).toMatchObject({ fresh: false, epochId: first.epochId })
    expect(second.text).toContain('Work report: the flat is booked.')
    for (const held of ['Owner message 1.', 'Bot reply 1.', 'Owner message 2.', BOT_MEMORY_PROTOCOL]) expect(second.text).not.toContain(held)
    await settle('a2')
    // Nothing new: no chat block at all, only the present.
    fx.message({ botId: 'ada', id: 'o3', author: 'owner', text: 'Owner message 3.', activationId: 'a3' })
    const third = await turn('a3')
    expect(third.text).not.toContain('New in the chat')
    expect(third.text).not.toContain('Work report')
    expect(third.text).toContain('Situation:')
  })

  it('carries the memory again only when it changed outside the conversation', async () => {
    const { fx, turn, settle } = setup()
    await turn('a1')
    // A save the chat's own turn made is in the conversation as its tool result.
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner likes short replies.', activationId: 'a1' })
    await settle('a1')
    const second = await turn('a2')
    expect(second.text).not.toContain('Your memory changed')
    await settle('a2')
    // The owner's edit in the Memory dialog is not: the next turn carries the memory as it is now.
    fx.store.save('ada', { lane: 'owner_ui', kind: 'owner', text: 'The owner lives in Leeds.' })
    const third = await turn('a3')
    expect(third.text).toContain('Your memory changed outside this conversation')
    expect(third.text).toContain('The owner lives in Leeds.')
    expect(third.text).toContain('The owner likes short replies.')
    await settle('a3')
    expect((await turn('a4')).text).not.toContain('Your memory changed')
  })

  it('freezes each turn\'s pack: the same activation reads the same text again', async () => {
    const { turn, settle } = setup()
    await turn('a1')
    await settle('a1')
    const second = await turn('a2')
    expect(await turn('a2')).toEqual(second)
    // Its continuation (a wall, an answered ask) reads the same text too, on the same epoch.
    expect(await turn('a2', undefined, false)).toEqual(second)
  })
})

describe('a new epoch', () => {
  it('folds the window to its tail in one step: the newest rows verbatim, the older ones in the summary', async () => {
    const { fx, turn } = setup()
    for (let n = 1; n <= 40; n++) exchange(fx, n, `old${n}`, 120)
    fx.message({ botId: 'ada', id: 'o41', author: 'owner', text: 'Owner message 41.', activationId: 'a41' })
    const base = await turn('a41', 'full')
    expect(base.fresh).toBe(true)
    expect(base.text).toContain('Bot reply 40.')
    expect(base.text).not.toContain('Owner message 1.')
    const recent = base.text.slice(base.text.indexOf('Recent chat'), base.text.indexOf('\n\nSituation:'))
    expect(estimateTokens(recent)).toBeLessThanOrEqual(BOT_CHAT_EPOCH_MARKS.tail + 200)
    expect(fx.store.getState<{ text: string }>('ada', 'chat_summary')?.text).toBeTruthy()
  })

  it.each([
    ['a failed turn', 'failed'],
    ['a stopped turn', 'stopped']
  ] as const)('%s ends the epoch: the next turn starts a new one', async (_name, endedBy) => {
    const { turn, settle, epoch } = setup()
    const first = await turn('a1')
    await settle('a1', endedBy)
    expect(epoch()?.ended).toBe(endedBy)
    // The engine reads `ended` back through `chatEpochEnd` and starts the next turn afresh.
    const next = await turn('a2', epoch()!.ended)
    expect(next).toMatchObject({ fresh: true, reason: endedBy })
    expect(next.epochId).not.toBe(first.epochId)
  })

  it('a turn stopped at a wall keeps the epoch: its continuation goes on in the same conversation', async () => {
    const { turn, settle, epoch } = setup()
    await turn('a1')
    await settle('a1', 'wall')
    expect(epoch()?.ended).toBeUndefined()
  })

  it('/clear ends the epoch; a forget removes it at once', async () => {
    const { fx, packs, turn, settle, epoch } = setup()
    await turn('a1')
    await settle('a1')
    packs.endChatEpoch('ada', 'cleared')
    expect(epoch()?.ended).toBe('cleared')
    await turn('a2', 'cleared')
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: 'My PIN hint is the dog.', activationId: 'a2' })
    expect(epoch()).toBeDefined()
    createBotMemoryAdmin({ store: fx.store }).forget('ada', 'm1')
    expect(epoch()).toBeUndefined()
  })

  it('a continuation never starts an epoch: with none running it reads the whole pack, as before epochs', async () => {
    const { turn, epoch } = setup()
    const continued = await turn('a1', 'none', false)
    expect(continued.fresh).toBe(false)
    expect(continued.text).toContain(BOT_MEMORY_PROTOCOL)
    expect(epoch()).toBeUndefined()
  })
})

describe('when the epoch ends (chatEpochEnd)', () => {
  const T = Date.parse('2026-11-16T12:00:00.000Z')
  const epoch: BotChatEpoch = { id: 'e:1', startedAt: '', instanceId: SEL.instanceId, model: SEL.model, deliveredSeq: 0, ran: [], outsideMemory: '', addedTokens: 0 }
  const usage = (lastPrompt: number | null, at = T, compactions = 0) => ({ lastPrompt, lastRequestAt: at, compactions, contextWindow: 200_000, cacheTtlMs: HOUR }) as unknown as BotTurnUsageRow
  const budget = () => contextBudget({ contextWindow: 200_000, cacheTtlMs: HOUR })
  // Each input: the epoch, the turns it ran (first one 20k: system text, tools, base and first message), and when.
  const rows: Array<[string, { epoch?: BotChatEpoch; selection?: typeof SEL; turns?: BotTurnUsageRow[]; now?: number; digest?: BotChatDigestState }, BotChatEpochVerdict]> = [
    ['no epoch yet', { epoch: undefined }, 'none'],
    ['an ended one', { epoch: { ...epoch, ended: 'failed' } }, 'failed'],
    ['another model', { selection: { ...SEL, model: 'claude-sonnet' } }, 'model'],
    ['another entry', { selection: { ...SEL, instanceId: 'codex' } }, 'model'],
    ['a runtime compaction', { turns: [usage(20_000), usage(30_000, T, 1)] }, 'compacted'],
    ['small and warm', { turns: [usage(20_000), usage(40_000)], now: T + 60_000 }, undefined],
    ['at the high mark', { turns: [usage(20_000), usage(20_000 + 48_000)] }, 'full'],
    ['past 40% of the window', { turns: [usage(79_000), usage(81_000)] }, 'full'],
    ['past the mid mark, cache expired', { turns: [usage(20_000), usage(45_000)], now: T + HOUR + 1 }, 'cold'],
    ['past the mid mark, cache warm', { turns: [usage(20_000), usage(45_000)], now: T + HOUR - 1 }, undefined],
    ['below the mid mark, cache expired', { turns: [usage(20_000), usage(30_000)], now: T + 3 * HOUR }, undefined],
    ['no sizes reported: the pack\'s estimate', { epoch: { ...epoch, addedTokens: 50_000 }, turns: [usage(null)] }, 'full'],
    // Past the high mark the epoch waits for its digest, but never past the hard mark or the cap.
    ['past the high mark, digest coming', { turns: [usage(20_000), usage(20_000 + 50_000)], digest: 'coming' }, 'due'],
    ['past the high mark, digest ready', { turns: [usage(20_000), usage(20_000 + 50_000)], digest: 'ready' }, 'full'],
    ['past the high mark, no digest', { turns: [usage(20_000), usage(20_000 + 50_000)], digest: 'none' }, 'full'],
    ['at the hard mark, digest coming', { turns: [usage(10_000), usage(10_000 + 64_000)], digest: 'coming' }, 'full'],
    ['past 40% of the window, digest coming', { turns: [usage(79_000), usage(81_000)], digest: 'coming' }, 'full']
  ]
  it.each(rows)('%s', (_name, input, expected) => {
    expect(chatEpochEnd({
      epoch: 'epoch' in input ? input.epoch : epoch,
      selection: input.selection ?? SEL,
      turns: input.turns ?? [],
      now: input.now ?? T,
      budget,
      ...(input.digest ? { digest: input.digest } : {})
    })).toBe(expected)
  })

  it('the budget: 40% of the window, under the owner\'s compaction point, and the short cache when none was reported', () => {
    expect(contextBudget({ contextWindow: 200_000 })).toMatchObject({ cap: 80_000, cacheTtlMs: 5 * 60_000 })
    expect(contextBudget({ contextWindow: 200_000, compactAt: 60_000 }).cap).toBe(54_000)
    expect(contextBudget({}).cap).toBe(Infinity)
  })
})
