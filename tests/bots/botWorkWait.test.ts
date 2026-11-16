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
it.each(['stop', 'pause', 'delete', 'finish', 'fail'] as const)('%s leaves no open work timer', async action => {
  const { workId, turn } = await work()
  const set = await wait(workId)
  if (action === 'finish' || action === 'fail') {
    // A terminal transition, including failure before the requesting turn ends, cancels atomically.
    f.store.moveActivation(workId, ['running'], action === 'finish' ? 'done' : 'failed')
  } else {
    await finish(f, turn.payload, 'completed', { text: '' })
    if (action === 'stop') await f.bots.service.workStop(botId, workId)
    if (action === 'pause') f.bots.pauseBot(botId)
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
