import { AppError } from '../../shared/errors'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { NativeContextBoundary, ThreadAction, ExternalEffect } from '../../shared/threadActions'
import type { ConversationBranchId, WorkspaceActor } from '../../shared/workspace'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { assertHeldThreadLease, withGitMutationLocks } from './GitOperationCoordinator'
import { IN_PROGRESS_GIT_MARKERS } from '../git/gitMarkers'
import { changedPaths, git, tryGit } from './git'
import { describeGit, sameTree, takeSnapshot, type Snapshot } from './snapshots'

export interface RunThreadActionOptions {
  threadId: string
  actor?: WorkspaceActor
  runId?: string
  externalEffects?: ExternalEffect[]
  /** An explicit human action covers the files as they are, without first recording outside changes. Never used on primary. */
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

/** Turn ids of the checkpoints that record changes made outside Mousse before a turn (see `recordOutsideChanges`). */
export const USER_CHANGES_TURN_PREFIX = 'user-changes:'

export interface OutsideChangesOptions extends Pick<RunThreadActionOptions, 'threadId' | 'conversationBranchId' | 'workspacePath' | 'heldThreadLease' | 'signal'> {
  /** Where the next turn's messages start; the record covers none. Defaults to the end of the latest action. */
  presentationMessageStart?: number
  /** The conversation position the next turn starts from. Defaults to the latest action's. */
  nativeContextBoundary?: NativeContextBoundary
}

export { IN_PROGRESS_GIT_MARKERS }

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

/** Written when a turn's start could not be snapshotted; the checkpoint of the action that starts there reads it. */
const UNCAPTURED_START_FILE = 'uncaptured-start.json'
interface UncapturedStart { startSha: string; error: string }
/** Written when a turn's end could not be snapshotted; the next record of outside changes says it holds that turn's changes. */
const UNRECORDED_END_FILE = 'unrecorded-end.json'
interface UnrecordedEnd { actionId: string; turnId: string }

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

  private newAction(options: RunThreadActionOptions, startSha: string, actions: ThreadAction[]): ThreadAction {
    return {
      id: randomUUID(), turnId: options.turnId, conversationBranchId: options.conversationBranchId,
      actor: options.actor ?? { kind: 'main' }, runId: options.runId,
      parentActionId: actions.filter((item) => item.conversationBranchId === options.conversationBranchId).at(-1)?.id,
      presentationMessageStart: options.presentationMessageStart, presentationMessageEnd: options.presentationMessageEnd,
      nativeContextStartBoundary: options.nativeContextStartBoundary, nativeContextBoundary: options.nativeContextBoundary,
      startSha, endSha: startSha, commits: [], childIntegrations: [], changedPaths: [],
      externalEffects: options.externalEffects ?? [], reversible: true, state: 'running', createdAt: new Date().toISOString()
    }
  }

  /** Durable intent is established before model execution, under its task lease. `startSha` is the snapshot the turn starts from. */
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
    git(options.workspacePath, ['rev-parse', '--verify', `${startSha}^{commit}`])
    const actions = this.list()
    const action = this.newAction(options, startSha, actions)
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'running', expectedPreState: { startSha, actionId: action.id }, details: { action } })
    actions.push(action); this.replace(actions)
    return action
  }

  /**
   * Takes the snapshot the next action starts from. When the files differ from the latest recorded snapshot, someone
   * changed them outside a Mousse action (the user in an editor or a terminal, a tool, `git` in a shell): that is
   * recorded as a completed `user` action of its own, so the turn that follows covers only its own work and Undo of
   * the turn never takes the edits back. The record covers no messages and has no conversation start boundary, so the
   * app never offers it as a turn to undo. Nothing is committed, switched or staged; the files are left as they are.
   * A merge or rebase waiting in the worktree is recorded with the snapshot, not refused.
   *
   * Returns the snapshot the next action starts from. The caller holds the thread lease, as for `beginTurn`.
   */
  async recordOutsideChanges(options: OutsideChangesOptions): Promise<{ startSha: string; action?: ThreadAction }> {
    return withGitMutationLocks(this.threadDirectory, options.workspacePath, 'outside-changes', () => this.recordOutsideChangesHeld(options), options.signal, options.heldThreadLease)
  }

  /** `recordOutsideChanges` for a caller that already holds the mutation locks. */
  recordOutsideChangesHeld(options: OutsideChangesOptions): { startSha: string; action?: ThreadAction } {
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    const latest = this.latest(options.conversationBranchId)
    let snapshot: Snapshot
    try {
      snapshot = takeSnapshot(options.workspacePath, { reason: 'before the next action', threadId: options.threadId })
    } catch (error) {
      // No snapshot now never stops the turn. The last recorded one stands in only as a placeholder: it is marked as not
      // this turn's start, so the checkpoint records the turn from its end (nothing attributed, no files for Undo to restore).
      const fallback = metadata?.snapshotSha ?? latest?.endSha ?? metadata?.headSha ?? (tryGit(options.workspacePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout || undefined)
      if (!fallback) throw error
      atomicWriteJsonSync(join(this.threadDirectory, UNCAPTURED_START_FILE), { startSha: fallback, error: String((error as Error).message ?? error).split(/\r?\n/)[0] } satisfies UncapturedStart)
      return { startSha: fallback }
    }
    rmSync(join(this.threadDirectory, UNCAPTURED_START_FILE), { force: true })
    // The latest recorded snapshot. Workspaces recorded before snapshots have none; their last checkpoint commit was HEAD.
    const known = metadata?.snapshotSha ?? latest?.endSha ?? metadata?.headSha ?? snapshot.head
    const receipts = new ChangeReceiptService(this.threadDirectory)
    let unrecorded: UnrecordedEnd | undefined
    try { unrecorded = JSON.parse(readFileSync(join(this.threadDirectory, UNRECORDED_END_FILE), 'utf8')) as UnrecordedEnd } catch { unrecorded = undefined }
    rmSync(join(this.threadDirectory, UNRECORDED_END_FILE), { force: true })
    if (!known || !tryGit(options.workspacePath, ['cat-file', '-e', `${known}^{commit}`]).ok || sameTree(options.workspacePath, known, snapshot.sha)) {
      receipts.adoptSnapshot(options.workspacePath, snapshot)
      return { startSha: snapshot.sha }
    }
    const at = options.presentationMessageStart ?? latest?.presentationMessageEnd ?? 0
    const action = this.checkpointTurnHeld({
      threadId: options.threadId, turnId: `${USER_CHANGES_TURN_PREFIX}${randomUUID()}`, actor: { kind: 'user' },
      conversationBranchId: options.conversationBranchId, workspacePath: options.workspacePath,
      presentationMessageStart: at, presentationMessageEnd: at,
      nativeContextBoundary: options.nativeContextBoundary ?? latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' },
      externalEffects: []
    }, known, 'completed')
    if (unrecorded) {
      // Not only the person's edits: the turn before could not record its end, so its changes are in here too.
      const all = this.list(), recorded = all.find((item) => item.id === action.id)
      if (recorded) { recorded.notice = `These changes include those of turn ${unrecorded.turnId}, whose end could not be recorded.`; this.replace(all); action.notice = recorded.notice }
    }
    return { startSha: action.endSha, action }
  }

  /** Checkpoint a turn while the caller owns the execution lease, or acquire it for standalone callers. */
  async checkpointExistingTurn(
    options: RunThreadActionOptions,
    startSha: string,
    state: 'completed' | 'stopped' | 'failed'
  ): Promise<ThreadAction> {
    return withGitMutationLocks(this.threadDirectory, options.workspacePath, 'turn-checkpoint', () => this.checkpointTurnHeld(options, startSha, state), options.signal, options.heldThreadLease)
  }

  /** `checkpointExistingTurn` for a caller that already holds the mutation locks. */
  private checkpointTurnHeld(options: RunThreadActionOptions, startSha: string, state: 'completed' | 'stopped' | 'failed'): ThreadAction {
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
      action = this.newAction(options, startSha, actions)
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
      this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionId: action.id, actionState: state, startSha, error: String(error) } })
      throw error
    }
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
        if (metadata && metadata.lifecycle !== 'ready') throw new Error('Workspace requires recovery before this action.')
        this.assertExpectedRevision(options.expectedJournalRevision)
        // Other changes made outside Mousse are recorded as their own action first, so this action covers only its own change.
        const startSha = options.allowDirtyInput ? this.startFromFiles(options) : this.recordOutsideChangesHeld(options).startSha
        const actions = this.list()
        if (actions.some((item) => item.turnId === options.turnId)) throw new Error('This turn already has a durable intent; execution must not be replayed.')
        const action = this.newAction(options, startSha, actions)
        actions.push(action)
        this.replace(actions)
        this.journal.append({
          operationId: action.id,
          operationType: 'action-checkpoint',
          state: 'running',
          expectedPreState: { startSha },
          details: { action: structuredClone(action) }
        })
        let result: T
        try {
          result = await mutate()
        } catch (error) {
          // Whatever the failure left behind is recorded as it is; a snapshot commits nothing, so no hook is bypassed.
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
          // The mutation's own error is what the caller needs; recovery finishes whatever bookkeeping did not.
          try {
            if (!checkpointComplete) throw new Error('The checkpoint was not recorded.')
            this.appendCheckpointCompleted(action, 'failed')
          } catch (bookkeepingError) {
            this.journal.append({
              operationId: action.id,
              operationType: 'action-checkpoint',
              state: 'recovery_required',
              details: { actionState: action.state, startSha: action.startSha, error: String(bookkeepingError) }
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

  /** The snapshot an explicit human action starts from: the files as they are, which the action then covers. */
  private uncapturedStart(): UncapturedStart | undefined {
    try { return JSON.parse(readFileSync(join(this.threadDirectory, UNCAPTURED_START_FILE), 'utf8')) as UncapturedStart } catch { return undefined }
  }

  private startFromFiles(options: RunThreadActionOptions): string {
    let snapshot: Snapshot
    try { snapshot = takeSnapshot(options.workspacePath, { reason: 'before the action', threadId: options.threadId }) }
    catch { return this.recordOutsideChangesHeld(options).startSha }
    new ChangeReceiptService(this.threadDirectory).adoptSnapshot(options.workspacePath, snapshot)
    return snapshot.sha
  }

  /** Recover an interrupted writer as captured code, never replay its model/tools. */
  async recoverPending(workspacePath: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'checkpoint-recovery', async () => {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      for (const entry of [...this.journal.latestByOperation().values()].reverse()) {
        if (!['action-checkpoint', 'change-checkpoint'].includes(entry.operationType) || !['running', 'prepared', 'git_applied', 'recovery_required'].includes(entry.state)) continue
        const history = this.journal.list().filter((item) => item.operationId === entry.operationId)
        const all = this.list()
        const details = [...history].reverse().map((item) => item.details as { action?: ThreadAction; actionState?: 'completed' | 'stopped' | 'failed' } | undefined)
        let action = details.find((item) => item?.action)?.action ?? all.find((item) => item.id === entry.operationId)
        if (!action) throw new Error('Interrupted checkpoint has no durable action boundary.')
        action = structuredClone(action)
        const receipt = receipts.list().find((item) => item.operationId === entry.operationId)
        const state = details.find((item) => item?.actionState)?.actionState ?? 'stopped'
        if (receipt) {
          // The snapshot was already taken and recorded; only the action's own record is finished. Files are not touched.
          receipts.replay(workspacePath, receipt)
          action.receiptId = receipt.id; action.endSha = receipt.afterSha; action.commits = receipt.introducedCommits
          action.changedPaths = changedPaths(workspacePath, action.startSha, action.endSha)
          action.externalEffects = receipt.externalEffects
          if (receipt.git) action.git = receipt.git
          action.state = state; action.completedAt = receipt.createdAt
        } else {
          // Nothing landed that a retake would not capture, whatever stopped the first attempt (this includes
          // threads that an earlier version locked when the agent had switched branches or rewritten history).
          try {
            this.checkpoint(workspacePath, action, state)
          } catch (error) {
            // The retake failed as well: the operation stays waiting, with what stopped it this time.
            this.journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: 'recovery_required', details: { actionId: action.id, actionState: state, startSha: action.startSha, error: String(error) } })
            throw error
          }
        }
        const index = all.findIndex((item) => item.id === action.id)
        if (index >= 0) all.splice(index, 1)
        all.push(action); this.replace(all)
        this.appendCheckpointCompleted(action, state)
      }
    }, undefined, heldThreadLease)
  }

  /**
   * Records the worktree's files as the action's end snapshot and the action's change as a receipt. The branch the
   * thread is on, HEAD and the index are whatever the agent left them; they are described, never checked.
   */
  private checkpoint(
    workspacePath: string,
    action: ThreadAction,
    state: 'completed' | 'stopped' | 'failed'
  ): void {
    workspacePath = git(workspacePath, ['rev-parse', '--show-toplevel'])
    action.state = 'checkpointing'
    this.journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'prepared', expectedPreState: { startSha: action.startSha }, details: { action, actionState: state } })
    const threadId = new ThreadWorkspaceManager(this.threadDirectory).load()?.threadId
    const reason = action.turnId.startsWith(USER_CHANGES_TURN_PREFIX) ? 'outside changes' : `end of turn ${action.turnId}`
    let snapshot: Snapshot
    try {
      snapshot = takeSnapshot(workspacePath, { reason, threadId, operationId: action.id })
    } catch (error) {
      // A snapshot that cannot be taken never locks the thread: the action ends where it started, says nothing of its
      // files was covered and why, and cannot be undone (there is nothing recorded to restore).
      const head = tryGit(workspacePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout || undefined
      const branch = tryGit(workspacePath, ['branch', '--show-current']).stdout || undefined
      snapshot = { sha: action.startSha, tree: git(workspacePath, ['rev-parse', `${action.startSha}^{tree}`]), ...(head ? { head } : {}), ...(branch ? { branch } : {}),
        coverageGaps: [{ path: '.', reason: `no snapshot could be taken (${String((error as Error).message ?? error).split(/\r?\n/)[0]})` }] }
      action.reversible = false
      if (action.actor?.kind !== 'user') atomicWriteJsonSync(join(this.threadDirectory, UNRECORDED_END_FILE), { actionId: action.id, turnId: action.turnId } satisfies UnrecordedEnd)
    }
    // The turn's start could not be captured: the placeholder start is not used. The turn is recorded from its end, so no
    // file is attributed to it and code Undo restores nothing (the conversation still rewinds), and the gap says why.
    const uncaptured = this.uncapturedStart()
    if (uncaptured?.startSha === action.startSha && action.actor?.kind !== 'user') {
      action.startSha = snapshot.sha
      snapshot = { ...snapshot, coverageGaps: [{ path: '.', reason: `start of turn not captured: ${uncaptured.error}` }, ...(snapshot.coverageGaps ?? [])] }
      rmSync(join(this.threadDirectory, UNCAPTURED_START_FILE), { force: true })
    }
    const { record, commits } = describeGit(workspacePath, action.startSha, snapshot)
    action.endSha = snapshot.sha
    action.commits = commits
    action.git = record
    action.changedPaths = changedPaths(workspacePath, action.startSha, snapshot.sha)
    action.state = state
    action.completedAt = new Date().toISOString()
    const receipts = new ChangeReceiptService(this.threadDirectory)
    // Changes recorded inside the action (a subagent's result, a nested snapshot) belong to it. A snapshot has no ancestry to test,
    // so the window is the action's own: nothing else writes to this thread while its turn holds the lease.
    const integrations = receipts.list().filter((item) => item.operationId !== action.id && item.createdAt >= action.createdAt && (item.kind === 'integration' || item.kind === 'checkpoint') && item.afterSha !== item.beforeSha)
    action.externalEffects = [...new Map([...action.externalEffects, ...integrations.flatMap((item) => item.externalEffects)].map((effect) => [JSON.stringify(effect), effect])).values()]
    const receipt = receipts.record(workspacePath, {
      operationId: action.id, kind: 'checkpoint', actor: action.actor ?? { kind: 'main' },
      actionId: action.id, turnId: action.turnId, runId: action.runId,
      beforeSha: action.startSha, afterSha: action.endSha, introducedCommits: action.commits,
      contributions: integrations.map((item) => ({ receiptId: item.id, baseSha: item.beforeSha, resultSha: item.afterSha })),
      externalEffects: action.externalEffects, git: record
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
