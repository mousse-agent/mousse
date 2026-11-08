/**
 * No internet (docs/bots.md): a bot activation waits instead of failing. Before a dispatch is
 * sent, when a live dispatch makes no progress, and when its provider can't be reached, the engine
 * checks the internet (an injected fake here). While it waits the bot says "Waiting for internet"
 * with one notice row; the wait is not charged, never counts as a failure and never raises a
 * budget ask; when the internet is back the activation sends or continues its dispatch. A waiting
 * run survives a restart, and a schedule keeps at most one waiting run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_OFFLINE_POLL_MAX_MS, BOT_OFFLINE_POLL_MS, BOT_OFFLINE_STALL_MS, BOT_OFFLINE_TEXT, BOT_OFFLINE_WATCH_MS, BotEngine } from '../../src/mms/bots/activation/BotEngine'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { DEFAULT_BOT_ACTIVE_MS, OLD_DEFAULT_BOT_ACTIVE_MS } from '../../src/shared/bots/personal/definition'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const net = { online: true, checks: 0 }
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>

const call: NormalisedCall = { kind: 'app', tool: 'memory_list', args: {} }
const CONNECTION_ERROR = { error: '[provider_unavailable] The provider is temporarily unavailable. Please try again.' }

/** Fires the newest live timer of `ms`, then lets what follows run. */
async function fire(ms: number): Promise<void> {
  const timer = timers.filter((entry) => entry.ms === ms && !entry.cleared).at(-1)
  if (!timer) throw new Error(`no timer of ${ms} ms (have ${timers.filter((entry) => !entry.cleared).map((entry) => entry.ms).join(', ')})`)
  timer.cleared = true
  timer.fn()
  await flush(12)
}

const live = (ms: number) => timers.filter((entry) => entry.ms === ms && !entry.cleared)
const notices = () => chatOf(f, botId).filter((message) => message.text === BOT_OFFLINE_TEXT)
const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

beforeEach(async () => {
  f = botFixture()
  timers = []
  f.host.setTimer = (fn, ms) => {
    const timer = { fn, ms, cleared: false }
    timers.push(timer)
    return { clear: () => { timer.cleared = true } }
  }
  net.online = true
  net.checks = 0
  botId = (await createBot(f, { name: 'Noobesh', reply: 'Hello.' })).botId
  f.host.connectivity = { online: async () => { net.checks += 1; return net.online } }
})

afterEach(() => f.close())

describe('offline before a dispatch starts', () => {
  it('waits with one notice and no time charged, then sends the dispatch when the internet is back', async () => {
    net.online = false
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    await flush()
    const row = f.store.activation(activation.id)!
    expect(row).toMatchObject({ status: 'running', offline: true })
    expect(f.store.dispatch(activation.id, 1)).toMatchObject({ runId: null, startedAt: null })
    expect(f.store.counters(activation.id).activeMs).toBe(0)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({ kind: 'notice', activationId: activation.id })
    expect(chatOf(f, botId).some((message) => message.kind === 'error')).toBe(false)
    expect(summary()).toMatchObject({ state: 'working', stateText: 'Waiting for internet', waiting: 'internet' })

    // Still offline: it checks again later, backing off to a minute, and posts nothing more.
    await fire(BOT_OFFLINE_POLL_MS)
    await fire(2 * BOT_OFFLINE_POLL_MS)
    await fire(BOT_OFFLINE_POLL_MAX_MS)
    expect(live(BOT_OFFLINE_POLL_MAX_MS)).toHaveLength(1)
    expect(notices()).toHaveLength(1)
    expect(f.store.dispatch(activation.id, 1)!.runId).toBeNull()

    net.online = true
    await fire(BOT_OFFLINE_POLL_MAX_MS)
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: false })
    expect(summary().stateText).toBe('Working…')
    expect(summary().waiting).toBeUndefined()
    await runDispatch(f, activation.id, 1, { text: 'Three stories.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Three stories.' })
    expect(notices()).toHaveLength(1)
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
  })

  it('a chat message waits too, and is answered once the internet is back', async () => {
    net.online = false
    await f.bots.service.chatSend({ botId, text: 'Anything new?', clientRequestId: 'm1' })
    await flush()
    const chat = f.store.listActivations(botId).find((row) => row.lane === 'chat' && row.status === 'running')!
    expect(chat.offline).toBe(true)
    expect(notices()).toHaveLength(1)
    net.online = true
    await fire(BOT_OFFLINE_POLL_MS)
    await runDispatch(f, chat.id, 1, { text: 'Nothing yet.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'text', text: 'Nothing yet.' })
  })

  it('Stop ends a waiting activation', async () => {
    net.online = false
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    await flush()
    await f.bots.stop(activation.id)
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'stopped', offline: false })
    expect(live(BOT_OFFLINE_POLL_MS)).toHaveLength(0)
  })
})

describe('offline while a dispatch runs', () => {
  it('a dispatch that makes no progress ends to wait: only its work is charged, no ask, no failure, and it continues', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { payload, prepared } = await start(f, activation.id)
    // Ten seconds of work, then nothing: the internet went away.
    f.clock.now += 10_000
    prepared.authority.check(call)
    net.online = false
    f.clock.now += BOT_OFFLINE_STALL_MS
    await fire(BOT_OFFLINE_WATCH_MS)
    // One failed check is not enough.
    expect(prepared.authority.time.signal.aborted).toBe(false)
    f.clock.now += BOT_OFFLINE_WATCH_MS
    await fire(BOT_OFFLINE_WATCH_MS)
    expect(prepared.authority.time.signal.aborted).toBe(true)
    expect(notices()).toHaveLength(1)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: true })
    expect(f.store.counters(activation.id).activeMs).toBe(10_000)
    expect(f.store.openAsks(botId)).toEqual([])
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0 })
    expect(summary().stateText).toBe('Waiting for internet')

    net.online = true
    await fire(BOT_OFFLINE_POLL_MS)
    const next = f.store.dispatch(activation.id, 2)!
    expect(next).toMatchObject({ kind: 'continue', send: { continuationOfRunId: payload.runId } })
    expect(next.prompt.text).toMatch(/internet connection dropped/)
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: false, autoRestarts: 0 })
    await runDispatch(f, activation.id, 2, { text: 'Three stories.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    expect(notices()).toHaveLength(1)
  })

  it('a dispatch that makes progress is left alone, whatever the checks say', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { prepared } = await start(f, activation.id)
    net.online = false
    net.checks = 0
    for (let i = 0; i < 5; i += 1) {
      f.clock.now += BOT_OFFLINE_WATCH_MS
      prepared.authority.check(call)
      await fire(BOT_OFFLINE_WATCH_MS)
    }
    expect(net.checks).toBe(0)
    expect(prepared.authority.time.signal.aborted).toBe(false)
  })

  it('the deadline of a dispatch stuck with no internet waits instead of raising a budget ask', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { payload, prepared } = await start(f, activation.id)
    net.online = false
    f.clock.now += DEFAULT_BOT_ACTIVE_MS
    await fire(DEFAULT_BOT_ACTIVE_MS)
    expect(prepared.authority.time.signal.aborted).toBe(true)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: true })
    expect(f.store.counters(activation.id).activeMs).toBe(0)
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).some((message) => /ran out of room/.test(message.text) || message.kind === 'error')).toBe(false)
  })

  it('the deadline of a dispatch that worked is still a budget end with its ask', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { prepared } = await start(f, activation.id)
    net.checks = 0
    f.clock.now += DEFAULT_BOT_ACTIVE_MS
    prepared.authority.check(call)
    await fire(DEFAULT_BOT_ACTIVE_MS)
    expect(net.checks).toBe(0)
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'budget_exhausted' })
    expect(f.store.openAsks(botId)).toMatchObject([{ kind: 'budget', title: 'work for up to 2 hours per run' }])
  })

  it('the deadline of a run that made no call at all, with the internet there, ends it without a time ask', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    await start(f, activation.id)
    f.clock.now += DEFAULT_BOT_ACTIVE_MS
    await fire(DEFAULT_BOT_ACTIVE_MS)
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'no_progress' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'error', error: { text: 'I couldn\'t get anything done on this run, so I stopped.' } })
  })

  it('a run that fails on a connection error waits when the internet is gone, then continues', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    net.online = false
    await runDispatch(f, activation.id, 1, { status: 'failed', outcome: CONNECTION_ERROR })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: true })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0 })
    expect(chatOf(f, botId).some((message) => message.kind === 'error')).toBe(false)
    net.online = true
    await fire(BOT_OFFLINE_POLL_MS)
    await runDispatch(f, activation.id, 2, { text: 'Done.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
  })

  it('a connection error with the internet there is the provider\'s failure, as before', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    await runDispatch(f, activation.id, 1, { status: 'failed', outcome: CONNECTION_ERROR })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed' })
    expect(f.store.registry(botId)).toMatchObject({ failureStreak: 1 })
  })
})

describe('a restart while waiting', () => {
  const restart = async (): Promise<void> => {
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush(12)
  }

  it('a dispatch never sent waits again after the restart and is sent once the internet is back', async () => {
    net.online = false
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    await flush()
    await restart()
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: true })
    expect(f.store.dispatch(activation.id, 1)!.runId).toBeNull()
    expect(notices()).toHaveLength(1)
    net.online = true
    await fire(BOT_OFFLINE_POLL_MS)
    expect(f.store.dispatch(activation.id, 1)!.runId).not.toBeNull()
    await runDispatch(f, activation.id, 1, { text: 'Done.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
  })

  it('a dispatch ended for the internet continues after the restart, never as an automatic restart', async () => {
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { payload } = await start(f, activation.id)
    net.online = false
    f.clock.now += BOT_OFFLINE_STALL_MS
    await fire(BOT_OFFLINE_WATCH_MS)
    f.clock.now += BOT_OFFLINE_WATCH_MS
    await fire(BOT_OFFLINE_WATCH_MS)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    await restart()
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', offline: true, autoRestarts: 0 })
    expect(f.store.dispatch(activation.id, 2)).toBeUndefined()
    net.online = true
    await fire(BOT_OFFLINE_POLL_MS)
    expect(f.store.dispatch(activation.id, 2)!.prompt.text).toMatch(/internet connection dropped/)
    expect(f.store.activation(activation.id)).toMatchObject({ autoRestarts: 0 })
  })
})

describe('schedules', () => {
  it('keeps at most one waiting run per schedule: later occurrences are skipped', async () => {
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'check' }, 'owner')
    await f.bots.reconcileOnStartup()
    await f.bots.tickSchedules(new Date(f.clock.now))
    net.online = false
    f.clock.now += 5 * 60_000
    const first = await f.bots.tickSchedules(new Date(f.clock.now))
    await flush()
    expect(first.inserted).toHaveLength(1)
    expect(f.store.activation(first.inserted[0]!)).toMatchObject({ status: 'running', offline: true })
    for (let i = 0; i < 3; i += 1) {
      f.clock.now += 5 * 60_000
      expect((await f.bots.tickSchedules(new Date(f.clock.now))).inserted).toEqual([])
    }
    expect(f.store.scheduleStates(botId).find((state) => state.scheduleId === scheduleId)).toMatchObject({ lastSkipReason: 'waiting_for_internet' })
    expect(f.store.listActivations(botId).filter((row) => row.lane === 'run' && row.status !== 'done')).toHaveLength(1)
  })
})

describe('the hour of work', () => {
  const setWorkTime = (ms: number) => f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxActiveMs: ms } }))

  it('a new bot works up to an hour per run', () => {
    expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(60 * 60_000)
    expect(f.bots.definitionOf(botId).permissions.budget.maxActiveMs).toBe(60 * 60_000)
  })

  it('a grant still on the old 15 minutes is upgraded to the hour, its revision and draft too', () => {
    setWorkTime(OLD_DEFAULT_BOT_ACTIVE_MS)
    expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(OLD_DEFAULT_BOT_ACTIVE_MS)
    expect(f.bots.upgradeWorkTime()).toEqual([botId])
    expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(DEFAULT_BOT_ACTIVE_MS)
    const entry = f.host.definitions.get(botId)!
    expect(entry.published!.permissions.budget.maxActiveMs).toBe(DEFAULT_BOT_ACTIVE_MS)
    expect(entry.draft.permissions.budget.maxActiveMs).toBe(DEFAULT_BOT_ACTIVE_MS)
    // Once only: a second open changes nothing.
    expect(f.bots.upgradeWorkTime()).toEqual([])
  })

  it('a grant the owner set to something else stays', () => {
    setWorkTime(30 * 60_000)
    expect(f.bots.upgradeWorkTime()).toEqual([])
    expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(30 * 60_000)
  })

  it('a queued run moves to the upgraded grant and runs with the hour', async () => {
    setWorkTime(OLD_DEFAULT_BOT_ACTIVE_MS)
    f.bots.upgradeWorkTime()
    const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
    const { prepared } = await start(f, activation.id)
    expect(prepared.authority.time.deadline() - f.clock.now).toBe(DEFAULT_BOT_ACTIVE_MS)
  })
})
