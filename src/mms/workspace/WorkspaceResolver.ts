import type { ChatMode } from '../../shared/types'
import type { WorkspaceExecutionContext } from '../../shared/workspace'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'

/** Resolves one authoritative path at the turn boundary; no selected-project globals. */
export class WorkspaceResolver {
  constructor(
    private readonly threadDirectory: string,
    private readonly threadId: string,
    private readonly projectPath: string
  ) {}

  async resolve(
    mode: ChatMode,
    conversationBranchId = 'main',
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionContext> {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const mutating = mode === 'agent' || mode === 'build' || (typeof mode === 'object' && 'skillId' in mode)
    if (!mutating) {
      return {
        threadId: this.threadId,
        workspacePath: this.projectPath,
        projectPath: this.projectPath,
        primaryPath: this.projectPath,
        lifecycle: 'unprovisioned',
        capability: {
          gitBacked: true,
          checkpointable: false,
          publishable: false,
          undoable: false,
          unavailableReason: 'Read-only turn uses the primary checkout'
        }
      }
    }
    if (!manager.load()) await manager.provision(this.threadId, conversationBranchId, this.projectPath, signal)
    return manager.executionContext(this.projectPath)
  }
}
