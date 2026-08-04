import { basename, join, resolve } from 'node:path'

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,127}$/i

/**
 * The complete agent id is part of both the branch and directory identity. Truncating
 * ids can make two concurrently-created workers share a branch or worktree.
 */
export class WorktreeIdentity {
  readonly branch: string
  readonly directoryName: string
  readonly path: string

  private constructor(worktreesBase: string, readonly agentId: string) {
    this.directoryName = `agent-${agentId}`
    this.branch = `mousse/${this.directoryName}`
    this.path = join(worktreesBase, this.directoryName)
  }

  static forAgent(worktreesBase: string, agentId: string): WorktreeIdentity {
    if (!AGENT_ID_PATTERN.test(agentId)) {
      throw new Error('Agent id must be a complete safe identifier (3–128 letters, digits, _ or -).')
    }
    return new WorktreeIdentity(worktreesBase, agentId)
  }

  static isPathFor(identity: Pick<WorktreeIdentity, 'path' | 'directoryName'>, worktreesBase: string): boolean {
    const base = resolve(worktreesBase)
    const path = resolve(identity.path)
    return path === resolve(base, identity.directoryName) && basename(path) === identity.directoryName
  }
}
