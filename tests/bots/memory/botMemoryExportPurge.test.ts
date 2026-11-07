import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { botMemoryMethods } from '../../../src/mms/bots/memory/methods'
import { DomainRpcError } from '../../../src/mms/protocol/domainRegistry'
import { disposeFixtures, memoryFixture } from './memoryFixture'

/** Export (bot-context.md §8) writes what every turn gets and every row; purge removes one bot and nothing else. */

const dirs: string[] = []
afterEach(() => {
  disposeFixtures()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-export-'))
  dirs.push(dir)
  return dir
}

describe('export', () => {
  it('writes memory.md exactly as injected, every version, every journal row with redactions, and the definition', async () => {
    const fx = memoryFixture()
    const { store } = fx
    fx.message({ botId: 'ada', id: 'o1', author: 'owner', text: 'I live in Leeds' })
    store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner lives in Leeds.' })
    store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner lives in York.', replaces: 'm1' })
    store.save('ada', { lane: 'run', kind: 'note', text: 'The feed moved to /rss.', activationId: 'act-r' })
    fx.message({ botId: 'ada', id: 'o2', author: 'owner', text: 'my old phone number is 0123' })
    store.forget('ada', { refs: ['j5'], by: 'chat' })
    store.append({ botId: 'ada', kind: 'model_change', sourceKey: 'act:x:model', who: 'mousse', text: 'model changed' })
    const admin = createBotMemoryAdmin({ store, definition: (botId) => ({ id: botId, format: 2, name: 'Ada' }) })
    const dir = folder()
    const { files } = await admin.export('ada', dir)
    expect(files.map((file) => basename(file))).toEqual(['memory.md', 'memory.jsonl', 'journal.jsonl', 'definition.json'])
    expect(basename(join(files[0]!, '..'))).toBe('bot-memory-ada-2026-11-07')
    const packs = createBotContextProvider({ store, journal: createBotJournal({ store, readThread: () => ({ messages: [] }), listThreads: () => [] }) })
    const pack = await packs.chatPreamble({ botId: 'ada', activationId: 'act-x' })
    const md = readFileSync(files[0]!, 'utf8')
    expect(pack).toContain(md.trimEnd())
    expect(md).toContain('[m1v2 · 7 Nov 2026] The owner lives in York.')
    expect(md).toContain('[m2 · 7 Nov 2026] The feed moved to /rss.')
    const versions = readFileSync(files[1]!, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(versions.map((row) => [row.ref, row.status])).toEqual([['m1', 'superseded'], ['m1v2', 'active'], ['m2', 'active']])
    const journal = readFileSync(files[2]!, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(journal.find((row) => row.ref === 'j5')).toMatchObject({ text: '[removed at your request · 7 Nov 2026]', redactedAt: expect.any(String) })
    expect(journal.some((row) => row.kind === 'model_change')).toBe(true)
    expect(JSON.parse(readFileSync(files[3]!, 'utf8'))).toEqual({ id: 'ada', format: 2, name: 'Ada' })
    expect(statSync(files[2]!).mode & 0o777).toBe(0o600)
    // A second export goes to a new folder.
    const again = await admin.export('ada', dir)
    expect(basename(join(again.files[0]!, '..'))).toBe('bot-memory-ada-2026-11-07-2')
  })
})

describe('purge', () => {
  it('removes every memory row of one bot and nothing of another', async () => {
    const fx = memoryFixture()
    const { store, db } = fx
    for (const botId of ['ada', 'bob']) {
      fx.message({ botId, id: `${botId}-1`, author: 'owner', text: `hello from ${botId}` })
      store.save(botId, { lane: 'chat', kind: 'note', text: `note of ${botId}` })
      store.setState(botId, 'window_start_seq', 1)
    }
    const admin = createBotMemoryAdmin({ store })
    await admin.purge('ada')
    const count = (table: string, botId: string) => (db.statement(`SELECT count(*) AS n FROM ${table} WHERE bot_id = ?`).get(botId) as { n: number }).n
    for (const table of ['bot_journal', 'bot_memories', 'bot_memory_state']) {
      expect(count(table, 'ada')).toBe(0)
      expect(count(table, 'bob')).toBeGreaterThan(0)
    }
    expect(store.search('ada', { query: 'hello' })).toEqual([])
    expect(store.search('bob', { query: 'hello' }).map((hit) => hit.ref)).toEqual(['j3'])
    expect(store.search('bob', { query: 'note' }).map((hit) => hit.ref)).toEqual(['m1'])
    expect(store.checkIndexes()).toEqual([])
    await admin.reindex()
    expect(store.search('bob', { query: 'note' }).map((hit) => hit.ref)).toEqual(['m1'])
  })
})

describe('bots.memory.* handlers', () => {
  it('validate their params and answer through the admin', async () => {
    const fx = memoryFixture()
    fx.store.save('ada', { lane: 'chat', kind: 'note', text: 'Keep it short.' })
    const methods = botMemoryMethods(createBotMemoryAdmin({ store: fx.store }))
    expect(await methods['bots.memory.list']({ profileId: 'p', botId: 'ada' })).toMatchObject({ entries: [{ id: 'm1', text: 'Keep it short.' }], gauge: 'core 4/2,000 · run notes 0/500' })
    await expect(methods['bots.memory.list']({ botId: 'Not A Bot' })).rejects.toBeInstanceOf(DomainRpcError)
    await expect(methods['bots.memory.list']({ botId: 'ada', extra: 1 })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(methods['bots.memory.forget']({ botId: 'ada', id: 'j1' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(methods['bots.memory.forget']({ botId: 'ada', id: 'm9' })).rejects.toMatchObject({ code: 'not_found', message: 'There is no memory entry m9.' })
    expect(await methods['bots.memory.forget']({ botId: 'ada', id: 'm1' })).toMatchObject({ forgotten: 'm1' })
    expect(fx.store.journal('ada').at(-1)).toMatchObject({ kind: 'redaction', who: 'owner', lane: null })
    await expect(methods['bots.memory.export']({ botId: 'ada', dir: 'relative/dir' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(methods['bots.memory.export']({ botId: 'ada', dir: join(folder(), 'missing') })).rejects.toMatchObject({ code: 'invalid_params', message: 'That folder does not exist.' })
    expect((await methods['bots.memory.export']({ botId: 'ada', dir: folder() })).files).toHaveLength(3)
  })
})
