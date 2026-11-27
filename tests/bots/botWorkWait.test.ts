import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_JOURNAL_ERROR, BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'
import type { BotWakeEvent } from '../../src/shared/bots/personal/wakes'
let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})
afterEach(() => f.close())
async function work(key = 'request') {
  await f.bots.service.chatSend({ botId, text: 'Check the release', clientRequestId: key })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Release', brief: 'Check release', key })
  await runDispatch(f, chat.id, 1, { text: 'On it.' })
  return { workId, turn: await start(f, workId), chat }
}
const wait = (id: string, event?: BotWakeEvent, brief = 'Check again with the evidence already read.') => f.bots.tools.wakes!.wait!(botId, id, { brief, ...(event ? { event } : { dueAt: new Date(f.clock.now + 60 * 60_000).toISOString() }) })
it('parks without a slot, survives restart and resumes once in its own thread, with no chat wake', async () => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: 'Unsent.' })
  expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'waiting' })
  const thread = f.store.activation(workId)!.threadId
  expect(f.bots.isIdle(botId)).toBe(true)
  expect(f.bots.nextDueAt(botId)).toBe(set.dueAt)
  expect(f.bots.tools.reminders.list(botId)).toEqual([])
  f.bots.close()
  f.clock.now += 2 * 60 * 60_000
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
  expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  expect(f.store.activation(workId)).toMatchObject({ status: 'running', threadId: thread })
  await start(f, workId, 2)
  expect(JSON.stringify(f.store.dispatch(workId, 2)!.prompt)).toContain('Check again with the evidence already read.')
  expect(JSON.stringify(f.store.dispatch(workId, 2)!.prompt)).toContain('it was for')
  expect(chatOf(f, botId).some(m => m.id.startsWith('bm_wake_'))).toBe(false)
  expect(f.store.listActivations(botId).some(a => a.idempotencyKey.startsWith('wake:'))).toBe(false)
  await f.bots.deliverDueReminders()
  expect(f.store.dispatches(workId)).toHaveLength(2)
})
it.each(['thread', 'merged', 'checks', 'review'] as const)('resumes after %s with the shared event reader', async (kind) => {
  let done = false
  f.host.wakeThread = () => ({ state: done ? 'idle' : 'running', lastRun: { status: 'completed' } })
  f.host.pullRequestState = async () => ({ state: done && kind === 'merged' ? 'merged' : 'open', headSha: 'abcdef123', checkRuns: done ? [{ name: 'build', state: 'passing' }] : [], reviews: done ? [{ id: 'r1', state: 'approved', author: 'reviewer', submittedAt: new Date(f.clock.now).toISOString() }] : [] })
  const { workId, turn } = await work()
  const set = await wait(workId, kind === 'thread' ? { kind: 'thread', threadId: 'other' } : { kind: 'pr', repo: 'acme/app', number: 12, on: kind })
  await finish(f, turn.payload, 'completed', { text: '' })
  done = true
  f.clock.now += 3 * 60_000
  await f.bots.maintain()
  await flush()
  expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  expect(f.store.dispatches(workId)).toHaveLength(2)
})
it('cancels on Stop and ends stranded work when its wait disappears', async () => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.store.settleReminder(set.wakeId, 'cancelled')
  await f.bots.maintain()
  expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'wait_gone' })
  expect(chatOf(f, botId).find(m => m.id === `bm_${workId}_ended`)?.text).toContain('Release')
})
it('refuses a second wait, chat waits and times outside five minutes to a week', async () => {
  const { workId, chat } = await work()
  await expect(wait(chat.id)).rejects.toThrow('Use wake')
  for (const minutes of [4, 7 * 24 * 60 + 1]) {
    await expect(f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Later', dueAt: new Date(f.clock.now + minutes * 60_000).toISOString() })).rejects.toThrow()
  }
  await wait(workId)
  await expect(wait(workId)).rejects.toThrow('already has a wait')
  await f.bots.service.workStop(botId, workId)
  expect(f.store.workWait(workId)?.status).toBe('cancelled')
})
it.each(['stop', 'delete', 'finish', 'fail'] as const)('%s leaves no open work timer', async action => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  if (action === 'finish' || action === 'fail') {
    if (action === 'fail') await finish(f, turn.payload, 'failed', { outcome: { error: 'failed' } })
    else {
      await finish(f, turn.payload, 'completed', { text: '' })
      f.clock.now += 60 * 60_000
      await f.bots.deliverDueReminders()
      await flush()
      await finish(f, (await start(f, workId, 2)).payload, 'completed', { text: 'Done.' })
      expect(f.store.activation(workId)?.status).toBe('done')
      expect(f.store.waitingReminders(botId).filter(r => r.workId === workId)).toEqual([])
      return
    }
  } else {
    await finish(f, turn.payload, 'completed', { text: '' })
    if (action === 'stop') await f.bots.service.workStop(botId, workId)
    if (action === 'delete') await f.bots.service.delete(botId)
  }
  expect(f.store.reminder(set.wakeId)?.status).toBe('cancelled')
})
it('resumes once when an event never happens', async () => {
  f.host.wakeThread = () => ({ state: 'running' })
  const { workId, turn } = await work()
  await wait(workId, { kind: 'thread', threadId: 'other' })
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 25 * 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.dispatch(workId, 2)?.prompt.text).toContain("didn't happen in time")
  await f.bots.deliverDueReminders()
  expect(f.store.dispatches(workId)).toHaveLength(2)
})
it('Forget cancels the work timer with the original request', async () => {
  const { BotMemoryStore } = await import('../../src/mms/bots/memory/BotMemoryStore')
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  const message = chatOf(f, botId).find(m => m.author === 'owner')!
  const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${message.id}`, who: 'owner', text: message.text }))
  const journal = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!
  memory.forget(botId, { refs: [`j${journal.seq as number}`], by: 'owner_ui' })
  expect(f.store.reminder(set.wakeId)?.status).toBe('cancelled')
  f.bots.afterForget()
  expect(f.store.activation(workId)?.status).toBe('failed')
})
it('a scheduled run waits as work does (#1360): no slot held, its next occurrence skipped, and it carries on in its thread when due', async () => {
  const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Check the release.' }, 'owner')
  const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId, prompt: 'Check the release.', occurrenceAt: new Date(f.clock.now).toISOString() })
  if (scheduled.kind !== 'started') throw new Error(scheduled.kind)
  await flush()
  const turn = await start(f, scheduled.activationId)
  expect(turn.prepared.policy.tools!.allow).toContain('work_wait')
  const set = await wait(scheduled.activationId)
  await finish(f, turn.payload, 'completed', { text: '' })
  expect(f.store.activation(scheduled.activationId)).toMatchObject({ status: 'blocked', endReason: 'waiting' })
  expect(f.bots.isIdle(botId)).toBe(true)
  expect(f.bots.runScheduledOccurrence({ botId, scheduleId, prompt: 'Check the release.', occurrenceAt: new Date(f.clock.now + 60_000).toISOString() })).toEqual({ kind: 'skipped', reason: 'previous_run_waiting' })
  f.clock.now += 2 * 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  expect(f.store.activation(scheduled.activationId)).toMatchObject({ status: 'running', threadId: turn.payload.threadId })
  await start(f, scheduled.activationId, 2)
  expect(JSON.stringify(f.store.dispatch(scheduled.activationId, 2)!.prompt)).toContain('Check again with the evidence already read.')
})

// A wait can become due before the provider gives up its turn, or while a gate holds it.
it.each(['event already happened', 'turn still running', 'permission wall', 'unknown calls'] as const)('does not arm a zero timer before parking: %s', async state => {
  let idle = false
  f.host.wakeThread = () => ({ state: idle ? 'idle' : 'running' })
  const { workId, turn } = await work()
  const set = await f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Continue the release', ...(state === 'event already happened' ? { event: { kind: 'thread' as const, threadId: 'other' } } : { dueAt: new Date(f.clock.now + 5 * 60_000).toISOString() }) })
  let askId: string | undefined
  if (state === 'permission wall') {
    const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: 1, kind: 'escalate', permission: { tool: 'shell' }, reason: 'Run the check' }))
    askId = wall.escalation.id
    await finish(f, turn.payload, 'completed', { text: '' })
    expect(f.store.activation(workId)?.status).toBe('waiting_grant')
  }
  if (state === 'unknown calls') {
    f.runs.tools.start({ invocationId: 'unfinished-edit', runId: turn.payload.runId, attemptId: f.runs.getRun(turn.payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'test', now: f.store.now() })
    await finish(f, turn.payload, 'completed', { text: '' })
    expect(f.store.activation(workId)?.status).toBe('paused')
  }
  idle = true
  f.clock.now += 6 * 60_000
  if (state === 'event already happened') await f.bots.checkWakeEvents()
  const before = f.timers.length
  await f.bots.deliverDueReminders()
  await f.bots.deliverDueReminders()
  expect(f.timers.slice(before).filter(t => t.ms === 0)).toEqual([])
  expect(f.bots.nextDueAt(botId)).toBeUndefined()
  if (state === 'permission wall') await f.bots.answerAsk(botId, askId!, 'allow')
  else if (state === 'unknown calls') await f.bots.continueActivation(workId, { acknowledge: { calls: ['unfinished-edit'] } })
  else await finish(f, turn.payload, 'completed', { text: '' })
  await flush()
  expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  expect(f.store.dispatches(workId)).toHaveLength(2)
  await f.bots.deliverDueReminders()
  expect(f.store.dispatches(workId)).toHaveLength(2)
})

it('Pause preserves a wait and treats its due work like an answered question', async () => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.bots.pauseBot(botId)
  expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'waiting' })
  expect(f.store.reminder(set.wakeId)?.status).toBe('waiting')
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  expect(f.store.dispatches(workId)).toHaveLength(2)
  expect(f.store.registry(botId)?.pausedReason).toBe('owner')
})
it.each(['plain', 'note'] as const)('always explains a completed wait alongside %s', async extra => {
  const { workId, turn, chat } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  if (extra === 'note') f.bots.tools.work.note(botId, workId, 'Also check the changelog.', chat.id)
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const prompt = f.store.dispatch(workId, 2)!.prompt.text
  expect(prompt).not.toContain('The owner asked you to continue')
  expect(prompt).not.toContain('Your owner did not write')
  expect(prompt).toContain('[Mousse]')
  expect(prompt).toContain('Check again with the evidence already read.')
  if (extra === 'note') expect(prompt).toContain('Also check the changelog.')
})
it('offers work_wait to work and scheduled runs, never the chat or a run started by hand', async () => {
  const { workId, turn } = await work()
  expect(turn.prepared.policy.tools!.allow).toContain('work_wait')
  const chat = f.store.laneActivations(botId, 'chat', ['done'])[0]!
  expect(f.store.dispatch(chat.id, 1)).toBeDefined()
  await f.bots.service.chatSend({ botId, text: 'Hello again', clientRequestId: 'eligibility' })
  const chatTurn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  expect((await start(f, chatTurn.id)).prepared.policy.tools!.allow).not.toContain('work_wait')
  const other = await f.bots.tools.work.start(botId, chatTurn.id, { title: 'manual', brief: 'Check', key: 'manual' })
  f.store.run('UPDATE bot_activations SET trigger_json = ?, provenance = NULL WHERE id = ?', JSON.stringify({ kind: 'manual', input: 'Check' }), other.workId)
  expect((await start(f, other.workId)).prepared.policy.tools!.allow).not.toContain('work_wait')
  await expect(wait(other.workId)).rejects.toThrow('run started by hand')
})
it.each(['note', 'answer'] as const)('an owner %s resets the work wait chain', async input => {
  const { workId, turn, chat } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const next = await start(f, workId, 2)
  if (input === 'note') f.bots.tools.work.note(botId, workId, 'Check the changelog too.', chat.id)
  else {
    f.bots.askOwner(botId, workId, [{ spec: { question: 'Which release?', choices: [{ label: 'A' }, { label: 'B' }] } }])
    await finish(f, next.payload, 'completed', { text: '' })
    await f.bots.service.answerQuestion({ botId, questionId: f.store.workQuestion(workId)!.id, choice: 'A', clientRequestId: 'chain-answer' })
    await flush()
    await start(f, workId, 3)
  }
  const set = await wait(workId)
  expect(f.store.reminder(set.wakeId)?.chain).toBe(1)
})

it.each(['reload', 'network'] as const)('a %s continuation cannot bypass an open wait', async reason => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  await (f.bots as any).continueWith(workId, ['blocked'], { [reason]: true })
  await flush()
  expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'waiting' })
  expect(f.store.dispatches(workId)).toHaveLength(1)
  expect(f.store.reminder(set.wakeId)?.status).toBe('waiting')
})
it('transports the same structured wait to the work line and work_list', async () => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  const field = { dueAt: set.dueAt, event: null }
  expect(f.bots.service.list().bots.find(b => b.id === botId)?.work?.find(w => w.id === workId)?.wait).toEqual(field)
  expect(f.bots.tools.work.list(botId).now.find(w => w.workId === workId)?.wait).toEqual(field)
})
it('has no daily or waiting-row count shared with chat wakes: past the old 30 a day and 50 waiting, waits and wakes are still set', async () => {
  const { workId, chat } = await work()
  for (let i = 0; i < 30; i++) f.store.insertReminder({ id: `limit-${i}`, botId, dueAt: new Date(f.clock.now + 3600_000).toISOString(), text: 'chat wake', work: null, replyTo: null, createdAt: f.store.now(), wake: true })
  for (let i = 0; i < 50; i++) f.store.insertReminder({ id: `reminder-${i}`, botId, dueAt: new Date(f.clock.now + 3600_000).toISOString(), text: 'reminder', work: null, replyTo: null, createdAt: f.store.now() })
  await expect(wait(workId)).resolves.toMatchObject({ wakeId: expect.any(String) })
  await expect(f.bots.tools.wakes!.add(botId, chat.id, { brief: 'Later', dueAt: new Date(f.clock.now + 3600_000).toISOString() })).resolves.toMatchObject({ wakeId: expect.any(String) })
})
it('counts successive work waits in the existing wake chain, uncapped; the same wait a fourth time is refused as a loop', async () => {
  const { workId, turn } = await work()
  let current = turn
  // Past the old cap of five in a row, each wait with something new in it.
  for (let n = 1; n <= 7; n++) {
    const set = await wait(workId, undefined, `Check step ${n} of the release.`)
    expect(f.store.reminder(set.wakeId)?.chain).toBe(n)
    await finish(f, current.payload, 'completed', { text: '' })
    f.clock.now += 60 * 60_000
    await f.bots.deliverDueReminders()
    await flush()
    current = await start(f, workId, n + 1)
    if (n === 7) {
      // The same wait again and again with nothing new: refused on the fourth, counting only this work's waits.
      for (let k = 0; k < 3; k++) {
        const again = await wait(workId, undefined, 'Check the release again.')
        f.bots.tools.reminders.cancel(botId, again.wakeId)
      }
      await expect(wait(workId, undefined, 'Check the release again.')).rejects.toThrow('that is a loop')
    }
  }
})
it('admits ready owner work and usage resets before timed waits, then the queue', async () => {
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const { workId, turn } = await work(`order-${i}`)
    await wait(workId)
    await finish(f, turn.payload, 'completed', { text: '' })
    ids.push(workId)
  }
  // All provider turns have ended. Model the committed readiness markers before the admission pump runs.
  for (const [i, marker] of ['wait_ready', 'usage_limit', 'question_answered', 'room_allowed'].entries()) f.store.moveActivation(ids[i]!, ['blocked'], 'blocked', { endReason: marker })
  const queued = { ...f.store.activation(ids[0]!)!, id: 'queued-after-waits', idempotencyKey: 'queue-after-waits', status: 'queued' as const }
  f.store.insertActivation(queued, f.store.counters(ids[0]!).limits)
  const selected: string[] = []
  const tried = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const candidate = f.store.db.transaction(() => (f.bots as any).nextRun(tried))
    expect(candidate?.resume).toBeDefined()
    selected.push(candidate.resume.id)
    tried.add(candidate.resume.id)
  }
  expect(selected.at(-1)).toBe(ids[0])
  expect(new Set(selected.slice(0, 3))).toEqual(new Set(ids.slice(1)))
  expect(f.store.db.transaction(() => (f.bots as any).nextRun(tried))?.start.id).toBe(queued.id)
})
it('keeps the original why after delivery', async () => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  expect(f.store.reminder(set.wakeId)?.text).toBe('Check again with the evidence already read.')
})
it('delivers a wait late after more than a week offline', async () => {
  const { workId, turn } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.bots.close()
  f.clock.now += 8 * 24 * 60 * 60_000
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
  expect(f.store.activation(workId)?.status).toBe('running')
  expect(f.store.dispatch(workId, 2)?.prompt.text).toContain('it was for')
})
it('offers work_wait to work started by a reminder', async () => {
  const { chat } = await work()
  f.bots.tools.reminders.add(botId, chat.id, { text: 'Check release', dueAt: new Date(f.clock.now + 60_000).toISOString(), work: { title: 'Reminder release', brief: 'Check release' } })
  f.clock.now += 60_000
  await f.bots.deliverDueReminders()
  const reminderWork = f.store.laneActivations(botId, 'run', ['running']).find(r => r.trigger.kind === 'work' && r.trigger.title === 'Reminder release')!
  expect((await start(f, reminderWork.id)).prepared.policy.tools!.allow).toContain('work_wait')
  expect(await wait(reminderWork.id)).toMatchObject({ wakeId: expect.any(String) })
})

it('rolls back both parking and due delivery if settlement fails during recovery', async () => {
  const { workId } = await work()
  const set = await f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Continue', dueAt: new Date(f.clock.now + 5 * 60_000).toISOString() })
  f.clock.now += 6 * 60_000
  const fault = vi.spyOn(f.store, 'settleReminder').mockImplementationOnce(() => { throw new Error('injected settlement failure') })
  try {
    expect(() => (f.bots as any).park(f.store.activation(workId), 'waiting', ['running'])).toThrow('injected settlement failure')
    expect(f.store.activation(workId)?.status).toBe('running')
    expect(f.store.reminder(set.wakeId)?.status).toBe('waiting')
  } finally { fault.mockRestore() }
})

it.each(['allow', 'not_now'] as const)('carries a permission wall %s and its wait exactly once', async decision => {
  const { workId, turn, chat } = await work()
  const set = await wait(workId)
  const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: 1, kind: 'escalate', permission: { tool: 'shell' }, reason: 'Run the release check' }))
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await f.bots.answerAsk(botId, wall.escalation.id, decision)
  await flush()
  const prompt = f.store.dispatch(workId, 2)!.prompt.text
  const answer = decision === 'allow' ? 'The owner allowed: run commands' : 'The owner said not now: run commands'
  expect(prompt).toContain(answer)
  expect(prompt).toContain('Check again with the evidence already read.')
  expect(prompt.indexOf('Check again with the evidence already read.')).toBeLessThan(prompt.indexOf(answer))
  // An intent is not a started turn; its store facts are still unread.
  expect(f.store.unreadWorkWaits(workId).map(r => r.id)).toContain(set.wakeId)
  const next = await start(f, workId, 2)
  ;(next.prepared as any).modelOutput?.()
  expect(f.store.unreadWorkWaits(workId)).toEqual([])
  f.bots.tools.work.note(botId, workId, 'Read the release notes next.', chat.id)
  await finish(f, next.payload, 'completed', { text: '' })
  const following = f.store.dispatch(workId, 3)!.prompt.text
  expect(following).not.toContain(answer)
  expect(following).not.toContain('Your wait is over')
  expect(following).toContain('Read the release notes next.')
})

it('keeps notes and question answers unread until the wait continuation starts', async () => {
  const { workId, turn, chat } = await work()
  f.bots.askOwner(botId, workId, [{ spec: { question: 'Which release?', choices: [{ label: 'A' }, { label: 'B' }] } }])
  const questionId = f.store.workQuestion(workId)!.id
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60_000
  f.bots.tools.work.note(botId, workId, 'Read the release notes too.', chat.id)
  f.clock.now += 60_000
  await f.bots.service.answerQuestion({ botId, questionId, choice: 'A', clientRequestId: 'wait-answer' })
  f.clock.now += 58 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const prompt = f.store.dispatch(workId, 2)!.prompt.text
  expect(prompt).toContain('Read the release notes too.')
  expect(prompt).toContain('Which release?')
  expect(prompt).toContain('Check again with the evidence already read.')
  expect(prompt.indexOf('Read the release notes too.')).toBeLessThan(prompt.indexOf('Which release?'))
  expect(prompt.indexOf('Which release?')).toBeLessThan(prompt.indexOf('Check again with the evidence already read.'))
  expect(f.store.pendingWorkNotes(workId)).toHaveLength(1)
  expect(f.store.question(questionId)?.readAt).toBeNull()
  const next = await start(f, workId, 2)
  expect(f.store.pendingWorkNotes(workId)).toEqual([])
  expect(f.store.question(questionId)?.readAt).not.toBeNull()
  f.bots.tools.work.note(botId, workId, 'Now check the changelog.', chat.id)
  await finish(f, next.payload, 'completed', { text: '' })
  const following = f.store.dispatch(workId, 3)!.prompt.text
  expect(following).not.toContain('Read the release notes too.')
  expect(following).not.toContain('Which release?')
  expect(following).not.toContain('Your wait is over')
})

it('tells an earlier wall answer before the later wait event', async () => {
  const { workId, turn } = await work()
  await wait(workId)
  const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: 1, kind: 'escalate', permission: { tool: 'shell' }, reason: 'Run the release check' }))
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60_000
  await f.bots.answerAsk(botId, wall.escalation.id, 'allow')
  f.clock.now += 59 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const prompt = f.store.dispatch(workId, 2)!.prompt.text
  expect(prompt.indexOf('The owner allowed: run commands')).toBeLessThan(prompt.indexOf('Check again with the evidence already read.'))
})

it('keeps wait additions through a usage hold before the dispatch starts and a restart', async () => {
  const { workId, turn, chat } = await work()
  f.bots.askOwner(botId, workId, [{ spec: { question: 'Which release?', choices: [{ label: 'A' }, { label: 'B' }] } }])
  const questionId = f.store.workQuestion(workId)!.id
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.bots.tools.work.note(botId, workId, 'Read the release notes too.', chat.id)
  await f.bots.service.answerQuestion({ botId, questionId, choice: 'A', clientRequestId: 'usage-wait-answer' })
  f.clock.now += 60 * 60_000
  f.problem = { problem: 'all_limited', until: new Date(f.clock.now + 60 * 60_000).toISOString(), instanceId: 'claude:main' }
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.lastMainDispatch(workId)?.startedAt).toBeNull()
  expect(f.store.unreadWorkWaits(workId)).toHaveLength(1)
  expect(f.store.pendingWorkNotes(workId)).toHaveLength(1)
  expect(f.store.question(questionId)?.readAt).toBeNull()
  f.bots.close()
  f.problem = undefined
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await f.bots.resumeBot(botId)
  await flush()
  const dispatch = f.store.lastMainDispatch(workId)!
  const next = await start(f, workId, dispatch.n)
  ;(next.prepared as any).modelOutput?.()
  expect(next.prepared.prompt).toContain('Check again with the evidence already read.')
  expect(next.prepared.prompt).toContain('Read the release notes too.')
  expect(next.prepared.prompt).toContain('Which release?')
  expect(f.store.unreadWorkWaits(workId)).toEqual([])
  expect(f.store.pendingWorkNotes(workId)).toEqual([])
  expect(f.store.question(questionId)?.readAt).not.toBeNull()
})

it('keeps a delivered wait unread while the run queue is held, and carries it on once it goes again', async () => {
  const { workId, turn } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  // Nothing starts while the bot's journal cannot be written.
  f.store.setError(botId, { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'wait_ready' })
  expect(f.store.unreadWorkWaits(workId)).toHaveLength(1)
  expect(f.store.dispatches(workId)).toHaveLength(1)
  f.store.setError(botId, null)
  await (f.bots as unknown as { pump(botId: string): Promise<void> }).pump(botId)
  await flush()
  expect(f.store.dispatch(workId, 2)?.prompt.text).toContain('Check again with the evidence already read.')
  const receiving = await start(f, workId, 2)
  ;(receiving.prepared as any).modelOutput?.()
  expect(f.store.unreadWorkWaits(workId)).toEqual([])
})

// The same prompt builder must keep master's reason and instructions for both histories.
it.each([
  ['turn cap', { turnCap: true }, 'You reached the most steps one turn may take; what you did so far is kept.'],
  ['more room', { moreRoom: true }, 'You have more room now; what you had so far was already sent to the owner.'],
  ['restart', { restart: true }, 'Mousse restarted while you were working.'],
  ['reload', { reload: true }, 'Your settings changed.'],
  ['internet back', { network: true }, 'The internet connection dropped while you were working; it is back now.'],
  ['usage reset', { usageReset: true }, 'A usage limit stopped you while you were working; it has reset now.'],
  ['question re-asked', { askAgain: ['Which release?'] }, 'Ask it again with question_ask if you still need to know.'],
  ['never ran replay', { restart: true }, 'The original task never reached the provider.'],
  ['updated report', { afterReport: true }, 'Your last message is your updated report: lead with what changed, in plain words.'],
  ['permission switched off', { switchCut: true }, 'Your turn stopped; carry on without it and do not ask for it.']
] as const)('keeps the same %s continuation with a pending note, with or without past waits', async (reason, flags, expected) => {
  let baseline: string | undefined
  for (const hasWaited of [false, true]) {
    const { workId, turn, chat } = await work(`${reason}-${hasWaited}`)
    if (hasWaited) {
      await wait(workId)
      await finish(f, turn.payload, 'completed', { text: '' })
      f.clock.now += 60 * 60_000
      await f.bots.deliverDueReminders()
      await flush()
      await start(f, workId, 2)
    }
    f.bots.tools.work.note(botId, workId, 'Read the release notes next.', chat.id)
    const row = f.store.activation(workId)!
    const notes = (f.bots as any).workNotes(row)
    let answers: ReturnType<typeof f.store.pendingAnswers> = []
    if (reason === 'question re-asked') {
      const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: f.store.lastMainDispatch(workId)!.n, kind: 'escalate', permission: { tool: 'shell' }, reason: 'Run the check' }))
      f.store.answerEscalation(wall.escalation.id, 'allowed_bot')
      answers = f.store.pendingAnswers(workId)
    }
    const prompt: string = (f.bots as any).continuationPrompt(row, {
      ...flags, answers, notes: notes.text,
      ...(hasWaited ? { workEvents: notes.events } : {})
    }, reason === 'never ran replay' ? expected : undefined)
    expect(prompt).toContain(expected)
    expect(prompt.split('Read the release notes next.')).toHaveLength(2)
    expect(prompt).not.toContain('Your wait is over.')
    if (baseline === undefined) baseline = prompt
    else expect(prompt).toBe(baseline)
    await f.bots.service.workStop(botId, workId)
  }
})

it('marks a denied limit answered even when work has a past wait', async () => {
  const { workId, turn } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const next = await start(f, workId, 2)
  const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: 2, kind: 'budget', permission: { budget: { key: 'maxTurns', amount: 3 } }, reason: 'More steps' }))
  await finish(f, next.payload, 'completed', { text: '' })
  await f.bots.answerAsk(botId, wall.escalation.id, 'not_now')
  expect(f.store.activation(workId)?.endReason).toBe('budget_denied')
  expect(f.store.pendingAnswers(workId)).toEqual([])
  expect(f.store.escalation(wall.escalation.id)?.appliedAt).not.toBeNull()
})

it.each(['question', 'wall'] as const)('uses the master opening when an owner %s answer resumes work after a past wait', async kind => {
  const { default: golden } = await import('./fixtures/continuationMaster.json')
  const { workId, turn } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const next = await start(f, workId, 2)
  if (kind === 'question') {
    f.bots.askOwner(botId, workId, [{ spec: { question: 'Which flat?', choices: [{ label: 'A' }, { label: 'B' }] } }])
    const questionId = f.store.workQuestion(workId)!.id
    await finish(f, next.payload, 'completed', { text: '' })
    await f.bots.service.answerQuestion({ botId, questionId, choice: 'A', clientRequestId: 'after-wait-question' })
  } else {
    const wall = f.store.db.transaction(() => (f.bots as any).wallInTransaction(workId, ['running'], { dispatchN: 2, kind: 'escalate', permission: { tool: 'shell' }, reason: 'Run the check' }))
    await finish(f, next.payload, 'completed', { text: '' })
    await f.bots.answerAsk(botId, wall.escalation.id, 'allow')
  }
  await flush()
  const key = kind === 'question' ? 'question answered / none' : 'wall Allow / none'
  expect(f.store.dispatch(workId, 3)?.prompt.text).toBe(golden.prompts[key])
})

it('N2 tells an answer once when an older build carried it as its single question and a newer one confirmed it', async () => {
  const { workId, turn } = await work()
  f.bots.askOwner(botId, workId, [{ spec: { question: 'Which release?', choices: [{ label: 'A' }, { label: 'B' }] } }])
  const questionId = f.store.workQuestion(workId)!.id
  await finish(f, turn.payload)
  await f.bots.service.answerQuestion({ botId, questionId, choice: 'A', clientRequestId: 'old-field' })
  await flush()
  const next = await start(f, workId, 2)
  await finish(f, next.payload, 'failed', { outcome: { error: 'network_error' } })
  // The dispatch that carried it and never confirmed is an older build's: its single `question`, no `questions`.
  f.store.run("UPDATE bot_dispatches SET prompt_json = json_remove(json_set(prompt_json, '$.workDelivery.question', ?), '$.workDelivery.questions') WHERE activation_id = ? AND n = 2", questionId, workId)
  await (f.bots as any).continueWith(workId, [f.store.activation(workId)!.status], { network: true })
  await flush()
  const retry = f.store.lastMainDispatch(workId)!
  expect(retry.prompt.workDelivery?.questions).toContain(questionId)
  ;((await start(f, workId, retry.n)).prepared as any).modelOutput?.()
  expect(f.store.unreadWorkQuestions(workId)).toEqual([])
})

it.each(['restart', 'network', 'usage_retry'] as const)('N2 repeats a wait, note and answer after %s until output confirms them', async failure => {
  const { workId, turn, chat } = await work()
  f.bots.askOwner(botId, workId, [{ spec: { question: 'Which release?', choices: [{ label: 'A' }, { label: 'B' }] } }])
  const questionId = f.store.workQuestion(workId)!.id
  await wait(workId)
  await finish(f, turn.payload)
  f.bots.tools.work.note(botId, workId, 'Remember the delivery evidence.', chat.id)
  await f.bots.service.answerQuestion({ botId, questionId, choice: 'A', clientRequestId: 'N2-answer' })
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const next = await start(f, workId, 2)
  expect(f.store.unreadWorkWaits(workId)).toHaveLength(1)
  expect(f.store.unreadWorkNotes(workId)).toHaveLength(1)
  expect(f.store.unreadWorkQuestions(workId).at(-1)?.id).toBe(questionId)
  if (failure === 'restart') {
    // Simulate the previous build's eager read markers as well as a fresh interrupted dispatch.
    f.store.run('UPDATE bot_work_notes SET applied_at = ? WHERE activation_id = ?', f.store.now(), workId)
    f.store.run('UPDATE bot_questions SET read_at = ? WHERE id = ?', f.store.now(), questionId)
    f.runs.markTerminal(next.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
  } else {
    await finish(f, next.payload, 'failed', { outcome: { error: 'network_error' } })
    await (f.bots as any).continueWith(workId, [f.store.activation(workId)!.status], { network: failure === 'network', usageRetry: failure === 'usage_retry' })
  }
  await flush()
  const retry = f.store.lastMainDispatch(workId)!
  expect(retry.n).toBeGreaterThan(2)
  for (const text of ['Check again with the evidence already read.', 'Remember the delivery evidence.', 'Which release?']) expect(retry.prompt.text).toContain(text)
  if (failure !== 'usage_retry') {
    expect(retry.prompt.text).toContain('(may be a repeat) Remember the delivery evidence.')
    expect(retry.prompt.text).toContain('if you already acted on it, don\'t do it again.')
  }
  const running = await start(f, workId, retry.n)
  ;(running.prepared as any).modelOutput?.()
  expect(f.store.unreadWorkWaits(workId)).toEqual([])
  expect(f.store.unreadWorkNotes(workId)).toEqual([])
  expect(f.store.unreadWorkQuestions(workId)).toEqual([])
  await finish(f, running.payload, 'failed', { outcome: { error: 'network_error' } })
  await (f.bots as any).continueWith(workId, [f.store.activation(workId)!.status], { network: true })
  const later = f.store.lastMainDispatch(workId)!.prompt.text
  for (const text of ['Check again with the evidence already read.', 'Remember the delivery evidence.', 'Which release?']) expect(later).not.toContain(text)
})

it('N2 recovers confirmation when the run completed before its dispatch settled', async () => {
  const { workId, turn, chat } = await work()
  await wait(workId)
  await finish(f, turn.payload)
  f.bots.tools.work.note(botId, workId, 'Keep the completed delivery.', chat.id)
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const next = await start(f, workId, 2)
  f.runs.markTerminal(next.payload.runId, 'completed')
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
  expect(f.store.unreadWorkWaits(workId)).toEqual([])
  expect(f.store.unreadWorkNotes(workId)).toEqual([])
  expect((f.store.dispatch(workId, 2)!.prompt as any).workTold).toBe('completed')
})

it.each(['restart', 'network'] as const)('N2 keeps a note without any wait history after %s until model output', async failure => {
  const { workId, turn, chat } = await work()
  f.bots.tools.work.note(botId, workId, 'Use the ordinary work note.', chat.id)
  await finish(f, turn.payload, 'completed', { text: 'Initial findings.' })
  const next = await start(f, workId, 2)
  expect(f.store.unreadWorkNotes(workId)).toHaveLength(1)
  if (failure === 'restart') {
    f.runs.markTerminal(next.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
  } else {
    await finish(f, next.payload, 'failed', { outcome: { error: 'network_error' } })
    await (f.bots as any).continueWith(workId, [f.store.activation(workId)!.status], { network: true })
  }
  await flush()
  const retry = f.store.lastMainDispatch(workId)!
  expect(retry.prompt.text).toContain('(may be a repeat) Use the ordinary work note.')
  expect(retry.prompt.text).toContain('if you already acted on it, don\'t do it again.')
  const receiving = await start(f, workId, retry.n)
  ;(receiving.prepared as any).modelOutput?.()
  expect(f.store.unreadWorkNotes(workId)).toEqual([])
})

// A wait on a pull request past its deadline is read once more before the work goes on, wherever it falls due.
describe('a pull request wait past its deadline is read once more before the work resumes', () => {
  const pr = { kind: 'pr', repo: 'acme/app', number: 12 } as const
  const waitOnPr = (workId: string) => f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Ship once merged.', event: pr, hours: 1 })

  it('restart: the pull request merged before the deadline while Mousse was off, and the work resumes with the merge', async () => {
    const setAt = f.clock.now
    let merged = false
    f.host.pullRequestState = async () => merged ? { state: 'merged', title: 'Release', mergedAt: new Date(setAt + 30 * 60_000).toISOString() } : { state: 'open', title: 'Release' }
    const { workId, turn } = await work()
    const set = await waitOnPr(workId)
    await finish(f, turn.payload, 'completed', { text: '' })
    f.bots.close()
    merged = true
    f.clock.now = setAt + 2 * 60 * 60_000
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    await f.bots.deliverDueReminders()
    await flush()
    expect(f.store.reminder(set.wakeId)).toMatchObject({ status: 'delivered', fired: { kind: 'pr', number: 12, state: 'merged' } })
    await start(f, workId, 2)
    expect(f.store.dispatch(workId, 2)?.prompt.text).not.toContain("didn't happen in time")
    expect(f.store.dispatches(workId)).toHaveLength(2)
  })

  it('parking while the deadline read is under way: the work resumes once, with what that read showed', async () => {
    const setAt = f.clock.now
    let answer: ((read: { state: 'merged'; title: string; mergedAt: string }) => void) | undefined
    f.host.pullRequestState = async () => ({ state: 'open', title: 'Release' })
    const { workId, turn } = await work()
    const set = await waitOnPr(workId)
    // The deadline comes while the turn that set the wait still runs: its last read starts and waits on GitHub.
    f.host.pullRequestState = () => new Promise((resolve) => { answer = resolve })
    f.clock.now = setAt + 60 * 60_000 + 1_000
    await f.bots.deliverDueReminders()
    await flush()
    expect(answer).toBeTypeOf('function')
    await finish(f, turn.payload, 'completed', { text: '' })
    expect(f.store.reminder(set.wakeId)?.status).toBe('waiting')
    answer!({ state: 'merged', title: 'Release', mergedAt: new Date(setAt + 50 * 60_000).toISOString() })
    await flush()
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    await flush()
    expect(f.store.reminder(set.wakeId)).toMatchObject({ status: 'delivered', fired: { kind: 'pr', number: 12, state: 'merged' } })
    await start(f, workId, 2)
    await f.bots.deliverDueReminders()
    await flush()
    expect(f.store.dispatches(workId)).toHaveLength(2)
  })
})
