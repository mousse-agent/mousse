import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { NativeContextBoundary, ThreadAction, ExternalEffect } from '../../shared/threadActions'
import type { ConversationBranchId, WorkspaceActor } from '../../shared/workspace'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ChangeReceiptService } from './ChangeReceiptService'
import { assertHeldThreadLease, withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, git, introducedCommits, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

export interface RunThreadActionOptions {
  threadId: string
  actor?: WorkspaceActor
  runId?: string
  externalEffects?: ExternalEffect[]
  heldThreadLease?: ThreadLeaseHandle
  turnId: string
  conversationBranchId: ConversationBranchId
  workspacePath: string
  presentationMessageStart: number
  presentationMessageEnd: number
  nativeContextStartBoundary?: NativeContextBoundary
  nativeContextBoundary: NativeContextBoundary
  /** Compare under the owning mutation lock before changing Git or metadata. */
  expectedJournalRevision?: number
  signal?: AbortSignal
}

export class StaleThreadActionRevisionError extends Error {
  constructor(readonly currentRevision: number) {
    super(`STALE_JOURNAL_GENERATION:${currentRevision}`)
    this.name = 'StaleThreadActionRevisionError'
  }
}

export class ActionExecutionError extends Error {
  constructor(readonly action: ThreadAction, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ActionExecutionError'
  }
}

export class ThreadActionService {
  private readonly actionsPath: string
  private readonly journal: ThreadJournal

  constructor(private readonly threadDirectory: string) {
    this.actionsPath = join(threadDirectory, 'actions.json')
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ThreadAction[] {
    if (!existsSync(this.actionsPath)) return []
    return JSON.parse(readFileSync(this.actionsPath, 'utf8')) as ThreadAction[]
  }

  get(actionId: string): ThreadAction | undefined {
    return this.list().find((action) => action.id === actionId)
  }

  latest(branchId: ConversationBranchId): ThreadAction | undefined {
    return this.list().filter((action) => action.conversationBranchId === branchId).at(-1)
  }

  replace(actions: ThreadAction[]): void {
    atomicWriteJsonSync(this.actionsPath, actions)
  }

  currentRevision(): number {
    return this.journal.latestSequence()
  }

  assertExpectedRevision(expectedRevision?: number): number {
    const current = this.currentRevision()
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new StaleThreadActionRevisionError(current)
    }
    return current
  }

  /** Durable intent is established before model execution, under its task lease. */
  beginTurn(options: RunThreadActionOptions, startSha: string): ThreadAction {
    if (options.heldThreadLease) assertHeldThreadLease(this.threadDirectory, options.heldThreadLease)
    const existing = this.list().find((item) => item.turnId === options.turnId && item.state === 'running')
    if (existing) return existing
    new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
    this.assertExpectedRevision(options.expectedJournalRevision)
    requireClean(options.workspacePath, 'Thread workspace')
    if (git(options.workspacePath, ['rev-parse', 'HEAD']) !== startSha) throw new Error('Task HEAD changed before turn admission.')
    const actions = this.list()
    const action: ThreadAction = {
      id: randomUUID(), turnId: options.turnId, conversationBranchId: options.conversationBranchId,
      actor: options.actor ?? { kind: 'main' }, runId: options.runId,
      parentActionId: actions.filter((item) => item.conversationBranchId === options.conversationBranchId).at(-1)?.id,
      presentationMessageStart: options.presentationMessageStart, presentationMessageEnd: options.presentationMessageEnd,
      nativeContextStartBoundary: options.nativeContextStartBoundary, nativeContextBoundary: options.nativeContextBoundary,
      startSha, endSha: startSha, commits: [], childIntegrations: [], changedPaths: [],
      externalEffects: options.externalEffects ?? [], reversible: true, state: 'running', createdAt: new Date().toISOString()
    }
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'running', expectedPreState: { startSha, actionId: action.id, branch: git(options.workspacePath, ['branch', '--show-current']) } })
    actions.push(action); this.replace(actions)
    return action
  }

  /** Checkpoint a turn while the caller owns the execution lease, or acquire it for standalone callers. */
  async checkpointExistingTurn(
    options: RunThreadActionOptions,
    startSha: string,
    state: 'completed' | 'stopped' | 'failed'
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, options.workspacePath, 'turn-checkpoint', async () => {
      const actions = this.list()
      let action = actions.find((item) => item.turnId === options.turnId && item.state === 'running')
      if (!action) {
        this.assertExpectedRevision(options.expectedJournalRevision)
        action = {
          id: randomUUID(), turnId: options.turnId, conversationBranchId: options.conversationBranchId,
          actor: options.actor ?? { kind: 'main' }, runId: options.runId,
          parentActionId: actions.filter((item) => item.conversationBranchId === options.conversationBranchId).at(-1)?.id,
          presentationMessageStart: options.presentationMessageStart, presentationMessageEnd: options.presentationMessageEnd,
          nativeContextStartBoundary: options.nativeContextStartBoundary, nativeContextBoundary: options.nativeContextBoundary,
          startSha, endSha: startSha, commits: [], childIntegrations: [], changedPaths: [],
          externalEffects: options.externalEffects ?? [], reversible: true, state: 'running', createdAt: new Date().toISOString()
        }
        actions.push(action)
        this.replace(actions)
        this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'running', expectedPreState: { startSha, actionId: action.id } })
      }
      action.presentationMessageEnd = options.presentationMessageEnd
      action.nativeContextBoundary = options.nativeContextBoundary
      action.externalEffects = options.externalEffects ?? action.externalEffects
      try {
        this.checkpoint(options.workspacePath, action, state)
        // Admission order differs from completion order when a turn snapshots before child spawn.
        actions.splice(actions.indexOf(action), 1); actions.push(action)
        this.replace(actions)
        this.appendCheckpointCompleted(action, state)
        return action
      } catch (error) {
        this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionId: action.id, startSha, error: String(error) } })
        throw error
      }
    }, options.signal, options.heldThreadLease)
  }

  async runCheckpointedAction<T>(
    options: RunThreadActionOptions,
    mutate: () => Promise<T> | T
  ): Promise<{ result: T; action: ThreadAction }> {
    return withGitMutationLocks(
      this.threadDirectory,
      options.workspacePath,
      'thread-action',
      async () => {
        this.assertExpectedRevision(options.expectedJournalRevision)
        requireClean(options.workspacePath, 'Thread workspace')
        const startSha = git(options.workspacePath, ['rev-parse', 'HEAD'])
        const actions = this.list()
        const action: ThreadAction = {
          id: randomUUID(),
          turnId: options.turnId,
          actor: options.actor ?? { kind: 'main' },
          runId: options.runId,
          conversationBranchId: options.conversationBranchId,
          parentActionId: actions.filter((item) => item.conversationBranchId === options.conversationBranchId).at(-1)?.id,
          presentationMessageStart: options.presentationMessageStart,
          presentationMessageEnd: options.presentationMessageEnd,
          nativeContextStartBoundary: options.nativeContextStartBoundary,
          nativeContextBoundary: options.nativeContextBoundary,
          startSha,
          endSha: startSha,
          commits: [],
          childIntegrations: [],
          changedPaths: [],
          externalEffects: options.externalEffects ?? [],
          reversible: true,
          state: 'running',
          createdAt: new Date().toISOString()
        }
        actions.push(action)
        this.replace(actions)
        this.journal.append({
          operationId: action.id,
          operationType: 'action-checkpoint',
          state: 'running',
          expectedPreState: { startSha, branch: git(options.workspacePath, ['branch', '--show-current']) }
        })
        let result: T
        try {
          result = await mutate()
        } catch (error) {
          let checkpointComplete = false
          try {
            this.checkpoint(options.workspacePath, action, 'failed')
            checkpointComplete = true
          } catch (checkpointError) {
            action.state = 'failed'
            action.externalEffects.push({
              kind: 'unknown',
              description: `Partial checkpoint failed: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`,
              reversible: false
            })
          }
          this.replace(actions)
          if (checkpointComplete) {
            this.appendCheckpointCompleted(action, 'failed')
          } else {
            this.journal.append({
              operationId: action.id,
              operationType: 'action-checkpoint',
              state: 'recovery_required',
              details: { actionState: action.state, startSha: action.startSha }
            })
          }
          throw new ActionExecutionError(action, error)
        }
        this.checkpoint(options.workspacePath, action, 'completed')
        this.replace(actions)
        this.appendCheckpointCompleted(action, 'completed')
        return { result, action }
      },
      options.signal,
      options.heldThreadLease
    )
  }

  private checkpoint(
    workspacePath: string,
    action: ThreadAction,
    state: 'completed' | 'stopped' | 'failed'
  ): void {
    workspacePath = git(workspacePath, ['rev-parse', '--show-toplevel'])
    action.state = 'checkpointing'
    git(workspacePath, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
    const staged = !tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok
    if (staged) {
      git(workspacePath, ['commit', '--no-verify', '-m', `mousse: checkpoint turn ${action.turnId}`], MOUSSE_COMMIT_ENV)
    }
    const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
    action.endSha = endSha
    action.commits = introducedCommits(workspacePath, action.startSha, endSha)
    action.changedPaths = changedPaths(workspacePath, action.startSha, endSha)
    action.state = state
    action.completedAt = new Date().toISOString()
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const integrations = receipts.list().filter((item) => item.createdAt >= action.createdAt && item.kind !== 'publish' && item.afterSha !== action.startSha && tryGit(workspacePath, ['merge-base', '--is-ancestor', action.startSha, item.beforeSha]).ok && tryGit(workspacePath, ['merge-base', '--is-ancestor', item.afterSha, action.endSha]).ok)
    const receipt = receipts.record(workspacePath, {
      operationId: action.id, kind: 'checkpoint', actor: action.actor ?? { kind: 'main' },
      actionId: action.id, turnId: action.turnId, runId: action.runId,
      beforeSha: action.startSha, afterSha: action.endSha, introducedCommits: action.commits,
      contributions: integrations.map((item) => ({ receiptId: item.id, baseSha: item.beforeSha, resultSha: item.afterSha })),
      externalEffects: action.externalEffects
    })
    action.receiptId = receipt.id
  }

  private appendCheckpointCompleted(
    action: ThreadAction,
    state: 'completed' | 'stopped' | 'failed'
  ): void {
    this.journal.append({
      operationId: action.id,
      operationType: 'action-checkpoint',
      state: 'completed',
      details: {
        actionState: state,
        startSha: action.startSha,
        endSha: action.endSha,
        commits: action.commits
      }
    })
  }
}
