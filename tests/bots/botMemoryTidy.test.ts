import { afterEach, expect, it, vi } from 'vitest'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotMemoryAdmin } from '../../src/mms/bots/memory/admin'
import { botFixture, createBot, start, finish, type BotFixture } from './botFixture'

let f: BotFixture
// Upkeep boundary: idle, queued/running turn, waiting work, open chat question,
// posted permission ask, paused/deleted bot, a failing store and a later tick.
afterEach(() => f?.close())
async function setup() {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  const created = await createBot(f, { reply: 'Hello.' })
  const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now })
  f.host.memory = createBotMemoryAdmin({ store: memory })
  memory.save(created.botId, { lane: 'chat', kind: 'owner', text: 'A saved fact.' })
  memory.save(created.botId, { lane: 'run', kind: 'note', text: 'A saved fact.' })
  return { ...created, memory }
}

it.each(['queued', 'running', 'work', 'question', 'paused', 'deleted'])('leaves refs alone for %s and puts copies away on a later tick', async (state) => {
  const { botId, firstActivation, memory } = await setup()
  if (state === 'queued' || state === 'running') f.store.run('UPDATE bot_activations SET status = ? WHERE id = ?', state, firstActivation)
  if (state === 'work') f.store.run("UPDATE bot_activations SET lane = 'run', status = 'blocked', end_reason = 'question', trigger_json = ? WHERE id = ?", JSON.stringify({ kind: 'work', title: 'Check.', input: 'Check.' }), firstActivation)
  if (state === 'question') {
    f.store.insertQuestion({ id: 'q', botId, activationId: firstActivation, dispatchN: 1, lane: 'chat', spec: { question: 'Which?', choices: ['A', 'B'] }, createdAt: f.store.now() })
    f.store.setQuestionMessage('q', 'question-message')
    expect(f.bots.isIdle(botId)).toBe(true)
    expect(f.bots.service.get(botId).summary.needsOwner).toBe(true)
  }
  if (state === 'paused') f.store.setPaused(botId, 'owner')
  if (state === 'deleted') f.store.run('UPDATE bot_registry SET deleted_at = ? WHERE bot_id = ?', f.store.now(), botId)
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('active')
  f.store.run("UPDATE bot_activations SET status = 'done' WHERE id = ?", firstActivation)
  f.store.withdrawQuestions(botId)
  f.store.setPaused(botId, null)
  f.store.run('UPDATE bot_registry SET deleted_at = NULL WHERE bot_id = ?', botId)
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)).toMatchObject({ status: 'superseded', reason: 'merged into m1' })
})

it('keeps refs under a posted ask after the turn ends, then tidies once it closes', async () => {
  const { botId, memory } = await setup()
  const activation = await f.bots.activate({ botId, input: 'Check', clientRequestId: 'ask-work' })
  const { payload, prepared } = await start(f, activation.id)
  prepared.authority.check({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: 'pwd' } })
  await finish(f, payload, 'completed', { text: 'I skipped commands.' })
  expect(f.bots.isIdle(botId)).toBe(true)
  expect(f.bots.service.get(botId).summary.needsOwner).toBe(true)
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('active')
  await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'not_now')
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('superseded')
})

it('continues other bots upkeep after a memory store error', async () => {
  const { botId, memory } = await setup()
  const other = (await createBot(f, { reply: 'Hello.' })).botId
  memory.save(other, { lane: 'chat', kind: 'owner', text: 'Another saved fact.' })
  memory.save(other, { lane: 'run', kind: 'note', text: 'Another saved fact.' })
  const tidy = memory.tidyDuplicates.bind(memory)
  vi.spyOn(memory, 'tidyDuplicates').mockImplementation(id => { if (id === botId) throw new Error('unreadable'); return tidy(id) })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(other, 'm2').at(-1)?.status).toBe('superseded')
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('active')
  warn.mockRestore()
})

it('leaves a bot paused by its pinned model limit alone until that limit clears', async () => {
  const { botId, firstActivation, memory } = await setup()
  f.bots.setModel(botId, firstActivation, 'always', { pick: { instanceId: 'pi:openrouter', model: 'some/model', name: 'Test model' } })
  f.store.setModel(botId, { limits: { provider: { instanceId: 'pi:openrouter', until: new Date(f.clock.now + 3_600_000).toISOString() } } })
  expect(f.bots.service.get(botId).summary.state).toBe('paused')
  expect(f.store.registry(botId)?.pausedReason).toBeNull()
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('active')
  f.store.setModel(botId, null)
  await f.bots.maintain(new Date(f.clock.now))
  expect(memory.versions(botId, 'm2').at(-1)?.status).toBe('superseded')
})
