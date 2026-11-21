import { randomUUID } from 'node:crypto'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { recordSnapshotSha } from '../workspace/SnapshotWorkspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { coverageNotice } from './snapshots'
import { gitAsync } from './git'
import type { Snapshot } from './snapshots'
import { UndoRetentionService } from './UndoRetentionService'
import { settlesItself } from '../../shared/resourceLifecycle'
import { repositoryFacts } from '../git/repositoryFacts'

/** `rev-parse --show-toplevel`, from the turn's shared facts when they are open (`repositoryFacts.ts`). */
async function topOf(cwd: string): Promise<string> {
  return (await repositoryFacts(cwd))?.top ?? await gitAsync(cwd, ['rev-parse', '--show-toplevel'])
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)])) : input
  return JSON.stringify(normalize(value))
}

/** One immutable receipt authority for chat, agents and workflows: the task journal. */
const isPublish = (type: string): boolean => type === 'publish' || type === 'change-publish'

export class ChangeReceiptService {
  private readonly journal: ThreadJournal
  /** `readOnly`: only lists receipts, so it never needs the thread's admission (a permanent delete fences it). */
  constructor(private readonly threadDirectory: string, options: { readOnly?: boolean } = {}) {
    this.journal = new ThreadJournal(threadDirectory, options.readOnly ? { readOnly: true } : {})
  }

  /**
   * Each receipt by id, its latest record winning, in the order ids first appeared. Kept with the journal's index
   * (`ThreadJournal.receipts`), so a call costs only the records written since the last one. Shared and frozen.
   */
  list(): readonly ChangeReceipt[] {
    return this.journal.receipts()
  }

  /** Caller holds task and repository leases. Replay of an operation is idempotent. Git runs without blocking the daemon. */
  async record(workspacePath: string, input: Omit<ChangeReceipt, 'id' | 'workspaceId' | 'generation' | 'retainedRefs' | 'createdAt'>): Promise<ChangeReceipt> {
    const existing = this.list().find((receipt) => receipt.operationId === input.operationId)
    if (existing) {
      const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, notCovered: _notCovered, ...original } = existing
      if (canonical(original) !== canonical(input)) throw new Error('Operation identity was reused for a different change.')
      // An immutable replay is audit lookup, never authority to recreate expired refs.
      if (!new UndoRetentionService(this.threadDirectory).isReceiptExpired(existing.id)) await this.refreshWorkspace(workspacePath, existing)
      return existing
    }
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = await manager.loadOrSnapshotAsync()
    const id = randomUUID()
    const refs = [`refs/mousse/changes/${id}/before`, `refs/mousse/changes/${id}/after`]
    // The workspace's pin of its newest snapshot (`refreshWorkspace`) is written with the receipt's own refs, in one
    // transaction and one Git process; the record of the workspace is still written only after the journal.
    const pin = workspace && await topOf(workspace.worktreePath) === await topOf(workspacePath) ? workspace.retainedRef : undefined
    const updates = [[refs[0]!, input.beforeSha], [refs[1]!, input.afterSha], ...(pin ? [[pin, input.afterSha]] : [])]
    await gitAsync(workspacePath, ['update-ref', '--no-deref', '--stdin'], undefined, ['start', ...updates.map(([ref, sha]) => `update ${ref} ${sha}`), 'prepare', 'commit', ''].join('\n'))
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
    await this.refreshWorkspace(workspacePath, receipt, pin)
    return receipt
  }

  /** Records an existing receipt again, as recovery does after an interruption: the same change, with its refs and workspace cache refreshed. */
  replay(workspacePath: string, receipt: ChangeReceipt): Promise<ChangeReceipt> {
    const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, notCovered: _notCovered, ...input } = receipt
    return this.record(workspacePath, input)
  }

  /** `pinned`: the pin `record` already moved to this receipt's end, in its own refs' transaction. */
  private async refreshWorkspace(workspacePath: string, receipt: ChangeReceipt, pinned?: string): Promise<void> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = await manager.loadOrSnapshotAsync()
    if (!workspace || await topOf(workspace.worktreePath) !== await topOf(workspacePath)) return
    if ((workspace.generation ?? 0) > receipt.generation) return
    if (pinned !== workspace.retainedRef) await gitAsync(workspacePath, ['update-ref', '--no-deref', workspace.retainedRef, receipt.afterSha])
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
  async adoptSnapshot(workspacePath: string, snapshot: Snapshot): Promise<void> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = await manager.loadOrSnapshotAsync()
    if (!workspace || await topOf(workspace.worktreePath) !== await topOf(workspacePath)) return
    if (workspace.snapshotSha === snapshot.sha) return
    await gitAsync(workspacePath, ['update-ref', '--no-deref', workspace.retainedRef, snapshot.sha])
    if (workspace.snapshotOnly) return recordSnapshotSha(this.threadDirectory, snapshot.sha)
    atomicWriteJsonSync(manager.workspacePath, { ...workspace, snapshotSha: snapshot.sha, headSha: snapshot.head ?? workspace.headSha })
  }

  isPublished(receipt: ChangeReceipt): boolean {
    return this.list().some((item) => item.kind === 'publish' && item.publishedReceiptIds?.includes(receipt.id))
  }

  assertNoPendingOperation(): void {
    // A publish waiting to be settled concerns the primary checkout only; it never holds up the thread's own work.
    const pending = this.journal.unsettled().find((entry) =>
      ['prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state) && !isPublish(entry.operationType) && !settlesItself(entry.operationType))
    if (pending) throw new Error(`Workspace recovery required for operation ${pending.operationId} (${pending.operationType}).`)
  }
}
