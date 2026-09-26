export interface AgentWorkspacePolicy {
  version: 1
  workspace: 'shared' | 'isolated'
  access: 'read-only' | 'write'
}

export interface AgentEpisodeBinding {
  workspaceId: string
  generation: number
  worktreePath: string
  branch?: string
  baseSha?: string
  /** Shared observations are never exact-revision evidence, even at the same generation. */
  consistency: 'moving' | 'snapshot'
  sparseFiles?: string[]
}

export interface NamedAgentIdentity {
  id: string
  name: string
  aliases: string[]
  state: 'available' | 'dormant' | 'retired'
  contextGeneration: number
  activeEpisodeId?: string
  lastEpisodeId?: string
  createdAt: string
}

export interface AgentEpisode {
  id: string
  agentId: string
  parentEpisodeId?: string
  requestHash: string
  request?: { name: string; provider?: string; model?: string; effort?: string }
  policy: AgentWorkspacePolicy
  binding: AgentEpisodeBinding
  parentConversation: { branchId: string; boundary: number }
  contextGeneration: number
  task: string
  assignment?: { provider?: string; model?: string; effort?: string }
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  createdAt: string
  completedAt?: string
  result?: { receiptId?: string; resultSha?: string; nativeContextRevision?: number; reason?: string }
}

export interface AgentEpisodeState {
  schemaVersion: 1
  identities: NamedAgentIdentity[]
  episodes: AgentEpisode[]
}
