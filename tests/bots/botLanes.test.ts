/**
 * Bot Phase 1 §3.1 and §5.3.2: each bot has two lanes, side by side. The chat lane runs the
 * owner's messages in order on the home thread; the run lane runs manual and scheduled runs on
 * threads of their own, each with the run pack of its schedule, and posts a run report.
 */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { name: 'Ticker', reply: 'Hi.' }))
})

afterEach(() => f.close())

async function send(text: string, clientRequestId: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId })
  await flush()
}

const lane = (which: 'chat' | 'run', statuses: Array<'running' | 'queued'>) => f.store.laneActivations(botId, which, statuses)

describe('two lanes', () => {
  it('a chat message during a run starts at once', async () => {
    const run = await f.bots.activate({ botId, input: 'Tidy the notes', clientRequestId: 'r1' })
    expect(run).toMatchObject({ status: 'running', threadId: `thread:bot:${botId}:act:${run.id}` })
    await send('How is it going?', 'm1')
    const [chat] = lane('chat', ['running'])
    expect(chat).toMatchObject({ threadId: `thread:bot:${botId}` })
    expect(lane('run', ['running']).map((row) => row.id)).toEqual([run.id])
    // Both run at the same time.
    const a = await start(f, run.id)
    const b = await start(f, chat!.id)
    await finish(f, b.payload, 'completed', { text: 'Halfway.' })
    await finish(f, a.payload, 'completed', { text: 'Notes tidied.' })
    expect(chatOf(f, botId).slice(-2)).toMatchObject([{ kind: 'text', text: 'Halfway.' }, { kind: 'run_report', text: 'Notes tidied.', activationId: run.id }])
  })

  it('two chat messages run in order', async () => {
    await send('first', 'm1')
    await send('second', 'm2')
    const [running] = lane('chat', ['running'])
    const [queued] = lane('chat', ['queued'])
    expect(running?.trigger.input).toBe('first')
    expect(queued?.trigger.input).toBe('second')
    await runDispatch(f, running!.id, 1, { text: 'one' })
    expect(f.store.activation(queued!.id)?.status).toBe('running')
    await runDispatch(f, queued!.id, 1, { text: 'two' })
    expect(chatOf(f, botId).filter((message) => message.author === 'bot').map((message) => message.text).slice(-2)).toEqual(['one', 'two'])
  })
})

describe('the run lane', () => {
  it('a scheduled run gets the run pack of its schedule, and its final text is a run report', async () => {
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'check' }, 'owner')
    await f.bots.reconcileOnStartup()
    await f.bots.tickSchedules(new Date(f.clock.now))
    f.clock.now += 5 * 60_000
    const { inserted } = await f.bots.tickSchedules(new Date(f.clock.now))
    expect(inserted).toHaveLength(1)
    const activation = f.store.activation(inserted[0]!)!
    expect(activation).toMatchObject({ lane: 'run', status: 'running', trigger: { kind: 'schedule', scheduleId, input: 'check' } })
    const { payload, prepared } = await start(f, activation.id)
    expect(prepared).toMatchObject({ history: 'none', lane: 'run', preamble: `<bot_memory>run pack ${scheduleId}</bot_memory>` })
    expect(f.packs.at(-1)).toEqual({ lane: 'run', activationId: activation.id, scheduleId })
    await finish(f, payload, 'completed', { text: 'All quiet.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', kind: 'run_report', text: 'All quiet.', activationId: activation.id })
    expect(f.journal.find((row) => row.kind === 'run_start' && row.activationId === activation.id)).toMatchObject({ json: { scheduleId } })
  })

  it('a manual run\'s pack has no schedule id', async () => {
    const run = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    const { prepared } = await start(f, run.id)
    expect(f.packs.at(-1)).toEqual({ lane: 'run', activationId: run.id })
    expect(prepared.preamble).toBe('<bot_memory>run pack manual</bot_memory>')
  })

  it('activationOf answers each thread\'s lane, and nothing once the work ended; scratch goes at each run\'s end', async () => {
    const run = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    await send('hi', 'm1')
    const [chat] = lane('chat', ['running'])
    expect(f.bots.tools.activationOf(`thread:bot:${botId}`)).toMatchObject({ botId, activationId: chat!.id, lane: 'chat', role: 'home' })
    expect(f.bots.tools.activationOf(run.threadId!)).toMatchObject({ botId, activationId: run.id, lane: 'run', role: 'activation' })
    expect(f.bots.tools.activationOf('thread:someone-else')).toBeUndefined()
    const prepared = await runDispatch(f, run.id, 1, { text: 'done' })
    expect(existsSync(prepared.scratch)).toBe(false)
    expect(f.bots.tools.activationOf(run.threadId!)).toBeUndefined()
    await runDispatch(f, chat!.id, 1, { text: 'hello' })
    expect(f.bots.tools.activationOf(`thread:bot:${botId}`)).toBeUndefined()
    // Startup capture gives each thread's new rows to the latest activation that ran there.
    expect(f.store.captureThreads().filter((thread) => thread.botId === botId).map((thread) => [thread.role, thread.lastActivation])).toEqual(expect.arrayContaining([
      ['home', { id: chat!.id, lane: 'chat' }],
      ['activation', { id: run.id, lane: 'run' }]
    ]))
  })
})
