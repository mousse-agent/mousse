import { AppError, knownAppError } from '../../shared/errors'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { NativeContextBoundary, ThreadAction, ExternalEffect } from '../../shared/threadActions'
import type { ConversationBranchId, WorkspaceActor } from '../../shared/workspace'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { assertHeldThreadLease, withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, git, introducedCommits, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

export interface RunThreadActionOptions {
  threadId: string
  actor?: WorkspaceActor
  runId?: string
  externalEffects?: ExternalEffect[]
  /** Explicit human commit may capture existing dirty owned inputs. Never used on primary. */
  allowDirtyInput?: boolean
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

const IN_PROGRESS_GIT_MARKERS = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'] as const

/** Refuse to snapshot a workspace that is mid-merge/revert/cherry-pick/rebase or has unmerged paths; `git add -A` would commit conflict markers. */
function assertNoInProgressGitOperation(workspacePath: string): void {
  for (const marker of IN_PROGRESS_GIT_MARKERS) {
    const resolved = tryGit(workspacePath, ['rev-parse', '--git-path', marker])
    if (!resolved.ok) continue
    if (existsSync(resolve(workspacePath, resolved.stdout))) throw knownAppError({ code: 'workspace_conflict', message: 'Cannot checkpoint: the workspace has an in-progress Git operation; resolve or abort the conflict first.' }, { category: 'conflict', retryable: false })
  }
  const unmerged = tryGit(workspacePath, ['diff', '--name-only', '--diff-filter=U'])
  if (unmerged.ok && unmerged.stdout) throw knownAppError({ code: 'workspace_conflict', message: 'Cannot checkpoint: the workspace has unmerged paths; resolve the conflicts first.' }, { category: 'conflict', retryable: false })
}

export class StaleThreadActionRevisionError extends AppError {
  constructor(readonly currentRevision: number) {
    super({ code: 'stale_journal_generation', message: `STALE_JOURNAL_GENERATION:${currentRevision}`, details: { actualRevision: currentRevision }, errorInfo: { category: 'conflict', retryable: false } })
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
    const existing = this.list().find((item) => item.turnId === options.turnId)
    if (existing) {
      if (existing.startSha !== startSha || existing.conversationBranchId !== options.conversationBranchId) throw new Error('Turn identity was reused for a different workspace boundary.')
      if (existing.state !== 'running') throw new Error('This turn already has a durable result; model execution must not be replayed.')
      return existing
    }
    new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
    this.assertExpectedRevision(options.expectedJournalRevision)
    requireClean(options.workspacePath, 'Thread workspace')
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    if (metadata && metadata.headSha !== startSha) throw new Error('Workspace HEAD moved outside a recorded operation; recovery is required.')
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
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'running', expectedPreState: { startSha, actionId: action.id, branch: git(options.workspacePath, ['branch', '--show-current']) }, details: { action } })
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
      const completed = actions.find((item) => item.turnId === options.turnId && item.state !== 'running')
      if (completed) {
        if (completed.startSha !== startSha || completed.conversationBranchId !== options.conversationBranchId || completed.runId !== options.runId ||
            completed.presentationMessageStart !== options.presentationMessageStart || completed.presentationMessageEnd !== options.presentationMessageEnd ||
            !isDeepStrictEqual(completed.nativeContextBoundary, options.nativeContextBoundary) || !isDeepStrictEqual(completed.nativeContextStartBoundary, options.nativeContextStartBoundary) ||
            !isDeepStrictEqual(completed.actor ?? { kind: 'main' }, options.actor ?? { kind: 'main' })) throw new Error('Turn identity was reused for a different workspace boundary or context payload.')
        if (this.journal.latestByOperation().get(completed.id)?.state !== 'completed') throw new Error('Checkpoint result requires operation recovery.')
        return completed
      }
      let action = actions.find((item) => item.turnId === options.turnId && item.state === 'running')
      if (!action) {
        new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
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
        new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
        const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
        if (metadata && (metadata.lifecycle !== 'ready' || metadata.headSha !== git(options.workspacePath, ['rev-parse', 'HEAD']) || metadata.branch !== git(options.workspacePath, ['branch', '--show-current']))) throw new Error('Workspace HEAD or branch moved outside a recorded operation; recovery is required.')
        this.assertExpectedRevision(options.expectedJournalRevision)
        if (!options.allowDirtyInput) requireClean(options.workspacePath, 'Thread workspace')
        const startSha = git(options.workspacePath, ['rev-parse', 'HEAD'])
        const actions = this.list()
        if (actions.some((item) => item.turnId === options.turnId)) throw new Error('This turn already has a durable intent; execution must not be replayed.')
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

  /** Recover an interrupted writer as captured code, never replay its model/tools. */
  async recoverPending(workspacePath: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'checkpoint-recovery', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      for (const entry of [...this.journal.latestByOperation().values()].reverse()) {
        if (!['action-checkpoint', 'change-checkpoint'].includes(entry.operationType) || !['running', 'prepared', 'git_applied', 'recovery_required'].includes(entry.state)) continue
        const history = this.journal.list().filter((item) => item.operationId === entry.operationId)
        const all = this.list()
        const saved = [...history].reverse().map((item) => item.details as { action?: ThreadAction; actionState?: 'completed' | 'stopped' | 'failed' } | undefined).find((item) => item?.action)
        let action = saved?.action ?? all.find((item) => item.id === entry.operationId)
        if (!action) throw new Error('Interrupted checkpoint has no durable action boundary.')
        action = structuredClone(action)
        const receipt = receipts.list().find((item) => item.operationId === entry.operationId)
        const state = saved?.actionState ?? 'stopped'
        if (receipt) {
          if (git(workspacePath, ['rev-parse', 'HEAD']) !== receipt.afterSha) throw new Error('Checkpoint recovery HEAD does not match the receipt.')
          requireClean(workspacePath, 'Thread workspace')
          const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, ...input } = receipt
          receipts.record(workspacePath, input)
          action.receiptId = receipt.id; action.endSha = receipt.afterSha; action.commits = receipt.introducedCommits
          action.changedPaths = changedPaths(workspacePath, action.startSha, action.endSha)
          action.externalEffects = receipt.externalEffects
          action.state = state; action.completedAt = receipt.createdAt
        } else {
          if (!tryGit(workspacePath, ['merge-base', '--is-ancestor', action.startSha, 'HEAD']).ok) throw new Error('Interrupted writer HEAD diverged from its recorded start.')
          this.checkpoint(workspacePath, action, state)
        }
        const index = all.findIndex((item) => item.id === action.id)
        if (index >= 0) all.splice(index, 1)
        all.push(action); this.replace(all)
        this.appendCheckpointCompleted(action, state)
      }
    }, undefined, heldThreadLease)
  }

  private checkpoint(
    workspacePath: string,
    action: ThreadAction,
    state: 'completed' | 'stopped' | 'failed'
  ): void {
    workspacePath = git(workspacePath, ['rev-parse', '--show-toplevel'])
    assertNoInProgressGitOperation(workspacePath)
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    // An admitted writer may author commits itself. Preserve them when they descend
    // from the verified managed head; admission rejects moves between turns.
    if (metadata && git(workspacePath, ['branch', '--show-current']) !== metadata.branch) throw new Error('Workspace branch changed during execution; recovery is required.')
    if (metadata && !tryGit(workspacePath, ['merge-base', '--is-ancestor', metadata.headSha, 'HEAD']).ok) throw new Error('Workspace history diverged during execution; recovery is required.')
    action.state = 'checkpointing'
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'prepared', expectedPreState: { startSha: action.startSha, headSha: git(workspacePath, ['rev-parse', 'HEAD']) }, details: { action, actionState: state } })
    git(workspacePath, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
    const staged = !tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok
    if (staged) {
      git(workspacePath, ['commit', '--no-verify', '-m', `mousse: checkpoint turn ${action.turnId} (${action.id})`], MOUSSE_COMMIT_ENV)
    }
    const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
    action.endSha = endSha
    action.commits = introducedCommits(workspacePath, action.startSha, endSha)
    action.changedPaths = changedPaths(workspacePath, action.startSha, endSha)
    action.state = state
    action.completedAt = new Date().toISOString()
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const integrations = receipts.list().filter((item) => item.operationId !== action.id && item.createdAt >= action.createdAt && item.kind !== 'publish' && item.afterSha !== action.startSha && tryGit(workspacePath, ['merge-base', '--is-ancestor', action.startSha, item.beforeSha]).ok && tryGit(workspacePath, ['merge-base', '--is-ancestor', item.afterSha, action.endSha]).ok)
    action.externalEffects = [...new Map([...action.externalEffects, ...integrations.flatMap((item) => item.externalEffects)].map((effect) => [JSON.stringify(effect), effect])).values()]
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
