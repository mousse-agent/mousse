import { afterEach, describe, expect, it } from 'vitest'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { botMemoryMethods } from '../../../src/mms/bots/memory/methods'
import { disposeFixtures, memoryFixture } from './memoryFixture'

/**
 * The owner edits a memory entry (`bots.memory.edit`): a new version the bot's next turn carries, held to a save's
 * rules. Inputs: an owner wish, a bot note, a run note; the current ref, an older ref, a forgotten entry, an unknown id;
 * the same words, words the guard refuses, words over the length limit.
 */

afterEach(disposeFixtures)

function setup() {
  const fx = memoryFixture()
  fx.message({ botId: 'ada', id: 'o1', author: 'owner', text: 'I live in Leeds' })
  fx.store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner lives in Leeds.' })
  fx.store.save('ada', { lane: 'chat', kind: 'note', text: 'Keep replies short.' })
  fx.store.save('ada', { lane: 'run', kind: 'note', text: 'The feed moved to /rss.', activationId: 'act-r' })
  const methods = botMemoryMethods(createBotMemoryAdmin({ store: fx.store }))
  const edit = (id: string, text: string) => methods['bots.memory.edit']({ profileId: 'p', botId: 'ada', id, text })
  return { fx, methods, edit }
}

describe('bots.memory.edit', () => {
  it('saves the new words as the next version, which the next turn carries instead of the old', async () => {
    const { fx, edit } = setup()
    const { entry } = await edit('m1', '  The owner lives in   York. ')
    expect(entry).toMatchObject({ id: 'm1', version: 2, ref: 'm1v2', kind: 'owner', text: 'The owner lives in York.', status: 'active', by: 'you said' })
    expect(fx.store.list('ada').entries.find((item) => item.id === 'm1')?.text).toBe('The owner lives in York.')
    expect(fx.store.versions('ada', 'm1').map((version) => version.status)).toEqual(['superseded', 'active'])
    expect(fx.store.journal('ada').at(-1)).toMatchObject({ kind: 'memory_op', who: 'owner', text: 'remembered · The owner lives in York.' })
    const packs = createBotContextProvider({ store: fx.store, journal: createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] }) })
    const pack = await packs.chatPreamble({ botId: 'ada', activationId: 'act-x' })
    expect(pack).toContain('The owner lives in York.')
    expect(pack).not.toContain('The owner lives in Leeds.')
  })

  it('keeps a note a note, and makes a run note the owner edits a note', async () => {
    const { edit } = setup()
    expect((await edit('m2', 'Keep replies to two lines.')).entry).toMatchObject({ kind: 'note', ref: 'm2v2' })
    expect((await edit('m3', 'The feed is at /rss now.')).entry).toMatchObject({ kind: 'note', ref: 'm3v2' })
  })

  it('makes no new version for the same words', async () => {
    const { fx, edit } = setup()
    expect((await edit('m1', 'The owner lives in Leeds.')).entry).toMatchObject({ ref: 'm1', version: 1 })
    expect(fx.store.versions('ada', 'm1')).toHaveLength(1)
  })

  it('refuses an older version, a forgotten or unknown entry, and words a save refuses', async () => {
    const { fx, edit } = setup()
    await edit('m1', 'The owner lives in York.')
    await expect(edit('m1', 'The owner lives in Hull.')).rejects.toMatchObject({ code: 'invalid_params', message: 'This memory changed since you opened it.' })
    fx.store.forget('ada', { id: 'm2', by: 'owner_ui' })
    await expect(edit('m2', 'Anything.')).rejects.toMatchObject({ code: 'not_found' })
    await expect(edit('m9', 'Anything.')).rejects.toMatchObject({ code: 'not_found' })
    await expect(edit('m3', 'x'.repeat(401))).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('under 400 characters') })
    await expect(edit('m3', 'wifi password = hunter2')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(edit('j1', 'Anything.')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(edit('m3', '   ')).rejects.toMatchObject({ code: 'invalid_params' })
    expect(fx.store.versions('ada', 'm3')).toHaveLength(1)
  })
})
