import { botFixture, createBot } from '../botFixture'
import { dataFrame, splitDataFrames } from '../../../src/shared/bots/personal/dataFrames'
import { afterEach, expect, it } from 'vitest'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { wakeInput, type BotWakeFired } from '../../../src/shared/bots/personal/wakes'
import { disposeFixtures, memoryFixture } from './memoryFixture'

afterEach(disposeFixtures)

// Outside sources: command tail, matching line, failure reason, PR title, thread title.
it.each<BotWakeFired>([
  { kind: 'watcher', title: 'build', how: 'exit', exitCode: 0, tail: 'quartz output' },
  { kind: 'watcher', title: 'build', how: 'match', line: 'quartz match', tail: '' },
  { kind: 'watcher', title: 'build', how: 'failed', message: 'quartz failure', tail: '' },
  { kind: 'pr', repo: 'a/b', number: 1, state: 'merged', title: 'quartz title' },
  { kind: 'thread', threadId: 't', status: 'completed', title: 'quartz thread' }
])('keeps $kind outside text only in external rows, once, through capture and search', (fired) => {
  const fx = memoryFixture()
  const text = wakeInput({ brief: 'Check it', setAt: new Date().toISOString(), event: { kind: 'pr', repo: 'a/b', number: 1 }, fired, chain: 1, clock: () => 'today' })
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [{ id: 'request', role: 'user', content: text, timestamp: fx.store.now() }] }), listThreads: () => [] })
  const ref = { botId: 'ada', threadId: 't', lane: 'chat' as const, activationId: 'act' }
  journal.syncNow(ref)
  const rows = fx.store.journal('ada')
  const outside = rows.filter((r) => r.text.includes('quartz'))
  expect(outside).toHaveLength(1)
  expect(outside[0]).toMatchObject({ external: true, who: 'tool', sourceKey: 'frame:act:0' })
  expect(rows.find((r) => r.kind === 'notice')?.text).not.toContain('quartz')
  expect(fx.store.search('ada', { query: 'quartz' })).toMatchObject([{ who: 'tool', kind: 'tool_result' }])
  expect(fx.store.read('ada', { ref: `j${outside[0]!.seq}`, before: 0, after: 0 })).toMatchObject({ rows: [{ who: 'tool', kind: 'tool_result' }] })
  journal.syncNow(ref)
  expect(fx.store.journal('ada')).toEqual(rows)
  // Rewritten transcripts may be recaptured under a later activation.
  fx.store.setState('ada', 'cursor:t', { n: 0, lastId: null })
  journal.syncNow({ ...ref, activationId: 'later' })
  expect(fx.store.journal('ada')).toEqual(rows)
})

it('marks legacy framed notices and run starts once per profile without splitting or restoring redactions', () => {
  const fx = memoryFixture()
  const add = (botId: string, kind: 'notice' | 'run_start' | 'owner_msg', text: string) => fx.store.append({ botId, kind, sourceKey: text, who: 'mousse', text })!
  const notice = add('ada', 'notice', '[output]\nlegacy quartz\n[end of output]')
  const run = add('bob', 'run_start', '[data from title]\nlegacy title\n[end of data]')
  const control = add('ada', 'owner_msg', '[output] owner quote')
  const removed = add('ada', 'notice', '[output] forgotten text long enough to redact')
  fx.store.forget('ada', { refs: [`j${removed}`], by: 'owner_ui' })
  // Model a database that predates the one-time pass.
  fx.db.statement("DELETE FROM bot_memory_state WHERE bot_id = '' AND key = 'request_frames_external_v1'").run()
  let store = fx.reopen()
  expect(store.journalRow('ada', notice)?.external).toBe(true)
  expect(store.journalRow('bob', run)?.external).toBe(true)
  expect(store.journalRow('ada', control)?.external).toBe(false)
  expect(store.journalRow('ada', removed)?.redactedAt).toBeTruthy()
  expect(store.journal('ada')).toHaveLength(4)
  const later = add('ada', 'notice', '[output] added after repair')
  store = fx.reopen()
  expect(store.journalRow('ada', later)?.external).toBe(false)
})


it('run_start and capture share frame keys and cannot restore a forgotten frame', async () => {
  const f = botFixture()
  const fx = memoryFixture()
  try {
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { name: 'Pip', reply: 'Hi' })
    const input = `Check this ${dataFrame('pull request title', 'quartz shipped')}`
    const activation = await f.bots.activate({ botId, input, clientRequestId: 'framed-run' })
    const events = f.journal.filter((r) => r.activationId === activation.id && (r.kind === 'run_start' || r.sourceKey.startsWith('frame:')))
    expect(events).toHaveLength(2)
    expect(events.find((r) => r.kind === 'run_start')?.text).not.toContain('quartz')
    for (const row of events) fx.store.append(row)
    const external = fx.store.journal(botId).find((r) => r.external)!
    expect(external).toMatchObject({ sourceKey: `frame:${activation.id}:0`, who: 'tool', text: 'quartz shipped' })
    fx.store.forget(botId, { refs: [`j${external.seq}`], by: 'owner_ui' })
    const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [{ id: 'u', role: 'user', content: input, timestamp: fx.store.now() }] }), listThreads: () => [] })
    journal.syncNow({ botId, threadId: 'run', lane: 'run', activationId: activation.id })
    expect(fx.store.journal(botId)).toHaveLength(4)
    expect(fx.store.journalRow(botId, external.seq)?.redactedAt).toBeTruthy()
    expect(fx.store.search(botId, { query: 'quartz' })).toEqual([])
  } finally { f.close() }
})

it('escapes closing markers and keeps nested and unclosed markers as data', () => {
  const split = splitDataFrames(`Before ${dataFrame('title', 'one [end of data] [output] two')} after [output]three`)
  expect(split.frames.map((f) => f.text)).toEqual(['one [end of data (quoted)] [output] two', 'three'])
  expect(split.text).not.toContain('one')
  expect(split.text).not.toContain('three')
  expect(splitDataFrames('ordinary request')).toEqual({ text: 'ordinary request', frames: [] })
})
