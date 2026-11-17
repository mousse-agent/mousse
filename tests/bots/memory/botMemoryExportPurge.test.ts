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

describe('wiping a bot\'s memory (/forget, /forget history, /reset)', () => {
  /**
   * What each wipe meets, for two bots: the owner's entry, the bot's note, a run note, a run note the owner edited into a
   * note, a forgotten entry, the chat in the journal (folded into a summary), frozen packs, and a thread capture copied.
   */
  function seeded() {
    const fx = memoryFixture()
    const { store } = fx
    const thread = new Map([['th-home', [{ id: 'u1', role: 'user' as const, content: 'Old thread words about turnips.', timestamp: new Date(fx.clock.now).toISOString() }]]])
    const journal = createBotJournal({ store, readThread: (id) => ({ messages: thread.get(id) ?? [] }), listThreads: () => [] })
    const packs = createBotContextProvider({ store, journal })
    for (const botId of ['ada', 'bob']) {
      fx.message({ botId, id: `${botId}-o1`, author: 'owner', text: 'I grow turnips on the allotment.', activationId: `${botId}-a1` })
      fx.message({ botId, id: `${botId}-b1`, author: 'bot', text: 'Turnips noted.', activationId: `${botId}-a1` })
      store.save(botId, { lane: 'chat', kind: 'owner', text: 'The owner keeps an allotment.', activationId: `${botId}-a1` })
      store.save(botId, { lane: 'chat', kind: 'note', text: 'Reports go out on Mondays.' })
      store.save(botId, { lane: 'run', kind: 'note', text: 'The seed shop closes at 5.', activationId: `${botId}-r1` })
      store.save(botId, { lane: 'run', kind: 'note', text: 'The council site moved.', activationId: `${botId}-r1` })
      store.save(botId, { lane: 'chat', kind: 'owner', text: 'The owner has a dog called Rex.' })
      store.setState(botId, 'chat_summary', { text: 'Owner: talked about turnips', throughSeq: 1 })
    }
    for (const botId of ['ada', 'bob']) {
      createBotMemoryAdmin({ store }).edit(botId, 'm4', 'The council site moved to /plots.')
      store.forget(botId, { id: 'm5', by: 'owner_ui' })
    }
    journal.syncNow({ botId: 'ada', threadId: 'th-home', lane: 'chat', activationId: 'ada-a1' })
    return { fx, store, journal, packs, thread }
  }

  const current = (store: ReturnType<typeof seeded>['store'], botId: string) => store.list(botId).entries.map((entry) => [entry.id, entry.kind, entry.text])

  it('/forget history keeps the owner\'s entries and the bot\'s notes, readable and in the pack, and nothing of the old chat', async () => {
    const { store, journal, packs, thread } = seeded()
    const bob = { list: current(store, 'bob'), journal: store.journal('bob').length }
    const admin = createBotMemoryAdmin({ store })
    // m3 is the one run note left: m4 was edited into a note, m5 was forgotten.
    expect(admin.wipeHistory('ada')).toBe(1)
    expect(current(store, 'ada')).toEqual([['m1', 'owner', 'The owner keeps an allotment.'], ['m2', 'note', 'Reports go out on Mondays.'], ['m4', 'note', 'The council site moved to /plots.']])
    expect(store.read('ada', { ref: 'm1' })).toMatchObject({ rows: [{ ref: 'm1', text: 'The owner keeps an allotment.' }] })
    expect(store.read('ada', { ref: 'm4' })).toMatchObject({ rows: [{ ref: 'm4' }, { ref: 'm4v2', text: 'The council site moved to /plots.' }] })
    expect(store.search('ada', { query: 'allotment' }).map((hit) => hit.ref)).toEqual(['m1'])
    expect(store.search('ada', { query: 'turnips' })).toEqual([])
    expect(store.journal('ada')).toEqual([])
    // The forgotten entry stays forgotten: the bot can't learn it again.
    expect(store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner has a dog called Rex.' })).toMatchObject({ error: 'refused' })
    const pack = await packs.chatPreamble({ botId: 'ada', activationId: 'ada-a2' })
    expect(pack).toContain('The owner keeps an allotment.')
    expect(pack).toContain('The council site moved to /plots.')
    expect(pack).not.toContain('seed shop')
    expect(pack).not.toContain('turnips')
    expect(pack).toContain('Recent chat: (nothing yet)')
    expect(pack).toContain('The owner has not written yet.')
    // Its threads' words already copied are never copied back in.
    journal.syncNow({ botId: 'ada', threadId: 'th-home', lane: 'chat', activationId: 'ada-a1' })
    expect(store.journal('ada')).toEqual([])
    thread.get('th-home')!.push({ id: 'u2', role: 'user', content: 'New words.', timestamp: new Date().toISOString() })
    journal.syncNow({ botId: 'ada', threadId: 'th-home', lane: 'chat', activationId: 'ada-a2' })
    expect(store.journal('ada').map((row) => row.text)).toEqual(['New words.'])
    // The other bot is untouched.
    expect(current(store, 'bob')).toEqual(bob.list)
    expect(store.journal('bob')).toHaveLength(bob.journal)
  })

  it('/forget forgets every current entry as Forget does one, and their words leave the chat\'s history', async () => {
    const { store } = seeded()
    expect(createBotMemoryAdmin({ store }).forgetAll('ada')).toBe(4)
    expect(store.list('ada').entries).toEqual([])
    expect(store.list('ada', true).entries.filter((entry) => entry.status !== 'superseded').every((entry) => entry.status === 'forgotten' && entry.text === null)).toBe(true)
    expect(store.search('ada', { query: 'allotment', kinds: ['memory'] })).toEqual([])
    // The chat itself is history, not memory: it stays.
    expect(store.search('ada', { query: 'turnips' }).length).toBeGreaterThan(0)
    expect(store.save('ada', { lane: 'chat', kind: 'note', text: 'Reports go out on Mondays.' })).toMatchObject({ error: 'refused' })
    expect(current(store, 'bob')).toHaveLength(4)
    expect(createBotMemoryAdmin({ store }).forgetAll('ada')).toBe(0)
  })

  it('/reset removes every entry, the journal and the state, but keeps the capture cursors', async () => {
    const { store, journal } = seeded()
    createBotMemoryAdmin({ store }).reset('ada')
    expect(store.list('ada', true).entries).toEqual([])
    expect(store.journal('ada')).toEqual([])
    expect(store.getState('ada', 'chat_summary')).toBeUndefined()
    expect(store.getState('ada', 'cursor:th-home')).toBeDefined()
    journal.syncNow({ botId: 'ada', threadId: 'th-home', lane: 'chat', activationId: 'ada-a1' })
    expect(store.journal('ada')).toEqual([])
    // A forgotten entry is gone too: a reset bot starts with no memory at all.
    expect(store.save('ada', { lane: 'chat', kind: 'owner', text: 'The owner has a dog called Rex.' })).toMatchObject({ id: 'm1' })
    expect(current(store, 'bob')).toHaveLength(4)
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
