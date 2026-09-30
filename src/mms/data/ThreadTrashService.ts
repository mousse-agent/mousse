import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMousseHomeDir } from './paths'
import { assertOwnedPath } from '../profiles/pathSafety'

export interface ThreadTrashRecord {
  threadId: string
  originalPath: string
  trashPath: string
  tombstonedAt: string
  restoredAt?: string
  purgedAt?: string
}

export interface LegacyTrashDiagnostic {
  threadId?: string
  reason: string
}

export class ThreadTrashService {
  private readonly root: string
  private readonly indexPath: string
  constructor(private readonly home = getMousseHomeDir(), private readonly options: { strictOwnedRoot?: boolean } = {}) {
    this.root = join(home, 'trash', 'threads')
    this.indexPath = join(this.root, 'index.json')
  }

  private validateRecord(record: ThreadTrashRecord): void {
    assertOwnedPath(this.home, this.root, 'trash root')
    assertOwnedPath(this.root, record.trashPath, 'trash path')
    if (this.options.strictOwnedRoot) {
      assertOwnedPath(join(this.home, 'thread-data'), record.originalPath, 'original thread path')
    }
  }

  list(): ThreadTrashRecord[] {
    const records = existsSync(this.indexPath) ? JSON.parse(readFileSync(this.indexPath, 'utf8')) as ThreadTrashRecord[] : []
    for (const record of records) this.validateRecord(record)
    return records
  }

  /** Read legacy authority without letting one malformed row hide other trash. */
  inspectLegacy(): { records: ThreadTrashRecord[]; diagnostics: LegacyTrashDiagnostic[] } {
    const records: ThreadTrashRecord[] = [], diagnostics: LegacyTrashDiagnostic[] = []
    if (!existsSync(this.indexPath)) return { records, diagnostics }
    let rows: unknown
    try {
      assertOwnedPath(this.home, this.indexPath, 'legacy trash index')
      rows = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (!Array.isArray(rows)) throw new Error('Legacy trash index must be an array')
    } catch (error) {
      return { records, diagnostics: [{ reason: (error as Error).message }] }
    }
    for (const row of rows as unknown[]) {
      const value = row && typeof row === 'object' ? row as Partial<ThreadTrashRecord> : undefined
      const threadId = typeof value?.threadId === 'string' ? value.threadId : undefined
      try {
        if (!threadId || !/^[a-zA-Z0-9_-]{1,256}$/.test(threadId) ||
            typeof value?.originalPath !== 'string' || typeof value.trashPath !== 'string' ||
            typeof value.tombstonedAt !== 'string' || !Number.isFinite(Date.parse(value.tombstonedAt))) {
          throw new Error('Invalid legacy trash ownership record')
        }
        if (value.restoredAt || value.purgedAt) continue
        const record = value as ThreadTrashRecord
        this.validateRecord(record)
        records.push(record)
      } catch (error) { diagnostics.push({ threadId, reason: (error as Error).message }) }
    }
    return { records, diagnostics }
  }

  trash(_threadId: string, _originalPath: string): never {
    throw new Error('Thread trash requires the lifecycle coordinator')
  }

  restore(_threadId: string): never {
    throw new Error('Thread restore requires the lifecycle coordinator')
  }

  purge(_threadId: string): never {
    throw new Error('Permanent purge is unavailable in lifecycle Phase 1')
  }
}
