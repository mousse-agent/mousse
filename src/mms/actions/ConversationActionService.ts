import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { NativeContextBoundary, ThreadAction } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { acquireExecutionLease, tryAcquireExecutionLease, releaseExecutionLeaseHandle, type ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from './GitOperationCoordinator'
import { ThreadActionService } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { ChangeReceiptService } from './ChangeReceiptService'

export function assertConversationBoundary(action: ThreadAction): void {
  const start = action.nativeContextStartBoundary, end = action.nativeContextBoundary
  for (const boundary of [start, end]) {
    if (!boundary || !['exact', 'compacted'].includes(boundary.fidelity) || !Number.isSafeInteger(boundary.compactionGeneration) || boundary.compactionGeneration < 0 || !Number.isSafeInteger(boundary.activeStartIndex ?? 0) || (boundary.activeStartIndex ?? 0) < 0 || (boundary.activeStartIndex ?? 0) > boundary.messageIndex) throw new Error('Conversation boundary metadata is invalid.')
  }
  if (action.scope !== 'conversation' || !start || ![start.messageIndex, end.messageIndex, action.presentationMessageStart, action.presentationMessageEnd].every((value) => Number.isSafeInteger(value) && value >= 0) || start.messageIndex > end.messageIndex || action.presentationMessageStart >= action.presentationMessageEnd || start.fidelity === 'legacy' || end.fidelity === 'legacy' || !start.safeBoundaryProof || !end.safeBoundaryProof || start.compactionGeneration !== end.compactionGeneration || action.externalEffects.length || action.commits.length || action.changedPaths.length || action.startSha || action.endSha) throw new Error('Conversation boundary is unavailable or incomplete.')
}

type Restore = (action: ThreadAction, kind: 'undo' | 'redo') => void
interface Intent { action: ThreadAction; kind?: 'undo' | 'redo' }

/** Pointer-only history in the existing task-owned action store and retention journal. */
export class ConversationActionService {
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly directory: string) {
    this.actions = new ThreadActionService(directory)
    this.journal = new ThreadJournal(directory)
  }

  private save(action: ThreadAction): void {
    const actions = this.actions.list()
    const index = actions.findIndex((item) => item.id === action.id)
    if (index < 0) actions.push(action)
    else actions[index] = action
    this.actions.replace(actions)
  }

  begin(turnId: string, branchId: string, start: number, boundary: NativeContextBoundary, lease: ThreadLeaseHandle): ThreadAction {
    assertHeldThreadLease(this.directory, lease)
    new ChangeReceiptService(this.directory).assertNoPendingOperation()
    if (this.actions.list().some((item) => item.turnId === turnId)) throw new Error('Turn already has a recorded conversation boundary.')
    const action: ThreadAction = {
      scope: 'conversation', id: randomUUID(), turnId, conversationBranchId: branchId,
      presentationMessageStart: start, presentationMessageEnd: start,
      nativeContextStartBoundary: structuredClone(boundary), nativeContextBoundary: structuredClone(boundary),
      startSha: '', endSha: '', commits: [], changedPaths: [], childIntegrations: [], externalEffects: [],
      reversible: false, state: 'running', createdAt: new Date().toISOString()
    }
    this.journal.append({ operationId: action.id, operationType: 'conversation-checkpoint', state: 'running', details: { action } })
    this.save(action)
    return action
  }

  settle(turnId: string, end: number, boundary: NativeContextBoundary, state: 'completed' | 'stopped' | 'failed', toolsUsed: boolean, lease: ThreadLeaseHandle): ThreadAction {
    assertHeldThreadLease(this.directory, lease)
    const previous = this.actions.list().find((item) => item.turnId === turnId)
    if (!previous || previous.scope !== 'conversation' || previous.state !== 'running') throw new Error('Conversation turn has no open boundary.')
    const action: ThreadAction = { ...previous, presentationMessageEnd: end, nativeContextBoundary: structuredClone(boundary), state,
      completedAt: new Date().toISOString(), reversible: state === 'completed' && !toolsUsed && previous.nativeContextStartBoundary?.fidelity !== 'legacy' && boundary.fidelity !== 'legacy' && previous.nativeContextStartBoundary?.compactionGeneration === boundary.compactionGeneration,
      externalEffects: toolsUsed ? [{ kind: 'unknown', description: 'This turn dispatched tools without a workspace checkpoint; conversation undo is unavailable.', reversible: false }] : [] }
    this.journal.append({ operationId: action.id, operationType: 'conversation-checkpoint', state: 'prepared', details: { action } })
    this.save(action)
    this.journal.append({ operationId: action.id, operationType: 'conversation-checkpoint', state: 'completed', details: { action } })
    return action
  }

  recoverHistoryIfIdle(isBusy: () => boolean, restore: Restore): void {
    const pending = [...this.journal.latestByOperation().values()].some(record => record.operationType === 'conversation-history' && !['completed', 'failed', 'cancelled'].includes(record.state))
    if (!pending || isBusy()) return
    const lease = tryAcquireExecutionLease(this.directory, { source: 'conversation-history-recovery' })
    if (!lease) return
    try { if (!isBusy()) this.recover(lease, restore, true) } finally { releaseExecutionLeaseHandle(lease) }
  }

  recover(lease: ThreadLeaseHandle, restore: Restore, historyOnly = false): void {
    assertHeldThreadLease(this.directory, lease)
    for (const record of this.journal.latestByOperation().values()) {
      if (historyOnly && record.operationType !== 'conversation-history') continue
      if (!['conversation-checkpoint', 'conversation-history'].includes(record.operationType) || ['completed', 'failed', 'cancelled'].includes(record.state)) continue
      const intent = record.details as Intent
      if (!intent?.action || intent.action.scope !== 'conversation') throw new Error('Conversation recovery receipt is invalid.')
      let action = intent.action
      if (record.operationType === 'conversation-history') {
        if (intent.kind !== 'undo' && intent.kind !== 'redo') throw new Error('Conversation recovery operation is invalid.')
        assertConversationBoundary(action)
        const current = this.actions.latest(action.conversationBranchId)
        if (!current || !isDeepStrictEqual({ ...current, state: action.state }, action) || action.state !== (intent.kind === 'undo' ? 'undone' : 'completed') || !['completed', 'undone'].includes(current.state)) throw new Error('Conversation recovery target changed; recovery requires review.')
        restore(action, intent.kind)
      } else if (record.state === 'running') {
        action = { ...action, state: 'failed', reversible: false, completedAt: new Date().toISOString() }
      }
      this.save(action)
      this.journal.append({ operationId: record.operationId, operationType: record.operationType, state: 'completed', details: { ...intent, action } })
    }
  }

  apply(branchId: string, kind: 'undo' | 'redo', expectedRevision: number, expectedTurnId: string | undefined, validate: (action: ThreadAction) => void, restore: Restore): ThreadAction {
    const lease = acquireExecutionLease(this.directory, { source: `conversation-${kind}` })
    try {
      this.recover(lease, restore)
      this.actions.assertExpectedRevision(expectedRevision)
      new ChangeReceiptService(this.directory).assertNoPendingOperation()
      const target = this.actions.latest(branchId)
      if (!target || target.scope !== 'conversation' || !target.reversible || target.state !== (kind === 'undo' ? 'completed' : 'undone')) throw new Error('No eligible conversation turn is available.')
      if (expectedTurnId !== undefined && target.turnId !== expectedTurnId) throw new Error('The requested turn is no longer the latest eligible turn.')
      assertConversationBoundary(target)
      validate(target)
      new UndoRetentionService(this.directory).assertAvailable(target)
      const action: ThreadAction = { ...target, state: kind === 'undo' ? 'undone' : 'completed' }
      const operationId = randomUUID()
      // The target state is durable before context changes. Recovery reapplies an idempotent boundary.
      this.journal.append({ operationId, operationType: 'conversation-history', state: 'context_pending', details: { action, kind } })
      restore(action, kind)
      this.save(action)
      this.journal.append({ operationId, operationType: 'conversation-history', state: 'completed', details: { action, kind } })
      return action
    } finally { releaseExecutionLeaseHandle(lease) }
  }
}
