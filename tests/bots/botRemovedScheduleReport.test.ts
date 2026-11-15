import { afterEach, beforeEach, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { botFixture, chatOf, createBot, finish, flush, start, T0, type BotFixture } from './botFixture'

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
function rebuildEngine() {
  f.bots.close()
  f.bots = new BotEngine(f.host)
}

// End triggers: requests exhausted, work time exhausted at a turn cap, work time exhausted at restart.
// Words arrive with settlement or late; replayed settlement, startup and inbox reads must stay idempotent.
it.each(['request limit', 'time limit', 'restart'] as const)('%s posts the removed schedule report once, also after late settlement and startup', async end => {
  const s = await scheduled()
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  if (end === 'request limit') {
    const counters = f.store.counters(s.row.id)
    f.store.setLimits(s.row.id, { ...counters.limits, maxTurns: counters.requests })
    await finish(f, s.payload, 'failed', { text: 'Checked the price.', outcome: CAP })
  } else {
    f.clock.now = s.prepared.authority.time.deadline() - 10_000
    s.prepared.authority.check({ kind: 'app', tool: 'memory_list', args: {} })
    if (end === 'time limit') await finish(f, s.payload, 'failed', { text: 'Checked the price.', outcome: CAP })
    else {
      // The last durable result is what startup has, without a live executor or an in-memory carried reply.
      f.store.run('UPDATE bot_activations SET result = ? WHERE id = ?', 'Checked the price.', s.row.id)
      f.runs.markTerminal(s.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      rebuildEngine()
      await f.bots.reconcileOnStartup()
      await flush()
    }
  }
  const reports = () => chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report')
  expect(f.store.activation(s.row.id)).toMatchObject({ status: 'done', endReason: 'schedule_removed' })
  expect(reports().map(message => message.text)).toEqual(['Checked the price.'])
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
  expect(inbox().endedAt).toBe(endedAt)
})

it.each(['request limit', 'time limit', 'restart'] as const)('%s takes final words arriving after its removed run ended', async end => {
  const s = await scheduled()
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  if (end === 'request limit') {
    const counters = f.store.counters(s.row.id)
    f.store.setLimits(s.row.id, { ...counters.limits, maxTurns: counters.requests })
    await finish(f, s.payload, 'failed', { outcome: CAP })
  } else {
    f.clock.now = s.prepared.authority.time.deadline() - 10_000
    s.prepared.authority.check({ kind: 'app', tool: 'memory_list', args: {} })
    if (end === 'time limit') await finish(f, s.payload, 'failed', { outcome: CAP })
    else {
      f.runs.markTerminal(s.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      rebuildEngine()
      await f.bots.reconcileOnStartup()
    }
  }
  expect(f.store.activation(s.row.id)!.status).toBe('done')
  f.bots.settle(s.payload, { text: 'Checked the price.' })
  await flush()
  const reports = chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report')
  expect(reports.map(message => message.text)).toEqual(['Checked the price.'])
})

it('uses the existing Done fallback once when no final words arrive', async () => {
  const s = await scheduled()
  f.bots.removeSchedule(botId, s.schedule.scheduleId)
  f.clock.now = s.prepared.authority.time.deadline() - 10_000
  await finish(f, s.payload, 'failed', { outcome: CAP })
  for (const timer of [...f.timers]) timer.fn()
  await flush()
  expect(chatOf(f, botId).filter(message => message.activationId === s.row.id && message.kind === 'run_report').map(message => message.text)).toEqual(['Done.'])
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
