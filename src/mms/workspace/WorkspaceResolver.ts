import { createErrorProvider } from '../../shared/errors'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { ChatMode } from '../../shared/types'
import type { WorkspaceExecutionContext } from '../../shared/workspace'
import { inspectPendingChanges } from '../actions/git'
import { PROJECT_FOLDER_REASON, type ThreadPlacement } from './threadPlacement'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'
import { startedInSnapshotStore } from './SnapshotWorkspace'

/** A thread that records its turns in its folder's hidden store, whatever the folder has become since (`unavailableReason`). */
export const SNAPSHOT_STORE_REASON = 'snapshot-store'

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
export function uncommittedLeftBehindNote(projectPath: string): string | undefined {
  let paths: string[]
  try {
    paths = inspectPendingChanges(projectPath).files.filter((path) => path !== '.mousse' && !path.startsWith('.mousse/'))
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
    private readonly placement: ThreadPlacement
  ) {}

  async resolve(
    mode: ChatMode,
    conversationBranchId = 'main',
    signal?: AbortSignal,
    heldThreadLease?: ThreadLeaseHandle,
    /** The thread's first message: a worktree made now names its branch from it (`ThreadWorkspaceManager.provision`). */
    nameFrom?: string
  ): Promise<WorkspaceExecutionContext> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const mutating = modeMutatesFiles(mode)
    const existing = manager.load()
    if (existing) {
      if (existing.lifecycle !== 'ready') throw workspaceErrors.create('workspace_recovery_required', undefined, { state: existing.lifecycle })
      const verified = manager.verify(existing)
      if (verified.lifecycle === 'missing' && manager.hasReconstructionManifest(existing)) {
        return manager.executionContext(this.projectPath, await manager.restore(this.projectPath, signal, heldThreadLease))
      }
      if (verified.lifecycle !== 'ready') throw workspaceErrors.create('workspace_recovery_required', undefined, { state: verified.lifecycle })
      return manager.executionContext(this.projectPath, verified)
    }
    if (!mutating) {
      const repository = manager.resolveRepository(this.projectPath)
      return unprovisionedContext(this.threadId, this.projectPath, repository.capability.gitBacked, 'Read-only turn uses the primary checkout')
    }
    const repository = manager.resolveRepository(this.projectPath)
    // A thread that started in the folder's hidden store keeps it, even after someone made the folder a Git repository:
    // its turns are recorded there. Only new threads use the repository.
    if (startedInSnapshotStore(this.threadDirectory)) {
      return { threadId: this.threadId, workspacePath: this.projectPath, projectPath: this.projectPath, primaryPath: this.projectPath, lifecycle: 'unprovisioned',
        capability: { gitBacked: repository.capability.gitBacked, checkpointable: false, publishable: false, undoable: false, unavailableReason: SNAPSHOT_STORE_REASON } }
    }
    if (this.placement === 'project-folder' && repository.capability.gitBacked) {
      return unprovisionedContext(this.threadId, this.projectPath, true, PROJECT_FOLDER_REASON)
    }
    // A folder without Git (or with no commit yet) works in place whatever the placement: its turns are recorded in the
    // folder's hidden store, as for any thread there.
    if (!repository.capability.gitBacked) {
      return { threadId: this.threadId, workspacePath: this.projectPath, projectPath: this.projectPath, primaryPath: this.projectPath, lifecycle: 'unprovisioned', capability: repository.capability }
    }
    // Read before the worktree exists: what the project folder holds that the new worktree, cut from HEAD, will not.
    const startNote = uncommittedLeftBehindNote(this.projectPath)
    await manager.provision(this.threadId, conversationBranchId, this.projectPath, signal, heldThreadLease, undefined, { nameFrom })
    return { ...manager.executionContext(this.projectPath), ...(startNote ? { startNote } : {}) }
  }
}
