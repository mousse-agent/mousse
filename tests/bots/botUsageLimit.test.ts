/**
 * Bot Phase 1 §5.6: a bot turn that hits `provider_usage_limit` marks its instance limited until
 * the reset and is tried again on the next candidate. With no candidate left the bot pauses until
 * the reset, with one error row that names the provider family and never the model, and the
 * pause never counts as a failed run. The first tick after the reset ends the pause.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, flush, PI, runDispatch, type BotFixture } from './botFixture'
import { BotEngine, USAGE_RECHECK_MS } from '../../src/mms/bots/activation/BotEngine'
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

describe('work a usage limit stopped', () => {
  /** Work the owner asked for in the chat, handed off and running on its first dispatch's model. */
  async function work(text = 'Compare three vacuums', id = 'm1') {
    const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { workId } = await f.bots.tools.work.start(botId, turn.id, { title: 'Vacuums', brief: 'Compare three vacuums.', key: `k-${id}` })
    await runDispatch(f, turn.id, 1, { text: 'On it.' })
    return { workId, message }
  }

  /**
   * Every model at its limit until `until`: the dispatch fails on the first, its retry on the second, and the next
   * retry finds none free (it is written, never sent).
   */
  async function limitedOut(workId: string, until: string) {
    for (const n of [1, 2]) await runDispatch(f, workId, n, limited(until))
    await flush()
  }

  const errors = () => chatOf(f, botId).filter((message) => message.kind === 'error')

  it('waits with one line, never as a failure, and carries on in the same thread when the pause ends', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + 2 * HOUR).toISOString()
    const { workId, message } = await work()
    await limitedOut(workId, until)
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'usage_limit', pausedUntil: until, failureStreak: 0 })
    expect(errors()).toMatchObject([{ error: { text: `Paused until ${hhmm(until)} (your Claude usage limit). I'll carry on with this then.` } }])
    expect(f.bots.tools.work.list(botId).now).toMatchObject([{ workId, status: 'paused' }])
    expect(f.store.dispatch(workId, 3)).toMatchObject({ runId: null, send: { usageRetry: true } })
    // A tick before the reset changes nothing.
    await f.tickSchedules(new Date(f.clock.now + HOUR))
    expect(f.store.dispatch(workId, 3)!.runId).toBeNull()
    // The first tick after it ends the pause and carries the work on in its thread, on a model chosen again.
    f.limited.clear()
    await f.tickSchedules(new Date(Date.parse(until) + 60_000))
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: null })
    expect(f.store.activation(workId)).toMatchObject({ status: 'running', selection: { instanceId: 'claude:main' } })
    expect(f.store.dispatch(workId, 3)!.runId).not.toBeNull()
    expect(f.store.dispatch(workId, 3)!.threadId).toBe(f.store.dispatch(workId, 1)!.threadId)

    // It meets the limit again, with its retries used: it waits again, in the same one line, and then continues.
    const later = new Date(Date.parse(until) + HOUR).toISOString()
    await runDispatch(f, workId, 3, limited(later))
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(errors()).toHaveLength(1)
    f.limited.clear()
    await f.tickSchedules(new Date(Date.parse(later) + 60_000))
    const next = f.store.dispatch(workId, 4)!
    expect(next).toMatchObject({ kind: 'continue', threadId: f.store.dispatch(workId, 1)!.threadId })
    expect(next.prompt.text).toContain('A usage limit stopped you while you were working; it has reset now.')
    await runDispatch(f, workId, 4, { text: 'The Q7.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'The Q7.', replyTo: { id: message.id } })
    expect(f.store.activation(workId)).toMatchObject({ status: 'done' })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0 })
    // Carried on once: later ticks send nothing more.
    await f.tickSchedules(new Date(Date.parse(later) + 5 * 60_000))
    expect(f.store.dispatches(workId)).toHaveLength(4)
  })

  it('a first dispatch that never went out (no model was free) is sent as it was after the reset', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + HOUR).toISOString()
    // The chat turn has its model; then every model reaches its limit before the work's first dispatch goes out.
    await f.bots.service.chatSend({ botId, text: 'Compare three vacuums', clientRequestId: 'm1' })
    const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    f.limited.set('claude:main', until)
    f.limited.set('pi:openrouter', until)
    const { workId } = await f.bots.tools.work.start(botId, turn.id, { title: 'Vacuums', brief: 'Compare three vacuums.', key: 'k-m1' })
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(f.store.dispatch(workId, 1)).toMatchObject({ runId: null, startedAt: null })
    f.limited.clear()
    await f.tickSchedules(new Date(Date.parse(until) + 60_000))
    expect(f.store.dispatches(workId)).toHaveLength(1)
    expect(f.store.dispatch(workId, 1)!.runId).not.toBeNull()
    expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
  })

  it('Stop wins: stopped work never carries on after the reset', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + HOUR).toISOString()
    const { workId } = await work()
    await limitedOut(workId, until)
    expect(await f.bots.service.workStop(botId, workId)).toEqual({ stopped: true })
    f.limited.clear()
    await f.tickSchedules(new Date(Date.parse(until) + 60_000))
    expect(f.store.activation(workId)).toMatchObject({ status: 'cancelled' })
    expect(f.store.dispatch(workId, 3)!.runId).toBeNull()
    expect(f.store.dispatches(workId)).toHaveLength(3)
  })

  it('under the owner\'s own pause it waits for the reset time itself, and Resume tries at once', async () => {
    await f.bots.reconcileOnStartup()
    f.bots.pauseBot(botId)
    const until = new Date(f.clock.now + HOUR).toISOString()
    const { workId } = await work()
    await limitedOut(workId, until)
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(f.store.registry(botId)!.pausedReason).toBe('owner')
    await f.tickSchedules(new Date(f.clock.now + 10 * 60_000))
    expect(f.store.dispatch(workId, 3)!.runId).toBeNull()
    f.limited.clear()
    await f.tickSchedules(new Date(Date.parse(until) + 60_000))
    expect(f.store.dispatch(workId, 3)!.runId).not.toBeNull()
    expect(f.store.registry(botId)!.pausedReason).toBe('owner')
  })

  it('the owner\'s Continue is refused with a plain message; Resume is the way to try now', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + HOUR).toISOString()
    const { workId } = await work()
    await limitedOut(workId, until)
    await expect(f.bots.continueActivation(workId)).rejects.toMatchObject({ code: 'bot_work_waiting', message: 'This work waits for a usage limit to reset. It carries on then, or press Resume to try now.' })
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    // The schedules are not held by it.
    expect(f.store.laneActivations(botId, 'run', ['running', 'waiting_grant'])).toEqual([])
  })

  it('Resume tries at once, before the reset', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + HOUR).toISOString()
    const { workId } = await work()
    await limitedOut(workId, until)
    f.limited.clear()
    await f.bots.service.resume(botId)
    await flush()
    expect(f.store.dispatch(workId, 3)!.runId).not.toBeNull()
    expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
  })

  it('with no reset time given it says so, and tries again every 30 minutes until it goes through', async () => {
    await f.bots.reconcileOnStartup()
    const { workId } = await work()
    // Every model is at its limit and none says when it resets.
    f.problem = { problem: 'all_limited', instanceId: 'claude:main' }
    await runDispatch(f, workId, 1, { status: 'failed', outcome: { error: 'provider_usage_limit', usageLimitUntil: new Date(f.clock.now + HOUR).toISOString() } })
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    const retryAt = new Date(f.clock.now + USAGE_RECHECK_MS).toISOString()
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'usage_limit', pausedUntil: retryAt })
    expect(errors()).toMatchObject([{ error: { text: 'Paused (your Claude usage limit, with no reset time given). I\'ll try this again every 30 minutes until it goes through.' } }])
    expect(JSON.stringify(chatOf(f, botId))).not.toContain('once it resets')
    // Still limited at the first retry: it waits another 30 minutes, with no second line.
    await f.tickSchedules(new Date(Date.parse(retryAt) + 1_000))
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(Date.parse(f.store.registry(botId)!.pausedUntil!)).toBe(Date.parse(retryAt) + 1_000 + USAGE_RECHECK_MS)
    expect(errors()).toHaveLength(1)
    // The limit is gone at the next retry: the work goes on.
    f.problem = undefined
    await f.tickSchedules(new Date(Date.parse(retryAt) + 1_000 + USAGE_RECHECK_MS + 1_000))
    expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
  })

  it('survives a restart: the pause is kept, and the work carries on once after the reset', async () => {
    await f.bots.reconcileOnStartup()
    const until = new Date(f.clock.now + HOUR).toISOString()
    const { workId } = await work()
    await limitedOut(workId, until)
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'usage_limit' })
    expect(f.store.dispatch(workId, 3)!.runId).toBeNull()
    f.limited.clear()
    f.clock.now = Date.parse(until) + 60_000
    await f.bots.maintain(new Date(f.clock.now))
    await flush()
    const sent = f.store.dispatch(workId, 3)!.runId
    expect(sent).not.toBeNull()
    await f.bots.maintain(new Date(f.clock.now + 60_000))
    expect(f.store.dispatches(workId)).toHaveLength(3)
    expect(f.store.dispatch(workId, 3)!.runId).toBe(sent)
  })
})
