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

  it('shares a running scheduler pass with other ticks and repeated resume checks', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const due = vi.spyOn(f.bots, 'deliverDueReminders').mockReturnValue(pending)
    const first = f.bots.maintain()
    await flush()
    const second = f.bots.maintain()
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(Date.now() + 120_000)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    const calls = due.mock.calls.length
    release()
    await Promise.all([first, second])
    expect(calls).toBe(1)
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
