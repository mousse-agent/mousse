import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { Thread } from '../../shared/types'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { ResourcePurgeService } from './ResourcePurgeService'

/**
 * Deleting a thread for good. A thread is archived first; deleting it moves it and its subagent threads through
 * the trash (which stops and fences them) and the reviewed purge (which removes exactly what its preview lists).
 * The trash is only a step of a delete: a thread left there by a delete that was cut short is finished at the next
 * start, as it was asked, or put back in Archived when what it asked does not allow it.
 */

export const ARCHIVE_BEFORE_DELETE = 'Archive the thread before deleting it.'

/** What a delete was asked to do, kept while it runs so a delete cut short finishes the same way. */
export interface DeleteIntent { human: boolean; discard: boolean; at: string }

export interface ThreadDeleteDeps {
  store: ResourceLifecycleStore
  purge: Pick<ResourcePurgeService, 'preview' | 'purge'>
  getThread(threadId: string): Thread | undefined
  listThreads(): Thread[]
  trash(threadId: string, operationId?: string, expectedGeneration?: number): Promise<TaskLifecycleRecord>
  restore(threadId: string): Promise<unknown>
  /** Archives a thread a person started; a subagent thread or an owned thread is left as it is. */
  archive(threadId: string): void
}

export interface DeleteOptions {
  /** A person in the app confirmed it: only then may unpublished work be discarded. */
  human: boolean
  discard: boolean
  operationId?: string
  expectedGeneration?: number
  /**
   * Mousse's own delete (a deleted bot's home thread, a failed pull-request start): the thread is archived first,
   * and one that holds unpublished work stays in Archived instead of failing.
   */
  internal?: boolean
}

interface ThreadMeta { id: string; settledAt?: string; lineage?: Thread['lineage'] }

export class ThreadDeleter {
  constructor(private readonly deps: ThreadDeleteDeps) {}

  private get intentsPath(): string { return join(this.deps.store.root, 'delete-intents.json') }

  private readIntents(): Record<string, DeleteIntent> {
    const path = this.intentsPath
    assertLifecyclePath(this.deps.store.root, path)
    if (!existsSync(path)) return {}
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, DeleteIntent> : {}
    } catch { return {} }
  }

  private writeIntents(intents: Record<string, DeleteIntent>): void {
    mkdirSync(this.deps.store.root, { recursive: true })
    atomicWriteJsonSync(this.intentsPath, intents)
  }

  private setIntent(taskId: string, intent: DeleteIntent | undefined): void {
    const intents = this.readIntents()
    if (intent) intents[taskId] = intent
    else delete intents[taskId]
    this.writeIntents(intents)
  }

  /** A thread's meta, also for one that is in the trash and so not listed. */
  private metaOf(taskId: string): ThreadMeta | undefined {
    const listed = this.deps.getThread(taskId)
    if (listed) return listed
    const record = this.deps.store.get(taskId)
    if (!record) return undefined
    try {
      const path = join(record.location, 'meta.json')
      assertLifecyclePath(record.location, path)
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) return undefined
      const meta = JSON.parse(readFileSync(path, 'utf8')) as ThreadMeta
      return meta.id === taskId ? meta : undefined
    } catch { return undefined }
  }

  private isArchived(meta: ThreadMeta): boolean {
    if (meta.settledAt) return true
    const root = meta.lineage?.rootThreadId
    return Boolean(root && root !== meta.id && this.metaOf(root)?.settledAt)
  }

  /** True when `taskId`'s lifecycle owner chain reaches one of `ids`: it is trashed and purged with that owner. */
  private ownedWithin(taskId: string, ids: ReadonlySet<string>): boolean {
    const seen = new Set<string>()
    for (let owner = this.deps.store.get(taskId)?.parentTaskId; owner && !seen.has(owner); owner = this.deps.store.get(owner)?.parentTaskId) {
      if (ids.has(owner)) return true
      seen.add(owner)
    }
    return false
  }

  /**
   * The subagent threads under `threadId`, deepest first, each deleted on its own: listed ones and ones a delete
   * cut short left in the trash. One whose lifecycle owner is in the family goes with its owner.
   */
  subagentsOf(threadId: string): string[] {
    const metas: ThreadMeta[] = [...this.deps.listThreads()]
    const listed = new Set(metas.map((thread) => thread.id))
    for (const record of this.deps.store.list()) {
      if (listed.has(record.taskId) || (record.state !== 'trashed' && record.state !== 'purge-started')) continue
      const meta = this.metaOf(record.taskId)
      if (meta) metas.push(meta)
    }
    const children = new Map<string, string[]>()
    for (const meta of metas) {
      const parent = meta.lineage?.parentThreadId
      if (parent && parent !== meta.id) children.set(parent, [...(children.get(parent) ?? []), meta.id])
    }
    const family = new Set([threadId]), order: string[] = []
    const visit = (id: string): void => {
      for (const child of children.get(id) ?? []) {
        if (family.has(child)) continue
        family.add(child)
        visit(child)
        order.push(child)
      }
    }
    visit(threadId)
    return order.filter((id) => !this.ownedWithin(id, family))
  }

  /**
   * Deletes `threadId` and its subagent threads for good. Every member is trashed and checked before anything is
   * purged, so a refusal (not archived, unpublished work, a blocker, busy) puts the whole family back as it was.
   * A thread already in the trash (a delete cut short) is finished, so pressing Delete again works.
   */
  async delete(threadId: string, options: DeleteOptions): Promise<TaskLifecycleRecord> {
    const record = this.deps.store.get(threadId)
    const listed = this.deps.getThread(threadId)
    const continuing = !listed && (record?.state === 'trashed' || record?.state === 'purge-started')
    if (!listed && !continuing) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
    if (listed && options.internal && !listed.settledAt) this.deps.archive(threadId)
    if (listed && !this.isArchived(this.deps.getThread(threadId) ?? listed)) throw new DomainRpcError('thread_not_archived', ARCHIVE_BEFORE_DELETE, { threadId })
    const intent: DeleteIntent = { human: options.human, discard: options.human && options.discard, at: new Date().toISOString() }
    const members = [threadId, ...this.subagentsOf(threadId)]
    const trashedHere: string[] = []
    // Check everything first: the thread, then its subagent threads. Nothing is purged until all of them may go.
    try {
      for (const id of members) {
        const current = this.deps.store.get(id)
        if (current?.state === 'purge-started' || current?.state === 'purged') continue
        this.setIntent(id, intent)
        if (!current || current.state === 'active') {
          await this.deps.trash(id, id === threadId ? options.operationId : undefined, id === threadId ? options.expectedGeneration : undefined)
          trashedHere.push(id)
        }
        await this.check(id, intent)
      }
    } catch (error) {
      await this.putBack(members)
      if (options.internal && error instanceof DomainRpcError && error.code === 'thread_has_unpublished_work') {
        // Mousse's own delete keeps a thread with unpublished work in Archived, where the person decides.
        return this.deps.store.require(threadId)
      }
      throw error
    }
    // Subagent threads first, deepest first; the thread itself last. A failure here leaves the rest in the trash
    // with their intent: Delete again, or the next start, finishes them.
    for (const id of [...members.slice(1), threadId]) await this.finish(id, intent)
    return this.deps.store.require(threadId)
  }

  /** Refuses what this delete may not do; the preview is read again right before the purge. */
  private async check(taskId: string, intent: DeleteIntent): Promise<Awaited<ReturnType<ThreadDeleteDeps['purge']['preview']>>> {
    const preview = await this.deps.purge.preview(taskId)
    if (preview.blockers.length) throw new DomainRpcError('thread_delete_blocked', `The thread could not be deleted: ${preview.blockers.join('; ')}`, { threadId: taskId })
    if (preview.items.some((item) => item.discardRequired) && !(intent.human && intent.discard))
      throw new DomainRpcError('thread_has_unpublished_work', 'The thread has unpublished work. Delete it from the Mousse app.', { threadId: taskId })
    return preview
  }

  /** Purges one trashed thread, or resumes a purge that started. */
  private async finish(taskId: string, intent: DeleteIntent): Promise<void> {
    const record = this.deps.store.get(taskId)
    if (!record || record.state === 'purged') { this.setIntent(taskId, undefined); return }
    if (record.state === 'purge-started' && record.purge) {
      await this.deps.purge.purge({ taskId, operationId: record.purge.operationId })
    } else {
      const preview = await this.check(taskId, intent)
      await this.deps.purge.purge({ taskId, operationId: randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard: intent.discard, human: intent.human })
    }
    this.setIntent(taskId, undefined)
  }

  /** A refused delete: every member still in the trash goes back where it was. */
  private async putBack(members: readonly string[]): Promise<void> {
    for (const id of members) {
      if (this.deps.store.get(id)?.state === 'trashed') {
        await this.deps.restore(id).catch((error: unknown) => {
          console.warn('a refused delete could not put a thread back; the next start tries again', { threadId: id, error: error instanceof Error ? error.message : String(error) })
        })
      }
      if (this.deps.store.get(id)?.state !== 'trashed') this.setIntent(id, undefined)
    }
  }

  /**
   * At start, after the one-time move of the old trash to Archived: a thread still in the trash is a delete that was
   * cut short. It is finished as it was asked; when that is not allowed (unpublished work without the person's
   * consent) it goes back to Archived. One with a blocker (a drive that is not connected) waits for the next start.
   */
  async finishCutShort(): Promise<Array<{ taskId: string; outcome: 'purged' | 'archived' | 'kept'; reason?: string }>> {
    const results: Array<{ taskId: string; outcome: 'purged' | 'archived' | 'kept'; reason?: string }> = []
    const tried = new Set<string>()
    for (let progress = true; progress;) {
      progress = false
      const records = this.deps.store.list()
      const byId = new Map(records.map((record) => [record.taskId, record]))
      // An owner first: purging it detaches a child trashed on its own, which the next pass finishes.
      const tops = records.filter((record) => record.state === 'trashed' && !tried.has(record.taskId) && byId.get(record.parentTaskId ?? '')?.state !== 'trashed')
      for (const record of tops) {
        tried.add(record.taskId)
        progress = true
        const intent = this.readIntents()[record.taskId] ?? { human: false, discard: false, at: new Date().toISOString() }
        try {
          await this.check(record.taskId, intent)
        } catch (error) {
          if (error instanceof DomainRpcError && error.code === 'thread_has_unpublished_work') {
            await this.putBack([record.taskId])
            if (this.deps.store.get(record.taskId)?.state === 'active') {
              try { this.deps.archive(record.taskId) } catch { /* It is listed again either way. */ }
              results.push({ taskId: record.taskId, outcome: 'archived' })
            } else results.push({ taskId: record.taskId, outcome: 'kept', reason: 'could not be put back' })
          } else results.push({ taskId: record.taskId, outcome: 'kept', reason: error instanceof Error ? error.message : String(error) })
          continue
        }
        try {
          await this.finish(record.taskId, intent)
          results.push({ taskId: record.taskId, outcome: 'purged' })
        } catch (error) {
          results.push({ taskId: record.taskId, outcome: 'kept', reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return results
  }
}
