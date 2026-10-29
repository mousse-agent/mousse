import { randomUUID } from 'node:crypto'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { recordSnapshotSha } from '../workspace/SnapshotWorkspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { coverageNotice } from './snapshots'
import { git } from './git'
import type { Snapshot } from './snapshots'
import { UndoRetentionService } from './UndoRetentionService'

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)])) : input
  return JSON.stringify(normalize(value))
}

/** One immutable receipt authority for chat, agents and workflows: the task journal. */
const isPublish = (type: string): boolean => type === 'publish' || type === 'change-publish'

export class ChangeReceiptService {
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ChangeReceipt[] {
    const receipts = new Map<string, ChangeReceipt>()
    for (const entry of this.journal.list()) {
      const receipt = (entry.details as { receipt?: ChangeReceipt } | undefined)?.receipt
      if (receipt?.id) receipts.set(receipt.id, receipt)
    }
    return [...receipts.values()]
  }

  /** Caller holds task and repository leases. Replay of an operation is idempotent. */
  record(workspacePath: string, input: Omit<ChangeReceipt, 'id' | 'workspaceId' | 'generation' | 'retainedRefs' | 'createdAt'>): ChangeReceipt {
    const existing = this.list().find((receipt) => receipt.operationId === input.operationId)
    if (existing) {
      const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, notCovered: _notCovered, ...original } = existing
      if (canonical(original) !== canonical(input)) throw new Error('Operation identity was reused for a different change.')
      // An immutable replay is audit lookup, never authority to recreate expired refs.
      if (!new UndoRetentionService(this.threadDirectory).isReceiptExpired(existing.id)) this.refreshWorkspace(workspacePath, existing)
      return existing
    }
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = manager.loadOrSnapshot()
    const id = randomUUID()
    const refs = [`refs/mousse/changes/${id}/before`, `refs/mousse/changes/${id}/after`]
    git(workspacePath, ['update-ref', '--no-deref', refs[0], input.beforeSha])
    git(workspacePath, ['update-ref', '--no-deref', refs[1], input.afterSha])
    const receipt: ChangeReceipt = {
      ...input, id,
      ...(coverageNotice(input.git?.coverageGaps) ? { notCovered: coverageNotice(input.git?.coverageGaps) } : {}),
      workspaceId: workspace?.workspaceId ?? workspace?.threadId ?? this.threadDirectory,
      generation: Math.max(workspace?.generation ?? 0, ...this.list().map((item) => item.generation), 0) + 1,
      retainedRefs: refs,
      createdAt: new Date().toISOString()
    }
    // Persist receipt before updating the cached workspace head. Recovery can rebuild the cache.
    this.journal.append({ operationId: input.operationId, operationType: `change-${input.kind}`, state: 'git_applied', details: { receipt } })
    this.refreshWorkspace(workspacePath, receipt)
    return receipt
  }

  /** Records an existing receipt again, as recovery does after an interruption: the same change, with its refs and workspace cache refreshed. */
  replay(workspacePath: string, receipt: ChangeReceipt): ChangeReceipt {
    const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, ...input } = receipt
    return this.record(workspacePath, input)
  }

  private refreshWorkspace(workspacePath: string, receipt: ChangeReceipt): void {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = manager.loadOrSnapshot()
    if (!workspace || git(workspace.worktreePath, ['rev-parse', '--show-toplevel']) !== git(workspacePath, ['rev-parse', '--show-toplevel'])) return
    if ((workspace.generation ?? 0) > receipt.generation) return
    git(workspacePath, ['update-ref', '--no-deref', workspace.retainedRef, receipt.afterSha])
    // A folder that is the person's has no `workspace.json`; its record keeps the latest snapshot.
    if (workspace.snapshotOnly) return recordSnapshotSha(this.threadDirectory, receipt.afterSha)
    // A snapshot receipt moves the pin and the latest snapshot; HEAD is whatever the thread's Git left it at.
    const snapshot = receipt.git ? { snapshotSha: receipt.afterSha } : {}
    atomicWriteJsonSync(manager.workspacePath, { ...workspace, ...snapshot, headSha: receipt.git ? receipt.git.headAfter ?? workspace.headSha : receipt.afterSha, generation: receipt.generation })
  }

  /**
   * Makes `snapshot` the latest one without a receipt, for a start that found nothing outside Mousse's records
   * changed: `retainedRef` keeps pointing at the newest snapshot, so the next turn compares against it.
   */
  adoptSnapshot(workspacePath: string, snapshot: Snapshot): void {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = manager.loadOrSnapshot()
    if (!workspace || git(workspace.worktreePath, ['rev-parse', '--show-toplevel']) !== git(workspacePath, ['rev-parse', '--show-toplevel'])) return
    if (workspace.snapshotSha === snapshot.sha) return
    git(workspacePath, ['update-ref', '--no-deref', workspace.retainedRef, snapshot.sha])
    if (workspace.snapshotOnly) return recordSnapshotSha(this.threadDirectory, snapshot.sha)
    atomicWriteJsonSync(manager.workspacePath, { ...workspace, snapshotSha: snapshot.sha, headSha: snapshot.head ?? workspace.headSha })
  }

  isPublished(receipt: ChangeReceipt): boolean {
    return this.list().some((item) => item.kind === 'publish' && item.publishedReceiptIds?.includes(receipt.id))
  }

  assertNoPendingOperation(): void {
    // A publish waiting to be settled concerns the primary checkout only; it never holds up the thread's own work.
    const pending = [...this.journal.latestByOperation().values()].find((entry) =>
      ['prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state) && !isPublish(entry.operationType))
    if (pending) throw new Error(`Workspace recovery required for operation ${pending.operationId} (${pending.operationType}).`)
  }
}
