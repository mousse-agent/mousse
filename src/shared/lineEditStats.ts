export type LineEditSource = 'orchestrator' | 'manual'
export type LineEditFilter = 'all' | 'tab' | 'agent'

export interface LineEditDayRecord {
  orchestrator: number
  manual: number
}

export interface LineEditStatsSnapshot {
  days: Record<string, LineEditDayRecord>
  total: number
  totalTab: number
  totalAgent: number
  mostActiveMonth: string | null
  mostActiveDay: { date: string; label: string } | null
  longestStreak: number
  currentStreak: number
}

export interface HeatmapCell {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface HeatmapWeek {
  days: (HeatmapCell | null)[]
  monthLabel?: string
}

export function countLineEdits(before: string, after: string): number {
  const a = before.split('\n')
  const b = after.split('\n')
  const minLen = Math.min(a.length, b.length)
  let changed = Math.abs(a.length - b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) changed++
  }
  return changed
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getCountForDay(record: LineEditDayRecord | undefined, filter: LineEditFilter): number {
  if (!record) return 0
  if (filter === 'tab') return record.orchestrator
  if (filter === 'agent') return record.manual
  return record.orchestrator + record.manual
}

function emptyDayRecord(): LineEditDayRecord {
  return { orchestrator: 0, manual: 0 }
}

function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year!, month! - 1, day)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfWeekSunday(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  return start
}

function computeStreaks(
  activeDates: Set<string>,
  referenceDate: Date
): { longest: number; current: number } {
  if (activeDates.size === 0) return { longest: 0, current: 0 }

  const sorted = [...activeDates].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]!)
    const curr = new Date(sorted[i]!)
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86_400_000)
    if (diffDays === 1) {
      run++
      longest = Math.max(longest, run)
    } else if (diffDays > 1) {
      run = 1
    }
  }

  let current = 0
  let cursor = new Date(referenceDate)
  cursor.setHours(0, 0, 0, 0)
  while (activeDates.has(toDateKey(cursor))) {
    current++
    cursor = addDays(cursor, -1)
  }

  return { longest, current }
}

export function buildLineEditSnapshot(
  days: Record<string, LineEditDayRecord>,
  referenceDate: Date = new Date()
): LineEditStatsSnapshot {
  let total = 0
  let totalTab = 0
  let totalAgent = 0

  const monthTotals = new Map<string, number>()
  let bestDay: { date: string; count: number } | null = null
  const activeDates = new Set<string>()

  for (const [date, record] of Object.entries(days)) {
    const dayTotal = record.orchestrator + record.manual
    if (dayTotal <= 0) continue

    total += dayTotal
    totalTab += record.orchestrator
    totalAgent += record.manual
    activeDates.add(date)

    const monthKey = date.slice(0, 7)
    monthTotals.set(monthKey, (monthTotals.get(monthKey) ?? 0) + dayTotal)

    if (!bestDay || dayTotal > bestDay.count) {
      bestDay = { date, count: dayTotal }
    }
  }

  let mostActiveMonth: string | null = null
  let bestMonthTotal = 0
  for (const [monthKey, count] of monthTotals.entries()) {
    if (count > bestMonthTotal) {
      bestMonthTotal = count
      const [year, month] = monthKey.split('-').map(Number)
      mostActiveMonth = new Date(year!, month! - 1, 1).toLocaleDateString(undefined, {
        month: 'long'
      })
    }
  }

  const { longest, current } = computeStreaks(activeDates, referenceDate)

  return {
    days,
    total,
    totalTab,
    totalAgent,
    mostActiveMonth,
    mostActiveDay: bestDay ? { date: bestDay.date, label: formatDayLabel(bestDay.date) } : null,
    longestStreak: longest,
    currentStreak: current
  }
}

function levelForCount(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

export function buildHeatmapGrid(
  days: Record<string, LineEditDayRecord>,
  filter: LineEditFilter,
  referenceDate: Date = new Date(),
  weekCount = 53
): { weeks: HeatmapWeek[]; maxCount: number } {
  const end = new Date(referenceDate)
  end.setHours(0, 0, 0, 0)
  const gridEnd = startOfWeekSunday(end)
  gridEnd.setDate(gridEnd.getDate() + 6)

  const start = addDays(gridEnd, -(weekCount * 7 - 1))
  const alignedStart = startOfWeekSunday(start)

  let maxCount = 0
  const counts = new Map<string, number>()
  for (let cursor = new Date(alignedStart); cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const key = toDateKey(cursor)
    const count = getCountForDay(days[key], filter)
    counts.set(key, count)
    if (count > maxCount) maxCount = count
  }

  const weeks: HeatmapWeek[] = []
  let cursor = new Date(alignedStart)
  let lastMonth = -1

  while (cursor <= gridEnd) {
    const week: HeatmapWeek = { days: [] }
    for (let row = 0; row < 7; row++) {
      if (cursor > gridEnd) {
        week.days.push(null)
        cursor = addDays(cursor, 1)
        continue
      }

      const dateKey = toDateKey(cursor)
      const count = counts.get(dateKey) ?? 0
      week.days.push({
        date: dateKey,
        count,
        level: levelForCount(count, maxCount)
      })

      if (row === 0) {
        const month = cursor.getMonth()
        if (month !== lastMonth) {
          week.monthLabel = cursor.toLocaleDateString(undefined, { month: 'short' }).slice(0, 1)
          lastMonth = month
        }
      }

      cursor = addDays(cursor, 1)
    }
    weeks.push(week)
  }

  return { weeks, maxCount }
}

export function mergeDayRecord(
  days: Record<string, LineEditDayRecord>,
  dateKey: string,
  source: LineEditSource,
  lines: number
): Record<string, LineEditDayRecord> {
  if (lines <= 0) return days
  const existing = days[dateKey] ?? emptyDayRecord()
  return {
    ...days,
    [dateKey]: {
      ...existing,
      [source === 'orchestrator' ? 'orchestrator' : 'manual']: existing[source] + lines
    }
  }
}
