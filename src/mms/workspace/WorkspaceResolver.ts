import { createErrorProvider } from '../../shared/errors'
import { releaseExecutionLeaseHandle, waitAcquireExecutionLease, type ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { ChatMode, TurnSetupStep } from '../../shared/types'
import type { WorkspaceExecutionContext, WorkspaceLifecycle } from '../../shared/workspace'
import { inspectPendingChangesAsync } from '../actions/git'
import { PROJECT_FOLDER_REASON, type ThreadPlacement } from './threadPlacement'
import { isProjectFolderWorkspace, ThreadWorkspaceManager } from './ThreadWorkspaceManager'
import { startedInSnapshotStore } from './SnapshotWorkspace'
import { assertWorktreeFolderConnected } from '../worktree/worktreeLayout'
import { forgetRepositoryFacts } from '../git/repositoryFacts'
import { isPreparing, notePreparationClaim, settledPreparation, startNoteWhenReady } from './workspacePreparation'

/** A thread that records its turns in its folder's hidden store, whatever the folder has become since (`unavailableReason`). */
export const SNAPSHOT_STORE_REASON = 'snapshot-store'

/** A thread whose worktree someone removed or emptied: its turns run in the project folder, unrecorded (`unavailableReason`). */
export const WORKTREE_GONE_REASON = 'This thread\'s worktree is gone or no longer a Git repository, so it works in the project folder.'

/** What the agent is told, once, when its turns move to the project folder because its worktree is gone or emptied. */
export function worktreeGoneNote(worktreePath: string, lifecycle: WorkspaceLifecycle, projectPath: string): string {
  return `Your worktree folder ${worktreePath} ${lifecycle === 'missing' ? 'is gone' : 'is no longer a Git repository'}. You are working from the project folder ${projectPath} now.`
}

/** Resolves one authoritative path at the turn boundary; no selected-project globals. */
const workspaceErrors = createErrorProvider({
  workspace_recovery_required: { category: 'conflict', retryable: false, message: 'Thread workspace requires restore or recovery before execution.' }
})

/**
 * A turn that runs on the project's own checkout and provisions nothing: no checkpoints, no publish,
 * no undo. `reason` says why, for the tools that refuse work needing an owned workspace.
 */
export function unprovisionedContext(threadId: string, projectPath: string, gitBacked: boolean, reason: string): WorkspaceExecutionContext {
  return {
    threadId,
    workspacePath: projectPath,
    projectPath,
    primaryPath: projectPath,
    lifecycle: 'unprovisioned',
    capability: {
      gitBacked,
      checkpointable: false,
      publishable: false,
      undoable: false,
      unavailableReason: reason
    }
  }
}

/** Whether a turn in `mode` changes files, so it is the kind that is recorded and can be undone. */
export function modeMutatesFiles(mode: ChatMode): boolean {
  return mode === 'agent' || mode === 'build' || (typeof mode === 'object' && 'skillId' in mode)
}

/** Paths named in a turn's note about uncommitted changes the new worktree does not have; the rest are counted. */
const START_NOTE_PATHS = 5

/**
 * The note for a turn whose worktree was just made from the project's committed HEAD while the project folder held
 * uncommitted changes, which the worktree therefore does not have. They are not copied over and nothing waits on
 * them; the turn record says so. Undefined when the folder is clean or cannot be read.
 */
export async function uncommittedLeftBehindNote(projectPath: string): Promise<string | undefined> {
  let paths: string[]
  try {
    paths = (await inspectPendingChangesAsync(projectPath)).files.filter((path) => path !== '.mousse' && !path.startsWith('.mousse/'))
  } catch {
    return undefined
  }
  if (paths.length === 0) return undefined
  const named = paths.slice(0, START_NOTE_PATHS).join(', ')
  const more = paths.length > START_NOTE_PATHS ? ` and ${paths.length - START_NOTE_PATHS} more` : ''
  const files = paths.length === 1 ? '1 file' : `${paths.length} files`
  return `The project folder had uncommitted changes the worktree doesn't have (${files}: ${named}${more}). The worktree started from the last commit; the changes stay in the project folder.`
}

export class WorkspaceResolver {
  /** `placement` comes from `threadPlacement`: a `project-folder` thread works in the project's folder and never gets a worktree. */
  constructor(
    private readonly threadDirectory: string,
    private readonly threadId: string,
    private readonly projectPath: string,
    private readonly placement: ThreadPlacement,
    /** Tells the thread about a restore (`ThreadWorkspaceManager.restore`'s `onNotice`): a line in it, made once per `id`. */
    private readonly notify?: (notice: { id: string; text: string }) => unknown
  ) {}

  async resolve(
    mode: ChatMode,
    conversationBranchId = 'main',
    signal?: AbortSignal,
    heldThreadLease?: ThreadLeaseHandle,
    /** The thread's first message: a worktree made now is named from it in the background (`ThreadWorkspaceManager.provision`). */
    nameFrom?: string,
    /** Each slow step as it begins (the line under Working names it): checking the worktree, making it, or remaking it. */
    onStep?: (step: TurnSetupStep) => void
  ): Promise<WorkspaceExecutionContext> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const mutating = modeMutatesFiles(mode)
    // Callers resolving a workspace outside turn setup also wait before taking the draft's lease.
    if (!heldThreadLease && isPreparing(this.threadDirectory)) {
      onStep?.('worktree')
      await settledPreparation(this.threadDirectory, signal)
      signal?.throwIfAborted()
    }
    let existing = manager.load()
    if (!heldThreadLease && (existing?.prepared || existing?.lifecycle === 'provisioning')) {
      const lease = await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-claim', signal })
      try {
        return await this.resolve(mode, conversationBranchId, signal, lease, nameFrom, onStep)
      } finally {
        releaseExecutionLeaseHandle(lease)
      }
    }
    if (existing?.prepared && !mutating) {
      const repository = await manager.resolveRepositoryAsync(this.projectPath)
      return unprovisionedContext(this.threadId, this.projectPath, repository.capability.gitBacked, 'Read-only turn uses the primary checkout')
    }
    if (heldThreadLease && existing?.prepared && this.placement === 'project-folder') {
      if (await manager.releasePrepared(heldThreadLease, undefined, signal) === 'kept') {
        await manager.separateRenamedPreparation(heldThreadLease)
      }
      signal?.throwIfAborted()
      existing = undefined
    }
    if (heldThreadLease && existing?.lifecycle === 'provisioning' &&
      (await manager.reconcileFailedProvision(this.projectPath, signal) || await manager.resumeInterruptedProvision(this.projectPath, heldThreadLease, signal))) existing = manager.load()
    let claimNote: string | undefined
    if (heldThreadLease && existing?.prepared && existing.lifecycle === 'ready') {
      const prepared = existing.prepared
      existing = await manager.claimPrepared(this.projectPath, conversationBranchId, heldThreadLease, nameFrom)
      if (existing) {
        notePreparationClaim(this.threadId, prepared)
        claimNote = prepared.startNote
      }
    }
    if (existing) {
      if (existing.lifecycle !== 'ready') throw workspaceErrors.create('workspace_recovery_required', undefined, { state: existing.lifecycle })
      onStep?.('check')
      // A rename of the worktree's branch that a stop left unsettled: settled from the repository, as part of checking the
      // worktree, before the turn reads the record.
      if (manager.branchRenamePending()) {
        try { await manager.settleBranchRename({ signal }) } catch (error) { console.warn('[branches] an unsettled branch rename could not be settled', { threadId: this.threadId, error: error instanceof Error ? error.message : String(error) }) }
        existing = manager.load() ?? existing
      }
      // On a drive that is not connected: the turn waits for it (`DriveNotConnectedError`), and nothing is marked or rebuilt.
      await assertWorktreeFolderConnected(existing.worktreePath)
      const verified = await manager.verify(existing)
      if (verified.lifecycle === 'missing' && manager.hasReconstructionManifest(existing)) {
        onStep?.('restore')
        const restored = await manager.restore(this.projectPath, signal, heldThreadLease, this.notify)
        // The worktree was rebuilt: what the turn read of it before is read again (`repositoryFacts.ts`).
        forgetRepositoryFacts()
        return manager.executionContext(this.projectPath, restored)
      }
      if (verified.lifecycle !== 'ready') {
        // An operation of Mousse's own on the worktree that did not finish pauses the thread until it is recovered.
        if (await manager.ownOperationUnfinished(verified)) throw workspaceErrors.create('workspace_recovery_required', undefined, { state: verified.lifecycle })
        // Removed or emptied by someone else (the agent, the person): the turn runs in the project folder, unrecorded, and
        // the worktree's path is left alone. A thread recorded in the project folder itself has nowhere else to go.
        const repository = await manager.resolveRepositoryAsync(this.projectPath)
        const context = unprovisionedContext(this.threadId, this.projectPath, repository.capability.gitBacked, WORKTREE_GONE_REASON)
        return isProjectFolderWorkspace(existing) ? context : { ...context, workspaceNote: worktreeGoneNote(existing.worktreePath, verified.lifecycle, this.projectPath) }
      }
      const context = await manager.executionContext(this.projectPath, verified)
      return claimNote ? { ...context, startNote: claimNote } : context
    }
    if (!mutating) {
      const repository = await manager.resolveRepositoryAsync(this.projectPath)
      return unprovisionedContext(this.threadId, this.projectPath, repository.capability.gitBacked, 'Read-only turn uses the primary checkout')
    }
    const repository = await manager.resolveRepositoryAsync(this.projectPath)
    // A thread that started in the folder's hidden store keeps it, even after someone made the folder a Git repository:
    // its turns are recorded there. Only new threads use the repository.
    if (startedInSnapshotStore(this.threadDirectory)) {
      return { threadId: this.threadId, workspacePath: this.projectPath, projectPath: this.projectPath, primaryPath: this.projectPath, lifecycle: 'unprovisioned',
        capability: { gitBacked: repository.capability.gitBacked, checkpointable: false, publishable: false, undoable: false, unavailableReason: SNAPSHOT_STORE_REASON } }
    }
    if (this.placement === 'project-folder' && repository.capability.gitBacked) {
      // The project folder itself, with a record of its own so the turn is snapshotted and can be undone. No worktree.
      const folder = await manager.ensureProjectFolder(this.threadId, conversationBranchId, this.projectPath)
      if (folder) return manager.executionContext(this.projectPath, folder)
      // Never a worktree for this thread, whatever happened above.
      return unprovisionedContext(this.threadId, this.projectPath, true, PROJECT_FOLDER_REASON)
    }
    // A folder without Git (or with no commit yet) works in place whatever the placement: its turns are recorded in the
    // folder's hidden store, as for any thread there.
    if (!repository.capability.gitBacked) {
      return { threadId: this.threadId, workspacePath: this.projectPath, projectPath: this.projectPath, primaryPath: this.projectPath, lifecycle: 'unprovisioned', capability: repository.capability }
    }
    onStep?.('worktree')
    // Read the project folder alongside provisioning. A slow status scan can omit the note and leave provider startup free.
    const startNote = startNoteWhenReady(uncommittedLeftBehindNote(this.projectPath))
    await manager.provision(this.threadId, conversationBranchId, this.projectPath, signal, heldThreadLease, undefined, { nameFrom })
    forgetRepositoryFacts()
    const note = [startNote(), manager.placementNote].filter(Boolean).join(' ')
    return { ...await manager.executionContext(this.projectPath), ...(note ? { startNote: note } : {}) }
  }
}
