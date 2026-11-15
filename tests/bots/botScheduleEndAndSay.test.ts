import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botFixture, chatOf, createBot, runDispatch, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const MIN = 60_000
beforeEach(async () => { f = botFixture(); ({ botId } = await createBot(f)) })
afterEach(() => { vi.restoreAllMocks(); f.close() })

it.each(['yesterday', '2000-01-01', '2026-02-30', '2030-13-01'])('refuses an unreadable or past until: %s', (until) => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check.', until }, 'owner')).toThrow(/until|date|past/i)
})

it('runs before its end, never after, leaves About and says once that it ended', async () => {
  // Input is local computer time, not UTC.
  const localEnd = new Date(T0 + 7 * MIN)
  const local = `${localEnd.getFullYear()}-${String(localEnd.getMonth()+1).padStart(2,'0')}-${String(localEnd.getDate()).padStart(2,'0')}T${String(localEnd.getHours()).padStart(2,'0')}:${String(localEnd.getMinutes()).padStart(2,'0')}`
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Inbox check', until: local }, 'owner')
  expect(f.book.list(botId)[0]!.label).toContain(' · until ')
  await f.bots.reconcileOnStartup()
  const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
  expect(inserted).toHaveLength(1)
  await runDispatch(f, inserted[0]!, 1, { text: 'Done.' })
  for (const minute of [8, 10, 15]) expect((await f.tickSchedules(new Date(T0 + minute * MIN))).inserted).toEqual([])
  expect(f.book.list(botId)).toEqual([])
  const ended = chatOf(f, botId).filter((row) => row.text === '‘Inbox check’ ended, as planned.')
  expect(ended).toHaveLength(1)
  expect(ended[0]!.systemLine).toBe(true)
})

it.each([undefined, 'usage_limit', 'owner'] as const)('says once without a run with pause %s', async (pause) => {
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' }, 'owner')
  expect(f.scheduler.getJob(entry.jobId)).toMatchObject({ prompt: 'Say exactly: Take your pills', bot: { say: 'Take your pills' } })
  expect(f.bots.listSchedules(botId)[0]!.label).toBe('Says “Take your pills” · every 60 minutes')
  await f.bots.reconcileOnStartup()
  if (pause) f.store.setPaused(botId, pause)
  f.problem = { problem: 'all_limited', until: new Date(T0 + 300 * MIN).toISOString() }
  const packs = f.packs.length
  const oneShots = f.oneShot.prompts.length
  const before = f.store.listActivations(botId).map((row) => row.id)
  await f.tickSchedules(new Date(T0 + 60 * MIN))
  expect(f.store.listActivations(botId).map((row) => row.id)).toEqual(before)
  expect(f.packs).toHaveLength(packs)
  expect(f.oneShot.prompts).toHaveLength(oneShots)
  const lines = () => chatOf(f, botId).filter((row) => row.text === 'Take your pills')
  expect(lines()).toHaveLength(pause === 'owner' ? 0 : 1)
  f.bots.runScheduledOccurrence({ botId, scheduleId: entry.scheduleId, say: 'Take your pills', prompt: 'Say exactly: Take your pills', occurrenceAt: new Date(T0 + 60 * MIN).toISOString() })
  expect(lines()).toHaveLength(pause === 'owner' ? 0 : 1)
})

it.each(['', 'a'.repeat(501), 'hello\u200bworld'])('refuses empty, long or hidden say text', (say) => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, say }, 'owner')).toThrow()
})

it('refuses both prompt and say', () => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check', say: 'Hello' }, 'owner')).toThrow(/prompt|say/i)
})

it.each([[10, true], [30, false], [40, false]])('after downtime at %i minutes late, says %s', async (late, said) => {
  const { recordTickerHeartbeat } = await import('../../src/mms/scheduled/ScheduledJobStore')
  const { join } = await import('node:path')
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' }, 'owner')
  await f.bots.reconcileOnStartup()
  recordTickerHeartbeat(false, join(f.base, 'mousse-home'), new Date(T0))
  await f.tickSchedules(new Date(T0 + (60 + late) * MIN))
  const messages = chatOf(f, botId).filter((row) => row.text.includes('Take your pills'))
  expect(messages).toHaveLength(said ? 1 : 0)
  if (said) expect(messages[0]!.text).toMatch(/^\(For \d\d:\d\d\) Take your pills$/)
  else expect(f.book.get(botId, entry.scheduleId)!.skip?.reason).toContain('Missed')
})

it.each([false, true])('projects the wording and end for say=%s', (say) => {
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, ...(say ? { say: 'Take your pills' } : { prompt: 'Inbox check' }), until: '2030-11-21' }, 'owner')
  const detail = f.bots.chat.detail(f.bots.get(botId).published!, T0)
  expect(detail.runs[0]!.label).toBe(`${say ? 'Says “Take your pills” · ' : ''}every 60 minutes · until Thu 21 Nov`)
  expect(entry.label).toBe(detail.runs[0]!.label)
})

it('an unfinished scheduler claim retried after the stale cutoff keeps the first line and time', async () => {
  const { ScheduledJobStore, recordTickerHeartbeat } = await import('../../src/mms/scheduled/ScheduledJobStore')
  const { MousseConfigStore } = await import('../../src/mms/config/MousseConfigStore')
  const { ScheduledJobService } = await import('../../src/mms/scheduled/ScheduledJobService')
  const { join } = await import('node:path')
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' }, 'owner')
  await f.bots.reconcileOnStartup()
  recordTickerHeartbeat(false, join(f.base, 'mousse-home'), new Date(T0))
  const store = new ScheduledJobStore(MousseConfigStore.load(join(f.base, 'mousse-home')))
  const scheduler = new ScheduledJobService({ runIsolated: async () => { throw new Error('no run') } }, store)
  scheduler.setClock(() => new Date(f.clock.now))
  scheduler.setBotRunner({ findOccurrence: (input) => f.bots.findScheduledOccurrence(input), runOccurrence: (input) => f.bots.runScheduledOccurrence(input) })
  vi.spyOn(store, 'finishBotClaim').mockReturnValueOnce(null)
  try {
    f.clock.now = T0 + 70 * MIN
    await scheduler.tickNow()
    const claim = store.getJob(entry.jobId)!.runClaim!
    store.releaseClaim(entry.jobId, claim.token)
    f.clock.now = T0 + 160 * MIN
    await scheduler.tickNow()
    expect(chatOf(f, botId).filter((row) => row.text.includes('Take your pills'))).toHaveLength(1)
    expect(store.getJob(entry.jobId)).toMatchObject({ lastRunAt: new Date(T0 + 60 * MIN).toISOString(), lastStatus: 'ok' })
    expect(store.getJob(entry.jobId)!.botSkip).toBeUndefined()
    expect(f.store.listActivations(botId).filter((row) => row.lane === 'run')).toEqual([])
  } finally { scheduler.beginShutdown() }
})

it('a failed message transaction leaves no occurrence record and can be retried', async () => {
  const entry = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, say: 'Take your pills' }, 'owner')
  await f.bots.reconcileOnStartup()
  const occurrenceAt = new Date(T0 + 60 * MIN).toISOString()
  const input = { botId, scheduleId: entry.scheduleId, prompt: 'Say exactly: Take your pills', say: 'Take your pills', occurrenceAt }
  f.journalFails.append = true
  expect(() => f.bots.runScheduledOccurrence(input)).toThrow()
  expect(f.bots.findScheduledOccurrence({ botId, scheduleId: entry.scheduleId, occurrenceKey: occurrenceAt })).toBeUndefined()
  expect(chatOf(f, botId).filter((row) => row.text === 'Take your pills')).toEqual([])
  f.journalFails.append = false
  expect(f.bots.runScheduledOccurrence(input).kind).toBe('said')
  expect(chatOf(f, botId).filter((row) => row.text === 'Take your pills')).toHaveLength(1)
})
