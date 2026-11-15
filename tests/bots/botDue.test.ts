/** Due sources: reminders, timed/event wakes, shown open question follow-ups, active schedules.
 * Activity: queued/running/walled turns, resumable work, joined messages, watchers and launched threads.
 * Edges: no due time, overdue, window boundary, another bot, settled/cancelled/deleted rows, paused schedules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { BotLaunchedThread } from '../../src/shared/bots/personal/chat'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

const MIN = 60_000
let f: BotFixture
let botId: string
let first: string
const at = (minutes: number) => new Date(f.clock.now + minutes * MIN).toISOString()

beforeEach(async () => {
  f = botFixture({ spawnWatcher: () => new EventEmitter() as ChildProcess })
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

  it.each(['owner', 'failures', 'usage_limit'] as const)('skips enabled schedules while the bot is paused for %s', (reason) => {
    const entry = schedule()
    f.clock.now = Date.parse(entry.nextAt!) - MIN
    f.store.setPaused(botId, reason, at(60))
    expect(f.bots.schedulesOf(botId)[0]?.paused).toBe(false)
    expect(f.bots.nextDueAt(botId)).toBeUndefined()
    expect(f.bots.nextDueAt()).toBeUndefined()
    expect(f.bots.isIdle(botId)).toBe(true)
    // Pausing the bot excludes schedules only: fixed reminders can still be delivered.
    reminder('r', 20)
    expect(f.bots.nextDueAt(botId)).toBe(at(20))
    f.store.settleReminder('r', 'cancelled')
    f.store.setPaused(botId, null)
    expect(f.bots.nextDueAt(botId)).toBe(entry.nextAt)
    expect(f.bots.nextDueAt()).toBe(entry.nextAt)
    expect(f.bots.isIdle(botId)).toBe(false)
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
  it.each(['chat', 'run'] as const)('is busy for queued, running and walled turns in the %s lane', (lane) => {
    for (const status of ['queued', 'running', 'waiting_grant']) {
      f.store.run('UPDATE bot_activations SET lane = ?, status = ? WHERE id = ?', lane, status, first)
      expect(f.bots.isIdle(botId)).toBe(false)
    }
  })

  it.each(['budget_exhausted', 'room_allowed', 'usage_limit', 'question', 'question_answered'])('is busy for work waiting on %s', (reason) => {
    f.store.run("UPDATE bot_activations SET lane = 'run', status = 'blocked', trigger_json = ?, end_reason = ? WHERE id = ?",
      JSON.stringify({ kind: 'work', title: 'Check.', input: 'Check.' }), reason, first)
    expect(f.bots.isIdle(botId)).toBe(false)
  })

  it.each([
    ['paused', 'unknown_calls'], ['paused', 'uncertain'], ['paused', 'restarted_twice'], ['paused', 'wall_lost'],
    ['blocked', 'budget_denied'], ['blocked', 'bot_grant_revoked'], ['blocked', 'asked_too_often'],
    ['blocked', 'escalation_expired'], ['blocked', 'no_progress'], ['done', null], ['failed', null], ['cancelled', null]
  ])('is idle after a stopped %s row (%s)', (status, reason) => {
    f.store.run("UPDATE bot_activations SET lane = 'run', status = ?, trigger_json = ?, end_reason = ? WHERE id = ?",
      status, JSON.stringify({ kind: 'work', title: 'Check.', input: 'Check.' }), reason, first)
    expect(f.bots.isIdle(botId)).toBe(true)
  })

  it.each([
    ['running', false], ['queued', false], ['paused', false], ['subagents', false], ['needs_input', false],
    ['idle', true], ['done', true], ['failed', true], ['stopped', true]
  ] as const)('agrees with the summary for a launched thread that is %s', (status, idle) => {
    const thread: BotLaunchedThread = { threadId: 'launched', title: 'Check.', status, startedAt: at(0), updatedAt: at(0) }
    const home = f.store.registry(botId)!.homeThreadId!
    f.launched = (creators) => creators.has(home) ? [thread] : []
    expect(f.bots.service.list().bots.find((bot) => bot.id === botId)?.state).toBe(idle ? 'idle' : 'working')
    expect(f.bots.isIdle(botId)).toBe(idle)
  })

  it('answers not idle when the launched-thread lookup throws, then recovers', () => {
    f.launched = () => { throw new Error('Thread store unavailable') }
    expect(f.bots.isIdle(botId)).toBe(false)
    f.launched = () => []
    expect(f.bots.isIdle(botId)).toBe(true)
  })

  it('is busy while a background command runs beyond the idle window, and idle after Stop', async () => {
    const activation = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'grant' })
    const turn = await start(f, activation.id)
    turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Watch the build.' })
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    await f.bots.service.chatSend({ botId, text: 'Watch the build.', clientRequestId: 'watch' })
    const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const running = await start(f, chat.id)
    // Hand-authored process stub: the watcher really registers, but starts no shell or process.
    const watcher = f.bots.tools.watchers!.start(botId, chat.id, { command: 'build', brief: 'Check the build.', minutes: 60 })
    await finish(f, running.payload, 'completed', { text: 'Watching.' })
    expect(Date.parse(f.bots.nextDueAt(botId)!) - f.clock.now).toBeGreaterThan(30 * MIN)
    expect(f.bots.service.list().bots.find((bot) => bot.id === botId)?.watchers?.[0]?.id).toBe(watcher.watcherId)
    expect(f.bots.isIdle(botId)).toBe(false)
    f.bots.tools.watchers!.stop(botId, watcher.watcherId)
    expect(f.bots.isIdle(botId)).toBe(true)
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
