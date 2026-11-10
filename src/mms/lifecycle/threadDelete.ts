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
 * Only the threads go: their worktrees, branches, uncommitted files and Git refs stay where they are (`keepWork`), until
 * the person removes them. Only a thread's expiry takes its worktree with it. The trash is only a step of a delete: a
 * thread left there by a delete that was cut short is finished at the next start, as it was asked, or put back in
 * Archived when what it asked does not allow it.
 */

export const ARCHIVE_BEFORE_DELETE = 'Archive the thread before deleting it.'

/** What a delete was asked to do, kept while it runs so a delete cut short finishes the same way. */
export interface DeleteIntent {
  human: boolean
  discard: boolean
  at: string
  /**
   * The thread's expiry asked for it (`Thread.expiresAt`): it goes without being archived, and its purge has the
   * expiry's authority (`ResourcePurgeService.purge`), which holds only while that expiry has passed.
   */
  expiry?: true
}

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
  /** The thread's expiry passed (`DeleteIntent.expiry`); the daemon's own expiry pass is the only caller. */
  expiry?: boolean
}

/** A delete keeps the thread's worktrees, branches and Git refs; only its expiry takes them (`Thread.expiresAt`). */
const keepsWork = (intent: DeleteIntent): boolean => !intent.expiry

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
    // One already in the trash (a delete of it cut short) does not move with its owner, and the owner's purge leaves it
    // behind, so it is deleted on its own as well.
    const trashed = (id: string): boolean => ['trashed', 'purge-started'].includes(this.deps.store.get(id)?.state ?? '')
    return order.filter((id) => !this.ownedWithin(id, family) || trashed(id))
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
    if (listed && options.internal && !options.expiry && !listed.settledAt) this.deps.archive(threadId)
    // An expired thread is deleted where it is: it is never archived on its way out.
    if (listed && !options.expiry && !this.isArchived(this.deps.getThread(threadId) ?? listed)) throw new DomainRpcError('thread_not_archived', ARCHIVE_BEFORE_DELETE, { threadId })
    const intent: DeleteIntent = { human: options.human, discard: options.human && options.discard, at: new Date().toISOString(), ...(options.expiry ? { expiry: true as const } : {}) }
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
      // Only what this delete trashed goes back, and the thread itself when it was left by an earlier one: a member
      // another delete is working on stays with that delete.
      const back = continuing && !trashedHere.includes(threadId) ? [threadId, ...trashedHere] : trashedHere
      await this.putBack(back)
      // The others keep no consent from this refused delete; a delete still working on them holds its own in memory.
      for (const id of members) if (!back.includes(id)) this.withdrawConsent(id)
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
    const preview = await this.deps.purge.preview(taskId, { keepWork: keepsWork(intent) })
    if (preview.blockers.length) throw new DomainRpcError('thread_delete_blocked', `The thread could not be deleted: ${preview.blockers.join('; ')}`, { threadId: taskId })
    if (preview.items.some((item) => item.discardRequired) && !(intent.human && intent.discard) && !intent.expiry)
      throw new DomainRpcError('thread_has_unpublished_work', 'The thread has unpublished work. Delete it from the Mousse app.', { threadId: taskId })
    return preview
  }

  /** Purges one trashed thread, or resumes a purge that started. */
  private async finish(taskId: string, intent: DeleteIntent): Promise<void> {
    const record = this.deps.store.get(taskId)
    if (!record || record.state === 'purged') { this.setIntent(taskId, undefined); return }
    if (record.state === 'purge-started' && record.purge) {
      await this.deps.purge.purge({ taskId, operationId: record.purge.operationId, keepWork: keepsWork(intent), ...(intent.expiry ? { authorization: 'expiry' as const } : {}) })
    } else {
      const preview = await this.check(taskId, intent)
      await this.deps.purge.purge({ taskId, operationId: randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard: intent.discard, human: intent.human, keepWork: keepsWork(intent), ...(intent.expiry ? { authorization: 'expiry' as const } : {}) })
    }
    this.setIntent(taskId, undefined)
  }

  /**
   * A refused delete: these members go back where they were. One that cannot be put back keeps no consent to
   * discard, so the next start never purges unpublished work the dialog said was kept.
   */
  private async putBack(members: readonly string[]): Promise<void> {
    for (const id of members) {
      if (this.deps.store.get(id)?.state === 'trashed') {
        await this.deps.restore(id).catch((error: unknown) => {
          console.warn('a refused delete could not put a thread back; the next start tries again', { threadId: id, error: error instanceof Error ? error.message : String(error) })
        })
      }
      if (this.deps.store.get(id)?.state === 'trashed') this.withdrawConsent(id)
      else this.setIntent(id, undefined)
    }
  }

  private withdrawConsent(taskId: string): void {
    const intent = this.readIntents()[taskId]
    if (intent && (intent.human || intent.discard)) this.setIntent(taskId, { ...intent, human: false, discard: false })
  }

  /** A restored thread's delete is over: its recorded consent can never be used again. */
  forgetIntent(taskId: string): void {
    if (this.readIntents()[taskId]) this.setIntent(taskId, undefined)
  }

  private dropIntentUnlessTrashed(taskId: string): void {
    const state = this.deps.store.get(taskId)?.state
    if (state !== 'trashed' && state !== 'purge-started') this.forgetIntent(taskId)
  }

  /**
   * At start: a thread in the trash with a recorded delete is a delete that was cut short. It is finished as it was
   * asked; when that is not allowed (unpublished work without the person's consent) it goes back to Archived. A
   * thread in the trash with no recorded delete (an older build's trash, one the move to Archived could not bring
   * back) is never purged: it goes back to Archived, or stays where it is when it cannot. One with a blocker (a
   * drive that is not connected) waits for the next start. `skip` names threads the move is still bringing back.
   */
  async finishCutShort(skip: ReadonlySet<string> = new Set()): Promise<Array<{ taskId: string; outcome: 'purged' | 'archived' | 'kept'; reason?: string }>> {
    const results: Array<{ taskId: string; outcome: 'purged' | 'archived' | 'kept'; reason?: string }> = []
    // Consent recorded for a delete that is over (the thread was restored, or is gone) is dropped.
    const intents = this.readIntents()
    for (const taskId of Object.keys(intents)) this.dropIntentUnlessTrashed(taskId)
    const tried = new Set<string>(skip)
    for (let progress = true; progress;) {
      progress = false
      const records = this.deps.store.list()
      const byId = new Map(records.map((record) => [record.taskId, record]))
      // An owner first: purging it detaches a child trashed on its own, which the next pass finishes.
      const tops = records.filter((record) => record.state === 'trashed' && !tried.has(record.taskId) && byId.get(record.parentTaskId ?? '')?.state !== 'trashed')
      for (const record of tops) {
        tried.add(record.taskId)
        progress = true
        const intent = this.readIntents()[record.taskId]
        if (!intent) {
          await this.putBack([record.taskId])
          if (this.deps.store.get(record.taskId)?.state === 'active') {
            try { this.deps.archive(record.taskId) } catch { /* It is listed again either way. */ }
            results.push({ taskId: record.taskId, outcome: 'archived' })
          } else results.push({ taskId: record.taskId, outcome: 'kept', reason: 'no delete was asked for, and it could not be put back' })
          continue
        }
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
