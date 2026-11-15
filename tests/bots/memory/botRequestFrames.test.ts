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
  expect(fx.store.search('ada', { query: 'quartz' })).toMatchObject([{ external: true, who: 'tool' }])
  expect(fx.store.read('ada', { ref: `j${outside[0]!.seq}`, before: 0, after: 0 })).toMatchObject({ rows: [{ external: true, who: 'tool' }] })
  journal.syncNow(ref)
  expect(fx.store.journal('ada')).toEqual(rows)
})
