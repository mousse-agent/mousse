import { appendFile, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { ProviderUsage, ProviderUsageWindow } from '../../shared/providerAuth'
import { LIMIT_TREND_SPAN_MS, LIMIT_WINDOW_MS, type LimitTrend, type LimitTrendRange, type LimitTrendWindow, type LimitTrendWindowId } from '../../shared/limitTrends'

/** How long readings are kept: the longest range shown, and a day more for the window running at its start. */
export const LIMIT_READINGS_KEEP_MS = 31 * 86_400_000
/** A reading that says the same as the last one is kept only once this long has passed since it. */
export const LIMIT_READING_STEP_MS = 15 * 60_000
/** A use of the window that falls by this many points without a new reset time is read as a reset. */
const RESET_DROP = 10

const WINDOWS: ReadonlyArray<[LimitTrendWindowId, string, readonly string[]]> = [
  ['five_hour', '5-hour', ['five_hour', 'rolling']],
  ['seven_day', 'Weekly', ['seven_day', 'weekly']]
]

/** [share used in %, when the window resets in ms or null when the provider does not say]. */
type WindowReading = [number, number | null]
interface Reading { t: number; p: string; l: string; w: Partial<Record<LimitTrendWindowId, WindowReading>> }

function windowsOf(windows: readonly ProviderUsageWindow[]): Reading['w'] {
  const out: Reading['w'] = {}
  for (const [id, , ids] of WINDOWS) {
    const window = windows.find((entry) => ids.includes(entry.id))
    if (!window || !Number.isFinite(window.remainingPercent)) continue
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    out[id] = [Math.round(Math.min(100, Math.max(0, 100 - window.remainingPercent)) * 10) / 10, Number.isFinite(resetsAt) ? resetsAt : null]
  }
  return out
}

const sameWindows = (a: Reading['w'], b: Reading['w']) => JSON.stringify(a) === JSON.stringify(b)

function parse(line: string): Reading | null {
  try {
    const value = JSON.parse(line) as Reading
    return typeof value?.t === 'number' && typeof value.p === 'string' && typeof value.l === 'string' && value.w && typeof value.w === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * The 5-hour and weekly limit readings Mousse made, one line each in a small file of the profile's cache, kept
 * for a month. A reading that says nothing new is kept at most every 15 minutes, so the file stays a few
 * hundred kilobytes. Read on first use, never at start.
 */
export class LimitReadingStore {
  private readings: Reading[] | null = null
  private loading: Promise<Reading[]> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path: string, private readonly clock: () => number = Date.now) {}

  /** Keeps a provider's fresh reading, and each of its sign-ins' when it reads several. */
  async record(usage: ProviderUsage): Promise<void> {
    const at = this.clock()
    const entries: Reading[] = []
    const own = windowsOf(usage.windows)
    if (Object.keys(own).length) entries.push({ t: at, p: usage.id, l: usage.label, w: own })
    for (const account of usage.accounts ?? []) {
      if (account.pending) continue
      const windows = windowsOf(account.windows)
      if (Object.keys(windows).length) entries.push({ t: at, p: `${usage.id}#${account.id}`, l: `${usage.label} · ${account.label}`, w: windows })
    }
    if (!entries.length) return
    const readings = await this.load()
    const fresh = entries.filter((entry) => {
      const last = this.last(entry.p)
      return !last || !sameWindows(last.w, entry.w) || entry.t - last.t >= LIMIT_READING_STEP_MS
    })
    if (!fresh.length) return
    readings.push(...fresh)
    await this.write(() => appendFile(this.path, fresh.map((entry) => `${JSON.stringify(entry)}\n`).join('')))
  }

  /** When the provider, or any of its sign-ins, was last read, in ms; undefined when it never was this month. */
  async lastReadAt(id: string): Promise<number | undefined> {
    const readings = await this.load()
    for (let i = readings.length - 1; i >= 0; i--) {
      const p = readings[i]!.p
      if (p === id || p.startsWith(`${id}#`)) return readings[i]!.t
    }
    return undefined
  }

  /** Each provider's trends across the range: those read in it, or in the last week (its weekly window still counts). */
  async trends(range: LimitTrendRange): Promise<LimitTrend[]> {
    const now = this.clock()
    const from = now - LIMIT_TREND_SPAN_MS[range]
    const readings = await this.load()
    const byProvider = new Map<string, Reading[]>()
    for (const reading of readings) {
      const list = byProvider.get(reading.p) ?? []
      list.push(reading)
      byProvider.set(reading.p, list)
    }
    const trends: LimitTrend[] = []
    for (const [id, list] of byProvider) {
      if (list[list.length - 1]!.t < Math.min(from, now - LIMIT_WINDOW_MS.seven_day)) continue
      const windows = WINDOWS.map(([windowId, label]) => trendWindow(windowId, label, list, from, now)).filter((window): window is LimitTrendWindow => !!window)
      if (windows.length) trends.push({ id, label: list[list.length - 1]!.l, windows })
    }
    return trends.sort((a, b) => a.label.localeCompare(b.label))
  }

  private last(id: string): Reading | undefined {
    const readings = this.readings ?? []
    for (let i = readings.length - 1; i >= 0; i--) if (readings[i]!.p === id) return readings[i]
    return undefined
  }

  private load(): Promise<Reading[]> {
    if (this.readings) return Promise.resolve(this.readings)
    this.loading ??= (async () => {
      const text = await readFile(this.path, 'utf8').catch(() => '')
      const lines = text.split('\n').filter(Boolean)
      const cutoff = this.clock() - LIMIT_READINGS_KEEP_MS
      const readings = lines.map(parse).filter((reading): reading is Reading => !!reading && reading.t >= cutoff).sort((a, b) => a.t - b.t)
      // Readings past the month, or lines that could not be read, are left out of a rewritten file.
      if (readings.length !== lines.length) {
        await this.write(async () => {
          const temp = `${this.path}.${process.pid}.tmp`
          await writeFile(temp, readings.map((reading) => `${JSON.stringify(reading)}\n`).join(''))
          await rename(temp, this.path)
        })
      }
      this.readings = readings
      return readings
    })()
    return this.loading
  }

  /** One write at a time, in order; a failed one is dropped (a missing reading only thins the line). */
  private write(run: () => Promise<unknown>): Promise<void> {
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await run()
    }).catch(() => undefined)
    return this.writes
  }
}

/** One window's line across the range, with its resets, from a provider's readings oldest first. */
function trendWindow(id: LimitTrendWindowId, label: string, readings: readonly Reading[], from: number, now: number): LimitTrendWindow | null {
  const points: Array<[number, number]> = []
  const resets: number[] = []
  let before: WindowReading | undefined
  let beforeAt = 0
  // The last reading before the range, so the line starts where it stood.
  let lead: [number, number] | undefined
  for (const reading of readings) {
    const window = reading.w[id]
    if (!window) continue
    if (before) {
      const [used, resetsAt] = window
      const [usedBefore, resetBefore] = before
      // The window reset in between: at the time it was due to, or, without one, just before this reading. From
      // then until this reading nothing of it was used.
      let reset: number | undefined
      if (resetBefore !== null && resetsAt !== null && resetsAt - resetBefore > 60_000 && resetBefore <= reading.t) reset = resetBefore
      else if (usedBefore - used >= RESET_DROP && (resetBefore === null || resetsAt === null)) reset = Math.max(beforeAt, reading.t - 60_000)
      if (reset !== undefined) {
        resets.push(reset)
        if (reset >= from) points.push([reset, 0])
      }
    }
    before = window
    beforeAt = reading.t
    if (reading.t < from) lead = [from, window[0]]
    else points.push([reading.t, window[0]])
  }
  if (!points.length && !lead) return null
  if (lead && (!points.length || points[0]![0] > from)) points.unshift(lead)
  const due = before?.[1] ?? undefined
  // A reset due since the last reading (Mousse was not running, or nothing read it): the line drops there.
  if (due !== undefined && due > beforeAt && due <= now) {
    resets.push(due)
    if (due >= from) points.push([due, 0])
  }
  const nextReset = due
  return {
    id,
    label,
    points,
    resets: resets.filter((at) => at >= from && at <= now),
    ...(nextReset !== undefined && nextReset > now ? { nextReset } : {})
  }
}

const stores = new Map<string, LimitReadingStore>()

/** The profile's limit readings, kept in its cache folder. */
export function limitReadings(homeDir: string): LimitReadingStore {
  const path = join(homeDir, 'cache', 'usage-limit-readings.jsonl')
  let store = stores.get(path)
  if (!store) { store = new LimitReadingStore(path); stores.set(path, store) }
  return store
}
