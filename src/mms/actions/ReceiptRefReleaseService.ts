import { randomUUID } from 'node:crypto'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { buildResourceInventory, buildResourceInventoryFromFacts, OwnershipFacts } from '../lifecycle/ResourceInventory'
import { getExternalResourceClaims, getExternalResourceClaimsFromFacts, unverifiedOwnerOver } from '../lifecycle/LifecycleClaims'
import { readDirectLifecycleRefAsync } from '../lifecycle/WorktreeRetirementService'
import type { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { UndoRetentionService } from './UndoRetentionService'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { PRESERVED_EXPIRY_OPERATION } from '../../shared/resourceLifecycle'

/** The ownership inventory showed a blocker: the whole release stops, as when it shows one before the first receipt. */
class OwnershipBlocked extends Error {}

interface ReleaseIntent { version: 1; receiptId: string; repositoryId: string; refs: Array<{ name: string; sha: string }> }
export interface ReceiptRefReleaseResult { releasedRefs: string[]; retained: Array<{ receiptId: string; reason: string }>; reclaimedGitBytes: null }

/** Phase 3b: only expired, exclusive immutable receipt refs. Never runs Git GC or deletes user refs. */
export class ReceiptRefReleaseService {
  constructor(private readonly store: ResourceLifecycleStore, private readonly taskId: string, private readonly now: () => number = Date.now) {}

  async release(workspacePath: string, options: { limit?: number; signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; afterPrepared?: () => void; afterGit?: () => void } = {}): Promise<ReceiptRefReleaseResult> {
    const task = this.store.require(this.taskId)
    if (task.state !== 'active') throw new Error('Receipt release requires an active task owner.')
    const admission = this.store.captureAdmission(task.taskId, task.location)
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid receipt release batch size.')
    return withGitMutationLocks(task.location, workspacePath, 'undo-ref-release', async () => {
      this.store.assertAdmission(admission)
      const identity = await resolveRepositoryIdentityAsync(workspacePath, { requireMutationCapability: true })
      const workspace = new ThreadWorkspaceManager(task.location).load()
      if (!workspace || workspace.repositoryId !== identity.key || workspace.lifecycle !== 'ready') throw new Error('Receipt release repository does not match the authoritative task workspace.')
      const journal = new ThreadJournal(task.location)
      const retention = new UndoRetentionService(task.location, this.now)
      if (!retention.clockAllowsRelease()) throw new Error('Clock review or recovery is required before physical receipt release.')
      const expired = retention.expiredReceiptIds()
      const receipts = new ChangeReceiptService(task.location).list()
      const latest = [...journal.latestByOperation().values()]
      if (latest.some((entry) => entry.operationType !== 'undo-ref-release' && entry.operationType !== PRESERVED_EXPIRY_OPERATION && ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state))) throw new Error('Active or recovery operations protect receipt refs.')
      const pending = latest.filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'prepared')
      const complete = new Set(latest.filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'completed').map((entry) => (entry.details as ReleaseIntent).receiptId))
      const candidates = [...pending.map((entry) => ({ receipt: receipts.find((receipt) => receipt.id === (entry.details as ReleaseIntent).receiptId), operationId: entry.operationId, intent: entry.details as ReleaseIntent })),
        ...receipts.filter((receipt) => expired.has(receipt.id) && !complete.has(receipt.id) && !pending.some((entry) => (entry.details as ReleaseIntent).receiptId === receipt.id)).map((receipt) => ({ receipt, operationId: randomUUID(), intent: undefined as ReleaseIntent | undefined }))].slice(0, limit)
      const result: ReceiptRefReleaseResult = { releasedRefs: [], retained: [], reclaimedGitBytes: null }
      if (!candidates.length) return result
      // All live source records, across this profile, are re-read inside the repository lease: here, and again right
      // before each receipt's transaction starts, with no await in between, since the reads of the refs now wait. The
      // checkouts and project folders they name are read just before, without blocking (`OwnershipFacts`); a record
      // that names one those facts do not cover fails closed.
      let facts = new OwnershipFacts()
      const readFacts = async (): Promise<void> => {
        facts = new OwnershipFacts()
        await buildResourceInventory(this.store, task, {}, facts)
        // Only the facts are wanted here: a refusal is made again, from the records, by `ownership`.
        await getExternalResourceClaims(this.store, new Set([task.taskId]), facts).catch(() => undefined)
      }
      const ownership = () => {
        const inventory = buildResourceInventoryFromFacts(this.store, task, facts)
        const external = getExternalResourceClaimsFromFacts(this.store, new Set([task.taskId]), facts)
        const blockers = inventory.blockers
        if (blockers.length) throw new OwnershipBlocked(`Receipt ref release needs unambiguous ownership: ${blockers.join('; ')}`)
        return { inventory, external }
      }
      await readFacts()
      ownership()
      for (const candidate of candidates) {
        const receipt = candidate.receipt
        if (!receipt) throw new Error('Release journal references a missing immutable receipt.')
        try {
          if (!expired.has(receipt.id)) throw new Error('Receipt Undo claim is still retained.')
          const intent = this.intent(receipt, identity.key)
          if (candidate.intent && JSON.stringify(candidate.intent) !== JSON.stringify(intent)) throw new Error('Release intent does not match immutable receipt ownership.')
          const present: Array<{ name: string; sha: string }> = []
          for (const ref of intent.refs) {
            // A successful exact ref enumeration proves absence. Git errors and
            // symbolic references cannot be interpreted as an interrupted delete.
            const current = await readDirectLifecycleRefAsync(workspacePath, ref.name)
            if (current === undefined) {
              if (!candidate.intent) throw new Error(`Receipt reference is unexpectedly absent: ${ref.name}`)
              continue // interrupted transaction may already have removed it
            }
            if (current !== ref.sha) throw new Error(`Receipt reference changed: ${ref.name}`)
            present.push(ref)
          }
          const release = `start\n${present.map((ref) => `delete ${ref.name} ${ref.sha}`).join('\n')}\nprepare\ncommit\n`
          // Checked (by the central Git check) before ownership is read, so that from there to the start of the transaction nothing waits.
          const argv = present.length ? await withoutRepoProgramsAsync(workspacePath, ['update-ref', '--no-deref', '--stdin'], { stdin: release }) : undefined
          await readFacts()
          const { inventory, external } = ownership()
          for (const ref of intent.refs) {
            const resources = inventory.resources.filter((resource) => resource.kind === 'git-ref' && resource.identity === ref.name)
            // Receipt refs are named by their receipt's id, so a claim on the same name is on this ref whatever repository the
            // claim records: a record written before the repository moved still names the old one.
            if (external.some((resource) => resource.kind === 'git-ref' && resource.identity === ref.name)) throw new Error(`Reference is associated with another task or profile: ${ref.name}`)
            // A thread whose checkout can't be verified holds what its records may name, and its repositories (recorded or real).
            const unverified = unverifiedOwnerOver(external, { repositoryIds: [identity.key], ref: ref.name })
            if (unverified) throw new Error(`${unverified.reason} ${ref.name} is kept.`)
            if (!resources.length || resources.some((resource) => resource.ownerTaskId !== task.taskId || resource.repositoryId !== identity.key || resource.claims.length > 0 || resource.ownership === 'unknown')) throw new Error(`Reference has an active, shared or unknown claim: ${ref.name}`)
          }
          if (!candidate.intent) journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'prepared', details: intent })
          options.afterPrepared?.()
          if (argv) {
            const ran = await runGitProcess(argv, { cwd: workspacePath, env: repoProgramEnv(), input: release })
            if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
          }
          options.afterGit?.()
          for (const ref of intent.refs) if (await readDirectLifecycleRefAsync(workspacePath, ref.name) !== undefined) throw new Error('Receipt reference survived the release transaction.')
          journal.append({ operationId: candidate.operationId, operationType: 'undo-ref-release', state: 'completed', details: intent })
          result.releasedRefs.push(...intent.refs.map((ref) => ref.name))
        } catch (error) {
          if (error instanceof OwnershipBlocked) throw error
          result.retained.push({ receiptId: receipt.id, reason: error instanceof Error ? error.message : String(error) })
          // A pending operation remains visible and blocks other mutations until this service retries.
          if (journal.latestByOperation().get(candidate.operationId)?.state === 'prepared') break
        }
      }
      return result
    }, options.signal, options.heldThreadLease)
  }

  private intent(receipt: ChangeReceipt, repositoryId: string): ReleaseIntent {
    if (!/^[a-f0-9-]{36}$/i.test(receipt.id) || !/^[a-f0-9]{40,64}$/i.test(receipt.beforeSha) || !/^[a-f0-9]{40,64}$/i.test(receipt.afterSha)) throw new Error('Receipt reference ownership is invalid.')
    const names = [`refs/mousse/changes/${receipt.id}/before`, `refs/mousse/changes/${receipt.id}/after`]
    if (JSON.stringify(receipt.retainedRefs) !== JSON.stringify(names)) throw new Error('Receipt owns an unexpected reference namespace.')
    return { version: 1, receiptId: receipt.id, repositoryId, refs: [{ name: names[0], sha: receipt.beforeSha }, { name: names[1], sha: receipt.afterSha }] }
  }
}
