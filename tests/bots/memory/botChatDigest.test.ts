import { afterEach, describe, expect, it } from 'vitest'
import { BOT_CHAT_DIGEST, estimateTokens } from '../../../src/shared/bots/personal/memory'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { parseDigest, type ChatSummaryState } from '../../../src/mms/bots/memory/chatSummary'
import type { BotChatDigestState, BotChatEpoch, BotChatEpochVerdict } from '../../../src/mms/bots/memory/contextBudget'
import { BOT_CHANGELOG_LATEST } from '../../../src/mms/bots/changelog'
import { disposeFixtures, memoryFixture, type MemoryFixture } from './memoryFixture'

/**
 * The digest of a fold (docs/plans/bot-context.md §14), at the pack with the model call scripted: written in the
 * background, adopted only when an epoch starts and only while the chat it summarised is unchanged, never waited for,
 * kept as three tiers, searchable, and written again after a forget. When the epoch ends is `chatEpochEnd`'s table in
 * botChatEpochPack.test.ts; the engine's side (the hard mark from real sizes, the fold's line) is in
 * tests/bots/botChatEpochs.test.ts.
 */

afterEach(disposeFixtures)

const SEL = { instanceId: 'claude', model: 'claude-opus' }

/** A digest as a model writes it. */
function answer(headline: string, items: { constraint?: string; fact?: string } = {}): string {
  return [
    'Here is the digest.',
    `Headline: ${headline}`,
    'Standing constraints:', `- ${items.constraint ?? 'none'}`,
    'Decisions:', '- none',
    'Open threads:', '- none',
    'Finished work:', '- none',
    'Key facts:', `- ${items.fact ?? 'none'}`
  ].join('\n')
}

function setup() {
  const fx = memoryFixture()
  fx.store.write(() => fx.store.setState('ada', 'changelog_seen', BOT_CHANGELOG_LATEST))
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  // The model call, scripted: each call waits until the test answers it.
  const calls: Array<{ prompt: string; answer: (text: string) => Promise<void> }> = []
  const packs = createBotContextProvider({
    store: fx.store, journal,
    digest: ({ prompt }) => new Promise<string>((resolve) => {
      calls.push({ prompt, answer: async (text) => { resolve(text); await packs.digestRunning('ada') } })
    })
  })
  // What the engine's `chatEpochEnd` decides, by hand: the conversation is small, past the prepare mark, past the high
  // mark, or past the hard mark.
  const size = { now: 'small' as 'small' | 'prepare' | 'high' | 'hard' }
  const verdict = (epoch: BotChatEpoch | undefined, digest: BotChatDigestState): BotChatEpochVerdict =>
    !epoch ? 'none' : epoch.ended ? epoch.ended : size.now === 'small' ? undefined
      : size.now === 'prepare' ? (digest === 'coming' ? 'prepare' : undefined)
      : size.now === 'high' && digest === 'coming' ? 'due' : 'full'
  const turn = (activationId: string, start = true) =>
    packs.chatContext({ botId: 'ada', activationId, start, selection: SEL, keep: verdict })
  const settle = (activationId: string) =>
    packs.afterDispatch({ botId: 'ada', activationId, dispatchId: `${activationId}:1`, lane: 'chat', memoryLane: 'chat', threadId: 'home', endedBy: 'settled' })
  const summary = () => fx.store.getState<ChatSummaryState>('ada', 'chat_summary')
  return { fx, packs, calls, size, turn, settle, summary }
}

/** One exchange of the chat, `size` tokens a row; returns the owner message's seq. */
function exchange(fx: MemoryFixture, n: number, size = 120, words = ''): number {
  const seq = fx.message({ botId: 'ada', id: `o${n}`, author: 'owner', text: `Owner message ${n}. ${words}${'q'.repeat(size * 4)}`, activationId: `old${n}` })
  fx.message({ botId: 'ada', id: `b${n}`, author: 'bot', text: `Bot reply ${n}. ${'a'.repeat(size * 4)}`, activationId: `old${n}` })
  return seq
}

describe('the digest of a fold', () => {
  it('is written in the background past the high mark, and the next epoch starts from it; every digest is searchable', async () => {
    const { fx, calls, size, turn, settle } = setup()
    for (let n = 1; n <= 40; n++) exchange(fx, n)
    await turn('a1')
    await settle('a1')
    size.now = 'high'
    // The turn goes on in the same conversation, and the digest is asked for beside it.
    expect(await turn('a2')).toMatchObject({ fresh: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain('Owner message 1.')
    await calls[0]!.answer(answer('Planning the move to Leeds', { constraint: 'Replies stay under 50 words (j2).', fact: 'The flat is on Park Row (j5).' }))
    await settle('a2')
    const next = await turn('a3')
    expect(next).toMatchObject({ fresh: true, reason: 'full', folded: { digest: true } })
    expect(next.text).toContain('Planning the move to Leeds')
    expect(next.text).toContain('Replies stay under 50 words (j2).')
    // The lines of what the digest covers are gone with it.
    expect(next.text).not.toContain('Owner message 1.')
    expect(fx.store.search('ada', { query: 'Park Row' })).toEqual([expect.objectContaining({ kind: 'chat digest' })])
  })

  it.each([
    ['once written', true],
    ['while it is written', false]
  ] as const)('is not used when a row it summarised was forgotten %s, and is written again without it', async (_name, written) => {
    const { fx, calls, size, turn, settle } = setup()
    let forgotten = 0
    for (let n = 1; n <= 60; n++) {
      const seq = exchange(fx, n, 120, n === 3 ? 'My locker is behind the blue door. ' : '')
      if (n === 3) forgotten = seq
    }
    await turn('a1')
    await settle('a1')
    size.now = 'high'
    await turn('a2')
    expect(calls[0]!.prompt).toContain('blue door')
    if (written) await calls[0]!.answer(answer('Lockers and moving', { fact: 'The locker is behind the blue door (j7).' }))
    fx.store.forget('ada', { refs: [`j${forgotten}`], by: 'owner_ui' })
    if (!written) await calls[0]!.answer(answer('Lockers and moving', { fact: 'The locker is behind the blue door (j7).' }))
    await settle('a2')
    // The forget ended the epoch: the next one starts without the digest, and asks for one of what is left.
    const next = await turn('a3')
    expect(next.fresh).toBe(true)
    expect(next.text).not.toContain('Lockers and moving')
    expect(next.text).not.toContain('blue door')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toContain('Owner message 4.')
    expect(calls[1]!.prompt).not.toContain('blue door')
  })

  it('is asked for from the prepare mark, so the epoch folds with it at the high mark instead of waiting', async () => {
    const { fx, calls, size, turn, settle } = setup()
    for (let n = 1; n <= 40; n++) exchange(fx, n)
    await turn('a1')
    await settle('a1')
    size.now = 'prepare'
    expect(await turn('a2')).toMatchObject({ fresh: false })
    expect(calls).toHaveLength(1)
    await calls[0]!.answer(answer('Early digest of the move'))
    await settle('a2')
    // Ready before the high mark: the epoch goes on, and no second call starts.
    expect(await turn('a3')).toMatchObject({ fresh: false })
    await settle('a3')
    expect(calls).toHaveLength(1)
    size.now = 'high'
    const fold = await turn('a4')
    expect(fold).toMatchObject({ fresh: true, reason: 'full', folded: { digest: true } })
    expect(fold.text).toContain('Early digest of the move')
  })

  it('never keeps the chat waiting: at the hard mark the epoch folds without it, and a late digest is used at the next fold', async () => {
    const { fx, calls, size, turn, settle } = setup()
    for (let n = 1; n <= 40; n++) exchange(fx, n)
    await turn('a1')
    await settle('a1')
    size.now = 'high'
    expect((await turn('a2')).fresh).toBe(false)
    await settle('a2')
    // Still being written: the epoch goes on, and no second call starts.
    expect((await turn('a3')).fresh).toBe(false)
    await settle('a3')
    expect(calls).toHaveLength(1)
    size.now = 'hard'
    const hard = await turn('a4')
    expect(hard).toMatchObject({ fresh: true, reason: 'full', folded: { digest: false } })
    expect(hard.text).toContain('Chat summary (older chat, newest first')
    expect(hard.text).not.toContain('Digest of')
    await settle('a4')
    // The digest arrives after all: what it summarised is unchanged, so the next fold starts from it.
    await calls[0]!.answer(answer('The first weeks of chat'))
    size.now = 'high'
    const after = await turn('a5')
    expect(after).toMatchObject({ fresh: true, folded: { digest: true } })
    expect(after.text).toContain('The first weeks of chat')
  })

  it('keeps the last three digests in full and older ones as dated timeline lines, within about 3k tokens', async () => {
    const { fx, calls, size, turn, settle, summary } = setup()
    await turn('start')
    await settle('start')
    let n = 0
    for (let fold = 1; fold <= 5; fold++) {
      for (let i = 0; i < 20; i++) exchange(fx, ++n, 150)
      size.now = 'high'
      await turn(`f${fold}a`)
      await settle(`f${fold}a`)
      await calls.at(-1)!.answer(answer(`Fold ${fold} headline`, {
        constraint: fold === 1 ? 'Never book trains before 9am (j2).' : calls.at(-1)!.prompt.includes('Never book trains before 9am (j2).') ? 'Never book trains before 9am (j2).' : 'none',
        fact: `Fold ${fold} fact ${'x'.repeat(1_500)}`
      }))
      await turn(`f${fold}b`)
      await settle(`f${fold}b`)
      size.now = 'small'
    }
    expect(calls).toHaveLength(5)
    const text = summary()!.text
    expect(text.match(/^Digest of /gm)).toHaveLength(3)
    for (const fold of [3, 4, 5]) expect(text).toContain(`Fold ${fold} fact`)
    // The two oldest are a dated line each, oldest first; their text stays in the journal.
    const timeline = text.slice(text.indexOf('Timeline of older digests:'), text.indexOf('Digest of'))
    expect(timeline).toMatch(/^- \d+ Nov 2026: Fold 1 headline \(j\d+–j\d+\)\n- \d+ Nov 2026: Fold 2 headline/m)
    expect(text).not.toContain('Fold 1 fact')
    expect(fx.store.search('ada', { query: 'Fold 1 fact' }).map((hit) => hit.ref)).toContain(`j${summary()!.digests![0]!.seq}`)
    // Each digest carries over the standing constraints of the one before, so only the newest shows them: once.
    expect(text.split('Never book trains before 9am (j2).')).toHaveLength(2)
    expect(text.match(/^Standing constraints:/gm)).toHaveLength(1)
    expect(text.lastIndexOf('Standing constraints:')).toBeGreaterThan(text.indexOf('Fold 5 headline'))
    for (const fold of [3, 4]) expect(text).toContain(`Fold ${fold} fact`)
    expect(estimateTokens(text)).toBeLessThanOrEqual(BOT_CHAT_DIGEST.summary + 100)
  })

  it('a forget rebuilds the digest that used the forgotten row: its words leave the summary and the search at once', async () => {
    const { fx, calls, size, turn, settle, summary } = setup()
    let forgotten = 0
    for (let n = 1; n <= 40; n++) {
      const seq = exchange(fx, n, 120, n === 3 ? 'My locker is behind the blue door. ' : '')
      if (n === 3) forgotten = seq
    }
    size.now = 'high'
    await turn('a1')
    await settle('a1')
    await turn('a2')
    await calls[0]!.answer(answer('Lockers and moving', { fact: `The locker is behind the blue door (j${forgotten}).` }))
    await settle('a2')
    expect((await turn('a3')).text).toContain('blue door')
    await settle('a3')
    fx.store.forget('ada', { refs: [`j${forgotten}`], by: 'owner_ui' })
    expect(summary()!.digests![0]).toMatchObject({ stale: true })
    expect(summary()!.text).not.toContain('blue door')
    expect(fx.store.search('ada', { query: 'blue door' })).toEqual([])
    // The next chat turn writes it again from what is left, in the background.
    size.now = 'small'
    const next = await turn('a4')
    expect(next.text).not.toContain('blue door')
    const rebuild = calls.at(-1)!
    expect(calls).toHaveLength(2)
    expect(rebuild.prompt).toContain('Owner message 4.')
    expect(rebuild.prompt).not.toContain('blue door')
    await rebuild.answer(answer('Moving house, written again', { fact: 'The flat is on Park Row (j9).' }))
    expect(summary()!.digests![0]).toMatchObject({ headline: 'Moving house, written again' })
    expect(summary()!.digests![0]!.stale).toBeUndefined()
    expect(summary()!.text).toContain('Park Row')
    expect(fx.store.search('ada', { query: 'Park Row' })[0]).toMatchObject({ kind: 'chat digest' })
  })

  it('a digest written during an epoch leaves its base byte for byte as it was; the next epoch starts from it', async () => {
    const { fx, calls, turn, settle, size } = setup()
    for (let n = 1; n <= 60; n++) exchange(fx, n)
    // A new epoch that folded chat no digest holds asks for one at once.
    const base = await turn('a1')
    expect(base.fresh).toBe(true)
    expect(calls).toHaveLength(1)
    await calls[0]!.answer(answer('Sixty exchanges about the move'))
    await settle('a1')
    const deltas = []
    for (const id of ['a2', 'a3']) {
      fx.message({ botId: 'ada', id: `o-${id}`, author: 'owner', text: `New message ${id}.`, activationId: id })
      deltas.push(await turn(id))
      await settle(id)
    }
    for (const delta of deltas) {
      expect(delta.fresh).toBe(false)
      expect(delta.text).not.toContain('Sixty exchanges about the move')
    }
    // The first turn's pack, as a continuation reads it again, is the same text: the runtime's conversation still starts
    // with every byte it was given.
    expect((await turn('a1', false)).text).toBe(base.text)
    size.now = 'high'
    expect((await turn('a4')).text).toContain('Sixty exchanges about the move')
  })

  it('takes only a well-formed answer: anything else leaves the fold deterministic', async () => {
    const { fx, calls, size, turn, settle } = setup()
    for (let n = 1; n <= 40; n++) exchange(fx, n)
    await turn('a1')
    await settle('a1')
    size.now = 'high'
    await turn('a2')
    await calls[0]!.answer('Sorry, I cannot help with that.')
    await settle('a2')
    // The call failed: no digest is coming for a while, so the high mark folds now, deterministically.
    const next = await turn('a3')
    expect(next).toMatchObject({ fresh: true, folded: { digest: false } })
    expect(next.text).not.toContain('Digest of')
  })
})

describe('a digest answer is kept however the model dressed its headings', () => {
  const sections = (heading: (name: string) => string) => ['Standing constraints', 'Decisions', 'Open threads', 'Finished work', 'Key facts']
    .map((name) => `${heading(name)}\n- ${name === 'Open threads' ? 'Redesign the usage page (j5, i1)' : 'none'}`).join('\n')

  it.each([
    ['as asked', `Headline: Planning the usage page\n${sections((name) => `${name}:`)}`],
    ['markdown headings, the headline on its own line', `# Headline\nPlanning the usage page\n\n${sections((name) => `## ${name}`)}`],
    ['bold headings', `**Headline:** Planning the usage page\n${sections((name) => `**${name}:**`)}`],
    ['a preface before it', `Here is the digest.\n\n### Headline: Planning the usage page\n${sections((name) => `### ${name}:`)}`]
  ])('%s', (_name, answer) => {
    expect(parseDigest(answer)).toEqual({
      headline: 'Planning the usage page',
      text: 'Standing constraints:\n- none\nDecisions:\n- none\nOpen threads:\n- Redesign the usage page (j5, i1)\nFinished work:\n- none\nKey facts:\n- none'
    })
  })

  it.each([
    ['no headline', 'Standing constraints:\n- none\nDecisions:\n- none\nOpen threads:\n- none\nFinished work:\n- none\nKey facts:\n- none'],
    ['a section missing', 'Headline: Planning\nStanding constraints:\n- none\nDecisions:\n- none\nFinished work:\n- none\nKey facts:\n- none'],
    ['a headline with no words', 'Headline:\nStanding constraints:\n- none\nDecisions:\n- none\nOpen threads:\n- none\nFinished work:\n- none\nKey facts:\n- none']
  ])('but not %s', (_name, answer) => {
    expect(parseDigest(answer)).toBeUndefined()
  })
})
