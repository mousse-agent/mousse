/**
 * Bot Phase 1 §5.3.3: pause, resume and the failure streak. Three failed runs in a row pause the
 * bot's schedules with one notice; a run that ends done resets the streak; chat failures never
 * count. Pause stops schedules only: the chat still works. Resume clears the pause, the streak and
 * the stuck error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, flush, runDispatch, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

const PAUSE_NOTICE = 'I\'ve paused my schedules after three failed runs. Resume when it\'s fixed.'

beforeEach(async () => {
  f = botFixture()
  botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** One manual run that ends `status`. */
async function runOnce(id: string, status: 'completed' | 'failed') {
  const activation = await f.bots.activate({ botId, input: 'Check the news', clientRequestId: id })
  await runDispatch(f, activation.id, 1, { status, ...(status === 'completed' ? { text: 'Three headlines.' } : { outcome: { error: 'provider_error' } }) })
  return f.store.activation(activation.id)!
}

/** One chat message whose turn ends `status`. */
async function chatOnce(id: string, status: 'completed' | 'failed') {
  await f.bots.service.chatSend({ botId, text: 'hi', clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  await runDispatch(f, activation.id, 1, { status, ...(status === 'completed' ? { text: 'Hi.' } : { outcome: { error: 'provider_error' } }) })
  return f.store.activation(activation.id)!
}

const notices = () => chatOf(f, botId).filter((message) => message.text === PAUSE_NOTICE)

describe('the failure streak', () => {
  it('three failed runs pause the schedules with one notice', async () => {
    expect(await runOnce('r1', 'failed')).toMatchObject({ status: 'failed' })
    await runOnce('r2', 'failed')
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 2, pausedReason: null })
    await runOnce('r3', 'failed')
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 3, pausedReason: 'failures' })
    expect(notices()).toMatchObject([{ author: 'bot', kind: 'notice' }])
    // A fourth failure posts no second notice.
    await runOnce('r4', 'failed')
    expect(notices()).toHaveLength(1)
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'paused', stateText: 'Paused' })
    // Failures say so in plain words, never the provider's own message.
    expect(chatOf(f, botId).filter((message) => message.kind === 'error').every((message) => !JSON.stringify(message).includes('provider_error'))).toBe(true)
  })

  it('a run that ends done resets the streak', async () => {
    await runOnce('r1', 'failed')
    await runOnce('r2', 'failed')
    await runOnce('r3', 'completed')
    expect(f.store.registry(botId)!.failureStreak).toBe(0)
    await runOnce('r4', 'failed')
    await runOnce('r5', 'failed')
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 2, pausedReason: null })
    expect(notices()).toEqual([])
  })

  it('chat failures never count', async () => {
    for (const id of ['m1', 'm2', 'm3', 'm4']) expect(await chatOnce(id, 'failed')).toMatchObject({ status: 'failed', lane: 'chat' })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
    expect(notices()).toEqual([])
  })

  it('a usage-limit pause is not a failed run', async () => {
    f.candidates = [{ instanceId: 'claude:main', model: 'claude-x' }]
    const until = new Date(f.clock.now + 2 * 60 * 60_000).toISOString()
    const activation = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    await runDispatch(f, activation.id, 1, { status: 'failed', outcome: { error: 'provider_usage_limit', usageLimitUntil: until } })
    await flush()
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'usage_limit' })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: 'usage_limit' })
  })
})

describe('pause and resume', () => {
  it('pause skips schedules while the chat still works; resume clears it', async () => {
    await f.bots.reconcileOnStartup()
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 10 }, prompt: 'Check the news' }, 'owner')
    await f.bots.tickSchedules(new Date(f.clock.now))
    const next = Date.parse(f.store.scheduleStates(botId)[0]!.nextRunAt!)
    f.bots.service.pause(botId)
    expect(f.store.registry(botId)!.pausedReason).toBe('owner')
    f.clock.now = next + 1_000
    const { inserted } = await f.bots.tickSchedules(new Date(f.clock.now))
    expect(inserted).toEqual([])
    expect(f.store.scheduleStates(botId)).toMatchObject([{ scheduleId, lastSkipReason: 'paused' }])
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'paused', stateText: 'Paused' })
    // Chat still works while paused.
    await f.bots.service.chatSend({ botId, text: 'Anything new?', clientRequestId: 'm1' })
    const chatting = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    await runDispatch(f, chatting.id, 1, { text: 'Nothing yet.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: 'Nothing yet.' })
    // Resume: the next occurrence runs again.
    const { bot } = await f.bots.service.resume(botId)
    expect(bot.state).not.toBe('paused')
    f.clock.now = Date.parse(f.store.scheduleStates(botId)[0]!.nextRunAt!) + 1_000
    expect((await f.bots.tickSchedules(new Date(f.clock.now))).inserted).toHaveLength(1)
  })

  it('resume clears a failures pause, the streak and the stuck error', async () => {
    for (const id of ['r1', 'r2', 'r3']) await runOnce(id, 'failed')
    f.store.setError(botId, { code: 'bot_no_provider', error: { text: 'Set up a provider so I can work.' } })
    await f.bots.service.resume(botId)
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: null, pausedUntil: null, failureStreak: 0, error: null })
    expect(f.bots.service.get(botId).summary.state).toBe('idle')
  })
})

describe('pauses that stay (review round 2)', () => {
  it('a run its runtime cannot hold ends failed and counts: three in a row pause the schedules', async () => {
    f.host.harness.checkPolicy = () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'This provider cannot limit tools.' } })
    for (const id of ['b1', 'b2', 'b3']) {
      const activation = await f.bots.activate({ botId, input: 'Check the news', clientRequestId: id })
      await expect(runDispatch(f, activation.id)).rejects.toThrow(/policy_unenforceable/)
      expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'policy_unenforceable' })
    }
    await flush()
    expect(f.store.activationsWith(['blocked'])).toEqual([])
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'failures', failureStreak: 3, error: { code: 'policy_unenforceable' } })
    expect(notices()).toHaveLength(1)
  })

  it('a usage limit never replaces the owner\'s pause, and its reset lifts nothing else', async () => {
    await f.bots.reconcileOnStartup()
    f.bots.pauseBot(botId)
    f.problem = { problem: 'all_limited', until: new Date(f.clock.now + 60 * 60_000).toISOString(), instanceId: 'claude:main' }
    const activation = await f.bots.activate({ botId, input: 'Check the news', clientRequestId: 'u1' })
    await flush()
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'usage_limit' })
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'owner', pausedUntil: null, error: null })
    f.clock.now += 2 * 60 * 60_000
    await f.bots.tickSchedules(new Date(f.clock.now))
    expect(f.store.registry(botId)!.pausedReason).toBe('owner')
  })

  it('the end of a usage pause keeps the failure streak', async () => {
    await f.bots.reconcileOnStartup()
    await runOnce('f1', 'failed')
    await runOnce('f2', 'failed')
    f.problem = { problem: 'all_limited', until: new Date(f.clock.now + 60 * 60_000).toISOString(), instanceId: 'claude:main' }
    await f.bots.activate({ botId, input: 'Check the news', clientRequestId: 'u1' })
    await flush()
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'usage_limit', failureStreak: 2 })
    f.problem = undefined
    f.clock.now += 2 * 60 * 60_000
    await f.bots.tickSchedules(new Date(f.clock.now))
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: null, failureStreak: 2 })
    await runOnce('f3', 'failed')
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'failures', failureStreak: 3 })
  })
})
