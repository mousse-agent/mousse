import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botFixture, chatOf, createBot, finish, start, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const MIN = 60_000
const localTime = (time: number) => {
  const at = new Date(time)
  return `${at.getFullYear()}-${String(at.getMonth()+1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
beforeEach(async () => {
  f = botFixture(); ({ botId } = await createBot(f))
  await f.bots.reconcileOnStartup()
})
afterEach(() => { vi.restoreAllMocks(); f.close() })
const add = (say = false) => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, ...(say ? { say: 'Take your pills' } : { prompt: 'Inbox check' }), until: localTime(T0 + 7 * MIN) }, 'owner')
const ownRun = () => f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
const notices = () => chatOf(f, botId).filter(row => row.systemLine).map(row => row.text)

// At expiry: queued, wall-waiting, parked and paused work leaves quietly; an executing run reports.
it.each(['queued', 'waiting_grant', 'blocked', 'paused'] as const)('expiry withdraws %s work without a stopped line', async status => {
  if (status === 'queued') for (let i = 0; i < 3; i++) await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` })
  const schedule = add()
  await f.tickSchedules(new Date(T0 + 5 * MIN))
  const row = ownRun()
  if (status === 'waiting_grant') f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
  else if (status !== 'queued') f.store.run('UPDATE bot_activations SET status = ? WHERE id = ?', status, row.id)
  await f.tickSchedules(new Date(T0 + 8 * MIN))
  expect(f.book.get(botId, schedule.scheduleId)).toBeUndefined()
  expect(f.store.activation(row.id)).toMatchObject({ status: 'cancelled', endReason: 'schedule_removed' })
  expect(f.store.openAsks(botId)).toEqual([])
  expect(chatOf(f, botId).filter(message => message.activationId === row.id)).toEqual([])
  expect(notices()).toEqual(['‘Inbox check’ ended, as planned.'])
  await f.tickSchedules(new Date(T0 + 10 * MIN))
  expect(notices()).toEqual(['‘Inbox check’ ended, as planned.'])
})

it.each([false, true])('an executing run reports after expiry without a wall card (%s)', async wall => {
  const schedule = add()
  f.book.update(f.scheduler.getJob(schedule.jobId)!, { tellMe: 'needs_you' })
  await f.tickSchedules(new Date(T0 + 5 * MIN))
  const row = ownRun(), turn = await start(f, row.id)
  const events: Array<{ message: { kind: string }; quiet?: true }> = []
  f.bots.events.on('message', event => events.push(event))
  await f.tickSchedules(new Date(T0 + 8 * MIN))
  expect(f.store.activation(row.id)!.status).toBe('running')
  // A late schedule_done is harmless: expiry already ended it and owns the quiet line.
  f.bots.tools.schedules.done(turn.payload.threadId, 'Finished after expiry.')
  if (wall) f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
  f.automationRuns.report({ threadId: '', activationId: row.id }, 'fyi', 'Checked.')
  await finish(f, turn.payload, 'completed', { text: 'Checked.' })
  expect(chatOf(f, botId).filter(message => message.activationId === row.id).some(message => message.ask)).toBe(false)
  expect(chatOf(f, botId).some(message => message.kind === 'run_report' && message.text === 'Checked.')).toBe(true)
  expect(events.find(event => event.message.kind === 'run_report')).toMatchObject({ quiet: true })
  expect(notices()).toEqual(['‘Inbox check’ ended, as planned.'])
})

it('schedule_done before until keeps its report filter and says stopped, never planned expiry', async () => {
  const schedule = add()
  f.book.update(f.scheduler.getJob(schedule.jobId)!, { tellMe: 'needs_you' })
  await f.tickSchedules(new Date(T0 + 5 * MIN))
  const row = ownRun(), turn = await start(f, row.id)
  const events: Array<{ message: { kind: string }; quiet?: true }> = []
  f.bots.events.on('message', event => events.push(event))
  f.bots.tools.schedules.done(turn.payload.threadId, 'Goal met.')
  f.automationRuns.report({ threadId: '', activationId: row.id }, 'fyi', 'Checked.')
  await finish(f, turn.payload, 'completed', { text: 'Checked.' })
  await f.tickSchedules(new Date(T0 + 8 * MIN))
  expect(f.scheduler.getJob(schedule.jobId)).toBeUndefined()
  expect(events.find(event => event.message.kind === 'run_report')).toMatchObject({ quiet: true })
  expect(notices()).toEqual(['Stopped ‘Inbox check’.'])
})

it('a fixed line always tells and reaches until without a run that could complete its schedule', async () => {
  const schedule = add(true)
  f.book.update(f.scheduler.getJob(schedule.jobId)!, { tellMe: 'needs_you' })
  const events: Array<{ message: { kind: string }; quiet?: true }> = []
  f.bots.events.on('message', event => events.push(event))
  await f.tickSchedules(new Date(T0 + 5 * MIN))
  expect(f.store.listActivations(botId).filter(row => row.lane === 'run')).toEqual([])
  expect(events.find(event => event.message.kind === 'run_report')?.quiet).toBeUndefined()
  await f.tickSchedules(new Date(T0 + 8 * MIN))
  expect(notices()).toEqual(['‘Take your pills’ ended, as planned.'])
})
