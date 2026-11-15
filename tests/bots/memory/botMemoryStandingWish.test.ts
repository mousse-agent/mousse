import { afterEach, describe, expect, it } from 'vitest'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { isStandingWish, nearDuplicate } from '../../../src/mms/bots/memory/standingWish'
import { disposeFixtures, memoryFixture, type MemoryFixture } from './memoryFixture'

/**
 * The missed-wish fallback: a standing wish the owner states in the chat is kept as an owner entry
 * when the turn ends without a memory_save; one-off requests and duplicates are not.
 */

afterEach(disposeFixtures)

const EM = "From now on don't use em dashes."

function chat(fx: MemoryFixture) {
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  const provider = createBotContextProvider({ store: fx.store, journal })
  let n = 0
  const turn = async (text: string, options: { activationId?: string; endedBy?: 'settled' | 'failed'; modelSaves?: string } = {}) => {
    const activationId = options.activationId ?? `act-${++n}`
    fx.message({ botId: 'ada', id: `msg-${++n}`, author: 'owner', text, activationId })
    if (options.modelSaves) {
      fx.store.append({ botId: 'ada', kind: 'tool_call', lane: 'chat', activationId, sourceKey: `t:${n}`, who: 'bot', text: 'memory_save', json: { tool: 'memory_save' } })
      fx.store.save('ada', { lane: 'chat', kind: 'owner', text: options.modelSaves, activationId })
    }
    await provider.afterDispatch({ botId: 'ada', activationId, dispatchId: `d-${n}`, lane: 'chat', memoryLane: 'chat', threadId: 'home', endedBy: options.endedBy ?? 'settled' })
  }
  const entries = () => fx.store.list('ada').entries.map((entry) => ({ kind: entry.kind, text: entry.text, by: entry.by }))
  return { turn, entries }
}

describe('the missed-wish fallback', () => {
  it('saves "from now on don\'t use em dashes" verbatim when the model did not', async () => {
    const fx = memoryFixture()
    const { turn, entries } = chat(fx)
    await turn(`  ${EM}  `)
    expect(entries()).toEqual([{ kind: 'owner', text: EM, by: 'you said' }])
    // The next dispatch's pack carries it.
    const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
    expect(await createBotContextProvider({ store: fx.store, journal }).chatPreamble({ botId: 'ada', activationId: 'act-next' })).toContain(EM)
  })

  it('tells the next chat about wishes refused at the cap, until a carrying turn settles', async () => {
    const fx = memoryFixture()
    for (let n = 0; n < 6; n++) {
      expect(fx.store.save('ada', { lane: 'chat', kind: 'owner', text: `Fact ${n}: ${'ordinary words '.repeat(30)}`.slice(0, 400) })).not.toHaveProperty('error')
    }
    const { turn } = chat(fx)
    await turn(EM)
    await turn('Always keep your replies short.')
    expect(fx.store.active('ada')).toHaveLength(6)
    // Reopen to prove that the notice survives a service restart.
    const store = fx.reopen()
    const journal = createBotJournal({ store, readThread: () => ({ messages: [] }), listThreads: () => [] })
    const packs = createBotContextProvider({ store, journal })
    const next = await packs.chatPreamble({ botId: 'ada', activationId: 'next' })
    const situation = next.slice(next.indexOf('Situation:'))
    expect(situation).toContain('2 standing wishes')
    expect(situation).toContain('full')
    expect(situation).toContain('which')
    expect(await packs.runPreamble({ botId: 'ada', activationId: 'run' })).not.toContain('2 standing wishes')
    const end = { botId: 'ada', activationId: 'next', dispatchId: 'd-next', lane: 'chat' as const, memoryLane: 'chat' as const, threadId: 'home' }
    await packs.afterDispatch({ ...end, endedBy: 'failed' })
    expect(await packs.chatPreamble({ botId: 'ada', activationId: 'retry' })).toContain('2 standing wishes')
    await packs.afterDispatch({ ...end, endedBy: 'settled', consult: true })
    expect(await packs.chatPreamble({ botId: 'ada', activationId: 'after-consult' })).toContain('2 standing wishes')
    // A third wish fails during the turn carrying the first two; only those two are acknowledged.
    fx.message({ botId: 'ada', id: 'new-wish', author: 'owner', text: 'Never use emoji.', activationId: 'next' })
    await packs.afterDispatch({ ...end, endedBy: 'settled' })
    await packs.afterDispatch({ ...end, endedBy: 'settled' })
    const last = await packs.chatPreamble({ botId: 'ada', activationId: 'last' })
    expect(last).toContain('1 standing wish')
    await packs.afterDispatch({ ...end, activationId: 'last', endedBy: 'settled' })
    const done = await packs.chatPreamble({ botId: 'ada', activationId: 'done' })
    expect(done.slice(done.indexOf('Situation:'))).not.toContain('standing wish')
  })

  it('does not save a one-off request', async () => {
    const fx = memoryFixture()
    const { turn, entries } = chat(fx)
    await turn("Don't forget to buy milk tomorrow")
    await turn('Stop the run')
    await turn("Don't reply to this email")
    expect(entries()).toEqual([])
  })

  it('does not duplicate: neither the same wish again, nor what the model already saved in other words', async () => {
    const fx = memoryFixture()
    const { turn, entries } = chat(fx)
    await turn(EM)
    await turn("from now on, don't use em dashes!")
    expect(entries()).toHaveLength(1)
    await turn('Never use emoji in your replies.', { modelSaves: 'The owner wants no emoji in my replies.' })
    expect(entries().map((entry) => entry.text)).toEqual([EM, 'The owner wants no emoji in my replies.'])
    // The same wish in nearly the same words, said again later.
    await turn('Never use emoji in your replies')
    expect(entries()).toHaveLength(2)
  })

  it('skips a turn that failed, and keeps a removed entry removed until the owner says it again', async () => {
    const fx = memoryFixture()
    const { turn, entries } = chat(fx)
    await turn('Always answer in British English.', { endedBy: 'failed' })
    expect(entries()).toEqual([])
    await turn('Always answer in British English.')
    expect(entries()).toHaveLength(1)
    createBotMemoryAdmin({ store: fx.store }).forget('ada', 'm1')
    expect(entries()).toEqual([])
    // A later unrelated turn does not bring it back.
    await turn('Thanks, that helps.')
    expect(entries()).toEqual([])
  })

  it('checks each message once, also when an activation continues', async () => {
    const fx = memoryFixture()
    const { turn, entries } = chat(fx)
    await turn('Thanks!', { activationId: 'act-long' })
    await turn('Please stop using exclamation marks.', { activationId: 'act-long' })
    expect(entries().map((entry) => entry.text)).toEqual(['Please stop using exclamation marks.'])
  })
})

describe('isStandingWish', () => {
  it.each([
    "From now on don't use em dashes",
    'Never use emoji.',
    'Please stop being so formal.',
    "Don't apologise so much.",
    'Always keep your replies short.',
    'Going forward, you should check with me before booking anything.',
    'Call me Sam from now on.',
    'no more bullet points please'
  ])('keeps %j', (text) => expect(isStandingWish(text)).toBe(true))

  it.each([
    "Don't forget to buy milk tomorrow",
    'Stop the run',
    "Don't send that message",
    'Can you always reply in French?',
    'Never mind',
    "Don't book the train yet",
    "I never got the email",
    'Please write a short summary of the report',
    'Use em dashes here for now',
    `${'Always '.repeat(40)}`
  ])('skips %j', (text) => expect(isStandingWish(text)).toBe(false))
})

describe('nearDuplicate', () => {
  it('matches the same words, one inside the other, or most words shared', () => {
    expect(nearDuplicate("From now on, don't use em dashes!", ["From now on don't use em dashes."])).toBe(true)
    expect(nearDuplicate("Don't use em dashes", ["From now on don't use em dashes."])).toBe(true)
    expect(nearDuplicate('Never use emoji', ['Always keep replies short.'])).toBe(false)
    expect(nearDuplicate('Never use emoji in your replies', ['The owner wants no emoji in my replies.'])).toBe(true)
    // A reversal is a new wish, not a duplicate.
    expect(nearDuplicate('Always use em dashes', ["Don't use em dashes."])).toBe(false)
  })
})

it('a telling_set call handles the wish without changing existing memory', async () => {
  const fx = memoryFixture()
  const original = fx.store.save('ada', { lane: 'chat', kind: 'owner', text: 'Never ping me at night.' })
  fx.message({ botId: 'ada', id: 'wish', author: 'owner', text: 'Never ping me at night.', activationId: 'telling' })
  fx.store.append({ botId: 'ada', kind: 'tool_call', lane: 'chat', activationId: 'telling', sourceKey: 'telling-call', who: 'bot', text: 'telling_set', json: { tool: 'telling_set' } })
  const before = fx.store.active('ada')
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  const provider = createBotContextProvider({ store: fx.store, journal, situation: () => ({ telling: 'Tells you when it needs you' }) })
  await provider.afterDispatch({ botId: 'ada', activationId: 'telling', dispatchId: 'd', lane: 'chat', memoryLane: 'chat', threadId: 'home', endedBy: 'settled' })
  expect(fx.store.active('ada')).toEqual(before)
  expect(original).not.toHaveProperty('error')
  expect(await provider.chatPreamble({ botId: 'ada', activationId: 'next' })).toContain('Tells you when it needs you')
})
