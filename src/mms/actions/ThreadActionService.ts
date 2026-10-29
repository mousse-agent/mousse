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
import { IN_PROGRESS_GIT_MARKERS } from '../git/gitMarkers'
import { changedPaths, git, inspectPendingChanges, introducedCommits, MOUSSE_COMMIT_ENV, pendingChangesError, requireClean, tryGit } from './git'

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
  /** Only for `runCheckpointedAction`; defaults to `sweep`. */
  onFailure?: ActionFailurePolicy
}

/**
 * What a checkpointed action does when its mutation throws. `sweep` (turns) checkpoints whatever
 * the failure left behind. `record` (a user's own Git commit) leaves the index and tree exactly as
 * they were and records the failed action with no commits, so a hook that rejected the commit is
 * never bypassed by a `--no-verify` checkpoint. A commit that succeeded but left files changed
 * (a hook that rewrites them) is not swept either; see `leftChangesBehind`.
 */
export type ActionFailurePolicy = 'sweep' | 'record'

/** Turn ids of the checkpoints that save the user's pending edits before a turn (see `saveUserChanges`). */
export const USER_CHANGES_TURN_PREFIX = 'user-changes:'

export interface SaveUserChangesOptions extends Pick<RunThreadActionOptions, 'threadId' | 'conversationBranchId' | 'workspacePath' | 'heldThreadLease' | 'signal'> {
  /** Where the next turn's messages start; the save covers none. Defaults to the end of the latest action. */
  presentationMessageStart?: number
  /** The conversation position the next turn starts from. Defaults to the latest action's. */
  nativeContextBoundary?: NativeContextBoundary
}

export { IN_PROGRESS_GIT_MARKERS }

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
    super(cause instanceof Error ? cause.message : String(cause), { cause })
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
    requireClean(options.workspacePath, 'Thread workspace', { folder: 'thread', actions: ['save', 'discard'] })
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

  /**
   * Saves the user's pending edits (tracked and untracked, never ignored files or `.mousse/`) as a checkpoint of
   * their own, a completed `user` action, so the turn that follows starts clean. Undoing that turn then reverts
   * only the turn's commits and the edits are back exactly as they were; they are never counted as the agent's.
   * The save covers no messages and has no conversation start boundary, so the app never offers it as a turn
   * to undo. A workspace with an unresolved conflict or a Git operation in progress is refused with an error that
   * offers Discard: committing it would record conflict markers.
   *
   * Returns the HEAD the next action starts from. The caller holds the thread lease, as for `beginTurn`.
   */
  async saveUserChanges(options: SaveUserChangesOptions): Promise<{ startSha: string; action?: ThreadAction }> {
    const head = git(options.workspacePath, ['rev-parse', 'HEAD'])
    const pending = inspectPendingChanges(options.workspacePath)
    if (pending.unmerged.length || pending.operation) throw pendingChangesError(options.workspacePath, 'Thread workspace', { folder: 'thread', actions: ['discard'] }, pending)
    if (!this.hasUncommittedChanges(options.workspacePath)) return { startSha: head }
    // HEAD moved outside a recorded operation: nothing is saved on top of it, as admission would refuse the turn.
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    if (metadata && metadata.headSha !== head) throw new Error('Workspace HEAD moved outside a recorded operation; recovery is required.')
    const latest = this.latest(options.conversationBranchId)
    const at = options.presentationMessageStart ?? latest?.presentationMessageEnd ?? 0
    const action = await this.checkpointExistingTurn({
      threadId: options.threadId, turnId: `${USER_CHANGES_TURN_PREFIX}${randomUUID()}`, actor: { kind: 'user' },
      conversationBranchId: options.conversationBranchId, workspacePath: options.workspacePath,
      heldThreadLease: options.heldThreadLease, signal: options.signal,
      presentationMessageStart: at, presentationMessageEnd: at,
      nativeContextBoundary: options.nativeContextBoundary ?? latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' },
      externalEffects: []
    }, head, 'completed')
    return { startSha: action.endSha, action }
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
          expectedPreState: { startSha, branch: git(options.workspacePath, ['branch', '--show-current']) },
          // Recovery reads the policy from here: after a restart nothing else says how this action may end.
          details: { action: structuredClone(action), failurePolicy: options.onFailure ?? 'sweep' }
        })
        let result: T
        try {
          result = await mutate()
        } catch (error) {
          if (options.onFailure === 'record') {
            this.finishRecordedFailure(options, action, actions, startSha)
            throw new ActionExecutionError(action, error)
          }
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
        // A user's commit that went through but left files changed (a hook that rewrites them) must not be swept
        // into a second, unverified commit. The edits stay; recovery records the commit once the tree is clean.
        if (options.onFailure === 'record' && this.leftChangesBehind(options, action, actions, startSha)) return { result, action }
        this.checkpoint(options.workspacePath, action, 'completed')
        this.replace(actions)
        this.appendCheckpointCompleted(action, 'completed')
        return { result, action }
      },
      options.signal,
      options.heldThreadLease
    )
  }

  /**
   * A `record` action whose mutation threw. With HEAD where it started the action ends `failed` with
   * no commits and the index and tree stay as the user had them. With HEAD moved the outcome is not
   * known, so the journal asks for recovery; nothing is swept either way.
   */
  private finishRecordedFailure(options: RunThreadActionOptions, action: ThreadAction, actions: ThreadAction[], startSha: string): void {
    try {
      const head = git(options.workspacePath, ['rev-parse', 'HEAD'])
      if (head !== startSha) {
        action.state = 'failed'
        this.replace(actions)
        this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionState: 'failed', startSha, failurePolicy: 'record', error: 'HEAD moved while the action failed' } })
        return
      }
      this.recordWithoutCommits(options.workspacePath, action)
      this.replace(actions)
      this.appendCheckpointCompleted(action, 'failed')
    } catch (recordError) {
      // The mutation's own error is what the caller needs; recovery finishes the bookkeeping.
      this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionState: 'failed', startSha, failurePolicy: 'record', error: String(recordError) } })
    }
  }

  /** Whether the workspace has changes a checkpoint would commit (`.mousse/` is never part of one). */
  private hasUncommittedChanges(workspacePath: string): boolean {
    const top = git(workspacePath, ['rev-parse', '--show-toplevel'])
    const status = tryGit(top, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).mousse/**'])
    return !status.ok || status.stdout !== ''
  }

  /**
   * A `record` action whose mutation succeeded. When files are still changed, nothing is swept:
   * with HEAD unmoved the action is simply recorded; with HEAD moved the commit landed, so the
   * journal asks for recovery, which records it once the user has dealt with the leftover edits.
   */
  private leftChangesBehind(options: RunThreadActionOptions, action: ThreadAction, actions: ThreadAction[], startSha: string): boolean {
    if (!this.hasUncommittedChanges(options.workspacePath)) return false
    if (git(options.workspacePath, ['rev-parse', 'HEAD']) === startSha) {
      this.recordWithoutCommits(options.workspacePath, action, 'completed')
      this.replace(actions)
      this.appendCheckpointCompleted(action, 'completed')
      return true
    }
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionState: 'completed', startSha, failurePolicy: 'record', error: 'The commit landed and files are still changed' } })
    return true
  }

  /** Finishes `action` with a receipt whose before and after are the same commit, so `headSha` and `generation` stay consistent. */
  private recordWithoutCommits(workspacePath: string, action: ThreadAction, state: 'failed' | 'completed' = 'failed'): void {
    const top = git(workspacePath, ['rev-parse', '--show-toplevel'])
    action.endSha = action.startSha
    action.commits = []
    action.changedPaths = []
    action.state = state
    action.completedAt = new Date().toISOString()
    const receipt = new ChangeReceiptService(this.threadDirectory).record(top, {
      operationId: action.id, kind: 'checkpoint', actor: action.actor ?? { kind: 'main' },
      actionId: action.id, turnId: action.turnId, runId: action.runId,
      beforeSha: action.startSha, afterSha: action.startSha, introducedCommits: [], contributions: [],
      externalEffects: action.externalEffects
    })
    action.receiptId = receipt.id
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
        let state = saved?.actionState ?? 'stopped'
        // A user's own commit never ends in a sweep: its failure policy was written with the action.
        const recordsFailure = history.some((item) => (item.details as { failurePolicy?: ActionFailurePolicy } | undefined)?.failurePolicy === 'record')
        const head = git(workspacePath, ['rev-parse', 'HEAD'])
        if (recordsFailure && receipt && receipt.beforeSha === receipt.afterSha) state = 'failed'
        if (receipt) {
          if (head !== receipt.afterSha) throw new Error('Checkpoint recovery HEAD does not match the receipt.')
          // A rejected commit leaves the user's files in place on purpose, so there is nothing to require clean.
          if (!(recordsFailure && receipt.beforeSha === receipt.afterSha)) requireClean(workspacePath, 'Thread workspace')
          const { id: _id, workspaceId: _workspaceId, generation: _generation, retainedRefs: _refs, createdAt: _createdAt, ...input } = receipt
          receipts.record(workspacePath, input)
          action.receiptId = receipt.id; action.endSha = receipt.afterSha; action.commits = receipt.introducedCommits
          action.changedPaths = changedPaths(workspacePath, action.startSha, action.endSha)
          action.externalEffects = receipt.externalEffects
          action.state = state; action.completedAt = receipt.createdAt
        } else if (recordsFailure && head === action.startSha) {
          // The commit never landed. Index and tree stay exactly as the user left them.
          this.recordWithoutCommits(workspacePath, action)
          state = 'failed'
        } else {
          if (!tryGit(workspacePath, ['merge-base', '--is-ancestor', action.startSha, 'HEAD']).ok) throw new Error('Interrupted writer HEAD diverged from its recorded start.')
          if (recordsFailure) {
            // HEAD moved: the commit landed and the process ended before its receipt. A clean tree
            // means the checkpoint only records it; edits a hook left behind need the user's decision.
            if (this.hasUncommittedChanges(workspacePath)) {
              if (entry.state !== 'recovery_required') this.journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: 'recovery_required', details: { actionState: 'completed', startSha: action.startSha, failurePolicy: 'record', error: 'The commit landed with files still changed' } })
              throw new Error('Interrupted commit needs recovery: it landed and the workspace still has uncommitted changes.')
            }
            state = 'completed'
          }
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
      const message = action.turnId.startsWith(USER_CHANGES_TURN_PREFIX) ? `mousse: save pending changes (${action.id})` : `mousse: checkpoint turn ${action.turnId} (${action.id})`
      git(workspacePath, ['commit', '--no-verify', '-m', message], MOUSSE_COMMIT_ENV)
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
