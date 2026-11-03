import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../shared/errors'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { ConversationBranch, NativeContextBoundary } from '../../shared/threadActions'
import type { ConversationBranchId, ThreadWorkspaceMetadata } from '../../shared/workspace'
import { ThreadActionService, USER_CHANGES_TURN_PREFIX } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { gitAsync, LISTING, mergeTreesAsync, refuseUnsafeChangesAsync, treeOfAsync, tryGitAsync } from './git'
import { coverageNotice, leftAsIsNotice, moveOutcome, moveProgressAsync, preservedNotice, restoreChangeAsync, sameTreeAsync, takeSnapshotAsync, type Snapshot } from './snapshots'

/** The thread's first conversation branch: the one every thread starts on. */
export const FIRST_BRANCH_ID = 'main'

/** The selected conversation branch does not exist, was removed, or can't be switched to. Nothing was changed. */
export class ConversationBranchUnavailableError extends AppError {
  constructor(readonly branchId: string) {
    super({
      code: 'conversation_branch_unavailable',
      message: `Conversation branch ${branchId} is not available to switch to. Nothing was changed.`,
      details: { branchId }, errorInfo: { category: 'unavailable', retryable: false }
    })
    this.name = 'ConversationBranchUnavailableError'
  }
}

/** The person's edits since the last record overlap with the files of the branch being switched to. Nothing was changed. */
export class ConversationSwitchConflictError extends AppError {
  constructor(readonly files: string[], target: string, current: string) {
    super({
      code: 'restore_conflict',
      message: `Switching to ${target} would overwrite your edits in: ${files.join(', ') || 'some files'}. They stay on ${current}. Nothing was changed.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: false }
    })
    this.name = 'ConversationSwitchConflictError'
  }
}

/** Files changed while the switch was writing them, so it wrote nothing. Nothing was changed. */
export class ConversationSwitchInterruptedError extends AppError {
  constructor(readonly files: string[], target: string) {
    super({
      code: 'restore_conflict',
      message: `${files.join(', ')} changed while switching to ${target}. Nothing was changed. Try the switch again.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: true }
    })
    this.name = 'ConversationSwitchInterruptedError'
  }
}

/** What `prepared` records for a switch: everything recovery needs to tell whether the files were changed. */
interface SwitchIntent {
  branchId: ConversationBranchId
  leaving: ConversationBranchId
  /** The files before the switch (the snapshot the merge was computed onto). */
  ours: string
  /** The tree the switch turns the files into. */
  expectedTree: string
  /** The selected branch's own code (its ref when the switch began). */
  own: string
  restoreContext: boolean
}

type SwitchedIn = NonNullable<ThreadWorkspaceMetadata['switchedIn']>

/** Paths in words: "a.txt", "a.txt and b.txt", "a.txt, b.txt and 3 more". */
function pathsInWords(paths: string[]): string {
  const named = paths.slice(0, 5)
  const rest = paths.length - named.length
  if (rest > 0) return `${named.join(', ')} and ${rest} more`
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!
}

/** What an activation returns: the branch now active, and what the switch kept or left as it was, in words. */
export interface ConversationBranchActivation {
  branch: ConversationBranch
  notice?: string
}

export class ConversationBranchService {
  private readonly path: string
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.path = join(threadDirectory, 'conversation-branches.json')
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ConversationBranch[] {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as ConversationBranch[] : []
  }

  /**
   * The branch a switch to `branchId` would activate, or undefined when there is none to switch to: no record, or a
   * removed one. The thread's first branch counts while the thread is still on it, before its record is written. A
   * thread that left its first branch before first branches had records has none, and none is made up for it.
   */
  available(branchId: ConversationBranchId, metadata = new ThreadWorkspaceManager(this.threadDirectory).load()): ConversationBranch | undefined {
    const leaving = metadata?.conversationBranchId ?? FIRST_BRANCH_ID
    return this.withFirstBranch(this.list(), metadata, leaving).branches.find((branch) => branch.id === branchId && branch.lifecycle !== 'tombstoned')
  }

  /**
   * The branch list with a record for the thread's first branch, made while the thread is still on that branch: it is
   * `active`, pins its code under the thread's own ref, and starts its conversation at the latest action's boundary.
   * `added` says whether the record is new (and still to be written).
   */
  private withFirstBranch(branches: ConversationBranch[], metadata: ThreadWorkspaceMetadata | undefined, current: ConversationBranchId): { branches: ConversationBranch[]; added: boolean } {
    if (current !== FIRST_BRANCH_ID || branches.some((branch) => branch.id === FIRST_BRANCH_ID)) return { branches, added: false }
    const threadId = metadata?.threadId
    const boundary: NativeContextBoundary = this.actions.latest(FIRST_BRANCH_ID)?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' }
    const first: ConversationBranch = {
      id: FIRST_BRANCH_ID,
      name: 'Main',
      gitBranch: metadata?.branch ?? '',
      // The ref the thread's first branch already pins its latest snapshot under; a thread with no workspace record has its own.
      retainedRef: threadId ? `refs/mousse/threads/${threadId}/${FIRST_BRANCH_ID}` : `refs/mousse/conversation-branches/${randomUUID()}`,
      contextBoundary: boundary,
      lifecycle: 'active',
      creationReason: 'initial',
      createdAt: new Date().toISOString()
    }
    return { branches: [first, ...branches], added: true }
  }

  /**
   * Makes another conversation branch the active one, and its files with it, by one three-way merge computed before
   * anything is written: from the code of the branch being left (`base`), onto the files now (`ours`), towards the
   * selected branch's own code (`theirs`). The branch's code is what it last recorded, or, while nothing has been
   * recorded since it was switched to, its own code from then (`switchedIn`): edits brought along on the way in come
   * along again. Edits made since (the person's own, in an editor or a terminal) come along; the branch being left
   * keeps its code under its ref, and the files as they are now stay pinned by the outside-changes record. When those
   * edits overlap with the selected branch's code, nothing changes and the files are named. HEAD, the Git branches
   * and the index are never touched.
   *
   * `saveContext` is told the branch being left once the switch is known to go ahead, before any file changes;
   * `restoreContext` is told the selected branch once its files are in place.
   */
  async activate(
    workspacePath: string,
    branchId: ConversationBranchId,
    expectedJournalRevision?: number,
    restoreContext?: (branch: ConversationBranch) => void | Promise<void>,
    saveContext?: (leaving: ConversationBranchId) => void | Promise<void>
  ): Promise<ConversationBranchActivation> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-activate', async () => {
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      await refuseUnsafeChangesAsync(workspacePath, 'Thread workspace', { discard: true })
      const manager = new ThreadWorkspaceManager(this.threadDirectory)
      const metadata = manager.load()
      const leaving = metadata?.conversationBranchId ?? FIRST_BRANCH_ID
      const { branches, added } = this.withFirstBranch(this.list(), metadata, leaving)
      const selected = branches.find((branch) => branch.id === branchId && branch.lifecycle !== 'tombstoned')
      if (!selected) throw new ConversationBranchUnavailableError(branchId)
      const threadId = metadata?.threadId
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'conversation-activate',
        state: 'running',
        expectedPreState: { branchId, leaving, preBranch: await gitAsync(workspacePath, ['branch', '--show-current']), preSha: (await tryGitAsync(workspacePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout }
      })
      let intent: SwitchIntent | undefined
      try {
        if (leaving === selected.id) {
          // Already active: the files and the record stay as they are.
          await saveContext?.(leaving)
          for (const branch of branches) if (branch.lifecycle !== 'tombstoned') branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
          atomicWriteJsonSync(this.path, branches)
          return this.complete(operationId, selected, restoreContext)
        }
        const left = branches.find((branch) => branch.id === leaving && branch.lifecycle !== 'tombstoned')
        const leftName = left?.name ?? leaving
        const top = await gitAsync(workspacePath, ['rev-parse', '--show-toplevel'])
        // The whole merge is worked out before anything is written or recorded: a conflict leaves files and refs as they were.
        const ours = await takeSnapshotAsync(workspacePath, { reason: `before switching to conversation branch ${selected.id}`, threadId, operationId })
        const base = await this.leavingCode(workspacePath, metadata, leaving) ?? ours.sha
        const theirs = await gitAsync(workspacePath, ['rev-parse', '--verify', `${selected.retainedRef}^{commit}`])
        const merged = await mergeTreesAsync(top, base, ours.sha, theirs)
        if ('conflicts' in merged) throw new ConversationSwitchConflictError(merged.conflicts, selected.name, leftName)
        await saveContext?.(leaving)
        // Edits made outside Mousse since the last record are recorded for the branch being left: its receipt pins the
        // files as they are now. The branch's ref keeps its own code, so edits brought along stay out of it.
        const current = (await this.actions.recordOutsideChangesHeld({ threadId: threadId ?? '', conversationBranchId: leaving, workspacePath })).startSha
        if (left) await gitAsync(workspacePath, ['update-ref', '--no-deref', left.retainedRef, base])
        if (added) atomicWriteJsonSync(this.path, branches)
        const restored = await restoreChangeAsync(workspacePath, { reason: `switch to conversation branch ${selected.id}`, threadId, operationId, base, ours: current, theirs, restoredTo: `on ${selected.name}` }, (expectedTree) => {
          intent = { branchId: selected.id, leaving, ours: current, expectedTree, own: theirs, restoreContext: Boolean(restoreContext) }
          this.journal.append({ operationId, operationType: 'conversation-activate', state: 'prepared', expectedPreState: { branchId, leaving, ours: current }, details: intent })
        })
        if ('conflicts' in restored) throw new ConversationSwitchConflictError(restored.conflicts, selected.name, leftName)
        const leftBehind = await this.leftBehind(workspacePath, metadata, leaving, current, restored.tree)
        const notice = [
          leftBehind.length && left ? `${pathsInWords(leftBehind)} ${leftBehind.length === 1 ? 'is now as it was' : 'are now as they were'} on ${selected.name}. Your ${leftBehind.length === 1 ? 'version stays' : 'versions stay'} on ${leftName}: switch back to it, or bring ${leftBehind.length === 1 ? 'it' : 'one'} back with git restore --source=${left.retainedRef} -- <path>.` : '',
          restored.preserved ? preservedNotice(restored.preserved, new UndoRetentionService(this.threadDirectory).policy().windowMs) : '',
          leftAsIsNotice(restored.leftAsIs) ?? '', coverageNotice(ours.coverageGaps, restored.snapshot.coverageGaps) ?? ''
        ].filter(Boolean).join(' ') || undefined
        this.settle(branches, selected.id, restored.snapshot, { branchId: selected.id, snapshotSha: restored.snapshot.sha, own: theirs, at: new Date().toISOString() })
        return this.complete(operationId, selected, restoreContext, restored.snapshot.sha, notice)
      } catch (error) {
        const state = this.journal.latestByOperation().get(operationId)?.state
        if (state === 'context_pending') throw error
        if (state === 'prepared' && intent) {
          // Stopped after the intent: when none of the files it writes changed (Git refuses when one was saved meanwhile),
          // the switch is settled as not done and the files named; otherwise recovery tells from the files.
          const progress = await moveProgressAsync(workspacePath, await treeOfAsync(workspacePath, intent.ours), intent.expectedTree).catch(() => undefined)
          if (!progress || moveOutcome(progress) !== 'not-applied') throw error
          this.journal.append({ operationId, operationType: 'conversation-activate', state: 'cancelled', details: { branchId, files: progress.other, error: error instanceof Error ? error.message : String(error) } })
          if (progress.other.length) throw new ConversationSwitchInterruptedError(progress.other, selected.name)
          throw error
        }
        this.journal.append({
          operationId,
          operationType: 'conversation-activate',
          state: 'failed',
          details: { branchId, error: error instanceof Error ? error.message : String(error) }
        })
        throw error
      }
    })
  }

  /** Restores the selected branch's conversation and records the switch as done. */
  private async complete(operationId: string, selected: ConversationBranch, restoreContext: ((branch: ConversationBranch) => void | Promise<void>) | undefined, snapshotSha?: string, notice?: string): Promise<ConversationBranchActivation> {
    this.journal.append({ operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId: selected.id, ...(snapshotSha ? { snapshotSha } : {}), restoreContext: Boolean(restoreContext), ...(notice ? { notice } : {}) } })
    if (restoreContext) await restoreContext(selected)
    this.journal.append({ operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: selected.id, ...(notice ? { notice } : {}) } })
    return { branch: selected, ...(notice ? { notice } : {}) }
  }

  /**
   * The code of the branch being left, without edits made since its last record: its own code from when it was
   * switched to, while nothing has been recorded since (the latest snapshot still holds the files it arrived with);
   * otherwise its last record (`lastRecorded`).
   */
  private async leavingCode(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId): Promise<string | undefined> {
    const arrived = metadata?.switchedIn
    if (arrived?.branchId === leaving && metadata?.snapshotSha && await this.readable(workspacePath, arrived.own) && await sameTreeAsync(workspacePath, metadata.snapshotSha, arrived.snapshotSha)) return arrived.own
    return this.lastRecorded(workspacePath, metadata, leaving)
  }

  private async readable(workspacePath: string, sha: string): Promise<boolean> {
    return (await tryGitAsync(workspacePath, ['cat-file', '-e', `${sha}^{commit}`])).ok
  }

  /**
   * The files that were the person's on the branch being left and that the switch changes: what an outside-changes
   * record touched last, or what came along when the branch was switched to and no turn has touched since. Such a file
   * leaves the folder only because a record made it the branch's own (a turn or the outside-changes record before it).
   */
  private async leftBehind(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId, from: string, to: string): Promise<string[]> {
    const changed = (await gitAsync(workspacePath, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to], undefined, undefined, LISTING)).split('\0').filter(Boolean)
    if (!changed.length) return []
    const personal = new Map<string, boolean>()
    const arrived = metadata?.switchedIn?.branchId === leaving ? metadata.switchedIn : undefined
    let broughtIn = !arrived
    const bringIn = async (switchedIn: SwitchedIn) => {
      broughtIn = true
      if (!await this.readable(workspacePath, switchedIn.own) || !await this.readable(workspacePath, switchedIn.snapshotSha)) return
      for (const path of (await gitAsync(workspacePath, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', switchedIn.own, switchedIn.snapshotSha], undefined, undefined, LISTING)).split('\0').filter(Boolean)) personal.set(path, true)
    }
    for (const action of this.actions.list()) {
      if (action.conversationBranchId !== leaving || action.state === 'running' || action.state === 'undone') continue
      if (!broughtIn && action.createdAt > arrived!.at) await bringIn(arrived!)
      const byPerson = action.turnId.startsWith(USER_CHANGES_TURN_PREFIX)
      for (const change of action.changedPaths) personal.set(change.path, byPerson)
    }
    if (!broughtIn) await bringIn(arrived!)
    return changed.filter((path) => personal.get(path))
  }

  /**
   * The files as last recorded on the branch being left, before edits made since: the workspace's latest snapshot, or
   * for a workspace recorded before snapshots, the branch's latest action or the HEAD it recorded. Undefined when none
   * can be read, so the switch counts nothing as edited since.
   */
  private async lastRecorded(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId): Promise<string | undefined> {
    for (const candidate of [metadata?.snapshotSha, this.actions.latest(leaving)?.endSha, metadata?.headSha]) {
      if (candidate && await this.readable(workspacePath, candidate)) return candidate
    }
    return undefined
  }

  /**
   * Records `branchId` as the active branch, whose files are `snapshot`. The branch's ref keeps its own code; the
   * workspace's latest snapshot is the files as they are, and `switchedIn` tells the two apart until the next record.
   */
  private settle(branches: ConversationBranch[], branchId: ConversationBranchId, snapshot: Snapshot, switchedIn: SwitchedIn): void {
    const selected = branches.find((branch) => branch.id === branchId)!
    for (const branch of branches) if (branch.lifecycle !== 'tombstoned') branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
    atomicWriteJsonSync(this.path, branches)
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const metadata = manager.load()
    if (metadata) atomicWriteJsonSync(manager.workspacePath, { ...metadata, conversationBranchId: selected.id, retainedRef: selected.retainedRef, snapshotSha: snapshot.sha, headSha: snapshot.head ?? metadata.headSha, switchedIn, generation: (metadata.generation ?? 0) + 1 })
  }

  /**
   * Finishes a switch that stopped. One that stopped after its intent (`prepared`) is never replayed: the files the
   * switch writes are read from disk. All of them as planned finishes the switch; none of them cancels it; some only
   * stays pending for a person. One that stopped with only the conversation left (`context_pending`) restores the
   * conversation.
   */
  async recoverPending(workspacePath: string, restoreContext: (branch: ConversationBranch) => void | Promise<void>, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'branch-context-recovery', async () => {
      for (const entry of this.journal.latestByOperation().values()) {
        if (entry.operationType !== 'conversation-activate') continue
        if (entry.state === 'prepared') {
          const intent = entry.details as SwitchIntent
          const branches = this.list()
          const branch = branches.find((item) => item.id === intent.branchId)
          if (!branch || !intent.expectedTree || !intent.ours || !intent.own) throw new Error('Conversation branch recovery does not match the recorded branch.')
          const outcome = moveOutcome(await moveProgressAsync(workspacePath, await treeOfAsync(workspacePath, intent.ours), intent.expectedTree))
          if (outcome === 'partial') throw new Error('Switching conversation branches stopped partway, and the files match neither the state before nor the state after the switch; resolve the differences by hand.')
          if (outcome === 'not-applied') {
            this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'cancelled', details: { branchId: intent.branchId, recoveredBeforeFiles: true } })
            continue
          }
          const snapshot = await takeSnapshotAsync(workspacePath, { reason: `switch to conversation branch ${branch.id}`, threadId: new ThreadWorkspaceManager(this.threadDirectory).load()?.threadId, operationId: entry.operationId })
          this.settle(branches, branch.id, snapshot, { branchId: branch.id, snapshotSha: snapshot.sha, own: intent.own, at: entry.createdAt })
          this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId: branch.id, snapshotSha: snapshot.sha, restoreContext: intent.restoreContext, recovered: true } })
          if (intent.restoreContext) await restoreContext(branch)
          this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
          continue
        }
        if (entry.state !== 'context_pending') continue
        const details = entry.details as { branchId: string; restoreContext: boolean }
        const branch = this.list().find((item) => item.id === details.branchId)
        // The files were switched before this entry was written; only the conversation side is left to restore.
        if (!branch) throw new Error('Conversation branch recovery does not match the recorded branch.')
        if (details.restoreContext) await restoreContext(branch)
        this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
      }
    }, undefined, heldThreadLease)
  }

  /**
   * Starts a conversation branch at a turn's code: the turn's end snapshot (or, for `current`, a snapshot of the files
   * now) is pinned under `refs/mousse/conversation-branches/<id>`. No Git branch is made; the files and the checkout
   * are left as they are until the branch is activated.
   */
  async fork(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    expectedJournalRevision?: number,
    codeMode: 'historical' | 'current' = 'historical'
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-fork', async () => {
      this.actions.assertExpectedRevision(expectedJournalRevision)
      const action = this.actions.get(actionId)
      if (action?.scope === 'conversation') throw new Error('Conversation-only turns have no repository snapshot to fork.')
      if (!action || action.state !== 'completed') throw new Error('Fork requires a completed action.')
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      if (codeMode === 'historical') new UndoRetentionService(this.threadDirectory).assertAvailable(action)
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      if (!action.nativeContextBoundary.safeBoundaryProof) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const operationId = randomUUID()
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      const codeSha = codeMode === 'current' ? (await takeSnapshotAsync(workspacePath, { reason: 'fork', threadId: metadata?.threadId, operationId })).sha : action.endSha
      this.journal.append({
        operationId,
        operationType: 'conversation-fork',
        state: 'running',
        expectedPreState: { sourceBranchId, actionId, codeMode, codeSha }
      })
      try {
        await gitAsync(workspacePath, ['update-ref', '--no-deref', retainedRef, codeSha])
        const record: ConversationBranch = {
          id,
          name,
          parentBranchId: sourceBranchId,
          parentTurnId: action.turnId,
          // Conversation branches share the worktree and its Git branch; they differ in the snapshot they own.
          gitBranch: metadata?.branch ?? '',
          retainedRef,
          contextBoundary: action.nativeContextBoundary,
          lifecycle: 'inactive',
          creationReason: 'fork',
          createdAt: new Date().toISOString()
        }
        // The first fork also writes the record of the branch the thread started on, so it can be switched back to.
        const { branches } = this.withFirstBranch(this.list(), metadata, metadata?.conversationBranchId ?? FIRST_BRANCH_ID)
        branches.push(record)
        atomicWriteJsonSync(this.path, branches)
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'completed',
          details: { branchId: id, actionId }
        })
        return record
      } catch (error) {
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'failed',
          details: { actionId, error: error instanceof Error ? error.message : String(error) }
        })
        throw error
      }
    })
  }
}
