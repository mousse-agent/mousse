/** Carried and confirmed are different facts in the gap before a model's first output. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { lateWorkNote } from '../../src/shared/bots/personal/questions'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'
let f: BotFixture
let botId: string
beforeEach(async () => { f = botFixture(); await f.bots.reconcileOnStartup(); botId = (await createBot(f, { reply: 'Hi.' })).botId })
afterEach(() => f.close())
async function work() {
  await f.bots.service.chatSend({ botId, text: 'Choose a flat', clientRequestId: 'gap-owner' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Flat hunt', brief: 'Choose a flat', key: 'gap' })
  await finish(f, (await start(f, chat.id)).payload)
  return { workId, turn: await start(f, workId) }
}
async function asks(defaulted = false) {
  const t = await work()
  f.bots.askOwner(botId, t.workId, [{ spec: { question: 'Which flat?', choices: [{ label: 'A' }, { label: 'B' }], other: false }, follow: defaulted ? { kind: 'default', afterMs: 30 * 60_000, default: 'A' } : undefined }])
  const questionId = f.store.workQuestion(t.workId)!.id
  await finish(f, t.turn.payload)
  return { ...t, questionId }
}
it('R3-gap a late tap after a default was carried reaches running work as a note before output', async () => {
  const t = await asks(true)
  f.clock.now += 30 * 60_000
  await f.bots.deliverDueReminders(); await flush()
  await start(f, t.workId, 2)
  expect((f.store.dispatch(t.workId, 2)!.prompt as any).workTold).toBe('pending')
  await f.bots.service.answerQuestion({ botId, questionId: t.questionId, choice: 'B', clientRequestId: 'gap-late' })
  expect(f.store.pendingWorkNotes(t.workId).map(note => note.text)).toEqual([lateWorkNote('B')])
  expect(f.store.question(t.questionId)).toMatchObject({ status: 'defaulted', answer: { choice: 'A', late: { choice: 'B' } } })
})
it('R3-gap Forget keeps the carried answer with running work before output instead of reopening it', async () => {
  const t = await asks()
  const { message } = await f.bots.service.answerQuestion({ botId, questionId: t.questionId, choice: 'A', clientRequestId: 'gap-answer' })
  await flush(); await start(f, t.workId, 2)
  const memory = new BotMemoryStore({ db: f.store.db })
  let seq = 0
  f.store.db.transaction(() => {
    memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'run', sourceKey: `bm:${message.id}`, who: 'owner', text: message.text, activationId: t.workId })
    seq = Number(f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq)
  })
  memory.forget(botId, { refs: [`j${seq}`], by: 'owner_ui' })
  expect(f.store.question(t.questionId)).toMatchObject({ status: 'answered', answer: { redacted: true } })
  expect(f.store.activation(t.workId)?.status).toBe('running')
})
it('R3-gap compaction re-gives a carried note before any output confirms it', async () => {
  const t = await work()
  f.bots.noteWork(botId, t.workId, 'Only flats with lifts.')
  await finish(f, t.turn.payload, 'completed', { text: 'Initial findings.' })
  const next = await start(f, t.workId, 2)
  expect((f.store.dispatch(t.workId, 2)!.prompt as any).workTold).toBe('pending')
  next.prepared.steer!.compacted()
  expect(next.prepared.steer!.peek()).toContain('What the owner added since:\n- Only flats with lifts.')
})

it('R3-hook a failed confirmation is nonfatal, logs once and leaves the note for the next continuation', async () => {
  const t = await work()
  f.bots.noteWork(botId, t.workId, 'Keep this unconfirmed note.')
  await finish(f, t.turn.payload, 'completed', { text: 'Initial findings.' })
  const next = await start(f, t.workId, 2)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const confirm = vi.spyOn(f.store, 'confirmWorkDelivery').mockImplementation(() => { throw new Error('database busy') })
  try {
    expect(() => next.prepared.modelOutput?.()).not.toThrow()
    expect(() => next.prepared.modelOutput?.()).not.toThrow()
    expect(confirm).toHaveBeenCalledTimes(1)
    f.bots.noteWork(botId, t.workId, 'Also check transport.')
    await finish(f, next.payload, 'completed', { text: 'Completed normally.' })
    expect(f.runs.getRun(next.payload.runId)?.status).toBe('completed')
    expect(warning).toHaveBeenCalledTimes(1)
    expect(f.store.lastMainDispatch(t.workId)!.prompt.text).toContain('Keep this unconfirmed note.')
  } finally { confirm.mockRestore(); warning.mockRestore() }
})
it('R3-hook output without stored updates performs no confirmation write transaction', async () => {
  const t = await work()
  const transaction = vi.spyOn(f.store.db, 'transaction')
  try {
    t.turn.prepared.modelOutput?.()
    expect(transaction).not.toHaveBeenCalled()
  } finally { transaction.mockRestore() }
})

it('R4 a fresh note is not labelled a repeat beside a carried but unconfirmed note', async () => {
  const t = await work()
  f.bots.noteWork(botId, t.workId, 'First note.')
  await finish(f, t.turn.payload, 'completed', { text: 'Initial findings.' })
  const next = await start(f, t.workId, 2)
  f.bots.noteWork(botId, t.workId, 'Fresh note.')
  await finish(f, next.payload, 'failed', { outcome: { error: 'network_error' } })
  await (f.bots as any).continueWith(t.workId, [f.store.activation(t.workId)!.status], { network: true })
  const prompt = f.store.lastMainDispatch(t.workId)!.prompt.text
  expect(prompt).toContain('(may be a repeat) First note.')
  expect(prompt).toContain('- Fresh note.')
  expect(prompt).not.toContain('(may be a repeat) Fresh note.')
})
