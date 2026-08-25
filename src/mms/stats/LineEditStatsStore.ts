import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  buildLineEditSnapshot,
  mergeDayRecord,
  toDateKey,
  type LineEditSource,
  type LineEditStatsSnapshot,
  type TurnUsageRecord,
  type UsageStatsSnapshot,
  buildUsageStatsSnapshot
} from '../../shared/lineEditStats'
import { getMousseHomeDir } from '../data/paths'

interface LineEditStatsFile {
  days: Record<string, { orchestrator: number; manual: number }>
  turns?: TurnUsageRecord[]
}

export class LineEditStatsStore extends EventEmitter {
  private days: Record<string, { orchestrator: number; manual: number }> = {}
  private readonly path: string
  private turns: TurnUsageRecord[] = []

  constructor() {
    super()
    this.path = join(getMousseHomeDir(), 'line-edits.json')
    const loaded = this.load()
    this.days = loaded.days
    this.turns = loaded.turns
  }

  record(source: LineEditSource, lines: number, at: Date = new Date()): LineEditStatsSnapshot {
    if (lines <= 0) return this.getSnapshot(at)
    // GUI and daemon may both contribute to this legacy combined store. Rebase on
    // disk before each write so one process never erases the other's telemetry.
    const latest = this.load()
    this.days = mergeDayRecord(latest.days, toDateKey(at), source, lines)
    this.turns = latest.turns
    this.persist()
    const snapshot = this.getSnapshot(at)
    this.emit('updated', snapshot)
    return snapshot
  }

  getSnapshot(referenceDate: Date = new Date()): LineEditStatsSnapshot {
    return buildLineEditSnapshot(this.days, referenceDate)
  }

  recordUsage(record: TurnUsageRecord): UsageStatsSnapshot {
    const nonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
    const latest = this.load()
    this.days = latest.days
    this.turns = [...latest.turns, {
      ...record,
      input: nonNegative(record.input), output: nonNegative(record.output),
      cacheRead: nonNegative(record.cacheRead), cacheWrite: nonNegative(record.cacheWrite)
    }]
    this.persist()
    const snapshot = this.getUsageSnapshot()
    this.emit('usage-updated', snapshot)
    return snapshot
  }

  getUsageSnapshot(): UsageStatsSnapshot {
    return buildUsageStatsSnapshot(this.turns.map((turn) => ({ ...turn })))
  }

  private load(): { days: LineEditStatsFile['days']; turns: TurnUsageRecord[] } {
    try {
      if (!existsSync(this.path)) return { days: {}, turns: [] }
      const raw = readFileSync(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as LineEditStatsFile
      return { days: parsed.days ?? {}, turns: Array.isArray(parsed.turns) ? parsed.turns : [] }
    } catch (err) {
      console.error('[LineEditStatsStore] Failed to load stats, starting fresh:', err)
      return { days: {}, turns: [] }
    }
  }

  private persist(): void {
    try {
      const dir = getMousseHomeDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload: LineEditStatsFile = { days: this.days, turns: this.turns }
      writeFileSync(this.path, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (err) {
      console.error('[LineEditStatsStore] Failed to persist stats:', err)
    }
  }
}
