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
export interface RepositoryBindingOptions { allowFetch?: boolean; allowPush?: boolean; remote?: string; projectId?: string }
export interface DispatchRuntime {
  resolveAgent(agent: string): Promise<ResolvedAgentDefinition>
  run(request: { definition: ResolvedAgentDefinition; threadId: string; worktreePath: string; prompt: string; executionId: string; limits: AgentExecutionBudget; signal: AbortSignal }): Promise<AgentExecutionResult>
}
export interface DispatchArtifacts {
  /** The root gateway enforces exact committed caller/user/RPC/method/capability scope. */
  readInput(ref: RpcArtifactRef, context: RpcContext): Promise<Uint8Array | AsyncIterable<Uint8Array>>
  prepareResult(bytes: Uint8Array, context: RpcContext): Promise<{ ref: RpcArtifactRef; commit(): void }>
}
export type DispatchPhase = 'preparing' | 'transferring' | 'verifying' | 'running' | 'publishing' | 'cleanup' | 'complete'
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
  createdAt: number
  updatedAt: number
}
