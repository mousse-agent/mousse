import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from './AtomicFs'
import { getMousseHomeDir } from './paths'
import { joinOwnedPath } from '../profiles/pathSafety'

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

  private assertOwnedPath(root: string, candidate: string): void {
    const segments = relative(resolve(root), resolve(candidate))
    if (!segments || isAbsolute(segments) || segments.split(/[/\\]/).includes('..')) throw new Error('Trash path escapes its owner')
    joinOwnedPath(root, ...segments.split(/[/\\]/))
  }

  private validateRecord(record: ThreadTrashRecord): void {
    this.assertOwnedPath(this.home, this.root)
    this.assertOwnedPath(this.root, record.trashPath)
    if (this.options.strictOwnedRoot) this.assertOwnedPath(join(this.home, 'thread-data'), record.originalPath)
  }

  list(): ThreadTrashRecord[] {
    return existsSync(this.indexPath) ? JSON.parse(readFileSync(this.indexPath, 'utf8')) as ThreadTrashRecord[] : []
  }

  trash(threadId: string, originalPath: string): ThreadTrashRecord {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(threadId)) throw new Error('Invalid trash thread identity')
    const existing = this.list().find((record) => record.threadId === threadId && !record.restoredAt && !record.purgedAt)
    if (existing) return existing
    if (!existsSync(originalPath)) throw new Error(`Thread directory is missing: ${originalPath}`)
    const trashPath = join(this.root, `${threadId}-${Date.now()}-${basename(originalPath)}`)
    const record: ThreadTrashRecord = { threadId, originalPath, trashPath, tombstonedAt: new Date().toISOString() }
    this.validateRecord(record)
    mkdirSync(this.root, { recursive: true })
    atomicWriteJsonSync(join(originalPath, 'tombstone.json'), record)
    renameSync(originalPath, trashPath)
    const records = this.list(); records.push(record); atomicWriteJsonSync(this.indexPath, records)
    return record
  }

  restore(threadId: string): ThreadTrashRecord {
    const records = this.list(); const record = [...records].reverse().find((item) => item.threadId === threadId && !item.restoredAt && !item.purgedAt)
    if (!record) throw new Error(`Thread is not in trash: ${threadId}`)
    this.validateRecord(record)
    if (existsSync(record.originalPath)) throw new Error('Original thread path is already occupied.')
    mkdirSync(dirname(record.originalPath), { recursive: true })
    renameSync(record.trashPath, record.originalPath)
    record.restoredAt = new Date().toISOString(); atomicWriteJsonSync(this.indexPath, records)
    return record
  }

  purge(threadId: string): ThreadTrashRecord {
    const records = this.list(); const record = [...records].reverse().find((item) => item.threadId === threadId && !item.restoredAt && !item.purgedAt)
    if (!record) throw new Error(`Thread is not in trash: ${threadId}`)
    this.validateRecord(record)
    rmSync(record.trashPath, { recursive: true, force: true })
    record.purgedAt = new Date().toISOString(); atomicWriteJsonSync(this.indexPath, records)
    return record
  }
}
