import { afterEach, expect, it, vi } from 'vitest'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { renderMemoryBlocks } from '../../../src/mms/bots/memory/render'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { disposeFixtures, memoryFixture } from './memoryFixture'

afterEach(disposeFixtures)
// Inputs: exact/near text, other bots, owner edits, kind order, dates, absorbed refs,
// forgotten/expired entries, repeated passes and the no-duplicate read-only path.
it('puts away cross-kind copies without changing the kept entry, and Forget takes them all', () => {
  const { store } = memoryFixture()
  const words = 'The owner lives in Leeds.'
  store.save('ada', { lane: 'chat', kind: 'owner', text: words })
  store.save('ada', { lane: 'chat', kind: 'note', text: words })
  store.save('ada', { lane: 'run', kind: 'note', text: words })
  const kept = store.versions('ada', 'm1')
  expect(store.tidyDuplicates('ada')).toBe(2)
  expect(store.versions('ada', 'm1')).toEqual(kept)
  for (const id of ['m2', 'm3']) {
    expect(store.versions('ada', id).at(-1)).toMatchObject({ status: 'superseded', text: words, reason: 'merged into m1' })
    expect(JSON.stringify(store.read('ada', { ref: id }))).toContain('merged into m1')
    expect(store.forget('ada', { id, by: 'owner_ui' })).toMatchObject({ error: expect.stringContaining('m1') })
    for (const key of ['replaces', 'merges'] as const) {
      expect(store.save('ada', { lane: 'chat', kind: 'note', text: 'A replacement.', [key]: key === 'merges' ? [id] : id }))
        .toMatchObject({ error: 'refused', reason: `${id} was put away as a copy of m1. To change these words, replace m1.` })
    }
  }
  expect(store.journal('ada').at(-1)).toMatchObject({ who: 'mousse', kind: 'memory_op' })
  expect(store.journal('ada').at(-1)?.text).not.toContain(words)
  const journal = store.journal('ada')
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(store.journal('ada')).toEqual(journal)
  createBotMemoryAdmin({ store }).forget('ada', 'm1')
  expect(store.list('ada').entries).toEqual([])
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(store.versions('ada', 'm2').every(v => v.text === null)).toBe(true)
})

it('keeps an owner-edited note ahead of a bot-written owner fact, leaving near text and other bots alone', () => {
  const { store } = memoryFixture()
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'Gym Tuesday 7pm' })
  store.save('ada', { lane: 'chat', kind: 'note', text: 'Old note' })
  createBotMemoryAdmin({ store }).edit('ada', 'm2', 'Gym Tuesday 7pm')
  store.save('ada', { lane: 'run', kind: 'note', text: 'Gym Wednesday 7pm' })
  store.save('bea', { lane: 'chat', kind: 'note', text: 'Gym Tuesday 7pm' })
  expect(store.tidyDuplicates('ada')).toBe(1)
  expect(store.list('ada').entries.map(e => e.ref)).toEqual(['m2v2', 'm3'])
  expect(store.list('bea').entries).toHaveLength(1)
})

it.each([
  [{ expiresAt: '2027-01-01' }, {}],
  [{ validFrom: '2026-12-01' }, {}]
])('keeps a duplicate whose validity exceeds the preferred entry (%j)', (preferred, other) => {
  const { store } = memoryFixture()
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'A fact.', ...preferred })
  store.save('ada', { lane: 'run', kind: 'note', text: 'A fact.', ...other })
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(store.list('ada').entries).toHaveLength(2)
})

it('uses one indexed read and no transaction or write with no duplicates', () => {
  const { store, db } = memoryFixture()
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'One fact.' })
  const statements = vi.spyOn(db, 'statement')
  const transaction = vi.spyOn(db, 'transaction')
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(statements).toHaveBeenCalledTimes(1)
  expect(transaction).not.toHaveBeenCalled()
  const sql = statements.mock.calls[0]![0]
  const plan = db.statement(`EXPLAIN QUERY PLAN ${sql}`).all('ada', new Date().toISOString(), 'ada', new Date().toISOString())
  expect(JSON.stringify(plan)).toContain('bot_memories_')
})

it.each(['kind', 'oldest', 'id'])('breaks duplicate ties by %s', (tie) => {
  const { store, clock } = memoryFixture()
  store.save('ada', { lane: 'chat', kind: 'note', text: 'A repeated fact.' })
  clock.now += tie === 'oldest' ? 1_000 : 0
  store.save('ada', { lane: tie === 'kind' ? 'run' : 'chat', kind: 'note', text: 'Different words.' })
  store.save('ada', { lane: tie === 'kind' ? 'run' : 'chat', kind: 'note', text: 'A repeated fact.', replaces: 'm2' })
  expect(store.tidyDuplicates('ada')).toBe(1)
  expect(store.active('ada').map(e => e.ref)).toEqual(['m1'])
})

it('never keeps an expired or forgotten entry', () => {
  const { store, clock } = memoryFixture()
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'A dated fact.', expiresAt: '2026-11-08' })
  store.save('ada', { lane: 'chat', kind: 'note', text: 'A dated fact.' })
  clock.now += 2 * 24 * 60 * 60 * 1_000
  store.expireMemories('ada')
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(store.active('ada').map(e => e.ref)).toEqual(['m2'])
  store.forget('ada', { id: 'm2', by: 'owner_ui' })
  expect(store.tidyDuplicates('ada')).toBe(0)
  expect(store.save('ada', { lane: 'run', kind: 'note', text: 'A dated fact.' })).toMatchObject({ error: 'refused' })
})


it('refreshes frozen chat and run packs, preserving every other block byte for byte', async () => {
  const { store } = memoryFixture()
  for (const lane of ['chat', 'run'] as const) store.save('ada', { lane, kind: 'note', text: 'The feed is at /rss.' })
  store.save('ada', { lane: 'chat', kind: 'owner', text: 'Keep replies short.' })
  const packs = createBotContextProvider({ store, journal: createBotJournal({ store, readThread: () => ({ messages: [] }), listThreads: () => [] }) })
  const beforeBlocks = renderMemoryBlocks(store.active('ada'), store.zone())
  const chat = await packs.chatPreamble({ botId: 'ada', activationId: 'chat-pack' })
  const run = await packs.runPreamble({ botId: 'ada', activationId: 'run-pack' })
  expect(chat).toContain('m2')
  expect(run).toContain('m2')
  store.tidyDuplicates('ada')
  const afterBlocks = renderMemoryBlocks(store.active('ada'), store.zone())
  for (const [before, after] of [
    [chat, await packs.chatPreamble({ botId: 'ada', activationId: 'chat-pack' })],
    [run, await packs.runPreamble({ botId: 'ada', activationId: 'run-pack' })]
  ]) {
    expect(after).toBe(before!.replace(beforeBlocks.core, afterBlocks.core).replace(beforeBlocks.runNotes, afterBlocks.runNotes))
    expect(after).not.toContain('m2')
  }
})
