import { afterEach, beforeEach, expect, it } from 'vitest'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { botFixture, createBot, finish, start, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { reply: 'Hi.' }))
  await f.bots.reconcileOnStartup()
})
afterEach(() => f.close())

function syncInbox() {
  MmsProfileServices.prototype.syncBotRuns.call({
    automationRuns: f.automationRuns, personalBots: f.bots, scheduled: f.scheduler, botStore: f.store
  } as never)
}

it('settles a removed schedule\'s last report and creates its Needs you item', async () => {
  const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check price.' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  const turn = await start(f, row.id)
  f.automationRuns.report({ threadId: turn.payload.threadId, activationId: row.id }, 'needs_you', 'Pick one.')
  f.bots.tools.schedules.done!(turn.payload.threadId, 'Finished.')
  await finish(f, turn.payload, 'completed', { text: 'Pick one.' })
  syncInbox()
  expect(f.book.get(botId, schedule.scheduleId)).toBeUndefined()
  expect(f.automationRuns.liveRunFor({ threadId: '', activationId: row.id })).toBeUndefined()
  const run = f.automationRuns.list().runs.find(run => run.jobId === schedule.jobId)!
  expect(run.state).toBe('done')
  expect(run.endedAt).toBeDefined()
  expect(run.items.some(item => item.kind === 'needs_you')).toBe(true)
})

it('settles cancelled waiting runs after the job is removed without creating failure items', async () => {
  for (let i = 0; i < 3; i++) await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` })
  const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check price.' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  expect(row.status).toBe('queued')
  f.bots.removeSchedule(botId, schedule.scheduleId)
  syncInbox()
  expect(f.automationRuns.liveRunFor({ threadId: '', activationId: row.id })).toBeUndefined()
  const run = f.automationRuns.list().runs.find(run => run.jobId === schedule.jobId)!
  expect(run.state).toBe('done')
  expect(run.items).toEqual([])
})
