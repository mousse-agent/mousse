import { createErrorProvider } from '../../shared/errors'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import type { ChatMode } from '../../shared/types'
import type { WorkspaceExecutionContext } from '../../shared/workspace'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'

/** Resolves one authoritative path at the turn boundary; no selected-project globals. */
const workspaceErrors = createErrorProvider({
  workspace_recovery_required: { category: 'conflict', retryable: false, message: 'Thread workspace requires restore or recovery before execution.' }
})

export class WorkspaceResolver {
  constructor(
    private readonly threadDirectory: string,
    private readonly threadId: string,
    private readonly projectPath: string
  ) {}

  async resolve(
    mode: ChatMode,
    conversationBranchId = 'main',
    signal?: AbortSignal,
    heldThreadLease?: ThreadLeaseHandle
  ): Promise<WorkspaceExecutionContext> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const mutating = mode === 'agent' || mode === 'build' || (typeof mode === 'object' && 'skillId' in mode)
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
      return {
        threadId: this.threadId,
        workspacePath: this.projectPath,
        projectPath: this.projectPath,
        primaryPath: this.projectPath,
        lifecycle: 'unprovisioned',
        capability: {
          gitBacked: repository.capability.gitBacked,
          checkpointable: false,
          publishable: false,
          undoable: false,
          unavailableReason: 'Read-only turn uses the primary checkout'
        }
      }
    }
    const repository = manager.resolveRepository(this.projectPath)
    if (!repository.capability.gitBacked) {
      return { threadId: this.threadId, workspacePath: this.projectPath, projectPath: this.projectPath, primaryPath: this.projectPath, lifecycle: 'unprovisioned', capability: repository.capability }
    }
    if (!manager.load()) await manager.provision(this.threadId, conversationBranchId, this.projectPath, signal, heldThreadLease)
    return manager.executionContext(this.projectPath)
  }
}
