import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, runDispatch, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const MIN = 60_000
beforeEach(async () => { f = botFixture(); ({ botId } = await createBot(f)) })
afterEach(() => f.close())

it.each(['yesterday', '2000-01-01', '2026-02-30', '2030-13-01'])('refuses an unreadable or past until: %s', (until) => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check.', until } as never, 'owner')).toThrow(/until|date|past/i)
})

it('runs before its end, never after, leaves About and says once that it ended', async () => {
  // Input is local computer time, not UTC.
  const localEnd = new Date(T0 + 7 * MIN)
  const local = `${localEnd.getFullYear()}-${String(localEnd.getMonth()+1).padStart(2,'0')}-${String(localEnd.getDate()).padStart(2,'0')}T${String(localEnd.getHours()).padStart(2,'0')}:${String(localEnd.getMinutes()).padStart(2,'0')}`
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Inbox check', until: local } as never, 'owner')
  expect(f.book.list(botId)[0]!.label).toContain(' · until ')
  await f.bots.reconcileOnStartup()
  const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
  expect(inserted).toHaveLength(1)
  await runDispatch(f, inserted[0]!, 1, { text: 'Done.' })
  for (const minute of [8, 10, 15]) expect((await f.tickSchedules(new Date(T0 + minute * MIN))).inserted).toEqual([])
  expect(f.book.list(botId)).toEqual([])
  expect(chatOf(f, botId).filter((row) => row.text === '‘Inbox check’ ended, as planned.')).toHaveLength(1)
})

it.each([undefined, 'usage_limit', 'owner'] as const)('says once without a run with pause %s', async (pause) => {
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' } as never, 'owner')
  expect(f.scheduler.getJob(entry.jobId)).toMatchObject({ prompt: 'Say exactly: Take your pills', bot: { say: 'Take your pills' } })
  expect(f.bots.listSchedules(botId)[0]!.label).toBe('Says “Take your pills” · every 60 minutes')
  await f.bots.reconcileOnStartup()
  if (pause) f.store.setPaused(botId, pause as never)
  const before = f.store.listActivations(botId).map((row) => row.id)
  await f.tickSchedules(new Date(T0 + 60 * MIN))
  expect(f.store.listActivations(botId).map((row) => row.id)).toEqual(before)
  const lines = () => chatOf(f, botId).filter((row) => row.text === 'Take your pills')
  expect(lines()).toHaveLength(pause === 'owner' ? 0 : 1)
  f.bots.runScheduledOccurrence({ botId, scheduleId: entry.scheduleId, say: 'Take your pills', prompt: 'Say exactly: Take your pills', occurrenceAt: new Date(T0 + 60 * MIN).toISOString() } as never)
  expect(lines()).toHaveLength(pause === 'owner' ? 0 : 1)
})

it.each(['', 'a'.repeat(501), 'hello\u200bworld'])('refuses empty, long or hidden say text', (say) => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, say } as never, 'owner')).toThrow()
})

it('refuses both prompt and say', () => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check', say: 'Hello' } as never, 'owner')).toThrow(/prompt|say/i)
})

it.each([[10, true], [30, false], [40, false]])('after downtime at %i minutes late, says %s', async (late, said) => {
  const { recordTickerHeartbeat } = await import('../../src/mms/scheduled/ScheduledJobStore')
  const { join } = await import('node:path')
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' } as never, 'owner')
  await f.bots.reconcileOnStartup()
  recordTickerHeartbeat(false, join(f.base, 'mousse-home'), new Date(T0))
  await f.tickSchedules(new Date(T0 + (60 + late) * MIN))
  const messages = chatOf(f, botId).filter((row) => row.text.includes('Take your pills'))
  expect(messages).toHaveLength(said ? 1 : 0)
  if (said) expect(messages[0]!.text).toMatch(/^\(For \d\d:\d\d\) Take your pills$/)
  else expect(f.book.get(botId, entry.scheduleId)!.skip?.reason).toContain('Missed')
})
