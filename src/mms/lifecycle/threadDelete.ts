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
  /** `keepWork`: the trash's inventory does not verify the worktrees the delete keeps. */
  trash(threadId: string, operationId?: string, expectedGeneration?: number, keepWork?: boolean): Promise<TaskLifecycleRecord>
  restore(threadId: string): Promise<unknown>
  /** Archives a thread a person started; a subagent thread or an owned thread is left as it is. */
  archive(threadId: string): void
  /**
   * Stops what still runs in these threads, their queued messages with it, and waits (within a bound) for it to end:
   * a delete never leaves a turn or its provider running in a thread that is gone.
   */
  stopRuns?(threadIds: readonly string[]): Promise<void>
  /** Whether a turn or run that `stopRuns` would stop is running in any of these threads. */
  isRunning?(threadIds: readonly string[]): boolean
  /**
   * Refuses, before anything stops, what would refuse the trash anyway: the profile shutting down, an open terminal, a
   * pending question, a running agent, chat or workflow in these threads, or another thread's turn. Their own turns
   * are not refused here: `stopRuns` ends them.
   */
  assertCanStop?(threadIds: readonly string[]): void
  /** What would refuse a delete that keeps the work, read before anything stops (`ResourcePurgeService.deletePrecheck`). */
  precheck?(threadId: string): Promise<{ blockers: string[]; soleCopies: string[] }>
  /**
   * Waits up to `budgetMs` for the profile's other requests to settle. The trash and the purge each refuse while one
   * is in flight, and a window still shows the thread for a moment, so its reads of it keep arriving meanwhile.
   */
  settle?(budgetMs: number): Promise<void>
}

/** How long a step refused for a passing reason is tried again; a refusal still there after it is reported. */
export const BUSY_RETRY_MS = 5_000

/** How long a delete that `stopBeforeDelete` prepared counts as prepared: its own request follows at once. */
const PREPARED_FOR_MS = 10_000

/**
 * A refusal that ends by itself within moments: another request in flight (a window's read of the thread it still
 * shows), or a thread's lease its stopped turn is letting go. Work that stays (a terminal, a question, an agent, a
 * workflow, another thread's turn) is refused at once, as before.
 */
function isPassingBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'LeaseBusyError') return true
  const code = (error as { code?: unknown }).code
  return (code === 'busy' || code === 'profile_busy') && /requests are still active/.test(error.message)
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
  constructor(private readonly deps: ThreadDeleteDeps, private readonly busyRetryMs = BUSY_RETRY_MS) {}

  /** Threads whose delete `stopBeforeDelete` already checked and stopped, with when: the delete does not stop them again. */
  private readonly prepared = new Map<string, number>()

  /**
   * Runs a step that refuses while the profile is busy once other requests settled, and again while it is refused for a
   * passing reason, until `busyRetryMs` has passed. `attempt` counts from 0, so a step can leave out on a retry what
   * belonged to its first try (the caller's operation id, which the refusal used up). Any other refusal, and a passing
   * one past the budget, is the step's own error.
   */
  private async whenSettled<T>(step: (attempt: number) => Promise<T>): Promise<T> {
    const until = Date.now() + this.busyRetryMs
    for (let attempt = 0; ; attempt++) {
      await this.deps.settle?.(Math.max(1, Math.min(2_000, until - Date.now())))
      try {
        return await step(attempt)
      } catch (error) {
        if (!isPassingBusy(error) || Date.now() >= until) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }

  /** The members of `threadId`'s delete that are still listed (the thread first). */
  private liveMembers(threadId: string): string[] {
    return [threadId, ...this.subagentsOf(threadId)].filter((id) => this.deps.getThread(id))
  }

  /**
   * Everything that would refuse this delete and can be known before anything stops, then the Stop. A refused delete
   * never stops a turn or drops a queue.
   */
  private async checkThenStop(members: readonly string[], intent: DeleteIntent): Promise<void> {
    // With nothing running there is nothing to stop, and the trash and the preview check everything as before.
    if (!members.length || (this.deps.isRunning && !this.deps.isRunning(members))) return
    this.deps.assertCanStop?.(members)
    // An expiry takes the thread's files with it as asked; a delete that keeps the work checks what would refuse it.
    if (!intent.expiry && this.deps.precheck) {
      const precheck = this.deps.precheck
      const found = await Promise.all(members.map(async (id) => ({ id, ...await precheck(id) })))
      for (const member of found) this.refuseFor(member.id, member.blockers, member.soleCopies.length > 0, intent)
    }
    await this.deps.stopRuns?.(members)
  }

  /** The refusals a preview, or the check before a Stop, can give. */
  private refuseFor(taskId: string, blockers: readonly string[], soleCopies: boolean, intent: DeleteIntent): void {
    if (blockers.length) throw new DomainRpcError('thread_delete_blocked', `The thread could not be deleted: ${blockers.join('; ')}`, { threadId: taskId })
    if (soleCopies && !(intent.human && intent.discard) && !intent.expiry)
      throw new DomainRpcError('thread_has_unpublished_work', 'The thread has unpublished work. Delete it from the Mousse app.', { threadId: taskId })
  }

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
   * The delete's Stop, before the delete is admitted: what runs in an archived thread and its subagent threads ends,
   * with their queues. A running turn's own request (the send waiting for it) would otherwise keep the delete from
   * being admitted. A thread that is not archived is left running: its delete is refused.
   */
  async stopBeforeDelete(threadId: string, options: Pick<DeleteOptions, 'human' | 'discard'>): Promise<void> {
    const listed = this.deps.getThread(threadId)
    if (!listed || !this.isArchived(listed)) return
    // A refusal is the delete's answer, with nothing stopped.
    await this.checkThenStop(this.liveMembers(threadId), { human: options.human, discard: options.human && options.discard, at: new Date().toISOString() })
    this.prepared.set(threadId, Date.now())
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
    const preparedAt = this.prepared.get(threadId)
    this.prepared.delete(threadId)
    const trashedHere: string[] = []
    // Check everything first: the thread, then its subagent threads. Nothing is purged until all of them may go.
    try {
      // What would refuse the delete is checked before the family's turns stop (with their queues); `stopBeforeDelete`
      // did both just before when it ran.
      if (listed && !(preparedAt !== undefined && Date.now() - preparedAt < PREPARED_FOR_MS)) await this.checkThenStop(this.liveMembers(threadId), intent)
      for (const id of members) {
        const current = this.deps.store.get(id)
        if (current?.state === 'purge-started' || current?.state === 'purged') continue
        this.setIntent(id, intent)
        if (!current || current.state === 'active') {
          await this.whenSettled((attempt) => {
            // Unarchived while the delete waited: the thread is in use again, and stays.
            if (id === threadId && listed && !options.expiry && !this.isArchived(this.deps.getThread(threadId) ?? { id: threadId }))
              throw new DomainRpcError('thread_not_archived', ARCHIVE_BEFORE_DELETE, { threadId })
            return this.deps.trash(id, id === threadId && attempt === 0 ? options.operationId : undefined, id === threadId ? options.expectedGeneration : undefined, keepsWork(intent))
          })
          trashedHere.push(id)
        }
        await this.whenSettled(() => this.check(id, intent))
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
    this.refuseFor(taskId, preview.blockers, preview.items.some((item) => item.discardRequired), intent)
    return preview
  }

  /** Purges one trashed thread, or resumes a purge that started. */
  private async finish(taskId: string, intent: DeleteIntent): Promise<void> {
    const record = this.deps.store.get(taskId)
    if (!record || record.state === 'purged') { this.setIntent(taskId, undefined); return }
    if (record.state === 'purge-started' && record.purge) {
      const purge = record.purge
      await this.whenSettled(() => this.deps.purge.purge({ taskId, operationId: purge.operationId, keepWork: keepsWork(intent), ...(intent.expiry ? { authorization: 'expiry' as const } : {}) }))
    } else {
      await this.whenSettled(async () => {
        const preview = await this.check(taskId, intent)
        await this.deps.purge.purge({ taskId, operationId: randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard: intent.discard, human: intent.human, keepWork: keepsWork(intent), ...(intent.expiry ? { authorization: 'expiry' as const } : {}) })
      })
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
