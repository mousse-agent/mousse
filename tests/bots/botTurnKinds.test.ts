/**
 * What a turn whose start no build names may do (`BOT_TURN_KINDS`' `unknown`, #1360), at the engine itself, past the
 * registry's check (tests/run/toolApiContract.test.ts covers the registered dispatch): it only reads and answers. A
 * newer build's row, or a provenance stored on the wrong lane, is such a start.
 *
 * Inputs: a chat turn keyed as no build writes it; a run whose row stores `unknown`; a run whose row stores a chat
 * turn's provenance. What it may not do: set a reminder, start a background command, ask its owner, message another
 * bot, hand out work, wait, start subagents or act on the owner's threads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QUESTION_NOT_OFFERED_TEXT } from '../../src/shared/bots/personal/questions'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Alpha', reply: 'Hello.' })).botId
  await createBot(f, { name: 'Beta', reply: 'Hi.' })
})
afterEach(() => f.close())

const due = () => new Date(f.clock.now + 30 * 60_000).toISOString()

describe('a chat turn whose start no build names', () => {
  it('is refused a reminder, a background command, a question, a message to a bot and work, and nothing is written', async () => {
    const activation = await f.bots.enqueueChat(botId, 'future:start', 'Carry on.')
    await flush()
    const turn = await start(f, activation.id)
    expect(f.store.activation(activation.id)?.provenance).toBe('unknown')
    const reminders = f.store.waitingReminders(botId).length
    const activations = f.store.listActivations(botId).length

    expect(() => f.bots.tools.reminders.add(botId, activation.id, { dueAt: due(), text: 'Check the oven.' })).toThrow(/can't set a reminder/)
    expect(() => f.bots.tools.watchers!.start(botId, activation.id, { command: 'echo hi', brief: 'Tell me.' })).toThrow(/can't start a background command/)
    expect(f.bots.askOwner(botId, activation.id, [{ spec: { question: 'Which?', choices: [{ label: 'A' }, { label: 'B' }], other: true } }])).toEqual({ asked: false, text: QUESTION_NOT_OFFERED_TEXT })
    await expect(f.bots.tools.bots!.send(botId, activation.id, { to: 'Beta', message: 'Hello.' })).rejects.toThrow(/Only your chat/)
    await expect(f.bots.tools.work.start(botId, activation.id, { title: 'Research', brief: 'Look it up.', key: 'k1' })).rejects.toThrow(/hand out work/)

    expect(f.store.waitingReminders(botId)).toHaveLength(reminders)
    expect(f.store.countQuestions(botId, {})).toBe(0)
    expect(f.store.listActivations(botId)).toHaveLength(activations)
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
  })
})

describe('a run whose row names no start it may have', () => {
  // A run's row is compiled with only what its start allows: these hold none of the run's own tools.
  it.each([['unknown'], ['owner_message']] as const)('stored as %s: no reminders, commands, asks, waits, bots or subagents, and the owner\'s threads only read', async (provenance) => {
    const activation = await f.bots.activate({ botId, input: 'Do the job.', clientRequestId: 'by-hand' })
    f.store.run('UPDATE bot_activations SET provenance = ? WHERE id = ?', provenance, activation.id)
    const turn = await start(f, activation.id)
    const held = turn.prepared.authority.appTools
    for (const tool of ['remind', 'watch_start', 'question_ask', 'work_wait', 'bot_send', 'subagent_start']) expect(held.has(tool), tool).toBe(false)
    expect(turn.prepared.authority.subagents).toBeUndefined()
    expect(turn.prepared.authority.threadsReadOnly).toBe('not_owner')
    expect(() => f.bots.tools.reminders.add(botId, activation.id, { dueAt: due(), text: 'Check the oven.' })).toThrow(/can't set a reminder/)
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
  })

  it('the control: the same run as its trigger says (by hand) holds them', async () => {
    const activation = await f.bots.activate({ botId, input: 'Do the job.', clientRequestId: 'by-hand' })
    const turn = await start(f, activation.id)
    const held = turn.prepared.authority.appTools
    for (const tool of ['remind', 'watch_start', 'subagent_start']) expect(held.has(tool), tool).toBe(true)
    expect(turn.prepared.authority.subagents).toBeDefined()
    expect(turn.prepared.authority.threadsReadOnly).toBeUndefined()
    expect(f.bots.tools.reminders.add(botId, activation.id, { dueAt: due(), text: 'Check the oven.' }).reminderId).toBeTruthy()
    // A run's reminder says its text: it hands out no work.
    expect(() => f.bots.tools.reminders.add(botId, activation.id, { dueAt: due(), text: 'Check the oven.', work: { title: 'Oven', brief: 'Check the oven.' } })).toThrow(/hands out no work/)
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
  })
})
