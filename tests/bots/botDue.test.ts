/** Due sources: reminders, timed/event wakes, shown open question follow-ups, active schedules.
 * Activity: every unfinished activation status in both lanes, plus unread joined chat messages.
 * Edges: no due time, overdue, window boundary, another bot, settled/cancelled/deleted rows, paused schedules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, createBot, type BotFixture } from './botFixture'

const MIN = 60_000
let f: BotFixture
let botId: string
let first: string
const at = (minutes: number) => new Date(f.clock.now + minutes * MIN).toISOString()

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  const created = await createBot(f, { reply: 'Hello.' })
  botId = created.botId
  first = created.firstActivation
})
afterEach(() => f.close())

function reminder(id: string, minutes: number, wake = false, target = botId) {
  f.store.insertReminder({ id, botId: target, dueAt: at(minutes), text: id, work: null, replyTo: null, createdAt: at(0), wake })
}
function question(id: string, minutes: number, target = botId) {
  f.store.insertQuestion({ id, botId: target, activationId: first, dispatchN: 1, lane: 'chat', spec: { question: 'Which?', choices: ['A', 'B'] }, createdAt: at(0) })
  f.store.setQuestionMessage(id, `message-${id}`, at(minutes))
}
function schedule() {
  return f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Check.' }, 'owner')
}

describe('next due time', () => {
  it.each(['reminder', 'wake', 'question', 'schedule'])('picks %s ahead of all other sources', (soonest) => {
    reminder('r', soonest === 'reminder' ? 5 : 120)
    reminder('w', soonest === 'wake' ? 5 : 120, true)
    question('q', soonest === 'question' ? 5 : 120)
    const entry = schedule()
    const expected = soonest === 'schedule' ? entry.nextAt : at(5)
    expect(f.bots.nextDueAt(botId)).toBe(expected)
    expect(f.bots.nextDueAt()).toBe(expected)
  })

  it('has no due time when nothing waits, and scopes each read to its bot', async () => {
    expect(f.bots.nextDueAt()).toBeUndefined()
    const other = (await createBot(f, { reply: 'Hello.' })).botId
    reminder('other-r', 1, false, other)
    question('own-q', 20)
    expect(f.bots.nextDueAt(botId)).toBe(at(20))
    expect(f.bots.nextDueAt(other)).toBe(at(1))
    expect(f.bots.nextDueAt()).toBe(at(1))
  })

  it('ignores delivered/cancelled reminders and wakes, closed or unshown questions, paused and removed schedules', () => {
    reminder('delivered', 1)
    reminder('cancelled', 2, true)
    f.store.settleReminder('delivered', 'delivered')
    f.store.settleReminder('cancelled', 'cancelled')
    question('closed', 3)
    f.store.withdrawQuestions(botId)
    f.store.insertQuestion({ id: 'unshown', botId, activationId: first, dispatchN: 1, lane: 'chat', spec: { question: 'Which?', choices: ['A', 'B'] }, createdAt: at(0) })
    f.store.setQuestionNext('unshown', at(4))
    const paused = schedule()
    f.scheduler.pauseJob(paused.jobId)
    const removed = schedule()
    f.book.remove(botId, removed.scheduleId)
    expect(f.bots.nextDueAt(botId)).toBeUndefined()
  })

  it('ignores a deleted bot across all sources, even with rows still present', () => {
    reminder('r', 1)
    question('q', 2)
    schedule()
    f.store.run('UPDATE bot_registry SET deleted_at = ? WHERE bot_id = ?', at(0), botId)
    expect(f.bots.nextDueAt(botId)).toBeUndefined()
    expect(f.bots.nextDueAt()).toBeUndefined()
  })

  it('counts an event wake at its deadline, or now when its event fires', () => {
    f.store.insertReminder({ id: 'event', botId, dueAt: at(60), text: 'Follow up.', work: null, replyTo: null, createdAt: at(0), wake: true, event: { kind: 'thread', threadId: 't' } })
    expect(f.bots.nextDueAt(botId)).toBe(at(60))
    f.store.fireWake('event', { kind: 'ended', reason: 'thread_deleted' }, at(0))
    expect(f.bots.nextDueAt(botId)).toBe(at(0))
  })

  it.each(['reminder', 'wake', 'question'])('arms the existing delivery timer at the %s time', async (source) => {
    if (source === 'question') question('q', 20)
    else reminder('r', 20, source === 'wake')
    // Arming after a delivery pass uses the same due-source list as nextDueAt.
    f.timers.length = 0
    await f.bots.deliverDueReminders()
    expect(f.timers.at(-1)?.ms).toBe(20 * MIN)
  })

  it('leaves an overdue schedule to the shared scheduler without arming a delivery loop', async () => {
    const entry = schedule()
    f.clock.now = Date.parse(entry.nextAt!) + MIN
    f.timers.length = 0
    await f.bots.deliverDueReminders()
    expect(f.bots.nextDueAt(botId)).toBe(entry.nextAt)
    expect(f.timers).toHaveLength(0)
    expect(f.store.listActivations(botId)).toHaveLength(1)
    await f.tickSchedules()
    expect(f.store.listActivations(botId)).toHaveLength(2)
  })
})

describe('idleness (no caller outside tests yet)', () => {
  it.each(['chat', 'run'] as const)('checks each unfinished status in the %s lane', (lane) => {
    for (const status of ['queued', 'running', 'waiting_grant', 'paused', 'blocked'] as const) {
      f.store.run('UPDATE bot_activations SET lane = ?, status = ? WHERE id = ?', lane, status, first)
      expect(f.bots.isIdle(botId)).toBe(false)
    }
    for (const status of ['done', 'failed', 'cancelled']) {
      f.store.run('UPDATE bot_activations SET status = ? WHERE id = ?', status, first)
      expect(f.bots.isIdle(botId)).toBe(true)
    }
  })

  it('is busy while an ended chat turn still holds unread joined messages', () => {
    expect(f.bots.isIdle(botId)).toBe(true)
    f.store.addWorkNote(first, botId, 'And check tomorrow.', 'joined-message')
    expect(f.bots.isIdle(botId)).toBe(false)
    f.store.applyWorkNotes(f.store.pendingWorkNotes(first).map((note) => note.id))
    expect(f.bots.isIdle(botId)).toBe(true)
  })

  it.each([-1, 0, 29, 30, 31])('uses the inclusive default 30 minute window for a reminder at %s minutes', (minutes) => {
    reminder('r', minutes)
    expect(f.bots.isIdle(botId)).toBe(minutes > 30)
  })

  it.each(['wake', 'question', 'schedule'])('uses a custom window for %s', (source) => {
    let due = at(20)
    if (source === 'wake') reminder('w', 20, true)
    if (source === 'question') question('q', 20)
    if (source === 'schedule') due = schedule().nextAt!
    const within = Date.parse(due) - f.clock.now
    expect(f.bots.isIdle(botId, { within })).toBe(false)
    expect(f.bots.isIdle(botId, { within: within - 1 })).toBe(true)
  })
})
