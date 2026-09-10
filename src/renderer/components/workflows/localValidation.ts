import {
  diagnostic,
  getNodeCatalogEntry,
  hasErrorDiagnostics,
  isReservedWorkflowSlug,
  isWorkflowNodeType,
  parseWorkflowBinding,
  parseWorkflowExpression,
  WORKFLOW_MAX_EDGES,
  WORKFLOW_MAX_NODES,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_SLUG_PATTERN,
  WORKFLOW_UUID_PATTERN,
  type WorkflowDiagnostic,
  type WorkflowEdge,
  type WorkflowManifest,
  type WorkflowNode
} from '../../../shared/workflows'
import { controlOutPortsForNode } from './defaultNode'

export interface LocalValidationResult {
  diagnostics: WorkflowDiagnostic[]
  preventable: WorkflowDiagnostic[]
  runnableHint: boolean
}

function nodeIds(nodes: readonly WorkflowNode[]): Set<string> {
  return new Set(nodes.map((node) => node.id))
}

export function collectLocalDiagnostics(manifest: WorkflowManifest): LocalValidationResult {
  const diagnostics: WorkflowDiagnostic[] = []
  const preventable: WorkflowDiagnostic[] = []

  if (!WORKFLOW_UUID_PATTERN.test(manifest.id)) {
    diagnostics.push(diagnostic('INVALID_ID', 'id must be a UUID', { path: '/id' }))
  }
  if (!manifest.name || manifest.name.length > WORKFLOW_NAME_MAX_LENGTH) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'name is required and must be ≤ 120 characters', { path: '/name' }))
  }
  if (!WORKFLOW_SLUG_PATTERN.test(manifest.slug ?? '')) {
    diagnostics.push(
      diagnostic('INVALID_SLUG', 'slug must be lowercase letters, digits, underscore, or hyphen, max 64 characters', {
        path: '/slug'
      })
    )
  }
  if (isReservedWorkflowSlug(manifest.slug ?? '')) {
    diagnostics.push(diagnostic('RESERVED_SLUG', `slug "${manifest.slug}" is reserved`, { path: '/slug' }))
  }

  const ids = nodeIds(manifest.nodes)
  const seen = new Set<string>()
  for (const node of manifest.nodes) {
    if (seen.has(node.id)) {
      const issue = diagnostic('DUPLICATE_NODE_ID', `Duplicate node id "${node.id}"`, { nodeId: node.id })
      diagnostics.push(issue)
      preventable.push(issue)
    }
    seen.add(node.id)
    if (!isWorkflowNodeType(node.type)) {
      diagnostics.push(
        diagnostic(
          'UNSUPPORTED_NODE',
          `Unsupported node type "${node.type}" is preserved and cannot run.`,
          { nodeId: node.id, severity: 'warning' }
        )
      )
    }
    const inputs = node.inputs ?? {}
    for (const [name, binding] of Object.entries(inputs)) {
      const parsed = parseWorkflowBinding(binding)
      if (!parsed.ok) {
        const issue = diagnostic('INVALID_BINDING', `${name}: ${parsed.error}`, {
          nodeId: node.id,
          path: `/nodes/${node.id}/inputs/${name}`
        })
        diagnostics.push(issue)
        preventable.push(issue)
      }
    }
    if (node.type === 'condition' && node.config.expression) {
      const parsed = parseWorkflowExpression(node.config.expression)
      if (!parsed.ok) {
        const issue = diagnostic('INVALID_EXPRESSION', parsed.error, {
          nodeId: node.id,
          path: `/nodes/${node.id}/config/expression`
        })
        diagnostics.push(issue)
        preventable.push(issue)
      }
    }
  }

  if (!ids.has(manifest.entryNodeId)) {
    diagnostics.push(diagnostic('INVALID_ENTRY', `entryNodeId "${manifest.entryNodeId}" is missing`, { path: '/entryNodeId' }))
  }

  if (manifest.nodes.length > WORKFLOW_MAX_NODES) {
    diagnostics.push(diagnostic('GRAPH_TOO_LARGE', `Graph exceeds ${WORKFLOW_MAX_NODES} nodes`))
  }
  if (manifest.edges.length > WORKFLOW_MAX_EDGES) {
    diagnostics.push(diagnostic('GRAPH_TOO_LARGE', `Graph exceeds ${WORKFLOW_MAX_EDGES} edges`))
  }

  const edgeKeys = new Set<string>()
  for (const edge of manifest.edges) {
    const key = `${edge.from}:${edge.port}->${edge.to}`
    if (edgeKeys.has(key)) {
      const issue = diagnostic('DUPLICATE_EDGE', `Duplicate edge ${key}`, { edge })
      diagnostics.push(issue)
      preventable.push(issue)
    }
    edgeKeys.add(key)
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      const issue = diagnostic('MISSING_REF', `Edge ${key} references a missing node`, { edge })
      diagnostics.push(issue)
      preventable.push(issue)
      continue
    }
    if (edge.from === edge.to) {
      const issue = diagnostic('CYCLE_DETECTED', 'Self-loop edges are not allowed', { edge })
      diagnostics.push(issue)
      preventable.push(issue)
    }
    const from = manifest.nodes.find((node) => node.id === edge.from)
    if (from) {
      const ports = controlOutPortsForNode(from)
      const entry = getNodeCatalogEntry(from.type)
      if (entry && !ports.includes(edge.port) && !entry.controlOutPorts.some((port) => port.dynamic)) {
        const issue = diagnostic('INVALID_PORT', `Node "${from.id}" has no control port "${edge.port}"`, {
          nodeId: from.id,
          edge
        })
        diagnostics.push(issue)
        preventable.push(issue)
      }
    }
  }

  const unsupported = manifest.nodes.filter((node) => !isWorkflowNodeType(node.type))
  const runnableHint = !hasErrorDiagnostics(diagnostics) && unsupported.length === 0
  return { diagnostics, preventable, runnableHint }
}

export function explainInvalidConnection(
  manifest: WorkflowManifest,
  edge: WorkflowEdge
): string | null {
  if (edge.from === edge.to) return 'A node cannot connect to itself.'
  const from = manifest.nodes.find((node) => node.id === edge.from)
  const to = manifest.nodes.find((node) => node.id === edge.to)
  if (!from || !to) return 'Both ends of a connection must exist.'
  if (!isWorkflowNodeType(from.type)) {
    return `Unsupported node "${from.type}" can be preserved but cannot receive new typed connections.`
  }
  const ports = controlOutPortsForNode(from)
  if (!ports.includes(edge.port)) {
    return `Node "${from.id}" (${from.type}) does not expose control port "${edge.port}".`
  }
  if (manifest.edges.some((item) => item.from === edge.from && item.port === edge.port && item.to === edge.to)) {
    return 'That connection already exists.'
  }
  return null
}

export function mergeDiagnostics(
  local: readonly WorkflowDiagnostic[],
  remote: readonly WorkflowDiagnostic[]
): WorkflowDiagnostic[] {
  const keys = new Set<string>()
  const result: WorkflowDiagnostic[] = []
  for (const item of [...local, ...remote]) {
    const key = `${item.code}:${item.nodeId ?? ''}:${item.path ?? ''}:${item.message}`
    if (keys.has(key)) continue
    keys.add(key)
    result.push(item)
  }
  return result
}
