/**
 * Bot Phase 1 §5.6: a bot turn that hits `provider_usage_limit` marks its instance limited until
 * the reset and is tried again on the next candidate. With no candidate left the bot pauses until
 * the reset, with one error row that names the provider family and never the model, and the
 * pause never counts as a failed run. The first tick after the reset ends the pause.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, flush, PI, runDispatch, type BotFixture } from './botFixture'
import { BOT_RUN_REPORT_LINE } from '../../src/mms/bots/memory/contextPack'

let f: BotFixture
let botId: string

const CLAUDE = { instanceId: 'claude:main', model: 'claude-x' }
const HOUR = 60 * 60_000

/** "14:00" in local time, as the chat shows a reset. */
const hhmm = (iso: string): string => {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

const limited = (until: string) => ({ status: 'failed' as const, outcome: { error: 'provider_usage_limit', usageLimitUntil: until } })

beforeEach(async () => {
  f = botFixture()
  f.candidates = [CLAUDE, PI]
  botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

describe('usage limits', () => {
  it('falls to the next candidate, retrying the same prompt once', async () => {
    const until = new Date(f.clock.now + 2 * HOUR).toISOString()
    const activation = await f.bots.activate({ botId, input: 'Three AI headlines', clientRequestId: 'r1' })
    expect(f.store.activation(activation.id)!.selection).toMatchObject({ instanceId: 'claude:main' })
    await runDispatch(f, activation.id, 1, limited(until))
    await flush()
    expect(f.limited.get('claude:main')).toBe(until)
    const retry = f.store.dispatch(activation.id, 2)!
    expect(retry).toMatchObject({ kind: 'continue', prompt: { text: `[Mousse] The last try did not go through. Answer this again:\n\nThree AI headlines\n\n${BOT_RUN_REPORT_LINE}` }, send: { usageRetry: true } })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', selection: { instanceId: 'pi:openrouter' }, reloadPending: false })
    const prepared = await runDispatch(f, activation.id, 2, { text: 'Here are three.' })
    expect(prepared.selection).toMatchObject({ instanceId: 'pi:openrouter', model: 'some/model' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: null, failureStreak: 0 })
    // The switch is journaled; the chat never mentions it.
    expect(f.journal.some((row) => row.kind === 'model_change' && row.activationId === activation.id)).toBe(true)
    expect(JSON.stringify(chatOf(f, botId))).not.toMatch(/claude-x|some\/model|claude:main|pi:openrouter/)
  })

  it('with every candidate limited, the bot pauses until the reset with one error row, never a failure', async () => {
    const until = new Date(f.clock.now + 2 * HOUR).toISOString()
    const activation = await f.bots.activate({ botId, input: 'Three AI headlines', clientRequestId: 'r1' })
    await runDispatch(f, activation.id, 1, limited(until))
    await runDispatch(f, activation.id, 2, limited(until))
    await flush()
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'usage_limit' })
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'usage_limit', pausedUntil: until, failureStreak: 0 })
    const errors = chatOf(f, botId).filter((message) => message.kind === 'error')
    expect(errors).toMatchObject([{ author: 'bot', error: { text: `Paused until ${hhmm(until)} (your Claude usage limit)`, action: { kind: 'resume' } } }])
    expect(JSON.stringify(errors)).not.toMatch(/claude-x|some\/model|claude:main/)
    const summary = f.bots.service.get(botId).summary
    expect(summary).toMatchObject({ state: 'paused', stateText: `Paused until ${hhmm(until)}` })
    expect(JSON.stringify(summary)).not.toMatch(/claude-x|some\/model/)
  })

  it('schedules skip until the reset, and the first tick after it ends the pause', async () => {
    await f.bots.reconcileOnStartup()
    f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 30 }, prompt: 'Headlines' }, 'owner')
    await f.tickSchedules(new Date(f.clock.now))
    const until = new Date(f.clock.now + 2 * HOUR).toISOString()
    const activation = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    await runDispatch(f, activation.id, 1, limited(until))
    await runDispatch(f, activation.id, 2, limited(until))
    await flush()
    expect(f.store.registry(botId)!.pausedReason).toBe('usage_limit')
    f.clock.now += 35 * 60_000
    expect((await f.tickSchedules(new Date(f.clock.now))).inserted).toEqual([])
    expect(f.book.list(botId)[0]).toMatchObject({ skip: { reason: 'usage_limited' } })
    // After the reset, the next tick ends the pause and the next occurrence runs.
    f.clock.now = Date.parse(until) + 60_000
    f.limited.clear()
    expect((await f.tickSchedules(new Date(f.clock.now))).inserted).toHaveLength(1)
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: null, pausedUntil: null, error: null })
    expect(f.book.list(botId)[0]!.skip).toBeUndefined()
  })

  it('chat still answers on another candidate; the chat lane\'s pause never counts as a failure', async () => {
    const until = new Date(f.clock.now + HOUR).toISOString()
    await f.bots.service.chatSend({ botId, text: 'Anything new?', clientRequestId: 'm1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    await runDispatch(f, activation.id, 1, limited(until))
    await flush()
    expect(f.store.dispatch(activation.id, 2)).toMatchObject({ send: { usageRetry: true }, prompt: { text: '[Mousse] The last try did not go through. Answer this again:\n\nAnything new?' } })
    await runDispatch(f, activation.id, 2, { text: 'Not yet.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', kind: 'text', text: 'Not yet.' })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
  })
})
