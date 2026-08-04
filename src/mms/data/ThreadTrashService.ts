import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { atomicWriteJsonSync } from './AtomicFs'
import { getMousseHomeDir } from './paths'

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
  constructor(home = getMousseHomeDir()) {
    this.root = join(home, 'trash', 'threads')
    this.indexPath = join(this.root, 'index.json')
  }

  list(): ThreadTrashRecord[] {
    return existsSync(this.indexPath) ? JSON.parse(readFileSync(this.indexPath, 'utf8')) as ThreadTrashRecord[] : []
  }

  trash(threadId: string, originalPath: string): ThreadTrashRecord {
    const existing = this.list().find((record) => record.threadId === threadId && !record.restoredAt && !record.purgedAt)
    if (existing) return existing
    if (!existsSync(originalPath)) throw new Error(`Thread directory is missing: ${originalPath}`)
    mkdirSync(this.root, { recursive: true })
    const trashPath = join(this.root, `${threadId}-${Date.now()}-${basename(originalPath)}`)
    const record: ThreadTrashRecord = { threadId, originalPath, trashPath, tombstonedAt: new Date().toISOString() }
    atomicWriteJsonSync(join(originalPath, 'tombstone.json'), record)
    renameSync(originalPath, trashPath)
    const records = this.list(); records.push(record); atomicWriteJsonSync(this.indexPath, records)
    return record
  }

  restore(threadId: string): ThreadTrashRecord {
    const records = this.list(); const record = [...records].reverse().find((item) => item.threadId === threadId && !item.restoredAt && !item.purgedAt)
    if (!record) throw new Error(`Thread is not in trash: ${threadId}`)
    if (existsSync(record.originalPath)) throw new Error('Original thread path is already occupied.')
    mkdirSync(dirname(record.originalPath), { recursive: true })
    renameSync(record.trashPath, record.originalPath)
    record.restoredAt = new Date().toISOString(); atomicWriteJsonSync(this.indexPath, records)
    return record
  }

  purge(threadId: string): ThreadTrashRecord {
    const records = this.list(); const record = [...records].reverse().find((item) => item.threadId === threadId && !item.restoredAt && !item.purgedAt)
    if (!record) throw new Error(`Thread is not in trash: ${threadId}`)
    rmSync(record.trashPath, { recursive: true, force: true })
    record.purgedAt = new Date().toISOString(); atomicWriteJsonSync(this.indexPath, records)
    return record
  }
}
