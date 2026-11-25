/** C1 baseline: real engine parking, projection, restart and owner lifecycle for each old reason.
 * Wake prompts, default/reply/tap, room sharing and usage retries stay covered by botWork,
 * botWorkQuestions, botQuestionFollowUps and botUsageLimit. Keep this baseline unchanged in the refactor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const HOUR = 3_600_000
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})
afterEach(() => f.close())

async function parked(reason: string) {
  if (reason === 'budget_exhausted') f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxTurns: 3 } }))
  const { message } = await f.bots.service.chatSend({ botId, text: 'Compare flats', clientRequestId: 'request' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Flats', brief: 'Compare flats', key: 'flats' })
  await runDispatch(f, chat.id, 1, { text: 'On it.' })
  const turn = await start(f, workId)
  if (reason === 'question') {
    f.bots.askOwner(botId, workId, [{ spec: { question: 'Which flat?', choices: ['A', 'B'] } }])
    await finish(f, turn.payload, 'completed', { text: 'Unsent draft.' })
  } else if (reason === 'budget_exhausted') {
    // Its 3 model requests used up: the 4th is over the limit, a wall.
    turn.prepared.authority.check({ kind: 'app', tool: 'web_fetch', args: {} })
    for (let i = 0; i < 4; i += 1) turn.prepared.authority.counters.charge('request')
    await finish(f, turn.payload, 'interrupted', { text: 'Partial comparison.', outcome: { interruptedBy: 'bot_wall' } })
  } else {
    f.problem = { problem: 'all_limited', until: new Date(f.clock.now + HOUR).toISOString(), instanceId: 'claude:main' }
    await finish(f, turn.payload, 'failed', { outcome: { error: 'provider_usage_limit', usageLimitUntil: new Date(f.clock.now + HOUR).toISOString() } })
  }
  await flush()
  return { workId, message }
}
const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

describe.each(['question', 'budget_exhausted', 'usage_limit'])('parked work: %s', (reason) => {
  it('keeps its stored identity and visible line across restart, busy without a slot', async () => {
    const { workId, message } = await parked(reason)
    const row = f.store.activation(workId)!
    expect(row).toMatchObject({ status: 'blocked', endReason: reason, endedAt: null, trigger: { kind: 'work', replyTo: message.id, title: 'Flats', input: 'Compare flats' } })
    expect(f.bots.isIdle(botId)).toBe(false)
    expect(f.store.laneActivations(botId, 'run', ['running', 'waiting_grant'])).toEqual([])
    expect(summary().needsOwner).toBe(reason === 'usage_limit' ? undefined : true)
    expect(summary()).toMatchObject({ work: [{ id: workId, status: 'paused', ...(reason === 'question' ? { waitsFor: 'answer' } : {}) }] })
    const visible = chatOf(f, botId)
    expect(visible.some((m) => m.activationId === workId && (reason === 'question' ? m.question?.status === 'open' : reason === 'budget_exhausted' ? m.ask?.status === 'open' : m.error?.action.kind === 'resume'))).toBe(true)
    const due = f.bots.nextDueAt(botId)
    const dispatches = f.store.dispatches(workId)
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: row.status, endReason: row.endReason, trigger: row.trigger, threadId: row.threadId, endedAt: null })
    expect(f.store.dispatches(workId)).toHaveLength(dispatches.length)
    expect(chatOf(f, botId).map((m) => m.id)).toEqual(visible.map((m) => m.id))
    expect(f.bots.nextDueAt(botId)).toBe(due)
  })

  it('ends stranded work once with the old reason and quiet line', async () => {
    const { workId } = await parked(reason)
    if (reason === 'question') f.store.run("DELETE FROM bot_questions WHERE activation_id = ?", workId)
    if (reason === 'budget_exhausted') f.store.answerEscalation(f.store.openAsks(botId)[0]!.id, 'denied')
    if (reason === 'usage_limit') f.store.setPaused(botId, 'usage_limit')
    await f.bots.maintain()
    expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: reason === 'question' ? 'question_gone' : 'nothing_to_wait_for' })
    const line = chatOf(f, botId).find((m) => m.id === `bm_${workId}_ended`)!
    expect(line).toMatchObject({ kind: 'notice', activationId: workId })
    expect(line.text).toContain('Flats')
    expect(f.store.message(line.id)?.tell).toBe('soon')
    await f.bots.maintain()
    expect(chatOf(f, botId).filter((m) => m.id === line.id)).toHaveLength(1)
  })

  it.each(['stop', 'forget request', 'pause bot', 'delete bot'])('%s preserves today’s lifecycle', async (action) => {
    const { workId, message } = await parked(reason)
    if (action === 'stop') await f.bots.service.workStop(botId, workId)
    if (action === 'delete bot') await f.bots.service.delete(botId)
    if (action === 'pause bot') f.bots.pauseBot(botId)
    if (action === 'forget request') {
      const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
      f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${message.id}`, who: 'owner', text: message.text }))
      const journal = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!
      memory.forget(botId, { refs: [`j${journal.seq as number}`], by: 'owner_ui' })
    }
    await flush()
    expect(f.store.activation(workId)?.status).toBe(action === 'stop' || action === 'delete bot' ? 'cancelled' : 'blocked')
    if (action === 'forget request') expect(JSON.stringify(f.store.activation(workId)!.trigger)).not.toContain('Compare flats')
    expect(f.store.laneActivations(botId, 'run', ['running', 'waiting_grant'])).toEqual([])
  })
})

/** Review baseline: observe both readers, the refusal text, notes, and /clear before moving those decisions. */
describe.each([
  ['question', 'question', 'paused', 'This work waits for your answer to its question. Answer it to let it carry on, or stop it.', 'question'],
  ['question', 'question_answered', 'queued', 'This work has your answer and carries on by itself.', 'noted'],
  ['budget_exhausted', 'budget_exhausted', 'paused', 'This work ran out of room. Answer its ask to let it carry on, or stop it.', 'noted'],
  ['budget_exhausted', 'room_allowed', 'queued', 'This work already has more room and carries on by itself.', 'noted'],
  ['usage_limit', 'usage_limit', 'paused', 'This work waits for a usage limit to reset. It carries on then, or press Resume to try now.', 'noted']
])('work readers and controls: %s / %s', (reason, marker, status, refusal, notes) => {
  it('agrees about pending and ready work, with the existing refusal and note result', async () => {
    const { workId } = await parked(reason)
    // The wake marker was committed, but the lane has not picked it up yet.
    f.store.moveActivation(workId, ['blocked'], 'blocked', { endReason: marker })
    expect(summary().work!.find((item) => item.id === workId)?.status).toBe(status)
    expect(f.bots.listWork(botId).now.find((item) => item.workId === workId)?.status).toBe(status)
    await expect(f.bots.continueActivation(workId)).rejects.toMatchObject({ code: 'bot_work_waiting', message: refusal })
    expect(f.bots.noteWork(botId, workId, 'Check the lease')).toBe(notes)
  })
})

it.each(['question', 'budget_exhausted', 'usage_limit'])('/clear keeps the existing owner-wait decision for %s', async (reason) => {
  const { workId } = await parked(reason)
  await f.bots.clearChat(botId)
  expect(f.store.activation(workId)?.status).toBe(reason === 'usage_limit' ? 'blocked' : 'cancelled')
  expect(chatOf(f, botId)).toEqual([])
})
