import type { AgentExecutionBudget, AgentExecutionResult } from '../../../shared/agents/execution'
import type { ResolvedAgentDefinition } from '../../../shared/agents/types'
import type { EnvelopeAuthor, RpcArtifactRef, RpcId, Signed } from '../../../shared/net'
import type { RpcContext } from '../../net/contracts'
import type { WorktreeInfo } from '../../worktree/WorktreeManager'

export interface DispatchRequest {
  repoId: string
  baseCommit: string
  agent: string
  prompt: string
  limits: AgentExecutionBudget
  inputBundle?: RpcArtifactRef
  fetch?: boolean
  push?: boolean
}
export interface RepositoryBindingOptions {
  allowFetch?: boolean
  allowPush?: boolean
  remote?: string
  projectId?: string
}
export interface DispatchRuntime {
  resolveAgent(agent: string): Promise<ResolvedAgentDefinition>
  run(request: {
    definition: ResolvedAgentDefinition
    threadId: string
    worktreePath: string
    prompt: string
    executionId: string
    limits: AgentExecutionBudget
    signal: AbortSignal
  }): Promise<AgentExecutionResult>
}
export interface DispatchArtifacts {
  /** The root gateway enforces exact committed caller/user/RPC/method/capability scope. */
  readInput(
    ref: RpcArtifactRef,
    context: RpcContext
  ): Promise<Uint8Array | AsyncIterable<Uint8Array>>
  prepareResult(
    bytes: Uint8Array,
    context: RpcContext
  ): Promise<{ ref: RpcArtifactRef; commit(): void }>
}
export type DispatchPhase =
  'preparing' | 'transferring' | 'verifying' | 'running' | 'publishing' | 'cleanup' | 'complete'
export type DispatchState = 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain'
export interface DispatchResultBody {
  v: 1
  kind: 'bridge.dispatch.result.v1'
  dispatch: string
  execution: string
  rpc: RpcId
  requestHash: string
  author: EnvelopeAuthor
  issuedAt: number
  repoId: string
  baseCommit: string
  headCommit: string
  branch: string
  ref: string
  bundleHash: string
  artifact: RpcArtifactRef
  agent: { definitionId: string; revision: string; profileId: string }
  threadId: string
  errors: []
}
export interface DispatchRecord {
  id: string
  execution: string
  caller: string
  user: string
  rpc: string
  requestHash: string
  request: DispatchRequest
  binding: { path: string; options: RepositoryBindingOptions }
  state: DispatchState
  phase: DispatchPhase
  threadId?: string
  definition?: { definitionId: string; revision: string; profileId: string }
  worktree?: WorktreeInfo
  result?: Signed
  error?: string
  cleanupError?: 'worktree_cleanup_failed' | 'quarantine_cleanup_failed'
  /** Why the worktree's cleanup did not finish, such as "Kept: it has uncommitted changes (a.txt). Nothing in it was changed." */
  cleanupReason?: string
  /**
   * A worktree cleanup under way, recorded before the worktree's ignored files and Git's own data of it are kept, and
   * again once they are kept and the proof is recorded, before the folder is renamed to `path` and deleted against the
   * proof (`ref` and `sha` name the copy of the files Git cannot write back, `admin` the copy of Git's data).
   * One a start-up finds in `deleting` is finished against the recorded proof. One in `keeping` (or `removing`, from
   * before cleanup deleted against a proof) is settled from what is there, never repeated.
   */
  worktreeCleanup?: { phase: 'keeping' | 'removing' | 'deleting'; owner: string; files: number; ref?: string; sha?: string; admin?: { ref: string; sha: string }; path?: string }
  /** The copy of the worktree's ignored files, kept before the worktree was removed. */
  worktreeCopy?: { ref: string; sha: string; files: number }
  /**
   * The worktree was not removed and stays where it was: its ignored files could not be kept first, or its cleanup
   * stopped part way. `reason` starts "Kept, N ignored files". Storage lists it, where it can be deleted.
   */
  worktreeKept?: { ignoredFiles: number; reason: string }
  createdAt: number
  updatedAt: number
}
