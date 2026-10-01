import {
  diagnostic,
  isFiniteInteger,
  isPlainObject,
  jsonByteLength,
  parseWorkflowBinding,
  WORKFLOW_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_FORMAT_SCHEMA_VERSION,
  WORKFLOW_MAX_MANIFEST_BYTES,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_SLUG_MAX_LENGTH,
  WORKFLOW_SLUG_PATTERN,
  WORKFLOW_UUID_PATTERN,
  type WorkflowBinding,
  type WorkflowDiagnostic,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowLimits,
  type WorkflowManifest,
  type WorkflowNode,
  type WorkflowRetryPolicy
} from '../../../shared/workflows'
import { boundedJsonSchemaSubsetValidator } from '../schema/boundedJsonSchema'

export interface ParsedManifest {
  manifest: WorkflowManifest
  diagnostics: WorkflowDiagnostic[]
}

export function parseWorkflowManifest(source: unknown): ParsedManifest {
  const diagnostics: WorkflowDiagnostic[] = []
  if (!isPlainObject(source)) {
    diagnostics.push(diagnostic('MALFORMED_SOURCE', 'workflow.json must be a JSON object'))
    return {
      manifest: emptyManifest(),
      diagnostics
    }
  }
  if (jsonByteLength(source) > WORKFLOW_MAX_MANIFEST_BYTES) {
    diagnostics.push(diagnostic('GRAPH_TOO_LARGE', 'Manifest exceeds maximum byte size'))
  }

  const schemaVersion = source.schemaVersion
  if (schemaVersion !== WORKFLOW_FORMAT_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported schemaVersion ${String(schemaVersion)}; v1 is required. Unknown majors open read-only.`,
        { severity: schemaVersion === undefined ? 'error' : 'error' }
      )
    )
  }

  const id = typeof source.id === 'string' ? source.id : ''
  if (!WORKFLOW_UUID_PATTERN.test(id)) {
    diagnostics.push(diagnostic('INVALID_ID', 'id must be a UUID'))
  }
  const name = typeof source.name === 'string' ? source.name : ''
  if (!name || name.length > WORKFLOW_NAME_MAX_LENGTH) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'name is required and must be ≤ 120 characters'))
  }
  const slug = typeof source.slug === 'string' ? source.slug : ''
  if (!WORKFLOW_SLUG_PATTERN.test(slug) || slug.length > WORKFLOW_SLUG_MAX_LENGTH) {
    diagnostics.push(
      diagnostic(
        'INVALID_SLUG',
        'slug must be lowercase letters, digits, underscore, or hyphen, max 64 characters'
      )
    )
  }
  const description =
    source.description === undefined
      ? undefined
      : typeof source.description === 'string' && source.description.length <= WORKFLOW_DESCRIPTION_MAX_LENGTH
        ? source.description
        : (diagnostics.push(diagnostic('INVALID_MANIFEST', 'description is too long')), undefined)

  const instructionsFile =
    source.instructionsFile === undefined
      ? undefined
      : typeof source.instructionsFile === 'string'
        ? source.instructionsFile
        : (diagnostics.push(diagnostic('INVALID_MANIFEST', 'instructionsFile must be a string')), undefined)

  const inputSchemaResult = boundedJsonSchemaSubsetValidator.validateDocument(
    source.inputSchema ?? { type: 'object', additionalProperties: false },
    '/inputSchema'
  )
  diagnostics.push(...inputSchemaResult.diagnostics)
  const outputSchemaResult = boundedJsonSchemaSubsetValidator.validateDocument(
    source.outputSchema ?? { type: 'object', additionalProperties: false },
    '/outputSchema'
  )
  diagnostics.push(...outputSchemaResult.diagnostics)

  const entryNodeId = typeof source.entryNodeId === 'string' ? source.entryNodeId : ''
  if (!entryNodeId) diagnostics.push(diagnostic('MISSING_ENTRY', 'entryNodeId is required'))

  const nodes = parseNodes(source.nodes, diagnostics)
  const edges = parseEdges(source.edges, diagnostics)
  const limits = parseLimits(source.limits, diagnostics)
  const permissions = parsePermissions(source.permissions, diagnostics)
  const dependencyPolicy = parseDependencyPolicy(source.dependencyPolicy, diagnostics)
  const extensions = isPlainObject(source.extensions) ? source.extensions : undefined

  const manifest: WorkflowManifest = {
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : WORKFLOW_FORMAT_SCHEMA_VERSION,
    id: id || '00000000-0000-4000-8000-000000000000',
    name: name || 'untitled',
    slug: slug || 'untitled',
    description,
    instructionsFile,
    inputSchema: inputSchemaResult.schema ?? { type: 'object', additionalProperties: false },
    outputSchema: outputSchemaResult.schema ?? { type: 'object', additionalProperties: false },
    entryNodeId,
    nodes,
    edges,
    limits,
    permissions,
    dependencyPolicy,
    extensions
  }
  return { manifest, diagnostics }
}

export function parseWorkflowGraph(raw: unknown, diagnostics: WorkflowDiagnostic[]): WorkflowGraph | undefined {
  if (!isPlainObject(raw)) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'subgraph must be an object'))
    return undefined
  }
  const entryNodeId = typeof raw.entryNodeId === 'string' ? raw.entryNodeId : ''
  if (!entryNodeId) diagnostics.push(diagnostic('MISSING_ENTRY', 'subgraph.entryNodeId is required'))
  return {
    entryNodeId,
    nodes: parseNodes(raw.nodes, diagnostics),
    edges: parseEdges(raw.edges, diagnostics)
  }
}

function parseNodes(raw: unknown, diagnostics: WorkflowDiagnostic[]): WorkflowNode[] {
  if (!Array.isArray(raw)) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'nodes must be an array'))
    return []
  }
  const nodes: WorkflowNode[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!isPlainObject(item)) {
      diagnostics.push(diagnostic('INVALID_MANIFEST', `nodes[${i}] must be an object`))
      continue
    }
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) diagnostics.push(diagnostic('INVALID_MANIFEST', `nodes[${i}].id is required`))
    const type = typeof item.type === 'string' ? item.type : ''
    if (!type) diagnostics.push(diagnostic('INVALID_MANIFEST', `nodes[${i}].type is required`, { nodeId: id }))
    const version = isFiniteInteger(item.version) ? item.version : 1
    const config = isPlainObject(item.config) ? item.config : {}
    if (item.config !== undefined && !isPlainObject(item.config)) {
      diagnostics.push(diagnostic('INVALID_NODE_CONFIG', `nodes[${i}].config must be an object`, { nodeId: id }))
    }
    const inputs = parseInputs(item.inputs, id, diagnostics)
    const retry = parseRetry(item.retry, id, diagnostics)
    const effect =
      item.effect === undefined
        ? undefined
        : typeof item.effect === 'string'
          ? (item.effect as WorkflowNode['effect'])
          : (diagnostics.push(diagnostic('INVALID_EFFECT', 'effect must be a string', { nodeId: id })), undefined)
    const timeoutMs =
      item.timeoutMs === undefined
        ? undefined
        : isFiniteInteger(item.timeoutMs) && item.timeoutMs > 0
          ? item.timeoutMs
          : (diagnostics.push(diagnostic('INVALID_NODE_CONFIG', 'timeoutMs must be a positive integer', { nodeId: id })),
            undefined)
    const extensions = isPlainObject(item.extensions) ? item.extensions : undefined
    nodes.push({
      id: id || `invalid-${i}`,
      type,
      version,
      inputs,
      config,
      effect,
      retry,
      timeoutMs,
      extensions
    })
  }
  return nodes
}

function parseInputs(
  raw: unknown,
  nodeId: string,
  diagnostics: WorkflowDiagnostic[]
): Record<string, WorkflowBinding> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push(diagnostic('INVALID_BINDING', 'inputs must be an object', { nodeId }))
    return undefined
  }
  const inputs: Record<string, WorkflowBinding> = {}
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseWorkflowBinding(value)
    if (!parsed.ok) {
      diagnostics.push(diagnostic('INVALID_BINDING', `${key}: ${parsed.error}`, { nodeId, path: key }))
      continue
    }
    inputs[key] = parsed.binding
  }
  return inputs
}

function parseRetry(
  raw: unknown,
  nodeId: string,
  diagnostics: WorkflowDiagnostic[]
): WorkflowRetryPolicy | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw) || !isFiniteInteger(raw.maxAttempts) || raw.maxAttempts < 1) {
    diagnostics.push(diagnostic('INVALID_RETRY', 'retry.maxAttempts must be a positive integer', { nodeId }))
    return undefined
  }
  const backoffMs =
    raw.backoffMs === undefined
      ? undefined
      : isFiniteInteger(raw.backoffMs) && raw.backoffMs >= 0
        ? raw.backoffMs
        : (diagnostics.push(diagnostic('INVALID_RETRY', 'retry.backoffMs must be a non-negative integer', { nodeId })),
          undefined)
  return { maxAttempts: raw.maxAttempts, backoffMs }
}

function parseEdges(raw: unknown, diagnostics: WorkflowDiagnostic[]): WorkflowEdge[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'edges must be an array'))
    return []
  }
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (
      !isPlainObject(item) ||
      typeof item.from !== 'string' ||
      typeof item.to !== 'string' ||
      typeof item.port !== 'string'
    ) {
      diagnostics.push(diagnostic('INVALID_MANIFEST', `edges[${i}] must have from, port, and to strings`))
      continue
    }
    edges.push({ from: item.from, port: item.port, to: item.to })
  }
  return edges
}

function parseLimits(raw: unknown, diagnostics: WorkflowDiagnostic[]): WorkflowLimits | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    diagnostics.push(diagnostic('INVALID_LIMITS', 'limits must be an object'))
    return undefined
  }
  const limits: WorkflowLimits = {}
  for (const key of [
    'maxSteps',
    'timeoutMs',
    'maxConcurrency',
    'maxLoopIterations',
    'maxTokens',
    'maxCost',
    'maxArtifactBytes'
  ] as const) {
    if (raw[key] === undefined) continue
    if (!isFiniteInteger(raw[key]) || raw[key] < 0) {
      diagnostics.push(diagnostic('INVALID_LIMITS', `limits.${key} must be a non-negative integer`))
      continue
    }
    limits[key] = raw[key]
  }
  return limits
}

function parsePermissions(
  raw: unknown,
  diagnostics: WorkflowDiagnostic[]
): WorkflowManifest['permissions'] {
  if (raw === undefined) return { capabilities: [] }
  if (!isPlainObject(raw) || !Array.isArray(raw.capabilities) || !raw.capabilities.every((c) => typeof c === 'string')) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'permissions.capabilities must be a string array'))
    return { capabilities: [] }
  }
  return { capabilities: raw.capabilities as string[] }
}

function parseDependencyPolicy(
  raw: unknown,
  diagnostics: WorkflowDiagnostic[]
): WorkflowManifest['dependencyPolicy'] {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw) || (raw.mode !== 'pinned' && raw.mode !== 'draft')) {
    diagnostics.push(diagnostic('INVALID_MANIFEST', 'dependencyPolicy.mode must be pinned or draft'))
    return undefined
  }
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.flatMap((item, index) => {
        if (!isPlainObject(item) || typeof item.kind !== 'string' || typeof item.id !== 'string') {
          diagnostics.push(diagnostic('INVALID_MANIFEST', `dependencyPolicy.dependencies[${index}] is invalid`))
          return []
        }
        return [
          {
            kind: item.kind as 'agent',
            id: item.id,
            revision: typeof item.revision === 'string' ? item.revision : undefined,
            hash: typeof item.hash === 'string' ? item.hash : undefined,
            name: typeof item.name === 'string' ? item.name : undefined,
            slug: typeof item.slug === 'string' ? item.slug : undefined
          }
        ]
      })
    : undefined
  return { mode: raw.mode, dependencies }
}

function emptyManifest(): WorkflowManifest {
  return {
    schemaVersion: WORKFLOW_FORMAT_SCHEMA_VERSION,
    id: '00000000-0000-4000-8000-000000000000',
    name: 'invalid',
    slug: 'invalid',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    entryNodeId: '',
    nodes: [],
    edges: []
  }
}
