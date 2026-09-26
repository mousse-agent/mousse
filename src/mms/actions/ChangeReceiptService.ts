import { randomUUID } from 'node:crypto'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { git } from './git'

/** One immutable receipt authority for chat, agents and workflows: the task journal. */
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
      if (existing.beforeSha !== input.beforeSha || existing.afterSha !== input.afterSha || existing.kind !== input.kind) throw new Error('Operation identity was reused for a different change.')
      this.refreshWorkspace(workspacePath, existing)
      return existing
    }
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = manager.load()
    const id = randomUUID()
    const refs = [`refs/mousse/changes/${id}/before`, `refs/mousse/changes/${id}/after`]
    git(workspacePath, ['update-ref', refs[0], input.beforeSha])
    git(workspacePath, ['update-ref', refs[1], input.afterSha])
    const receipt: ChangeReceipt = {
      ...input, id,
      workspaceId: workspace?.workspaceId ?? workspace?.threadId ?? this.threadDirectory,
      generation: (workspace?.generation ?? 0) + 1,
      retainedRefs: refs,
      createdAt: new Date().toISOString()
    }
    // Persist receipt before updating the cached workspace head. Recovery can rebuild the cache.
    this.journal.append({ operationId: input.operationId, operationType: `change-${input.kind}`, state: 'git_applied', details: { receipt } })
    this.refreshWorkspace(workspacePath, receipt)
    return receipt
  }

  private refreshWorkspace(workspacePath: string, receipt: ChangeReceipt): void {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const workspace = manager.load()
    if (!workspace || git(workspace.worktreePath, ['rev-parse', '--show-toplevel']) !== git(workspacePath, ['rev-parse', '--show-toplevel'])) return
    if ((workspace.generation ?? 0) > receipt.generation) return
    git(workspacePath, ['update-ref', workspace.retainedRef, receipt.afterSha])
    atomicWriteJsonSync(manager.workspacePath, { ...workspace, headSha: receipt.afterSha, generation: receipt.generation })
  }

  isPublished(receipt: ChangeReceipt): boolean {
    return this.list().some((item) => item.kind === 'publish' && item.publishedReceiptIds?.includes(receipt.id))
  }

  assertNoPendingOperation(): void {
    const pending = [...this.journal.latestByOperation().values()].find((entry) =>
      ['prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state))
    if (pending) throw new Error(`Workspace recovery required for operation ${pending.operationId} (${pending.operationType}).`)
  }
}
