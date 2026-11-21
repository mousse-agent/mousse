import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { repositoryLeaseWanted } from '../git/RepositoryLease'
import { buildResourceInventoryFromFacts, rereadRepositoryFacts, type OwnershipFacts } from '../lifecycle/ResourceInventory'
import { getExternalResourceClaimsFromFacts, repositoryTargetAsync, unverifiedOwnerOver } from '../lifecycle/LifecycleClaims'
import { discoverOwnershipFacts, factsFor } from '../lifecycle/ownershipDiscovery'
import { readDirectLifecycleRefAsync } from '../lifecycle/WorktreeRetirementService'
import { readDirectRefsAsync } from '../lifecycle/worktreeFacts'
import type { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { UndoRetentionService } from './UndoRetentionService'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { settlesItself } from '../../shared/resourceLifecycle'

/** The ownership inventory showed a blocker: the whole release stops, as when it shows one before the first receipt. */
class OwnershipBlocked extends Error {}

interface ReleaseIntent { version: 1; receiptId: string; repositoryId: string; refs: Array<{ name: string; sha: string }> }
export interface ReceiptRefReleaseResult { releasedRefs: string[]; retained: Array<{ receiptId: string; reason: string }>; reclaimedGitBytes: null }

/** Receipts released in one Git transaction, at most. */
export const RELEASE_BATCH_SIZE = 10
/**
 * How long one hold of the repository lease may run before the release lets go between batches and takes the lease
 * again, so a turn that wants the repository waits for at most about one batch.
 */
export const RELEASE_HOLD_BUDGET_MS = 1_000
/** How many times a release discovers ownership again after a record changed while it waited for the lease. */
export const RELEASE_EVIDENCE_RETRIES = 3

type Candidate = { receipt: ChangeReceipt | undefined; operationId: string; intent: ReleaseIntent | undefined }
/** How one hold of the repository lease ended. */
type HoldEnd = 'finished' | 'yield' | { changed: string }

/** Phase 3b: only expired, exclusive immutable receipt refs. Never runs Git GC or deletes user refs. */
export class ReceiptRefReleaseService {
  constructor(private readonly store: ResourceLifecycleStore, private readonly taskId: string, private readonly now: () => number = Date.now) {}

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

  /**
   * Releases the thread's expired receipt refs, in batches, each under a short hold of the repository lease.
   *
   * Who claims what across every profile is discovered before the lease (`discovery`, shared by a cleanup batch and
   * read before any thread's lease, or read here). Under the lease, for each batch: what the facts say about this
   * repository is read again (its worktrees, every real path, the repository's own identity), the refs are read in one
   * listing, and then, with nothing awaited until the Git transaction starts, ownership is checked from the records
   * themselves, the intents are recorded, and one transaction deletes every eligible ref by its expected commit. The
   * refs are read back and the intents completed. A batch stops at `RELEASE_BATCH_SIZE` receipts; between batches the
   * lease is let go once it has been held for `RELEASE_HOLD_BUDGET_MS` or someone in this process waits for it, and taken
   * again. A record that changed while the release waited (a fact the check was not given) lets go, discovers again and
   * retries, at most `RELEASE_EVIDENCE_RETRIES` times; the rest waits for the next run.
   */
  async release(workspacePath: string, options: { limit?: number; signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; discovery?: OwnershipFacts; afterPrepared?: () => void; afterGit?: () => void; afterCheck?: () => void } = {}): Promise<ReceiptRefReleaseResult> {
    const task = this.store.require(this.taskId)
    if (task.state !== 'active') throw new Error('Receipt release requires an active task owner.')
    const admission = this.store.captureAdmission(task.taskId, task.location)
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid receipt release batch size.')
    const result: ReceiptRefReleaseResult = { releasedRefs: [], retained: [], reclaimedGitBytes: null }
    if (!this.hasWork()) return result
    // Before the repository lease: what every other profile and thread claims, and this thread's own checkouts.
    let facts = options.discovery ? options.discovery.copy() : await discoverOwnershipFacts(this.store)
    await factsFor(this.store, facts, new Set([task.taskId]), [task])
    const handled = new Set<string>()
    let retries = 0
    for (;;) {
      const end = await withGitMutationLocks(task.location, workspacePath, 'undo-ref-release', () => this.hold(task.location, workspacePath, admission, facts, limit, handled, result, options), options.signal, options.heldThreadLease)
      if (end === 'finished') return result
      if (end !== 'yield') {
        if (++retries > RELEASE_EVIDENCE_RETRIES) {
          result.retained.push({ receiptId: '', reason: `Ownership kept changing while it was checked (${end.changed}); the release tries again on a later run.` })
          return result
        }
        facts = await discoverOwnershipFacts(this.store, { newerThan: facts.generation })
        await factsFor(this.store, facts, new Set([task.taskId]), [task])
      }
    }
  }

  /** One hold of the repository lease: batches until the budget is spent, someone waits, or nothing is left. */
  private async hold(location: string, workspacePath: string, admission: ReturnType<ResourceLifecycleStore['captureAdmission']>, facts: OwnershipFacts, limit: number, handled: Set<string>, result: ReceiptRefReleaseResult, options: { afterPrepared?: () => void; afterGit?: () => void; afterCheck?: () => void }): Promise<HoldEnd> {
    const task = this.store.require(this.taskId)
    const held = performance.now()
    this.store.assertAdmission(admission)
    const identity = await resolveRepositoryIdentityAsync(workspacePath, { requireMutationCapability: true })
    const workspace = new ThreadWorkspaceManager(location).load()
    if (!workspace || workspace.repositoryId !== identity.key || workspace.lifecycle !== 'ready') throw new Error('Receipt release repository does not match the authoritative task workspace.')
    const retention = new UndoRetentionService(location, this.now)
    if (!retention.clockAllowsRelease()) throw new Error('Clock review or recovery is required before physical receipt release.')
    // This repository's identity, read again under its lease: its keys and the worktrees it registers, which an
    // unverified thread's scope is matched against. Then what the facts say about it, and every alias.
    const repository = await repositoryTargetAsync(identity.commonDir, identity.key)
    await rereadRepositoryFacts(facts, repository)
    for (;;) {
      const journal = new ThreadJournal(location)
      const expired = retention.expiredReceiptIds()
      const receipts = new ChangeReceiptService(location).list()
      const latest = [...journal.latestByOperation().values()]
      if (latest.some((entry) => entry.operationType !== 'undo-ref-release' && !settlesItself(entry.operationType) && ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state))) throw new Error('Active or recovery operations protect receipt refs.')
      const pending = latest.filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'prepared')
      const complete = new Set(latest.filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'completed').map((entry) => (entry.details as ReleaseIntent).receiptId))
      const room = Math.min(RELEASE_BATCH_SIZE, limit - handled.size)
      if (room <= 0) return 'finished'
      const candidates: Candidate[] = [...pending.map((entry) => ({ receipt: receipts.find((receipt) => receipt.id === (entry.details as ReleaseIntent).receiptId), operationId: entry.operationId, intent: entry.details as ReleaseIntent })),
        ...receipts.filter((receipt) => expired.has(receipt.id) && !complete.has(receipt.id) && !pending.some((entry) => (entry.details as ReleaseIntent).receiptId === receipt.id)).map((receipt) => ({ receipt, operationId: randomUUID(), intent: undefined as ReleaseIntent | undefined }))]
        .filter((candidate) => !handled.has(candidate.intent?.receiptId ?? candidate.receipt?.id ?? candidate.operationId)).slice(0, room)
      if (!candidates.length) return 'finished'
      const end = await this.batch(task, journal, workspacePath, identity, repository, facts, expired, candidates, handled, result, options)
      if (end !== 'next') return end
      // Let go between batches once the hold is long or a turn wants the repository; the release takes it again.
      if (performance.now() - held >= RELEASE_HOLD_BUDGET_MS || repositoryLeaseWanted(identity.key)) return 'yield'
    }
  }

  private async batch(task: ReturnType<ResourceLifecycleStore['require']>, journal: ThreadJournal, workspacePath: string, identity: Awaited<ReturnType<typeof resolveRepositoryIdentityAsync>>, repository: Awaited<ReturnType<typeof repositoryTargetAsync>>, facts: OwnershipFacts, expired: ReadonlySet<string>, candidates: Candidate[], handled: Set<string>, result: ReceiptRefReleaseResult, options: { afterPrepared?: () => void; afterGit?: () => void; afterCheck?: () => void }): Promise<'next' | 'finished' | { changed: string }> {
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
        named.push({ candidate, intent })
      } catch (error) { retain(candidate, (error as Error).message) }
    }
    const listed = await readDirectRefsAsync(workspacePath, named.flatMap(({ intent }) => intent.refs.map((ref) => ref.name)))
    for (const { candidate, intent } of named) {
      try {
        const present: Array<{ name: string; sha: string }> = []
        for (const ref of intent.refs) {
          const found = listed.get(ref.name)
          if (found?.error) throw new Error(found.error)
          // A successful exact ref enumeration proves absence. Git errors and symbolic references cannot be
          // interpreted as an interrupted delete.
          const current = found?.sha ?? await readDirectLifecycleRefAsync(workspacePath, ref.name)
          if (current === undefined) {
            if (!candidate.intent) throw new Error(`Receipt reference is unexpectedly absent: ${ref.name}`)
            continue // interrupted transaction may already have removed it
          }
          if (current !== ref.sha) throw new Error(`Receipt reference changed: ${ref.name}`)
          present.push(ref)
        }
        ready.push({ candidate, intent, present })
      } catch (error) { retain(candidate, (error as Error).message) }
    }
    if (!ready.length) return 'next'
    const release = `start\n${ready.flatMap(({ present }) => present).map((ref) => `delete ${ref.name} ${ref.sha}`).join('\n')}\nprepare\ncommit\n`
    const deletes = ready.some(({ present }) => present.length)
    // Checked (by the central Git check) before ownership is read, so that from there to the start of the transaction nothing waits.
    const argv = deletes ? await withoutRepoProgramsAsync(workspacePath, ['update-ref', '--no-deref', '--stdin'], { stdin: release }) : undefined
    // From here to the start of the transaction nothing is awaited: the records are read, every claim is checked, and
    // the intents are recorded, so a claim written by anything that runs in this process is either seen here or written
    // after the refs are gone.
    const missed: string[] = []
    const inventory = buildResourceInventoryFromFacts(this.store, task, facts, {}, (what) => missed.push(what))
    let external: ReturnType<typeof getExternalResourceClaimsFromFacts>
    try { external = getExternalResourceClaimsFromFacts(this.store, new Set([task.taskId]), facts, (what) => missed.push(what)) }
    catch (error) { if (missed.length) return { changed: missed[0]! }; throw error }
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
    if (refused.length) {
      // The transaction was checked for every receipt in it: the refused ones are kept, the rest go in the next batch.
      for (const { candidate, reason } of refused) retain(candidate, reason)
      return 'next'
    }
    for (const { candidate, intent } of ready) if (!candidate.intent) journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'prepared', details: intent })
    try {
      options.afterPrepared?.()
      if (argv) {
        const ran = await runGitProcess(argv, { cwd: workspacePath, env: repoProgramEnv(), input: release })
        if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
      }
      options.afterGit?.()
      const after = await readDirectRefsAsync(workspacePath, ready.flatMap(({ intent }) => intent.refs.map((ref) => ref.name)))
      for (const { intent } of ready) for (const ref of intent.refs) if (after.get(ref.name)?.sha !== undefined || after.get(ref.name)?.error) throw new Error('Receipt reference survived the release transaction.')
    } catch (error) {
      // The prepared intents stay visible and block other mutations until this service retries them.
      for (const { candidate } of ready) retain(candidate, error instanceof Error ? error.message : String(error))
      return 'finished'
    }
    for (const { candidate, intent } of ready) {
      journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'completed', details: intent })
      handled.add(intent.receiptId)
      result.releasedRefs.push(...intent.refs.map((ref) => ref.name))
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
