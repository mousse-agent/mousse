import type { ExecutionPolicyLayer } from '../../../shared/execution/types'
import { isPlainObject, stableStringify, WORKFLOW_MAX_SUBWORKFLOW_DEPTH, type CompiledGraph, type CompiledNode, type CompiledWorkflow, type StartWorkflowRequest, type WorkflowRunManifest } from '../../../shared/workflows'
import { WORKFLOW_EXECUTION_BINDINGS_MAX_BYTES, type WorkflowExecutionBindings } from '../../../shared/workflows/executionBindings'
import type { WorkflowRecordSnapshot, WorkflowRegistry } from '../registry/WorkflowRegistry'

export interface WorkflowIntegrationRef {
  skills: Array<{ id: string; revision?: string }>
  mcpTools: Array<{ serverId: string; toolName: string }>
}

export interface PrepareChildAdmissionFields {
  executionBindings: WorkflowExecutionBindings
  installationPolicy: ExecutionPolicyLayer
  runPolicy?: ExecutionPolicyLayer
}

export type PrepareChildAdmission = (
  request: StartWorkflowRequest,
  parent: WorkflowRunManifest,
  child: WorkflowRecordSnapshot
) => Promise<PrepareChildAdmissionFields>

class ChildAdmissionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChildAdmissionError'
    this.code = code
  }
}

export function collectWorkflowIntegrationRefs(graph: CompiledGraph): WorkflowIntegrationRef {
  const skills = new Map<string, { id: string; revision?: string }>()
  const mcpTools = new Map<string, { serverId: string; toolName: string }>()
  const visit = (nodeGraph: CompiledGraph): void => {
    for (const node of nodeGraph.nodes) {
      if (node.type === 'load-skill' && isPlainObject(node.config.skill)) {
        const ref = { id: String(node.config.skill.id), revision: typeof node.config.skill.revision === 'string' ? node.config.skill.revision : undefined }
        skills.set(stableStringify(ref), ref)
      }
      if (node.type === 'mcp-tool') {
        const ref = { serverId: String(node.config.serverId), toolName: String(node.config.toolName) }
        mcpTools.set(stableStringify(ref), ref)
      }
      for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
    }
  }
  visit(graph)
  return { skills: [...skills.values()], mcpTools: [...mcpTools.values()] }
}

export function pinnedSubworkflowRevision(
  node: CompiledNode,
  compiled: CompiledWorkflow
): { id: string; revision: string } | undefined {
  if (node.type !== 'subworkflow' || !isPlainObject(node.config.workflow)) return undefined
  const ref = node.config.workflow as { id?: string; slug?: string; revision?: string }
  const declared = compiled.dependencies.find((dependency) => dependency.kind === 'subworkflow' && (
    (ref.id !== undefined && dependency.id === ref.id) ||
    (ref.slug !== undefined && (dependency.slug === ref.slug || dependency.id === ref.slug))
  ))
  const pinnedRevision = ref.revision ?? declared?.revision ?? declared?.hash
  const childDefinitionId = ref.id ?? declared?.id
  if (!childDefinitionId || !pinnedRevision) return undefined
  const declaredRevision = declared?.revision ?? declared?.hash
  if (ref.revision && declaredRevision && ref.revision !== declaredRevision) {
    throw new ChildAdmissionError('stale_revision', 'Subworkflow node revision does not match its pinned dependency')
  }
  return { id: childDefinitionId, revision: pinnedRevision }
}

export function collectTransitiveWorkflowRecords(
  record: WorkflowRecordSnapshot,
  registry: Pick<WorkflowRegistry, 'getRevision'>,
  options?: { onMissing?: (id: string, revision: string) => never }
): WorkflowRecordSnapshot[] {
  const found: WorkflowRecordSnapshot[] = []
  const seen = new Set<string>()
  const walk = (current: WorkflowRecordSnapshot, depth: number): void => {
    const visit = (graph: CompiledGraph): void => {
      for (const node of graph.nodes) {
        const pin = pinnedSubworkflowRevision(node, current.compiled)
        if (pin) {
          const key = pin.id + '@' + pin.revision
          if (!seen.has(key)) {
            if (depth >= WORKFLOW_MAX_SUBWORKFLOW_DEPTH) {
              throw new ChildAdmissionError('invalid_input', 'Subworkflow depth exceeded while collecting pinned child bindings')
            }
            seen.add(key)
            const child = registry.getRevision(pin.id, pin.revision)
            if (!child) {
              options?.onMissing?.(pin.id, pin.revision)
              throw new ChildAdmissionError('dependency_missing', 'Pinned child workflow revision is unavailable: ' + pin.id)
            }
            found.push(child)
            walk(child, depth + 1)
          }
        }
        for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
      }
    }
    visit(current.compiled.graph)
  }
  walk(record, 0)
  return found
}

export function inheritChildAdmission(args: {
  parent: WorkflowRunManifest
  child: WorkflowRecordSnapshot
  request: StartWorkflowRequest
}): PrepareChildAdmissionFields {
  const { parent, child, request } = args
  if (parent.profileId !== request.profileId || child.profileId !== request.profileId) {
    throw new ChildAdmissionError('profile_mismatch', 'Child workflow admission belongs to another profile')
  }
  if (parent.projectId !== request.projectId) {
    throw new ChildAdmissionError('project_mismatch', 'Child workflow project must match its parent run')
  }
  if (parent.threadId !== request.threadId) {
    throw new ChildAdmissionError('thread_unavailable', 'Child workflow thread must match its parent run')
  }
  const refs = collectWorkflowIntegrationRefs(child.compiled.graph)
  const parentBindings = parent.executionBindings
  if (parentBindings && (parentBindings.version !== 1 || parentBindings.profileId !== request.profileId)) {
    throw new ChildAdmissionError('profile_mismatch', 'Parent workflow bindings belong to another profile')
  }
  const bindings: WorkflowExecutionBindings = { version: 1, profileId: request.profileId, skills: [], mcpTools: [] }
  for (const ref of refs.skills) {
    const matches = (parentBindings?.skills ?? []).filter((skill) => skill.requestedId === ref.id && skill.requestedRevision === ref.revision)
    if (matches.length !== 1) {
      throw new ChildAdmissionError(
        'dependency_missing',
        matches.length === 0
          ? 'Pinned child Skill is missing from the parent workflow binding snapshot: ' + ref.id
          : 'Pinned child Skill has conflicting parent binding snapshots: ' + ref.id
      )
    }
    const pin = matches[0]!
    if (pin.installationId.length === 0 || pin.contentHash !== pin.revision) {
      throw new ChildAdmissionError('invalid_input', 'Pinned child Skill snapshot is malformed: ' + ref.id)
    }
    bindings.skills.push(structuredClone(pin))
  }
  for (const ref of refs.mcpTools) {
    const matches = (parentBindings?.mcpTools ?? []).filter((tool) => tool.requestedServerId === ref.serverId && tool.toolName === ref.toolName)
    if (matches.length !== 1) {
      throw new ChildAdmissionError(
        'dependency_missing',
        matches.length === 0
          ? 'Pinned child MCP tool is missing from the parent workflow binding snapshot: ' + ref.serverId + '/' + ref.toolName
          : 'Pinned child MCP tool has conflicting parent binding snapshots: ' + ref.serverId + '/' + ref.toolName
      )
    }
    bindings.mcpTools.push(structuredClone(matches[0]!))
  }
  if (Buffer.byteLength(JSON.stringify(bindings), 'utf8') > WORKFLOW_EXECUTION_BINDINGS_MAX_BYTES) {
    throw new ChildAdmissionError('invalid_input', 'Child workflow execution bindings exceed 8 MiB')
  }
  const parentCapabilities = request.runPolicy?.allowedCapabilities ?? request.installationPolicy.allowedCapabilities ?? []
  const allowedCapabilities = [...new Set(parentCapabilities.filter((capability) => child.compiled.permissions.includes(capability)))]
  return {
    executionBindings: bindings,
    installationPolicy: request.installationPolicy,
    runPolicy: {
      ...request.runPolicy,
      allowedCapabilities
    }
  }
}

export function isChildAdmissionError(error: unknown): error is Error & { code: string } {
  return error instanceof ChildAdmissionError
}
