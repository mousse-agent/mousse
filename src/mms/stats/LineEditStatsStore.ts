import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  buildLineEditSnapshot,
  mergeDayRecord,
  toDateKey,
  type LineEditSource,
  type LineEditStatsSnapshot
} from '../../shared/lineEditStats'
import { getMousseHomeDir } from '../data/paths'

interface LineEditStatsFile {
  days: Record<string, { orchestrator: number; manual: number }>
}

export class LineEditStatsStore extends EventEmitter {
  private days: Record<string, { orchestrator: number; manual: number }> = {}
  private readonly path: string

  constructor() {
    super()
    this.path = join(getMousseHomeDir(), 'line-edits.json')
    this.days = this.load()
  }

  record(source: LineEditSource, lines: number, at: Date = new Date()): LineEditStatsSnapshot {
    if (lines <= 0) return this.getSnapshot(at)
    this.days = mergeDayRecord(this.days, toDateKey(at), source, lines)
    this.persist()
    const snapshot = this.getSnapshot(at)
    this.emit('updated', snapshot)
    return snapshot
  }

  getSnapshot(referenceDate: Date = new Date()): LineEditStatsSnapshot {
    return buildLineEditSnapshot(this.days, referenceDate)
  }

  private load(): LineEditStatsFile['days'] {
    try {
      if (!existsSync(this.path)) return {}
      const raw = readFileSync(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as LineEditStatsFile
      return parsed.days ?? {}
    } catch (err) {
      console.error('[LineEditStatsStore] Failed to load stats, starting fresh:', err)
      return {}
    }
  }

  private persist(): void {
    try {
      const dir = getMousseHomeDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload: LineEditStatsFile = { days: this.days }
      writeFileSync(this.path, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (err) {
      console.error('[LineEditStatsStore] Failed to persist stats:', err)
    }
  }
}
