import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { rollUpChips } from '../../src/shared/bots/personal/chips'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const request = { title: 'Compare vacuums', brief: 'Compare three vacuums under £250.' }
const pick = { instanceId: 'pi:openrouter', model: 'some/model' }

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hi.' })).botId
  f.bots.setCustomSlot(botId, 'research', pick)
})
afterEach(() => f.close())

async function chat() {
  const { message } = await f.bots.service.chatSend({ botId, text: 'Compare vacuums; use my named model when asked.', clientRequestId: randomUUID() })
  return { message, ...(await start(f, message.activationId!)) }
}

function caller(turn: Awaited<ReturnType<typeof start>>) {
  const { payload, prepared } = turn
  const app = appToolRegistry(f.runs, fakeAppToolHost({ botRole: () => 'home' }).host, {
    bots: () => ({
      host: f.bots.tools,
      models: { pickable: async () => [{ ...pick, entry: 'OpenRouter', label: 'Model', efforts: ['low', 'high'] }] }
    })
  })
  app.turns.register(appTurn({ threadId: payload.threadId, runId: payload.runId, bot: prepared.authority }))
  return async (args: Record<string, unknown> = request, toolCallId = `mcp:${randomUUID()}`) => {
    const result = await app.registry.call('work_start', args, app.request({ threadId: payload.threadId, runId: payload.runId, toolCallId }))
    expect(result.isError, result.text).toBeFalsy()
    return JSON.parse(result.text)
  }
}

describe('work_start through the production registry', () => {
  it('random MCP ids return the same stored work within one chat turn', async () => {
    const call = caller(await chat())
    const first = await call()
    expect((await call()).runId).toBe(first.runId)
    expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work')).toHaveLength(1)
  })

  it('concurrent identical MCP requests start one piece of work', async () => {
    const call = caller(await chat())
    const [first, repeated] = await Promise.all([call(), call()])
    expect(repeated).toMatchObject({ runId: first.runId, replayed: true })
    expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work')).toHaveLength(1)
  })

  it('a repeated queued request says it is already queued', async () => {
    const call = caller(await chat())
    const queued = await call()
    // The run lane has no count (#1452), so work starts at once; the stored status stands in for a wait.
    f.store.run('UPDATE bot_activations SET status = ? WHERE id = ?', 'queued', queued.runId)
    const repeated = await call()
    expect(repeated).toMatchObject({ runId: queued.runId, status: 'queued', replayed: true, note: expect.stringMatching(/already queued/i) })
    expect(rollUpChips([{ tool: 'work_start', input: request, result: repeated }])).toMatchObject([{ text: 'already queued' }])
  })

  // Every field that chooses the job: changing any one makes a separate request, even with the same runtime id.
  it.each([
    ['title', { title: 'Other comparison' }],
    ['brief', { brief: 'Compare battery packs instead.' }],
    ['level', { level: 'hard' }],
    ['model', { model: pick }],
    ['slot', { slot: 'research' }]
  ] as const)('a different %s starts different work', async (_name, change) => {
    const call = caller(await chat())
    const id = `mcp:${randomUUID()}`
    const first = await call(request, id)
    expect((await call({ ...request, ...change }, id)).runId).not.toBe(first.runId)
  })

  it('different model reasoning levels start different work', async () => {
    const call = caller(await chat())
    const id = `mcp:${randomUUID()}`
    const first = await call({ ...request, model: { ...pick, effort: 'low' } }, id)
    expect((await call({ ...request, model: { ...pick, effort: 'high' } }, id)).runId).not.toBe(first.runId)
  })

  it('a new dispatch after a simulated restart reuses the work, while a new chat turn starts another', async () => {
    const turn = await chat()
    const first = await caller(turn)()
    // Boot ends the previous run; rebuild the engine over its persisted database, then take the real restart continuation.
    f.runs.markTerminal(turn.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    const dispatch = f.store.lastMainDispatch(turn.message.activationId!)!
    expect(dispatch.n).toBeGreaterThan(turn.payload.dispatchN)
    const next = await start(f, turn.message.activationId!, dispatch.n)
    expect(next.prepared.history).toBe('thread')
    expect((await caller(next)()).runId).toBe(first.runId)
    expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work')).toHaveLength(1)
    await finish(f, next.payload, 'completed', { text: 'Already on it.' })
    expect((await caller(await chat())()).runId).not.toBe(first.runId)
  })

  // An unfinished attempt is retryable; replaying its replacement is still one attempt, even after boot recovery.
  it.each(['failed', 'stopped'] as const)('retries %s work and reuses the retry across a restart', async (ending) => {
    const turn = await chat()
    const call = caller(turn)
    const first = await call()
    if (ending === 'failed') await runDispatch(f, first.runId, 1, { status: 'failed' })
    else await f.bots.service.workStop(botId, first.runId)
    const retry = await call()
    expect(retry.runId).not.toBe(first.runId)
    expect(retry.replayed).toBeUndefined()
    expect((await call()).runId).toBe(retry.runId)

    f.runs.markTerminal(turn.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    const dispatch = f.store.lastMainDispatch(turn.message.activationId!)!
    expect(dispatch.n).toBeGreaterThan(turn.payload.dispatchN)
    const next = await start(f, turn.message.activationId!, dispatch.n)
    expect((await caller(next)()).runId).toBe(retry.runId)
    expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work')).toHaveLength(2)
  })

  it('retries work a full queue refused, once there is room', async () => {
    const call = caller(await chat())
    const park = async (workId: string) => {
      await flush()
      const turn = await start(f, workId)
      await f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Check later', dueAt: new Date(f.clock.now + 3600_000).toISOString() })
      await finish(f, turn.payload)
      expect(f.store.activation(workId)?.endReason).toBe('waiting')
    }
    // Only a runaway fills the queue; a ceiling of one stands in for it. Work that waits counts, and is never dropped.
    f.host.maxQueuedActivations = 1
    const parked = await call({ ...request, title: 'Other job' })
    await park(parked.runId)
    const refused = await call()
    expect(refused.status).toBe('ended')
    expect(f.store.activation(refused.runId)).toMatchObject({ status: 'cancelled', endReason: 'queue_full' })
    expect(f.store.activation(parked.runId)?.endReason).toBe('waiting')
    delete f.host.maxQueuedActivations
    const retry = await call()
    expect(retry.runId).not.toBe(refused.runId)
    expect(retry.status).toBe('started')
    expect((await call()).runId).toBe(retry.runId)
  })

  it('repeats describe existing and ended work truthfully, and the report still replies to the owner message', async () => {
    const turn = await chat()
    const call = caller(turn)
    const id = `mcp:${randomUUID()}`
    const first = await call(request, id)
    const repeated = await call(request, id)
    expect(repeated).toMatchObject({ runId: first.runId, replayed: true, note: expect.stringMatching(/already in progress/i) })
    expect(rollUpChips([{ tool: 'work_start', input: request, result: repeated }], {})).toMatchObject([{ text: 'already on it' }])
    await runDispatch(f, first.runId, 1, { text: 'Vacuum A wins.' })
    const ended = await call(request, id)
    expect(ended).toMatchObject({ runId: first.runId, status: 'ended', note: expect.stringMatching(/already ended/i) })
    expect(rollUpChips([{ tool: 'work_start', input: request, result: ended }])).toMatchObject([{ text: 'already ended' }])
    expect(chatOf(f, botId).find((row) => row.kind === 'run_report' && row.activationId === first.runId)?.replyTo?.id).toBe(turn.message.id)
  })
})
