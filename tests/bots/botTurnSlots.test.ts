/**
 * A bot's chat never waits for a turn slot (issue #1388). The bot engine, the run outbox, the effect worker and the
 * orchestrator's slot check are the real ones, in one process; only the turn itself is scripted: each turn the worker
 * starts holds its slot until the test lets it end.
 *
 * Every row starts with every slot the turn could use running another turn:
 * - the owner's message (a chat turn): starts at once, and takes no slot;
 * - work the chat hands off (run lane): waits for a background slot, says so on its line, and starts when one frees;
 * - a consult its running work asks, while that work holds the last background slot: starts at once.
 * The control in each row: an ordinary turn sent at the same moment still waits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import type { EffectRecord } from '../../src/mms/run/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
let worker: EffectWorker
let orch: OrchestratorService
/** The turns the worker started, in order, each holding its slot until `release`. */
let started: EffectRecord[]
let releases: Map<string, () => void>

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Long enough for the worker to claim whatever it can. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

const startedRun = (runId: string | null | undefined): boolean => Boolean(runId) && started.some((effect) => effect.runId === runId)

/** The turn of `runId` ends, and its slot frees. */
function release(runId: string): void {
  const effect = started.find((entry) => entry.runId === runId)!
  releases.get(effect.effectId)!()
}

/** An ordinary turn on a thread of its own, from `source` (`delegation` is background, `gui` a person's). */
function send(threadId: string, source: string): string {
  const run = f.runs.store.createRun({ threadId, source })
  f.outbox.enqueue({ threadId, runId: run.runId, kind: 'turn.start' })
  return run.runId
}

/** `n` ordinary turns from `source`, all started. */
async function fill(n: number, source: string): Promise<string[]> {
  const before = started.length
  const runs = Array.from({ length: n }, (_, index) => send(`${source}-${before + index}`, source))
  await waitFor(() => runs.every(startedRun), `${n} ${source} turns`)
  return runs
}

/** The owner's message; its chat turn, once the worker started it. */
async function chat(text: string, id: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const runId = () => f.store.dispatch(activation.id, 1)?.runId
  await waitFor(() => startedRun(runId()), 'the chat turn')
  return { message, activation, ...(await start(f, activation.id)) }
}

/** The chat hands off work; its dispatch's run once sent. */
async function handOff(chatActivationId: string, title: string, key: string): Promise<{ workId: string; runId: string }> {
  const { workId } = await f.bots.tools.work.start(botId, chatActivationId, { title, brief: `${title}: do it well.`, key })
  await waitFor(() => Boolean(f.store.dispatch(workId, 1)?.runId), 'the work\'s dispatch')
  return { workId, runId: f.store.dispatch(workId, 1)!.runId! }
}

const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hi, I keep your day in order.' })).botId
  // The first message ran by hand (`createBot`): its `turn.start` is for no worker.
  for (const effect of f.outbox.listPending()) f.outbox.cancel(effect.effectId, new Date(f.clock.now).toISOString(), 'test')
  started = []
  releases = new Map()
  worker = new EffectWorker({
    outbox: f.outbox,
    executors: {
      'turn.start': (effect) => {
        started.push(effect)
        return new Promise<void>((resolve) => releases.set(effect.effectId, resolve))
      }
    },
    owner: '1:1',
    now: () => new Date(f.clock.now).toISOString(),
    pollMs: 60_000
  })
  orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(f.base), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
  Object.assign(orch as unknown as Record<string, unknown>, { runEngine: f.runs, effectWorker: worker })
  // As the profile wires it: a bot's work line reads the orchestrator's slot check.
  f.host.turnWaitsForSlot = (runId) => orch.turnWaitsForSlot(runId)
  worker.start()
})

afterEach(async () => {
  for (const done of releases.values()) done()
  await worker.stop()
  f.close()
})

describe('a bot turn and the profile\'s turn slots', () => {
  it('the owner\'s message starts its chat turn at once while every turn slot runs another turn, and takes none', async () => {
    await fill(6, 'delegation')
    await fill(2, 'gui')
    expect(worker.turnSlots()).toMatchObject({ running: 8, limit: 8 })

    const { activation, payload } = await chat('hi', 'm1')
    expect(startedRun(payload.runId)).toBe(true)
    expect(worker.turnSlots().running).toBe(8)
    // Control: a person's ordinary message sent now still waits for a slot.
    const person = send('person-late', 'cli')
    await settle()
    expect(startedRun(person)).toBe(false)

    // Its next turn (another message once it ended) starts at once too.
    await finish(f, payload, 'completed', { text: 'Hello!' })
    release(payload.runId)
    await waitFor(() => f.store.activation(activation.id)?.status === 'done', 'the chat turn\'s end')
    const second = await chat('and again', 'm2')
    expect(startedRun(second.payload.runId)).toBe(true)
    expect(startedRun(person)).toBe(false)
  })

  it('work the chat hands off waits for a background slot, says so on its line, and starts when one frees', async () => {
    const background = await fill(6, 'delegation')
    const asked = await chat('Compare vacuums', 'm1')
    const changed: Array<{ activationId?: string }> = []
    f.bots.events.on('changed', (event: { activationId?: string }) => changed.push(event))
    const work = await handOff(asked.activation.id, 'Vacuum comparison', 'k1')
    await finish(f, asked.payload, 'completed', { text: 'On it.' })
    release(asked.payload.runId)
    await settle()

    expect(startedRun(work.runId)).toBe(false)
    expect(orch.turnWaitsForSlot(work.runId)).toBe(true)
    // The summary was sent again once the wait was known, so the app shows it without another change.
    expect(changed.some((event) => event.activationId === work.workId)).toBe(true)
    expect(summary()).toMatchObject({ state: 'working', stateText: 'Waiting for a free slot', work: [{ id: work.workId, status: 'running', waitsFor: 'slot' }] })

    const before = changed.length
    release(background[0]!)
    await waitFor(() => startedRun(work.runId), 'the work\'s turn')
    expect(orch.turnWaitsForSlot(work.runId)).toBe(false)
    expect(summary().work).toEqual([expect.not.objectContaining({ waitsFor: 'slot' })])
    expect(summary().stateText).toBe('Working on Vacuum comparison')
    // Its turn started: the line says what it does again, without waiting for another change.
    await start(f, work.workId)
    expect(changed.slice(before).some((event) => event.activationId === work.workId)).toBe(true)
  })

  it('a consult its running work asks starts at once while the work holds the last background slot', async () => {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
    await fill(5, 'delegation')
    const asked = await chat('Check the docs', 'm1')
    const work = await handOff(asked.activation.id, 'Docs check', 'k1')
    await waitFor(() => startedRun(work.runId), 'the work\'s turn')
    await fill(2, 'gui')
    expect(worker.turnSlots()).toMatchObject({ running: 8, sharedRunning: 6 })
    const running = await start(f, work.workId)

    const answer = running.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await waitFor(() => Boolean(f.store.dispatches(work.workId).find((dispatch) => dispatch.kind === 'consult')?.runId), 'the consult\'s dispatch')
    const consult = f.store.dispatches(work.workId).find((dispatch) => dispatch.kind === 'consult')!
    await waitFor(() => startedRun(consult.runId), 'the consult\'s turn')
    expect(worker.turnSlots()).toMatchObject({ running: 8, sharedRunning: 6 })
    // Control: an ordinary background turn sent now still waits.
    const late = send('delegation-late', 'delegation')
    await settle()
    expect(startedRun(late)).toBe(false)
    void answer.catch(() => undefined)
  })
})
