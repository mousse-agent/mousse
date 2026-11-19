import { afterEach, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { createBotActivitySink } from '../../src/mms/bots/activity/BotActivitySink'
import { botFixture, createBot, start, type BotFixture } from './botFixture'
let f: BotFixture
afterEach(() => f?.close())
it('supplies the ledger only for work, and service reads never become held calls', async () => {
  f = botFixture()
  const activity = createBotActivitySink({ emit: () => {} })
  f.host.activity = activity
  const { botId } = await createBot(f, { name: 'Reader', reply: 'Hello.' })
  await f.bots.service.chatSend({ botId, text: 'Read models', clientRequestId: 'chat' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  expect((await start(f, chat.id)).prepared.authority.secretFetch).toBeUndefined()
  // A durable work activation, as the chat's work tool creates it.
  const work = await f.bots.tools.work.start(botId, chat.id, {
    title: 'Models',
    brief: 'Read models',
    key: 'work'
  })
  const started = await start(f, work.workId)
  expect(started.prepared.authority.secretFetch).toBeTypeOf('function')
  await started.prepared.authority.secretFetch!(
    {
      callKey: 'read',
      secret: 'KEY',
      service: 'OpenAI',
      args: { path: '/v1/models' },
      mask: (s) => s
    },
    async () => ({ text: 'data' })
  )
  expect(activity.drain(`${work.workId}:d1`)).toContainEqual({
    icon: 'read',
    text: 'read from',
    highlight: 'OpenAI'
  })
  expect(
    f.store.get('SELECT status FROM bot_actions WHERE activation_id = ?', work.workId)?.status
  ).toBe('done')
  expect(f.bots.actions.forWork(work.workId)).toBeUndefined()
  expect(f.store.unreadWorkActions(work.workId)).toEqual([])
})

async function newWork() {
  f = botFixture()
  const { botId } = await createBot(f, { name: 'Reader', reply: 'Hello.' })
  await f.bots.service.chatSend({ botId, text: 'Read models', clientRequestId: 'chat' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const work = await f.bots.tools.work.start(botId, chat.id, {
    title: 'Models',
    brief: 'Read models',
    key: 'work'
  })
  f.store.putOverlay(work.workId, 'secrets', { tool: 'secrets' })
  return { botId, workId: work.workId }
}
it('withholds the service ledger from a hand-started run', async () => {
  f = botFixture()
  const { botId } = await createBot(f, { reply: 'Hello.' })
  const manual = await f.bots.activate({ botId, input: 'Read models', clientRequestId: 'manual' })
  f.store.putOverlay(manual.id, 'secrets', { tool: 'secrets' })
  expect((await start(f, manual.id)).prepared.authority.secretFetch).toBeUndefined()
})
it('withholds the service ledger from a subagent of work', async () => {
  const { workId } = await newWork()
  const parent = await start(f, workId)
  expect(parent.prepared.authority.secretFetch).toBeTypeOf('function')
  await parent.prepared.authority.subagents!.start({ title: 'Look', brief: 'Read models' })
  const dispatch = f.store.dispatches(workId).find((row) => row.kind === 'subagent')!
  expect((await start(f, workId, dispatch.n)).prepared.authority.secretFetch).toBeUndefined()
})
it('checks the run lane independently of the work trigger', async () => {
  const { workId } = await newWork()
  // Pin the lane guard even for an inconsistent persisted row; a work trigger alone grants nothing.
  f.store.run("UPDATE bot_activations SET lane = 'chat' WHERE id = ?", workId)
  expect((await start(f, workId)).prepared.authority.secretFetch).toBeUndefined()
})
it('supplies the ledger to a scheduled run', async () => {
  f = botFixture()
  const { botId } = await createBot(f, { reply: 'Hello.' })
  f.bots.addSchedule(
    botId,
    { when: { kind: 'interval', minutes: 5 }, prompt: 'Read models' },
    'owner'
  )
  await f.bots.reconcileOnStartup()
  const { inserted } = await f.tickSchedules(new Date(f.clock.now + 5 * 60000))
  expect(inserted).toHaveLength(1)
  f.store.putOverlay(inserted[0]!, 'secrets', { tool: 'secrets' })
  expect((await start(f, inserted[0]!)).prepared.authority.secretFetch).toBeTypeOf('function')
})
it.each(['approved', 'running'])(
  'fails an interrupted %s service read at startup without replay',
  async (status) => {
    const { workId } = await newWork()
    const parent = await start(f, workId)
    await parent.prepared.authority.secretFetch!(
      { callKey: 'read', secret: 'KEY', service: 'OpenAI', args: {}, mask: (s) => s },
      async () => ({ text: 'data' })
    )
    f.store.run(
      'UPDATE bot_actions SET status = ?, result_json = NULL WHERE activation_id = ?',
      status,
      workId
    )
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    const row = f.store.get(
      'SELECT status, result_json FROM bot_actions WHERE activation_id = ?',
      workId
    )!
    expect(row.status).toBe('failed')
    expect(JSON.parse(String(row.result_json))).toEqual({
      text: 'The service read was interrupted.',
      isError: true
    })
    expect(f.allowed.filter((entry) => entry.tool === 'service_read')).toHaveLength(1)
  }
)

it('passes a security refusal through the real engine without retaining its reserved slot', async () => {
  const { workId } = await newWork()
  const started = await start(f, workId)
  let received: unknown
  const result = await started.prepared.authority.secretFetch!(
    { callKey: 'unsafe-file', secret: 'KEY', service: 'OpenAI', args: {}, mask: (text) => text },
    async (refuseWithoutCounting) => {
      received = refuseWithoutCounting
      if (typeof refuseWithoutCounting === 'function') refuseWithoutCounting()
      return { text: 'The fetch folder changed or is unavailable.', isError: true }
    }
  )
  expect(received).toBeTypeOf('function')
  expect(result.isError).toBe(true)
  expect(
    f.store.get('SELECT status, ran_at FROM bot_actions WHERE activation_id = ?', workId)
  ).toMatchObject({ status: 'failed', ran_at: null })
})
