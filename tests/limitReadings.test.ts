import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LimitReadingStore } from '../src/mms/usageHistory/limitReadings'
import { LIMIT_POLL_EVERY_MS, LimitPoller } from '../src/mms/usageHistory/limitPoller'
import { keepUsage } from '../src/mms/protocol/usageReads'
import type { ProviderUsage, ProviderUsageWindow } from '../src/shared/providerAuth'

/**
 * The 5-hour and weekly limit readings Mousse keeps for their trends: each new reading kept, the same one at most
 * every 15 minutes, a month of them, with resets found from the readings; and the background read every 15 minutes.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-19T12:00:00Z')
let dir: string
let now: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'limit-readings-'))
  now = T0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = () => join(dir, 'cache', 'usage-limit-readings.jsonl')
const store = () => new LimitReadingStore(file(), () => now)
const lines = () => readFileSync(file(), 'utf8').split('\n').filter(Boolean)
const window = (id: string, used: number, resetsAt?: number): ProviderUsageWindow => ({ id, label: id, remainingPercent: 100 - used, ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString() } : {}) })
const usage = (windows: ProviderUsageWindow[], patch: Partial<ProviderUsage> = {}): ProviderUsage => ({ id: 'claude', label: 'Claude', status: 'available', windows, ...patch })

describe('keeping limit readings', () => {
  it('keeps a new reading at once, the same one at most every 15 minutes, and reads them back after a restart', async () => {
    const readings = store()
    await readings.record(usage([window('five_hour', 20, T0 + HOUR), window('seven_day', 40, T0 + 3 * DAY)]))
    now += 5 * MINUTE
    await readings.record(usage([window('five_hour', 20, T0 + HOUR), window('seven_day', 40, T0 + 3 * DAY)]))
    expect(lines()).toHaveLength(1)
    now += 5 * MINUTE
    await readings.record(usage([window('five_hour', 25, T0 + HOUR), window('seven_day', 40, T0 + 3 * DAY)]))
    expect(lines()).toHaveLength(2)
    now += 16 * MINUTE
    await readings.record(usage([window('five_hour', 25, T0 + HOUR), window('seven_day', 40, T0 + 3 * DAY)]))
    expect(lines()).toHaveLength(3)
    // A provider without a 5-hour or weekly limit keeps nothing.
    await readings.record(usage([window('monthly', 10)], { id: 'other' }))
    expect(lines()).toHaveLength(3)

    const [trend] = await store().trends('24h')
    expect(trend!.windows.find((entry) => entry.id === 'five_hour')!.points).toEqual([[T0, 20], [T0 + 10 * MINUTE, 25], [T0 + 26 * MINUTE, 25]])
  })

  it('keeps each sign-in of a provider that reads several on its own, not those still loading', async () => {
    const readings = store()
    await readings.record(usage([], { accounts: [
      { id: 'work', label: 'work@', windows: [window('five_hour', 30)] },
      { id: 'home', label: 'home@', windows: [], pending: true }
    ] }))
    expect((await readings.trends('24h')).map((trend) => [trend.id, trend.label])).toEqual([['claude#work', 'Claude · work@']])
    expect(await readings.lastReadAt('claude')).toBe(T0)
    expect(await readings.lastReadAt('claud')).toBeUndefined()
  })

  it('keeps each scoped limit (an Antigravity model group) as its own trend, named by its group', async () => {
    const readings = store()
    const scoped = (id: string, label: string, used: number): ProviderUsageWindow => ({ ...window(id, used), label })
    await readings.record(usage([
      scoped('gemini-models:5h', 'Gemini Models · 5-hour limit', 13),
      scoped('gemini-models:weekly', 'Gemini Models · Weekly limit', 40),
      scoped('claude-and-gpt-models:5h', 'Claude and GPT models · 5-hour limit', 0)
    ], { id: 'antigravity', label: 'Antigravity' }))
    const trends = await readings.trends('24h')
    expect(trends.map((trend) => [trend.id, trend.label, trend.windows.map((entry) => [entry.id, entry.points.at(-1)![1]])])).toEqual([
      ['antigravity#claude-and-gpt-models', 'Antigravity · Claude and GPT models', [['five_hour', 0]]],
      ['antigravity#gemini-models', 'Antigravity · Gemini Models', [['five_hour', 13], ['seven_day', 40]]]
    ])
    expect(await readings.lastReadAt('antigravity')).toBe(T0)
  })

  it('keeps a month, leaving older and unreadable lines out of the file', async () => {
    mkdirSync(join(dir, 'cache'), { recursive: true })
    const line = (t: number) => JSON.stringify({ t, p: 'claude', l: 'Claude', w: { seven_day: [50, null] } })
    writeFileSync(file(), `${line(T0 - 32 * DAY)}\nnot json\n${line(T0 - 2 * DAY)}\n`)
    const [trend] = await store().trends('30d')
    expect(trend!.windows[0]!.points).toEqual([[T0 - 2 * DAY, 50]])
    expect(lines()).toEqual([line(T0 - 2 * DAY)])
  })
})

describe('a limit over time', () => {
  // Rows: how the readings show a reset, and where the line drops to none.
  it('drops at the reset time the provider gave, once a later reading carries the next one', async () => {
    const readings = store()
    now = T0 - 3 * DAY
    await readings.record(usage([window('seven_day', 70, T0 - DAY)]))
    now = T0
    await readings.record(usage([window('seven_day', 10, T0 + 6 * DAY)]))
    const [trend] = await readings.trends('7d')
    expect(trend!.windows[0]).toEqual({ id: 'seven_day', label: 'Weekly', points: [[T0 - 3 * DAY, 70], [T0 - DAY, 0], [T0, 10]], resets: [T0 - DAY], nextReset: T0 + 6 * DAY })
  })

  it('a fall in use without a new reset time is no reset: the line falls, with no mark', async () => {
    const readings = store()
    now = T0 - HOUR
    await readings.record(usage([window('rolling', 80)]))
    now = T0
    await readings.record(usage([window('rolling', 5)]))
    const [trend] = await readings.trends('24h')
    expect(trend!.windows[0]).toMatchObject({ id: 'five_hour', points: [[T0 - HOUR, 80], [T0, 5]], resets: [] })
  })

  it('a reset due since the last reading is not drawn until a reading shows it, and the range starts where the line stood', async () => {
    const readings = store()
    now = T0 - 2 * DAY
    await readings.record(usage([window('five_hour', 60, T0 + HOUR)]))
    now = T0 + 3 * HOUR
    const [trend] = await readings.trends('24h')
    const from = now - DAY
    expect(trend!.windows[0]).toMatchObject({ points: [[from, 60]], resets: [] })
    expect(trend!.windows[0]!.nextReset).toBeUndefined()
  })

  it('only the windows the provider reports now: one it stopped reporting has no line', async () => {
    const readings = store()
    now = T0 - HOUR
    await readings.record(usage([window('five_hour', 40, T0 + HOUR), window('seven_day', 20, T0 + DAY)]))
    now = T0
    await readings.record(usage([window('seven_day', 21, T0 + DAY)]))
    const [trend] = await readings.trends('24h')
    expect(trend!.windows.map((entry) => entry.id)).toEqual(['seven_day'])
  })
})

describe('the background read', () => {
  const slots = [
    { id: 'due', label: 'Due', authType: 'oauth' as const },
    { id: 'later', label: 'Also due' },
    { id: 'key', label: 'Key', authType: 'api_key' as const },
    { id: 'recent', label: 'Recent' },
    { id: 'page', label: 'Read by the page' },
    { id: 'out', label: 'Signed out', signedOut: true as const },
    { id: 'never', label: 'Never read' },
    { id: 'asked', label: 'Read only when asked', onRequestOnly: true as const }
  ]
  const services = () => ({
    getProfileHomeDir: () => dir,
    providerInstances: { isDisabled: () => false },
    claudeSubscription: { configured: () => false },
    providerAccess: { usageSlots: () => slots }
  })

  it('reads, one at a time, only providers with a limit kept this month and not read in the last 15 minutes', async () => {
    const at = Date.now()
    mkdirSync(join(dir, 'cache'), { recursive: true })
    const line = (p: string, ago: number) => JSON.stringify({ t: at - ago, p, l: p, w: { five_hour: [10, null] } })
    writeFileSync(file(), [line('due', 20 * MINUTE), line('later', 30 * MINUTE), line('key', 20 * MINUTE), line('recent', 5 * MINUTE), line('page', HOUR), line('out', HOUR), line('asked#pool', HOUR)].join('\n'))
    const mms = services()
    // The page read this one a minute ago (its reading said nothing new, so the file has the older one).
    keepUsage(mms, usage([window('five_hour', 10)], { id: 'page' }), at - MINUTE)
    let reading = 0
    const order: string[] = []
    const read = vi.fn(async (_mms: unknown, id: string) => {
      reading++
      expect(reading).toBe(1)
      order.push(id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      reading--
    })
    await new LimitPoller(mms as never, read, () => at).tick()
    expect(order).toEqual(['due', 'later'])
  })

  it('first reads a full 15 minutes after start, then every 15 minutes until stopped', async () => {
    vi.useFakeTimers()
    try {
      const poller = new LimitPoller(services() as never, vi.fn())
      const tick = vi.spyOn(poller, 'tick').mockResolvedValue()
      poller.start()
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_EVERY_MS - 1)
      expect(tick).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(tick).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(LIMIT_POLL_EVERY_MS)
      expect(tick).toHaveBeenCalledTimes(2)
      poller.stop()
      await vi.advanceTimersByTimeAsync(3 * LIMIT_POLL_EVERY_MS)
      expect(tick).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
