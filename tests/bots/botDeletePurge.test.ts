/**
 * Bot Phase 1 §5.3.3 (bot-context.md §8): delete is an archive with a 30-day purge. At once the
 * bot leaves every list, its activations end, its asks are withdrawn, its grant is revoked and its
 * threads are archived (#681). After 30 days a daily sweep purges its memory, threads, chat,
 * schedules, definition and files folder, and nothing of another bot. Scratch goes at each run's end.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, flush, runDispatch, type BotFixture } from './botFixture'

const DAY = 24 * 60 * 60_000

let f: BotFixture

beforeEach(() => {
  f = botFixture()
})

afterEach(() => f.close())

/** A bot with a chat, a finished run that left an open ask, a schedule and a file. */
async function workedBot(description = 'Tidy my notes every evening.'): Promise<{ botId: string; runThread: string }> {
  const { botId } = await createBot(f, { description, reply: 'I tidy notes.' })
  const run = await f.bots.activate({ botId, input: 'Tidy now', clientRequestId: `run-${botId}` })
  await runDispatch(f, run.id, 1, {
    text: 'Tidied what I could.',
    during: (prepared) => {
      expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'Notes', 'a.md') } })).toMatchObject({ ok: false, refused: {} })
    }
  })
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Tidy.' }, 'bot')
  await f.bots.tickSchedules(new Date(f.clock.now))
  writeFileSync(join(f.bots.filesFolder(botId), 'notes.md'), 'tidy')
  return { botId, runThread: run.threadId! }
}

describe('delete', () => {
  it('archives the threads at once, hides the bot, withdraws its asks and revokes its grant', async () => {
    await f.bots.reconcileOnStartup()
    const { botId, runThread } = await workedBot()
    expect(f.store.openAsks(botId)).toHaveLength(1)
    // An activation still working ends with the delete (its queued run never starts).
    const working = await f.bots.activate({ botId, input: 'Again', clientRequestId: 'q1' })
    expect(working.status).toBe('running')
    const { purgeAt } = await f.bots.service.delete(botId)
    expect(Date.parse(purgeAt)).toBe(f.clock.now + 30 * DAY)
    expect(f.archived.sort()).toEqual([`thread:bot:${botId}`, runThread, working.threadId].sort())
    expect(f.trashed).toEqual([])
    expect(f.bots.service.list().bots).toEqual([])
    expect(f.store.openAsks(botId)).toEqual([])
    expect(f.store.activeGrant(botId)).toBeUndefined()
    expect(f.store.activation(working.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
    // Kept for 30 days: chat, schedules, definition and files.
    expect(f.store.messages(botId, { limit: 100 }).length).toBeGreaterThan(0)
    expect(f.store.schedules(botId)).toHaveLength(1)
    expect(f.host.definitions.get(botId)).toBeDefined()
    expect(existsSync(join(f.bots.filesFolder(botId), 'notes.md'))).toBe(true)
    // Its schedules never run again.
    f.clock.now += 2 * 60 * 60_000
    expect((await f.bots.tickSchedules(new Date(f.clock.now))).inserted).toEqual([])
  })
})

describe('the 30-day purge', () => {
  it('purges nothing before 30 days, then everything of the bot and nothing of another, once', async () => {
    const { botId } = await workedBot()
    const other = await workedBot('Watch flight prices to Lisbon.')
    await f.bots.service.delete(botId)
    expect(await f.bots.sweepDeleted(f.clock.now + 29 * DAY)).toEqual([])
    expect(f.purged).toEqual([])
    expect(await f.bots.sweepDeleted(f.clock.now + 30 * DAY + 1)).toEqual([botId])
    expect(f.purged).toEqual([botId])
    // The home thread is deleted for good; the run threads it owns go with it.
    expect(f.trashed).toEqual([`thread:bot:${botId}`])
    expect(f.store.messages(botId, { limit: 100 })).toEqual([])
    expect(f.store.schedules(botId)).toEqual([])
    expect(f.store.scheduleStates(botId)).toEqual([])
    expect(f.host.definitions.get(botId)).toBeUndefined()
    expect(existsSync(f.bots.filesFolder(botId))).toBe(false)
    expect(f.store.botThreads(botId)).toEqual([])
    expect(f.store.deletedRegistry()).toEqual([])
    // Its asks, activations (inputs and results), dispatches and grants go too.
    for (const table of ['bot_escalations', 'bot_activations', 'bot_grants'])
      expect(f.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE bot_id = ?`, botId)).toEqual({ n: 0 })
    expect(f.store.get('SELECT COUNT(*) AS n FROM bot_activations WHERE bot_id = ?', other.botId)).not.toEqual({ n: 0 })
    // The other bot is untouched.
    expect(chatOf(f, other.botId).length).toBeGreaterThan(0)
    expect(f.store.schedules(other.botId)).toHaveLength(1)
    expect(existsSync(join(f.bots.filesFolder(other.botId), 'notes.md'))).toBe(true)
    // Once: a later sweep finds nothing.
    expect(await f.bots.sweepDeleted(f.clock.now + 60 * DAY)).toEqual([])
    expect(f.purged).toEqual([botId])
  })

  it('a purge that fails is retried by the next sweep', async () => {
    const { botId } = await workedBot()
    await f.bots.service.delete(botId)
    const trash = f.host.trashThread!
    f.host.trashThread = async () => { throw new Error('busy') }
    expect(await f.bots.sweepDeleted(f.clock.now + 31 * DAY)).toEqual([])
    expect(f.host.definitions.get(botId)).toBeDefined()
    expect(f.store.deletedRegistry().map((row) => row.botId)).toEqual([botId])
    f.host.trashThread = trash
    expect(await f.bots.sweepDeleted(f.clock.now + 31 * DAY)).toEqual([botId])
    expect(f.store.deletedRegistry()).toEqual([])
  })

  it('a purge is finished only once its definition and files are gone', async () => {
    const { botId } = await workedBot()
    await f.bots.service.delete(botId)
    const remove = f.host.definitions.remove.bind(f.host.definitions)
    f.host.definitions.remove = () => { throw new Error('busy') }
    expect(await f.bots.sweepDeleted(f.clock.now + 31 * DAY)).toEqual([])
    expect(f.store.deletedRegistry().map((row) => row.botId)).toEqual([botId])
    f.host.definitions.remove = remove
    expect(await f.bots.sweepDeleted(f.clock.now + 31 * DAY)).toEqual([botId])
    expect(f.store.deletedRegistry()).toEqual([])
    expect(f.host.definitions.get(botId)).toBeUndefined()
    expect(existsSync(f.bots.filesFolder(botId))).toBe(false)
  })

  it('the sweep runs from the scheduler tick, once a day', async () => {
    await f.bots.reconcileOnStartup()
    const t1 = f.clock.now
    await f.bots.tickSchedules(new Date(t1))
    const { botId } = await workedBot()
    await f.bots.service.delete(botId)
    // Deleted long ago (a profile that was closed for a month).
    f.store.run('UPDATE bot_registry SET deleted_at = ? WHERE bot_id = ?', new Date(t1 - 31 * DAY).toISOString(), botId)
    f.clock.now = t1 + 60 * 60_000
    await f.bots.tickSchedules(new Date(f.clock.now))
    expect(f.purged).toEqual([])
    f.clock.now = t1 + DAY + 60_000
    await f.bots.tickSchedules(new Date(f.clock.now))
    expect(f.purged).toEqual([botId])
  })
})

describe('scratch', () => {
  it('a run\'s scratch folder is deleted when it ends; its files folder stays', async () => {
    const { botId } = await createBot(f, { reply: 'Hi.' })
    const run = await f.bots.activate({ botId, input: 'Work', clientRequestId: 'r1' })
    const scratch = f.store.activation(run.id)!.scratch!
    expect(existsSync(scratch)).toBe(true)
    await runDispatch(f, run.id, 1, { text: 'Done work.' })
    await flush()
    expect(f.store.activation(run.id)).toMatchObject({ status: 'done' })
    expect(existsSync(scratch)).toBe(false)
    expect(existsSync(f.bots.filesFolder(botId))).toBe(true)
  })
})
