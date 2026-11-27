/**
 * A bot's work in the thread tree (issue #1454, slice S4): the run database keeps a projection of each run-lane work as a
 * delegation from the bot's chat into the work's thread, written from bots.db (the source of truth) and rebuilt at
 * startup. A Stop or a message for that row reaches the work through the bot port, never the projection or the work
 * thread's inbox. Restarts are real: both databases close and open again, the run engine boots and then the bots.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botAuthoredNote } from '../../src/mms/bots/activation/BotEngine'
import { botInstructions } from '../../src/mms/bots/instructions'
import { botWorkDelegationId, botWorkInto } from '../../src/mms/run/delegation/botWork'
import { buildSubagentView } from '../../src/mms/run/delegation/subagentView'
import { Inbox } from '../../src/mms/run/Inbox'
import { getDefaultSettings } from '../../src/shared/settings'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

describe('a bot\'s work in the thread tree', () => {
  let f: BotFixture
  let botId: string
  let firstActivation: string

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    ;({ botId, firstActivation } = await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' }))
  })
  afterEach(() => f.close())

  async function work(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Compare three vacuum cleaners.', clientRequestId: id })
    const started = await start(f, activation.id)
    await flush()
    return { id: activation.id, threadId: f.store.activation(activation.id)!.threadId!, home: f.store.registry(botId)!.homeThreadId!, ...started }
  }

  const projection = (job: { threadId: string }) => botWorkInto(f.runs.store, job.threadId)
  const reports = (activationId: string) => f.store.all("SELECT id FROM bot_messages WHERE activation_id = ? AND kind = 'run_report'", activationId)
  const tree = (threadId: string) => buildSubagentView({ delegations: f.runs.delegations, inbox: new Inbox(f.runs.store), store: f.runs.store, thread: (id) => ({ name: id }), hasPendingQuestion: () => false }, threadId)

  it('the bot\'s chat lists its running work, and the work\'s end follows bots.db', async () => {
    const job = await work('w1')
    expect(projection(job)).toMatchObject({ status: 'running', parentThreadId: job.home, childThreadId: job.threadId })
    expect(tree(job.home)).toEqual([expect.objectContaining({ childThreadId: job.threadId, state: 'working' })])
    await finish(f, job.payload, 'completed', { text: 'The second one.' })
    expect(f.store.activation(job.id)!.status).toBe('done')
    expect(projection(job)).toMatchObject({ status: 'acknowledged', result: { runStatus: 'completed' } })
    expect(tree(job.home)).toEqual([expect.objectContaining({ childThreadId: job.threadId, state: 'done' })])
  })

  // The crash falls after bots.db recorded the work's end (and its report), before the run database's projection did.
  const crashes: Array<[string, string]> = [
    ['its projection still reads running', "UPDATE delegations SET status = 'running', result = NULL, completed_at = NULL WHERE delegation_id = ?"],
    ['its projection was never written', 'DELETE FROM delegations WHERE delegation_id = ?']
  ]
  it.each(crashes)('a crash between the work\'s end in bots.db and its projection, when %s, is rebuilt at startup with exactly one report to the owner', async (_name, sql) => {
    const job = await work('w1')
    await finish(f, job.payload, 'completed', { text: 'The second one.' })
    expect(reports(job.id)).toHaveLength(1)
    await f.restart({
      crashed: true,
      whileDown: ({ runDb }) => {
        const db = new DatabaseSync(runDb)
        db.prepare(sql).run(botWorkDelegationId(job.id))
        db.close()
      }
    })
    expect(projection(job)).toMatchObject({ status: 'acknowledged', result: { runStatus: 'completed' }, parentThreadId: job.home, childThreadId: job.threadId })
    expect(reports(job.id)).toHaveLength(1)
    // Rebuilding again writes nothing new.
    const events = f.runs.store.db.statement("SELECT COUNT(*) AS n FROM thread_events WHERE type = 'delegation.status' AND thread_id = ?").get(job.home)!.n
    await f.restart()
    expect(f.runs.store.db.statement("SELECT COUNT(*) AS n FROM thread_events WHERE type = 'delegation.status' AND thread_id = ?").get(job.home)!.n).toBe(events)
    expect(reports(job.id)).toHaveLength(1)
  })

  it('a Stop of the work\'s row stops the work through the bot port, and the projection follows', async () => {
    const job = await work('w1')
    expect(await f.runs.stopBotWork(job.threadId)).toBe('stopped')
    expect(f.store.activation(job.id)).toMatchObject({ status: 'cancelled', endReason: 'stopped' })
    await flush()
    expect(projection(job)).toMatchObject({ status: 'cancelled', result: { runStatus: 'cancelled' } })
    // Ended work is no longer the port's to stop: the thread is stopped as any thread is.
    expect(await f.runs.stopBotWork(job.threadId)).toBeNull()
  })

  it('a message to the work\'s row reaches the work as its owner\'s note through the bot port, never the work thread\'s inbox', async () => {
    const job = await work('w1')
    expect(f.runs.noteBotWork(job.threadId, 'Only cordless ones.')).toBe('noted')
    expect(f.store.pendingWorkNotes(job.id).map((note) => note.text)).toEqual(['Only cordless ones.'])
    expect(new Inbox(f.runs.store).listByStatus(job.threadId, 'pending')).toEqual([])
    // Not a bot work's thread: nothing is forwarded.
    expect(f.runs.noteBotWork(job.home, 'Hello.')).toBeNull()
  })

  it('a message sent from a turn its owner did not start is the bot\'s, not the owner\'s, and moves no ask-first cursor', async () => {
    const settings = getDefaultSettings()
    settings.experimental.botAsksFirstOff = false
    f.host.settings = { get: () => settings, set: () => undefined } as never
    const job = await work('w1')
    // The bot's first message is a turn no owner's message started.
    expect(f.runs.noteBotWork(job.threadId, 'Only cordless ones.', { from: firstActivation })).toBe('noted')
    const notes = f.store.pendingWorkNotes(job.id)
    expect(notes).toHaveLength(1)
    expect(botAuthoredNote(notes[0]!.fromMessage)).toBe(true)
    expect(f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `cursor:action-note:${job.id}`)).toBeUndefined()
  })

  it('a retry of the same message adds no second note', async () => {
    const job = await work('w1')
    expect(f.runs.noteBotWork(job.threadId, 'Only cordless ones.', { requestKey: 'send-1' })).toBe('noted')
    expect(f.runs.noteBotWork(job.threadId, 'Only cordless ones.', { requestKey: 'send-1' })).toBe('noted')
    expect(f.store.pendingWorkNotes(job.id).map((note) => note.text)).toEqual(['Only cordless ones.'])
    // Another request is another note.
    expect(f.runs.noteBotWork(job.threadId, 'And quiet.', { requestKey: 'send-2' })).toBe('noted')
    expect(f.store.pendingWorkNotes(job.id)).toHaveLength(2)
  })
})
