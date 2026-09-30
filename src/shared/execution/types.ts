export const EXECUTION_CONTRACT_VERSION = 1 as const
export type EffectClass = 'pure' | 'read' | 'write' | 'external' | 'unknown'
export type ExecutionSource = 'gui' | 'cli' | 'schedule' | 'channel' | 'control'

/** Revision actually consumed/produced by an execution attempt. */
export interface ExecutionWorkspaceRevision {
  workspaceId: string
  readSha: string
  writeSha: string
  receiptId?: string
  generation?: number
}

export interface ExecutionActor {
  readonly kind: 'main' | 'agent' | 'workflow' | 'scheduler' | 'channel'
  readonly definitionId?: string
  readonly definitionRevision?: string
}

/** Created by validated daemon ingress. Models and imported bundles cannot supply it. */
export interface ExecutionContext {
  readonly profileId: string
  readonly projectId?: string
  readonly threadId: string
  readonly turnId: string
  readonly runId?: string
  readonly actor: ExecutionActor
  readonly policySnapshotId: string
  readonly source: ExecutionSource
  readonly cancellationId: string
}

export interface ExecutionPolicyLayer {
  readonly allowedTools?: readonly string[]
  readonly deniedTools?: readonly string[]
  readonly allowedCapabilities?: readonly string[]
  readonly allowedEffects?: readonly EffectClass[]
  readonly approvalEffects?: readonly EffectClass[]
  readonly maxToolCalls?: number
  readonly maxElapsedMs?: number
  readonly maxArtifactBytes?: number
}

export interface ExecutionPolicySnapshot {
  readonly id: string
  readonly profileId: string
  readonly version: 1
  readonly allowedTools: readonly string[]
  readonly allowedCapabilities: readonly string[]
  readonly allowedEffects: readonly EffectClass[]
  readonly approvalEffects: readonly EffectClass[]
  readonly maxToolCalls: number
  readonly maxElapsedMs: number
  readonly maxArtifactBytes: number
}

export interface ExecutionEffect {
  readonly toolId: string
  readonly classification: EffectClass
  readonly capability?: string
  /** Digest of canonical execution bytes. Display redaction must not change this digest. */
  readonly requestDigest: string
  readonly description: string
}

export type AuthorizationDecision =
  | { status: 'allowed'; policySnapshotId: string }
  | { status: 'approval-required'; policySnapshotId: string; requestDigest: string; unattended: boolean }
  | { status: 'denied'; code: 'profile_mismatch' | 'policy_mismatch' | 'tool_denied' | 'effect_denied' | 'capability_denied' }

export interface ArtifactReference {
  readonly id: string
  readonly profileId: string
  readonly runId?: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
  readonly displayName: string
  readonly createdAt: string
}

export type ExecutionFailureCode =
  | 'cancelled' | 'timed_out' | 'budget_exceeded' | 'approval_required'
  | 'capability_denied' | 'stale_revision' | 'dependency_missing'
  | 'unknown_effect' | 'interrupted' | 'invalid_input' | 'executor_unavailable'
