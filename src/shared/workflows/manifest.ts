import type { WorkflowBinding } from './bindings'
import type { WorkflowExpression } from './expressions'
import type {
  FileInputRewrite,
  FileInputSource,
  ScriptExecutionMode,
  ScriptRuntime,
  WorkflowEffectClass,
  WorkflowJoinPolicy,
  WorkflowLoopFailPolicy,
  WorkflowNodeType
} from './nodeCatalog'
import type { BoundedJsonSchema } from './schema'

export interface WorkflowRetryPolicy {
  maxAttempts: number
  backoffMs?: number
}

export interface WorkflowFileInputDeclaration {
  pointer: string
  source: FileInputSource
  destination: string
  rewrite: FileInputRewrite
  maxTotalBytes: number
}

export interface WorkflowDependencyRef {
  kind: 'agent' | 'skill' | 'mcp-tool' | 'subworkflow' | 'asset' | 'tool'
  id: string
  revision?: string
  hash?: string
  name?: string
  slug?: string
}

export interface WorkflowAgentRef {
  kind: 'main' | 'user'
  definitionId?: string
  revision?: string
}

export interface WorkflowGraph {
  entryNodeId: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowSubgraph extends WorkflowGraph {}

export interface WorkflowParallelBranch {
  id: string
  subgraph: WorkflowSubgraph
}

export interface WorkflowSwitchCase {
  key: string
  equals: WorkflowBinding
}

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType | string
  version: number
  inputs?: Record<string, WorkflowBinding>
  config: Record<string, unknown>
  effect?: WorkflowEffectClass
  retry?: WorkflowRetryPolicy
  timeoutMs?: number
  extensions?: Record<string, unknown>
}

export interface WorkflowEdge {
  from: string
  port: string
  to: string
}

export interface WorkflowLimits {
  maxSteps?: number
  timeoutMs?: number
  maxConcurrency?: number
  maxLoopIterations?: number
  maxTokens?: number
  maxCost?: number
  maxArtifactBytes?: number
}

export interface WorkflowPermissions {
  capabilities: string[]
}

export interface WorkflowDependencyPolicy {
  mode: 'pinned' | 'draft'
  dependencies?: WorkflowDependencyRef[]
}

export interface WorkflowManifest {
  schemaVersion: number
  id: string
  name: string
  slug: string
  description?: string
  instructionsFile?: string
  inputSchema: BoundedJsonSchema
  outputSchema: BoundedJsonSchema
  entryNodeId: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  limits?: WorkflowLimits
  permissions?: WorkflowPermissions
  dependencyPolicy?: WorkflowDependencyPolicy
  extensions?: Record<string, unknown>
}

export interface ScriptNodeConfig {
  runtime: ScriptRuntime
  file: string
  fileInputs?: WorkflowFileInputDeclaration[]
  executionMode: ScriptExecutionMode
  workingDirectory?: 'thread-workspace' | 'run-staging' | 'profile-sandbox'
  timeoutMs?: number
  outputSchema?: BoundedJsonSchema
  argv?: string[]
  environmentAllowlist?: string[]
}

export interface AgentNodeConfig {
  agent: WorkflowAgentRef
  instructions: string
  outputSchema?: BoundedJsonSchema
}

export interface ConditionNodeConfig {
  expression: WorkflowExpression
}

export interface TransformNodeConfig {
  value?: WorkflowBinding
  expression?: WorkflowExpression
}

export interface ForEachNodeConfig {
  items: WorkflowBinding
  maxIterations: number
  maxDurationMs?: number
  failPolicy?: WorkflowLoopFailPolicy
  subgraph: WorkflowSubgraph
}

export interface BoundedRepeatNodeConfig {
  maxIterations: number
  maxDurationMs?: number
  until?: WorkflowExpression
  subgraph: WorkflowSubgraph
}

export interface ParallelNodeConfig {
  maxConcurrency?: number
  branches: WorkflowParallelBranch[]
}

export interface JoinNodeConfig {
  parallelNodeId: string
  policy: WorkflowJoinPolicy
}

export interface SubworkflowNodeConfig {
  workflow: { id?: string; slug?: string; revision?: string }
  input?: WorkflowBinding
}

export const EFFECT_CLASSES: readonly WorkflowEffectClass[] = [
  'pure',
  'read',
  'write',
  'external',
  'unknown'
]

export const JOIN_POLICIES: readonly WorkflowJoinPolicy[] = [
  'all-success',
  'collect-results',
  'first-success'
]
