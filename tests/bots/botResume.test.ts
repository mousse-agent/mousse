import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  f = botFixture()
  vi.setSystemTime(f.clock.now)
  f.host.clock = () => Date.now()
  f.host.setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return { clear: () => clearTimeout(timer) }
  }
  await f.bots.reconcileOnStartup()
})
afterEach(() => {
  f.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Orders: ordinary step; sleep past a due time; repeated jumps during an in-flight scheduler pass; close.
describe('bot timers after sleep', () => {
  it('does no extra due pass on ordinary ten-second steps', async () => {
    const due = vi.spyOn(f.bots, 'deliverDueReminders')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(due).not.toHaveBeenCalled()
  })

  it('delivers a due reminder and queues a wake on the first watchdog callback after a jump', async () => {
    const { botId } = await createBot(f, { reply: 'Hello.' })
    await f.bots.service.chatSend({ botId, text: 'Remind me and check back in a minute.', clientRequestId: 'timers' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const turn = await start(f, activation.id)
    const dueAt = new Date(Date.now() + 60_000).toISOString()
    f.bots.tools.reminders.add(botId, activation.id, { dueAt, text: 'Drink some water.' })
    const wake = await f.bots.tools.wakes!.add(botId, activation.id, { dueAt, brief: 'Check the deploy.' })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    const upkeep = vi.spyOn(f.bots, 'maintain')

    // Sleeping changes wall time without running the timers that would have fired meanwhile.
    vi.setSystemTime(Date.now() + 120_000)
    f.clock.now = Date.now()
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    expect(upkeep).toHaveBeenCalledTimes(1)
    expect(chatOf(f, botId).some((row) => row.text.includes('Drink some water.'))).toBe(true)
    expect(f.store.listActivations(botId).filter((row) => row.idempotencyKey === `wake:${wake.wakeId}`)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(upkeep).toHaveBeenCalledTimes(1)
  })

  it('delivers due timers after resume while a pull request read is blocked', async () => {
    const { botId } = await createBot(f, { reply: 'Hello.' })
    await f.bots.service.chatSend({ botId, text: 'Remind me and check the deploy.', clientRequestId: 'offline-resume' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const turn = await start(f, activation.id)
    const dueAt = new Date(Date.now() + 60_000).toISOString()
    f.bots.tools.reminders.add(botId, activation.id, { dueAt, text: 'Drink water offline.' })
    const wake = await f.bots.tools.wakes!.add(botId, activation.id, { dueAt, brief: 'Check back.' })
    f.host.pullRequestState = async () => ({ state: 'open' })
    await f.bots.tools.wakes!.add(botId, activation.id, { brief: 'Watch deploy.', event: { kind: 'pr', repo: 'acme/app', number: 1 } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    let release!: () => void
    const read = new Promise<{ state: 'open' }>((resolve) => { release = () => resolve({ state: 'open' }) })
    const network = vi.fn(() => read)
    f.host.pullRequestState = network
    try {
      vi.setSystemTime(Date.now() + 120_000)
      f.clock.now = Date.now()
      await vi.advanceTimersByTimeAsync(10_000)
      await flush()
      expect(network).toHaveBeenCalledTimes(1)
      expect(chatOf(f, botId).some((row) => row.text.includes('Drink water offline.'))).toBe(true)
      expect(f.store.listActivations(botId).filter((row) => row.idempotencyKey === `wake:${wake.wakeId}`)).toHaveLength(1)
    } finally {
      release()
      await flush()
    }
  })

  it('delivers later timers and reruns upkeep at the newest queued tick after a slow pass', async () => {
    const { botId } = await createBot(f, { reply: 'Hello.' })
    await f.bots.service.chatSend({ botId, text: 'Watch this PR and remind me.', clientRequestId: 'slow-tick' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const turn = await start(f, activation.id)
    const before = Date.now()
    f.bots.tools.reminders.add(botId, activation.id, { dueAt: new Date(before + 60_000).toISOString(), text: 'Due during the slow read.' })
    f.host.pullRequestState = async () => ({ state: 'open' })
    await f.bots.tools.wakes!.add(botId, activation.id, { brief: 'Watch deploy.', event: { kind: 'pr', repo: 'acme/app', number: 1 } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    let release!: () => void
    const read = new Promise<{ state: 'open' }>((resolve) => { release = () => resolve({ state: 'open' }) })
    const network = vi.fn<NonNullable<typeof f.host.pullRequestState>>()
      .mockImplementationOnce(() => read).mockResolvedValue({ state: 'open' })
    f.host.pullRequestState = network
    const first = f.bots.maintain(new Date(before))
    await flush()
    expect(network).toHaveBeenCalledTimes(1)
    // The first pass has already checked pauses and pumped its work queue.
    f.store.setPaused(botId, 'usage_limit', new Date(before + 120_000).toISOString())
    // A persisted work row arrives after this pass has already visited its queue.
    const work = { workId: 'act_00000000-0000-4000-8000-000000000008' }
    const from = f.store.activation(activation.id)!
    f.store.db.transaction(() => f.store.insertActivation({
      ...from, id: work.workId, lane: 'run', status: 'queued', idempotencyKey: 'work:queued-during-upkeep',
      trigger: { kind: 'work', input: 'Start queued work.', title: 'Queued work', from: activation.id }
    }, {}))
    expect(f.store.activation(work.workId)?.status).toBe('queued')
    vi.setSystemTime(before + 60_000)
    f.clock.now = Date.now()
    const second = f.bots.maintain(new Date(Date.now()))
    vi.setSystemTime(before + 180_000)
    f.clock.now = Date.now()
    const third = f.bots.maintain(new Date(Date.now()))
    try {
      await flush()
      expect.soft(chatOf(f, botId).some((row) => row.text.includes('Due during the slow read.'))).toBe(true)
      expect(network).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await Promise.all([first, second, third])
      await flush()
    }
    // One extra pass uses the newest tick, ending the pause and starting the queued work without another tick.
    expect.soft(f.store.activation(work.workId)?.status).toBe('running')
    expect.soft(f.store.registry(botId)?.pausedReason).toBeNull()
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('lets ten scheduler ticks reach inbox sync while upkeep is blocked, with one follow-up pass', async () => {
    const { botId } = await createBot(f, { reply: 'Hello.' })
    await f.bots.service.chatSend({ botId, text: 'Watch this PR.', clientRequestId: 'slow-inbox' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const turn = await start(f, activation.id)
    f.host.pullRequestState = async () => ({ state: 'open' })
    await f.bots.tools.wakes!.add(botId, activation.id, { brief: 'Watch deploy.', event: { kind: 'pr', repo: 'acme/app', number: 1 } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    let release!: () => void
    const read = new Promise<{ state: 'open' }>((resolve) => { release = () => resolve({ state: 'open' }) })
    const network = vi.fn<NonNullable<typeof f.host.pullRequestState>>()
      .mockImplementationOnce(() => read).mockResolvedValue({ state: 'open' })
    f.host.pullRequestState = network
    const syncInbox = vi.fn()
    // The service's tick hook awaits bot maintenance before syncing the Automations inbox.
    f.scheduler.setTickHook(async (now) => {
      await f.bots.maintain(now)
      syncInbox()
    })
    const first = f.scheduler.tickNow()
    await flush()
    expect(network).toHaveBeenCalledTimes(1)
    const ticks: Promise<void>[] = []
    try {
      for (let i = 1; i <= 10; i++) {
        // The engine's own clock moves with the ticks: a pull request read is timed by it, not by a tick's time.
        f.clock.now += 120_000
        vi.setSystemTime(f.clock.now)
        ticks.push(f.scheduler.tickNow())
        await flush()
        expect.soft(syncInbox).toHaveBeenCalledTimes(i)
        expect(network).toHaveBeenCalledTimes(1)
      }
    } finally {
      release()
      await Promise.all([first, ...ticks])
      await flush()
    }
    expect(syncInbox).toHaveBeenCalledTimes(11)
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('stops checking when the engine closes', async () => {
    const due = vi.spyOn(f.bots, 'deliverDueReminders')
    f.bots.close()
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(due).not.toHaveBeenCalled()
  })
})
