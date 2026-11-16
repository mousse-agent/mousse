import { afterEach, beforeEach, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
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
async function work() {
  await f.bots.service.chatSend({ botId, text: 'Check the release', clientRequestId: 'request' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Release', brief: 'Check release', key: 'release' })
  await runDispatch(f, chat.id, 1, { text: 'On it.' })
  return { workId, turn: await start(f, workId), chat }
}
const wait = (id: string, event?: BotWakeEvent) => f.bots.tools.wakes!.wait!(botId, id, { brief: 'Check again with the evidence already read.', ...(event ? { event } : { dueAt: new Date(f.clock.now + 60 * 60_000).toISOString() }) })
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
    // A terminal transition, including failure before the requesting turn ends, cancels atomically.
    f.store.moveActivation(workId, ['running'], action === 'finish' ? 'done' : 'failed')
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
it('quiet hours let work resume and hold its eventual report', async () => {
  const { workId, turn } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  f.clock.now += 60 * 60_000
  Object.assign(f.host, { quietHoursFor: () => ({ end: f.clock.now + 3600_000 }), ownerActive: () => false })
  await f.bots.deliverDueReminders()
  await flush()
  expect(f.store.dispatches(workId)).toHaveLength(2)
  const next = await start(f, workId, 2)
  await finish(f, next.payload, 'completed', { text: 'The release is ready.' })
  const report = chatOf(f, botId).find(m => m.text === 'The release is ready.')!
  expect(report).toBeDefined()
  expect(Date.parse(f.store.message(report.id)!.tellAt!)).toBeGreaterThan(f.clock.now)
})
it('scheduled runs must leave their place for the next run', async () => {
  const { workId } = await work()
  f.store.run('UPDATE bot_activations SET trigger_json = ? WHERE id = ?', JSON.stringify({ kind: 'schedule', scheduleId: 'schedule', input: 'Check', occurrenceAt: f.store.now() }), workId)
  await expect(wait(workId)).rejects.toThrow('next run carries on')
})

// A wait can become due before the provider gives up its turn, or while a gate holds it.
it.each(['event already happened', 'turn still running', 'permission wall', 'unknown calls'] as const)('does not arm a zero timer before parking: %s', async state => {
  let idle = false
  f.host.wakeThread = () => ({ state: idle ? 'idle' : 'running' })
  const { workId, turn } = await work()
  const set = await f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Continue the release', ...(state === 'event already happened' ? { event: { kind: 'thread' as const, threadId: 'other' } } : { dueAt: new Date(f.clock.now + 5 * 60_000).toISOString() }) })
  if (state === 'permission wall') f.store.moveActivation(workId, ['running'], 'waiting_grant')
  if (state === 'unknown calls') f.store.moveActivation(workId, ['running'], 'paused', { endReason: 'unknown_calls' })
  idle = true
  f.clock.now += 6 * 60_000
  if (state === 'event already happened') await f.bots.checkWakeEvents()
  const before = f.timers.length
  await f.bots.deliverDueReminders()
  await f.bots.deliverDueReminders()
  expect(f.timers.slice(before).filter(t => t.ms === 0)).toEqual([])
  expect(f.bots.nextDueAt(botId)).toBeUndefined()
  if (state === 'permission wall' || state === 'unknown calls') {
    await finish(f, turn.payload, 'completed', { text: '' })
    await (f.bots as any).continueWith(workId, [f.store.activation(workId)!.status], {})
  } else await finish(f, turn.payload, 'completed', { text: '' })
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
it.each(['plain', 'note', 'allowed permission'] as const)('always explains a completed wait alongside %s', async extra => {
  const { workId, turn, chat } = await work()
  await wait(workId)
  await finish(f, turn.payload, 'completed', { text: '' })
  if (extra === 'note') f.bots.tools.work.note(botId, workId, 'Also check the changelog.', chat.id)
  if (extra === 'allowed permission') {
    // The engine's permission continuation path supplies this list to the shared prompt builder.
    const row = f.store.activation(workId)!
    const rule = (await import('../../src/mms/bots/activation/workWaiting')).workWaitRule(row)!
    const context = rule.continuation(row, { store: () => f.store })
    const prompt = (f.bots as any).continuationPrompt(row, { ...context, allowed: ['run commands'], answers: [] })
    expect(prompt).toContain('Check again with the evidence already read.')
  }
  f.clock.now += 60 * 60_000
  await f.bots.deliverDueReminders()
  await flush()
  const prompt = f.store.dispatch(workId, 2)!.prompt.text
  expect(prompt).not.toContain('The owner asked you to continue')
  expect(prompt).toContain('[Mousse]')
  expect(prompt).toContain('Check again with the evidence already read.')
  if (extra === 'note') expect(prompt).toContain('Also check the changelog.')
})
it('offers work_wait only to work, including work from reminders', async () => {
  const { workId, turn } = await work()
  expect(turn.prepared.policy.tools!.allow).toContain('work_wait')
  const chat = f.store.laneActivations(botId, 'chat', ['done'])[0]!
  expect(f.store.dispatch(chat.id, 1)).toBeDefined()
  await f.bots.service.chatSend({ botId, text: 'Hello again', clientRequestId: 'eligibility' })
  const chatTurn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  expect((await start(f, chatTurn.id)).prepared.policy.tools!.allow).not.toContain('work_wait')
  for (const kind of ['manual', 'schedule'] as const) {
    const other = await f.bots.tools.work.start(botId, chatTurn.id, { title: kind, brief: 'Check', key: kind })
    f.store.run('UPDATE bot_activations SET trigger_json = ? WHERE id = ?', JSON.stringify({ kind, input: 'Check', ...(kind === 'schedule' ? { scheduleId: 's', occurrenceAt: f.store.now() } : {}) }), other.workId)
    expect((await start(f, other.workId)).prepared.policy.tools!.allow).not.toContain('work_wait')
    await expect(wait(other.workId)).rejects.toThrow(kind === 'schedule' ? 'next run' : 'run started by hand')
  }
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
    f.bots.askOwner(botId, workId, { question: 'Which release?', choices: ['A', 'B'] })
    await finish(f, next.payload, 'completed', { text: '' })
    await f.bots.service.answerQuestion({ botId, questionId: f.store.workQuestion(workId)!.id, choice: 'A', clientRequestId: 'chain-answer' })
    await flush()
    await start(f, workId, 3)
  }
  const set = await wait(workId)
  expect(f.store.reminder(set.wakeId)?.chain).toBe(1)
})
