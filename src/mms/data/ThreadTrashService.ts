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
