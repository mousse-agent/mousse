import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { FolderNotAnsweringError, waitForFolderAccess } from '../files/folderAccess'
import { resolveRepositoryIdentityAsync, type RepositoryIdentity } from '../git/RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseBusyError } from '../git/RepositoryLease'
import { buildResourceInventoryFromFacts, rereadRepositoryFacts, type OwnershipFacts } from '../lifecycle/ResourceInventory'
import { getExternalResourceClaimsFromFacts, repositoryTargetAsync, unverifiedOwnerOver } from '../lifecycle/LifecycleClaims'
import { discoverOwnershipFacts } from '../lifecycle/ownershipDiscovery'
import { readDirectLifecycleRefAsync } from '../lifecycle/WorktreeRetirementService'
import { readDirectRefsAsync } from '../lifecycle/worktreeFacts'
import { assertLifecyclePath, type ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { readThreadWorkspaceRecord, ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { UndoRetentionService } from './UndoRetentionService'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { untilAborted } from '../git/gitPolicy'
import { withScopedGitConfig } from '../git/gitEnv'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { settlesItself } from '../../shared/resourceLifecycle'
import { cancelUndoRefRelease, finishUndoRefRelease, pendingUndoRefRelease, prepareUndoRefRelease } from './undoRefClaims'

/** The ownership inventory showed a blocker: the whole release stops, as when it shows one before the first receipt. */
class OwnershipBlocked extends Error {}

interface ReleaseIntent { version: 1; receiptId: string; repositoryId: string; refs: Array<{ name: string; sha: string }> }
export interface ReceiptRefReleaseResult { releasedRefs: string[]; retained: Array<{ receiptId: string; reason: string }>; reclaimedGitBytes: null; oldestPendingReleaseAgeMs: number | null }

/** Receipts released in one Git transaction, at most. */
export const RELEASE_BATCH_SIZE = 10
const RELEASE_LEASE_WAIT_MS = 5_000
const RELEASE_HOLD_MS = 15_000
const RELEASE_RETRY_DELAY_MS = 10 * 60_000
// Git must unwind its own locks. A busy ref fails immediately instead of spending the lease waiting.
const NO_REF_LOCK_RETRY = [
  ['core.filesRefLockTimeout', '0'],
  ['core.packedRefsTimeout', '0'],
  ['reftable.lockTimeout', '0']
] as const
/** How many times a release discovers ownership again after a record changed while it waited for the lease. */
export const RELEASE_EVIDENCE_RETRIES = 3

type Candidate = { receipt: ChangeReceipt | undefined; operationId: string; intent: ReleaseIntent | undefined }
/** How one hold of the repository lease ended. */
type HoldEnd = 'finished' | 'yield' | { changed: string }
type ReleaseHooks = { afterPrepared?: () => void; afterGit?: () => void; afterCheck?: () => void }

async function preparedReceiptRefReleaseCleanup(location: string) {
  assertLifecyclePath(location, join(location, 'journal'))
  const journal = new ThreadJournal(location, { readOnly: true })
  const pending = journal.unsettled().filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'prepared')
  if (!pending.length) return
  for (const name of ['workspace.json', 'project-folder.json']) assertLifecyclePath(location, join(location, name))
  const workspace = readThreadWorkspaceRecord(location)
  const paths = new Set([workspace?.integrationTarget?.checkoutPath, workspace?.worktreePath])
  for (const path of paths) {
    if (!path) continue
    try { await waitForFolderAccess([path], { whenNotAnswering: 'fail' }) }
    catch (error) {
      if (error instanceof FolderNotAnsweringError) continue
      throw error
    }
    const repository = await resolveRepositoryIdentityAsync(path)
    if (!repository.capability.allowed || repository.key !== workspace?.repositoryId) continue
    const releases = pending.map((entry) => {
      const intent = entry.details as ReleaseIntent
      if (intent?.version !== 1 || intent.repositoryId !== repository.key) throw new Error('Cannot verify a pending Undo release repository for purge.')
      return { receiptId: intent.receiptId, operationId: entry.operationId }
    })
    return { repository, releases }
  }
  throw new Error('Reconnect the repository to settle the pending Undo releases before deleting this thread.')
}

/** A preview checks that prepared reservations can be reached without changing them. */
export async function checkPreparedReceiptRefReleases(location: string): Promise<void> {
  await preparedReceiptRefReleaseCleanup(location)
}

/**
 * Release recovery needs the task's prepared journal. Before purge becomes irreversible, clear reservations it owns
 * under the same repository lease used by release and copy. The refs stay as they are.
 */
export async function cancelPreparedReceiptRefReleases(location: string): Promise<void> {
  const cleanup = await preparedReceiptRefReleaseCleanup(location)
  if (!cleanup) return
  const { repository, releases } = cleanup
  const lease = await acquireRepositoryLease(repository, { maxWaitMs: RELEASE_LEASE_WAIT_MS })
  try {
    for (const { receiptId, operationId } of releases) cancelUndoRefRelease(repository, receiptId, operationId)
  } finally { lease.release() }
}

/** Phase 3b: only expired, exclusive immutable receipt refs. Never runs Git GC or deletes user refs. */
export class ReceiptRefReleaseService {
  constructor(private readonly store: ResourceLifecycleStore, private readonly taskId: string, private readonly now: () => number = Date.now, private readonly holdMs = RELEASE_HOLD_MS) {}

  /**
   * Whether a release would find receipts to release now: expired and not released, or a release left prepared. Reads
   * the thread's own records only, without a lease, so a cleanup batch knows whether to discover ownership first.
   */
  hasWork(): boolean {
    try {
      const task = this.store.require(this.taskId)
      const latest = [...new ThreadJournal(task.location).latestByOperation().values()]
      if (latest.some((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'prepared')) return true
      const complete = new Set(latest.filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'completed').map((entry) => (entry.details as ReleaseIntent).receiptId))
      const expired = new UndoRetentionService(task.location, this.now).expiredReceiptIds()
      return new ChangeReceiptService(task.location).list().some((receipt) => expired.has(receipt.id) && !complete.has(receipt.id))
    } catch { return true }
  }

  /** Age since logical expiry, or since preparation for older intents without a recorded expiry. */
  oldestPendingReleaseAgeMs(): number | null {
    const journal = new ThreadJournal(this.store.require(this.taskId).location, { readOnly: true })
    const latest = journal.latestByOperation()
    const completed = new Set([...latest.values()].filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'completed').map((entry) => (entry.details as ReleaseIntent).receiptId))
    const receipts = new Set(journal.receipts().map((receipt) => receipt.id))
    const pendingAt = new Map<string, number>()
    for (const entry of journal.ofTypes('undo-retention')) {
      const event = entry.details as { kind?: string; at?: number; ids?: string[] }
      if (event?.kind !== 'expire' || !Number.isFinite(event.at) || !Array.isArray(event.ids)) continue
      for (const id of event.ids) if (receipts.has(id) && !completed.has(id) && !pendingAt.has(id)) pendingAt.set(id, event.at!)
    }
    for (const entry of latest.values()) {
      if (entry.operationType !== 'undo-ref-release' || entry.state !== 'prepared') continue
      const id = (entry.details as ReleaseIntent).receiptId
      if (!pendingAt.has(id)) pendingAt.set(id, Date.parse(entry.createdAt))
    }
    let oldest = Infinity
    for (const at of pendingAt.values()) if (Number.isFinite(at)) oldest = Math.min(oldest, at)
    return Number.isFinite(oldest) ? Math.max(0, this.now() - oldest) : null
  }

  /**
   * Releases the thread's expired receipt refs, in batches, each under a short hold of the repository lease.
   *
   * Who claims what across every profile is discovered before the lease (`discovery`, shared by a cleanup batch and
   * read before any thread's lease, or read here). Under the lease, for each batch: what the facts say about this
   * repository is read again (its worktrees, every real path, the repository's own identity), the refs are read in one
   * listing, and then, with nothing awaited until the Git transaction starts, ownership is checked from the records
   * themselves, the intents are recorded, and one transaction deletes every eligible ref by its expected commit. The
   * refs are checked individually for absence before the intents complete. Each lease hold runs one transaction of
   * at most `RELEASE_BATCH_SIZE` receipts, with a deadline for starting Git. A running writer finishes so Git can
   * clear its locks. A failed transaction is retried one receipt per hold so a busy ref cannot hold up other receipts.
   * A record that changed while the release waited lets go, discovers again and
   * retries, at most `RELEASE_EVIDENCE_RETRIES` times; the rest waits for the next run.
   */
  async release(workspacePath: string, options: ReleaseHooks & { limit?: number; signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; discovery?: OwnershipFacts } = {}): Promise<ReceiptRefReleaseResult> {
    const task = this.store.require(this.taskId)
    if (task.state !== 'active') throw new Error('Receipt release requires an active task owner.')
    const admission = this.store.captureAdmission(task.taskId, task.location)
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid receipt release batch size.')
    const result: ReceiptRefReleaseResult = { releasedRefs: [], retained: [], reclaimedGitBytes: null, oldestPendingReleaseAgeMs: null }
    if (!this.hasWork()) return result
    // Before the repository lease: what every other profile and thread claims, and this thread's own checkouts.
    let facts = options.discovery ? options.discovery.copy() : await discoverOwnershipFacts(this.store)
    const handled = new Set<string>()
    const isolate = new Set<string>()
    let retries = 0
    for (;;) {
      let end: HoldEnd
      let timeout: AbortSignal | undefined
      let workSignal: AbortSignal | undefined
      let deadline = Infinity
      const deadlineReached = new Error('Receipt release reached its repository lease deadline and will continue on a later run.')
      const check = () => {
        options.signal?.throwIfAborted()
        if (timeout?.aborted || performance.now() >= deadline) throw deadlineReached
      }
      const bounded = <T>(work: Promise<T>) => untilAborted(work, workSignal)
      try {
        end = await withGitMutationLocks(task.location, workspacePath, 'undo-ref-release', (leasedRepository) =>
          this.hold(task.location, workspacePath, leasedRepository, admission, facts.copy(), limit, handled, isolate, result, options, check, bounded),
        options.signal, options.heldThreadLease, () => {
          deadline = performance.now() + this.holdMs
          timeout = AbortSignal.timeout(this.holdMs)
          workSignal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
          return workSignal
        }, RELEASE_LEASE_WAIT_MS)
      } catch (error) {
        options.signal?.throwIfAborted()
        if (!(error instanceof RepositoryLeaseBusyError) && error !== deadlineReached && !timeout?.aborted) throw error
        result.retained.push({ receiptId: '', reason: timeout?.aborted ? deadlineReached.message : (error as Error).message })
        break
      }
      if (end === 'finished' || handled.size >= limit) break
      if (end !== 'yield') {
        if (++retries > RELEASE_EVIDENCE_RETRIES) {
          result.retained.push({ receiptId: '', reason: `Ownership kept changing while it was checked (${end.changed}); the release tries again on a later run.` })
          break
        }
        facts = await discoverOwnershipFacts(this.store, { newerThan: facts.generation })
      }
    }
    result.oldestPendingReleaseAgeMs = this.oldestPendingReleaseAgeMs()
    return result
  }

  /** One hold of the repository lease, with at most one delete transaction. */
  private async hold(location: string, workspacePath: string, leasedRepository: RepositoryIdentity, admission: ReturnType<ResourceLifecycleStore['captureAdmission']>, facts: OwnershipFacts, limit: number, handled: Set<string>, isolate: Set<string>, result: ReceiptRefReleaseResult, options: ReleaseHooks, check: () => void, bounded: <T>(work: Promise<T>) => Promise<T>): Promise<HoldEnd> {
    check()
    const task = this.store.require(this.taskId)
    this.store.assertAdmission(admission)
    const identity = await bounded(resolveRepositoryIdentityAsync(workspacePath, { requireMutationCapability: true }))
    if (identity.key !== leasedRepository.key || identity.metadataDir !== leasedRepository.metadataDir) throw new Error('Receipt release repository changed while waiting for its lease.')
    const workspace = new ThreadWorkspaceManager(location).load()
    if (!workspace || workspace.repositoryId !== identity.key || workspace.lifecycle !== 'ready') throw new Error('Receipt release repository does not match the authoritative task workspace.')
    const retention = new UndoRetentionService(location, this.now)
    if (!retention.clockAllowsRelease()) throw new Error('Clock review or recovery is required before physical receipt release.')
    const journal = new ThreadJournal(location)
    const expired = retention.expiredReceiptIds()
    const receipts = new Map(new ChangeReceiptService(location).list().map((receipt) => [receipt.id, receipt]))
    const latest = [...journal.latestByOperation().values()]
    if (latest.some((entry) => entry.operationType !== 'undo-ref-release' && !settlesItself(entry.operationType) && ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state))) throw new Error('Active or recovery operations protect receipt refs.')
    const releases = new Map(latest.filter((entry) => entry.operationType === 'undo-ref-release').map((entry) => [(entry.details as ReleaseIntent).receiptId, entry]))
    const room = Math.min(RELEASE_BATCH_SIZE, limit - handled.size)
    const eligible = [...new Set([...releases.keys(), ...expired])].filter((id) => {
      const entry = releases.get(id)
      return !handled.has(id) && (entry ? entry.state === 'prepared' : receipts.has(id))
    })
    const candidates: Candidate[] = []
    for (const id of eligible) {
      const entry = releases.get(id)
      const candidate = { receipt: receipts.get(id), operationId: entry?.operationId ?? randomUUID(), intent: entry?.details as ReleaseIntent | undefined }
      if (isolate.has(id)) {
        if (!candidates.length) candidates.push(candidate)
        break
      }
      candidates.push(candidate)
      if (candidates.length >= room) break
    }
    if (!candidates.length) return 'finished'
    const repository = await bounded(repositoryTargetAsync(identity.commonDir, identity.key))
    const end = await this.batch(task, journal, workspacePath, identity, repository, facts, expired, candidates, handled, isolate, result, options, check, bounded)
    if (end !== 'next') return end
    return eligible.some((id) => !handled.has(id)) ? 'yield' : 'finished'
  }

  private async batch(task: ReturnType<ResourceLifecycleStore['require']>, journal: ThreadJournal, workspacePath: string, identity: Awaited<ReturnType<typeof resolveRepositoryIdentityAsync>>, repository: Awaited<ReturnType<typeof repositoryTargetAsync>>, facts: OwnershipFacts, expired: ReadonlySet<string>, candidates: Candidate[], handled: Set<string>, isolate: Set<string>, result: ReceiptRefReleaseResult, options: ReleaseHooks, check: () => void, bounded: <T>(work: Promise<T>) => Promise<T>): Promise<'next' | 'finished' | { changed: string }> {
    const retain = (candidate: Candidate, reason: string): void => {
      handled.add(candidate.intent?.receiptId ?? candidate.receipt?.id ?? candidate.operationId)
      result.retained.push({ receiptId: candidate.receipt?.id ?? candidate.intent?.receiptId ?? '', reason })
    }
    // Each receipt's intent and refs, read in one listing; a ref the listing leaves out is read on its own, so a
    // symbolic ref whose target is gone is never taken for one an interrupted release already removed.
    const ready: Array<{ candidate: Candidate; intent: ReleaseIntent; present: Array<{ name: string; sha: string }> }> = []
    const named: Array<{ candidate: Candidate; intent: ReleaseIntent }> = []
    for (const candidate of candidates) {
      try {
        const receipt = candidate.receipt
        if (!receipt) throw new Error('Release journal references a missing immutable receipt.')
        if (!expired.has(receipt.id)) throw new Error('Receipt Undo claim is still retained.')
        const intent = this.intent(receipt, identity.key)
        if (candidate.intent && JSON.stringify(candidate.intent) !== JSON.stringify(intent)) throw new Error('Release intent does not match immutable receipt ownership.')
        const pending = pendingUndoRefRelease(identity, receipt.id)
        if (pending && pending.operationId !== candidate.operationId) throw new Error('Another task owns this pending Undo ref release.')
        if (pending?.retryAfter && pending.retryAfter > this.now()) throw new Error('Undo refs are waiting to be retried on a later run.')
        named.push({ candidate, intent })
      } catch (error) { retain(candidate, (error as Error).message) }
    }
    const listed = await bounded(readDirectRefsAsync(workspacePath, named.flatMap(({ intent }) => intent.refs.map((ref) => ref.name))))
    for (const { candidate, intent } of named) {
      try {
        const present: Array<{ name: string; sha: string }> = []
        for (const ref of intent.refs) {
          const found = listed.get(ref.name)
          if (found?.error) throw new Error(found.error)
          // A successful exact ref enumeration proves absence. Git errors and symbolic references cannot be
          // interpreted as an interrupted delete.
          const current = found?.sha ?? await bounded(readDirectLifecycleRefAsync(workspacePath, ref.name))
          if (current === undefined) {
            if (!candidate.intent) throw new Error(`Receipt reference is unexpectedly absent: ${ref.name}`)
            continue // interrupted transaction may already have removed it
          }
          if (current !== ref.sha) throw new Error(`Receipt reference changed: ${ref.name}`)
          present.push(ref)
        }
        ready.push({ candidate, intent, present })
      } catch (error) { check(); retain(candidate, (error as Error).message) }
    }
    check()
    if (!ready.length) return 'next'
    const transaction = (items: typeof ready): string => ['start', ...items.flatMap(({ present }) => present.map((ref) => `delete ${ref.name} ${ref.sha}`)), 'prepare', 'commit', ''].join('\n')
    const deletes = ready.some(({ present }) => present.length)
    // Checked (by the central Git check) before ownership is read, so that from there to the start of the transaction nothing waits.
    const argv = deletes ? await bounded(withoutRepoProgramsAsync(workspacePath, ['update-ref', '--no-deref', '--stdin'], { stdin: transaction(ready) })) : undefined
    await bounded(rereadRepositoryFacts(facts, repository))
    check()
    // From here to Git's start, no asynchronous work runs. Other processes that publish claims share this lease.
    const missed: string[] = []
    const inventory = buildResourceInventoryFromFacts(this.store, task, facts, {}, (what) => missed.push(what))
    const ownMissed = missed.length
    let external: ReturnType<typeof getExternalResourceClaimsFromFacts>
    try { external = getExternalResourceClaimsFromFacts(this.store, new Set([task.taskId]), facts, (what) => missed.push(what)) }
    catch (error) { if (missed.length > ownMissed) return { changed: missed[ownMissed]! }; throw error }
    if (missed.length) return { changed: missed[0]! }
    if (inventory.blockers.length) throw new OwnershipBlocked(`Receipt ref release needs unambiguous ownership: ${inventory.blockers.join('; ')}`)
    options.afterCheck?.()
    const refused: Array<{ candidate: Candidate; reason: string }> = []
    for (const { candidate, intent } of ready) {
      for (const ref of intent.refs) {
        const resources = inventory.resources.filter((resource) => resource.kind === 'git-ref' && resource.identity === ref.name)
        // Receipt refs are named by their receipt's id, so a claim on the same name is on this ref whatever repository the
        // claim records: a record written before the repository moved still names the old one.
        if (external.some((resource) => resource.kind === 'git-ref' && resource.identity === ref.name)) { refused.push({ candidate, reason: `Reference is associated with another task or profile: ${ref.name}` }); break }
        // A thread whose checkout can't be verified holds what its records may name, and its repositories (recorded or real).
        const unverified = unverifiedOwnerOver(external, { ...repository, ref: ref.name })
        if (unverified) { refused.push({ candidate, reason: `${unverified.reason} ${ref.name} is kept.` }); break }
        if (!resources.length || resources.some((resource) => resource.ownerTaskId !== task.taskId || resource.repositoryId !== identity.key || resource.claims.length > 0 || resource.ownership === 'unknown')) { refused.push({ candidate, reason: `Reference has an active, shared or unknown claim: ${ref.name}` }); break }
      }
    }
    for (const { candidate, reason } of refused) retain(candidate, reason)
    const approved: typeof ready = []
    for (const item of ready) {
      check()
      const { candidate, intent } = item
      if (handled.has(intent.receiptId)) continue
      try {
        if (!candidate.intent) journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'prepared', details: intent })
        prepareUndoRefRelease(identity, intent.receiptId, candidate.operationId)
        approved.push(item)
      } catch (error) { retain(candidate, (error as Error).message) }
    }
    if (!approved.length) return 'next'
    try {
      options.afterPrepared?.()
      check()
      if (argv && approved.some(({ present }) => present.length)) {
        const ran = await withScopedGitConfig(NO_REF_LOCK_RETRY, () =>
          runGitProcess(argv, { cwd: workspacePath, env: repoProgramEnv(), input: transaction(approved) }))
        check()
        if (ran.error || ran.status !== 0) {
          if (approved.length > 1) for (const { intent } of approved) isolate.add(intent.receiptId)
          else {
            const { candidate, intent } = approved[0]!
            let reason = gitRunError(argv, ran).message
            try { prepareUndoRefRelease(identity, intent.receiptId, candidate.operationId, this.now() + RELEASE_RETRY_DELAY_MS) }
            catch (error) { reason += ` (${(error as Error).message})` }
            retain(candidate, reason)
          }
          return 'next'
        }
      }
      options.afterGit?.()
    } catch (error) {
      check()
      for (const { candidate } of approved) retain(candidate, error instanceof Error ? error.message : String(error))
      return 'finished'
    }
    const after = await bounded(readDirectRefsAsync(workspacePath, approved.flatMap(({ intent }) => intent.refs.map((ref) => ref.name))))
    for (const { candidate, intent } of approved) {
      check()
      try {
        for (const ref of intent.refs) {
          const found = after.get(ref.name)
          if (found?.error) throw new Error(found.error)
          if ((found?.sha ?? await bounded(readDirectLifecycleRefAsync(workspacePath, ref.name))) !== undefined) throw new Error(`Receipt reference survived the release transaction: ${ref.name}`)
        }
        check()
        finishUndoRefRelease(identity, intent.receiptId, candidate.operationId)
        journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'completed', details: intent })
        handled.add(intent.receiptId)
        result.releasedRefs.push(...intent.refs.map((ref) => ref.name))
      } catch (error) { check(); retain(candidate, (error as Error).message) }
    }
    return 'next'
  }

  private intent(receipt: ChangeReceipt, repositoryId: string): ReleaseIntent {
    if (!/^[a-f0-9-]{36}$/i.test(receipt.id) || !/^[a-f0-9]{40,64}$/i.test(receipt.beforeSha) || !/^[a-f0-9]{40,64}$/i.test(receipt.afterSha)) throw new Error('Receipt reference ownership is invalid.')
    const names = [`refs/mousse/changes/${receipt.id}/before`, `refs/mousse/changes/${receipt.id}/after`]
    if (JSON.stringify(receipt.retainedRefs) !== JSON.stringify(names)) throw new Error('Receipt owns an unexpected reference namespace.')
    return { version: 1, receiptId: receipt.id, repositoryId, refs: [{ name: names[0], sha: receipt.beforeSha }, { name: names[1], sha: receipt.afterSha }] }
  }
}
