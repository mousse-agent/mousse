import type { WorkflowDiagnostic } from './diagnostics'
import type { WorkflowBinding } from './bindings'
import type { WorkflowExpression } from './expressions'
import type {
  WorkflowDependencyRef,
  WorkflowLimits,
  WorkflowManifest,
  WorkflowRetryPolicy
} from './manifest'
import type { WorkflowEffectClass, WorkflowNodeType } from './nodeCatalog'
import type { BoundedJsonSchema } from './schema'

export interface CompiledControlEdge {
  from: string
  port: string
  to: string
}

export interface CompiledNode {
  id: string
  type: WorkflowNodeType | string
  version: number
  supported: boolean
  runtime: boolean
  terminal: boolean
  effect: WorkflowEffectClass
  timeoutMs?: number
  retry?: WorkflowRetryPolicy
  inputs: Record<string, WorkflowBinding>
  config: Record<string, unknown>
  requiredCapabilities: string[]
  controlOutPorts: string[]
  subgraphs?: Record<string, CompiledGraph>
  expression?: WorkflowExpression
  sourcePreserved: boolean
}

export interface CompiledGraph {
  entryNodeId: string
  nodes: CompiledNode[]
  edges: CompiledControlEdge[]
  nodeIds: string[]
}

export interface CompiledWorkflow {
  schemaVersion: number
  id: string
  name: string
  slug: string
  description?: string
  instructionsFile?: string
  inputSchema: BoundedJsonSchema
  outputSchema: BoundedJsonSchema
  limits: WorkflowLimits
  permissions: string[]
  dependencies: WorkflowDependencyRef[]
  graph: CompiledGraph
  diagnostics: WorkflowDiagnostic[]
  runnable: boolean
  unsupportedNodeTypes: string[]
  semanticSource: WorkflowManifest
}

export interface CompileWorkflowOptions {
  currentWorkflowId?: string
  /** Stack of workflow ids currently being compiled; used for recursive subworkflow detection. */
  compilationStack?: string[]
  dependencyResolver?: WorkflowDependencyResolver
  mode?: 'draft' | 'publish'
  knownAssets?: ReadonlySet<string>
}

export interface WorkflowDependencyResolver {
  hasWorkflow?(ref: { id?: string; slug?: string; revision?: string }): boolean
  workflowDependsOn?(id: string): string[]
  hasAgent?(ref: { definitionId?: string; kind: string; revision?: string }): boolean
  hasSkill?(ref: { id: string; revision?: string }): boolean
  hasMcpTool?(ref: { id: string; revision?: string }): boolean
  hasTool?(ref: { id: string }): boolean
}
