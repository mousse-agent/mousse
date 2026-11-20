import { afterEach, beforeEach, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const CAP = { error: '[provider_turn_cap] Claude Code reached the most steps one turn may take.' }
beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { reply: 'Hi.' }))
  await f.bots.reconcileOnStartup()
})
afterEach(() => f.close())

async function scheduled() {
  const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check price.' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  return { schedule, row, ...await start(f, row.id) }
}
function syncInbox() {
  MmsProfileServices.prototype.syncBotRuns.call({ automationRuns: f.automationRuns, botStore: f.store } as never)
}
/** The activation has made as many model requests as it may. */
function useUpRequests(activationId: string) {
  const counters = f.store.counters(activationId)
  f.store.setLimits(activationId, { ...counters.limits, maxTurns: counters.requests })
}

function rebuildEngine() {
  f.bots.close()
  f.bots = new BotEngine(f.host)
}

// The end: requests exhausted at a turn cap. Words arrive with settlement or late; replayed settlement, startup and inbox
// reads must stay idempotent.
it('a request limit posts the removed schedule report once, also after late settlement and startup', async () => {
  const s = await scheduled()
  const ordinary = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Check price.' }, 'owner')
  const started = f.bots.runScheduledOccurrence({ botId, scheduleId: ordinary.scheduleId, prompt: 'Check price.', occurrenceAt: f.store.now() })
  expect(started.kind).toBe('started')
  if (started.kind !== 'started') throw new Error('Expected ordinary report control')
  await flush()
  await runDispatch(f, started.activationId, 1, { text: 'Checked the price.' })
  const control = chatOf(f, botId).find(message => message.activationId === started.activationId && message.kind === 'run_report')!
  const ordinaryClass = f.store.message(control.id)!.tell
  expect(ordinaryClass).toBe('soon')
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  useUpRequests(s.row.id)
  await finish(f, s.payload, 'failed', { text: 'Checked the price.', outcome: CAP })
  const reports = () => chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report')
  expect(f.store.activation(s.row.id)).toMatchObject({ status: 'done', endReason: 'schedule_removed' })
  expect(reports().map(message => message.text)).toEqual(['Checked the price.'])
  expect(f.store.message(reports()[0]!.id)?.tell).toBe(ordinaryClass)
  expect(f.store.dispatches(s.row.id)).toHaveLength(1)
  expect(f.store.escalations({ activationId: s.row.id, status: 'open' })).toHaveLength(0)
  expect(chatOf(f, botId).some(message => message.activationId === s.row.id && (message.ask || message.systemLine))).toBe(false)
  syncInbox()
  const inbox = () => f.automationRuns.list().runs.find(run => run.jobId === s.schedule.jobId)!
  const endedAt = inbox().endedAt
  expect(inbox().state).toBe('done')
  expect(endedAt).toBeDefined()
  f.bots.settle(s.payload, { text: 'Checked the price.' })
  await flush()
  rebuildEngine()
  await f.bots.reconcileOnStartup()
  await flush()
  syncInbox()
  expect(reports().map(message => message.text)).toEqual(['Checked the price.'])
  expect(f.store.message(reports()[0]!.id)?.tell).toBe(ordinaryClass)
  expect(inbox().endedAt).toBe(endedAt)
})

it('a request limit takes final words arriving after its removed run ended', async () => {
  const s = await scheduled()
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  useUpRequests(s.row.id)
  await finish(f, s.payload, 'failed', { outcome: CAP })
  expect(f.store.activation(s.row.id)!.status).toBe('done')
  f.bots.settle(s.payload, { text: 'Checked the price.' })
  await flush()
  const reports = chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report')
  expect(reports.map(message => message.text)).toEqual(['Checked the price.'])
})

it('keeps an empty scheduled report quiet when no final words arrive', async () => {
  const s = await scheduled()
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  useUpRequests(s.row.id)
  await finish(f, s.payload, 'failed', { outcome: CAP })
  for (const timer of [...f.timers]) timer.fn()
  await flush()
  expect(chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report').map(message => message.text)).toEqual([])
})

it.each([false, true])('a live schedule still gets its wall card when another schedule was removed=%s', async otherRemoved => {
  const s = await scheduled()
  if (otherRemoved) {
    const other = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Other check.' }, 'owner')
    f.bots.removeSchedule(botId, other.scheduleId)
  }
  expect(f.bots.raiseWall(s.row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' }).kind).toBe('escalated')
  await finish(f, s.payload, 'interrupted', { text: 'Waiting for permission.', outcome: { interruptedBy: 'bot_wall' } })
  expect(f.store.activation(s.row.id)!.status).toBe('waiting_grant')
  expect(chatOf(f, botId).some(message => message.activationId === s.row.id && message.ask)).toBe(true)
})

it.each(['needs_you', 'every'] as const)('owner removal keeps the schedule Tell me %s for its final report', async tellMe => {
  const s = await scheduled()
  f.book.update(f.scheduler.getJob(s.schedule.jobId)!, { tellMe })
  f.host.quietHoursFor = () => ({ end: f.clock.now + 60_000 } as any)
  f.scheduler.deleteJob(s.schedule.jobId)
  await finish(f, s.payload, 'completed', { text: 'Checked the price.' })
  const report = chatOf(f, botId).find(row => row.activationId === s.row.id && row.kind === 'run_report')!
  expect(report).toBeDefined()
  const stored = f.store.message(report.id)!
  expect(stored.tell).toBe(tellMe === 'needs_you' ? 'later' : 'soon')
})
