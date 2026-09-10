import {
  bindingNodeRefs,
  diagnostic,
  EFFECT_CLASSES,
  expressionNodeRefs,
  getNodeCatalogEntry,
  hasErrorDiagnostics,
  isFiniteInteger,
  isJsonPointer,
  isPlainObject,
  isReservedWorkflowSlug,
  isWorkflowNodeType,
  JOIN_POLICIES,
  parseWorkflowBinding,
  parseWorkflowExpression,
  WORKFLOW_FORMAT_SCHEMA_VERSION,
  WORKFLOW_MAX_EDGES,
  WORKFLOW_MAX_LOOP_ITERATIONS,
  WORKFLOW_MAX_NESTING_DEPTH,
  WORKFLOW_MAX_NODES,
  WORKFLOW_MAX_PARALLEL_BRANCHES,
  WORKFLOW_MAX_RETRY_ATTEMPTS,
  WORKFLOW_MAX_SUBWORKFLOW_DEPTH,
  WORKFLOW_MAX_SWITCH_CASES,
  type CompiledControlEdge,
  type CompiledGraph,
  type CompiledNode,
  type CompiledWorkflow,
  type CompileWorkflowOptions,
  type WorkflowBinding,
  type WorkflowDiagnostic,
  type WorkflowEdge,
  type WorkflowFileInputDeclaration,
  type WorkflowGraph,
  type WorkflowManifest,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowSubgraph
} from '../../../shared/workflows'
import { checkBundleRelativePath } from '../pathSafety'
import { boundedJsonSchemaSubsetValidator } from '../schema/boundedJsonSchema'
import { parseWorkflowGraph, parseWorkflowManifest } from './parseManifest'

export function compileWorkflow(
  source: unknown,
  options: CompileWorkflowOptions = {}
): CompiledWorkflow {
  const parsed = parseWorkflowManifest(source)
  return compileParsedManifest(parsed.manifest, parsed.diagnostics, options)
}

export function compileParsedManifest(
  manifest: WorkflowManifest,
  prior: WorkflowDiagnostic[] = [],
  options: CompileWorkflowOptions = {}
): CompiledWorkflow {
  const diagnostics = [...prior]
  const unsupportedNodeTypes: string[] = []

  if (manifest.schemaVersion !== WORKFLOW_FORMAT_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic(
        'UNSUPPORTED_SCHEMA_VERSION',
        `schemaVersion ${manifest.schemaVersion} cannot run; v1 is required`
      )
    )
  }
  if (isReservedWorkflowSlug(manifest.slug)) {
    diagnostics.push(diagnostic('RESERVED_SLUG', `Slug "${manifest.slug}" is reserved by built-in commands`))
  }

  const allNodes: WorkflowNode[] = []
  const allEdges: WorkflowEdge[] = []
  collectGraph(manifest, allNodes, allEdges, 0, diagnostics)

  if (allNodes.length > WORKFLOW_MAX_NODES || allEdges.length > WORKFLOW_MAX_EDGES) {
    diagnostics.push(
      diagnostic(
        'GRAPH_TOO_LARGE',
        `Graph has ${allNodes.length} nodes and ${allEdges.length} edges; max is ${WORKFLOW_MAX_NODES}/${WORKFLOW_MAX_EDGES}`
      )
    )
  }

  const seenIds = new Set<string>()
  for (const node of allNodes) {
    if (seenIds.has(node.id)) {
      diagnostics.push(diagnostic('DUPLICATE_NODE_ID', `Duplicate node id "${node.id}"`, { nodeId: node.id }))
    }
    seenIds.add(node.id)
  }

  const seenEdges = new Set<string>()
  for (const edge of allEdges) {
    const key = `${edge.from}|${edge.port}|${edge.to}`
    if (seenEdges.has(key)) {
      diagnostics.push(diagnostic('DUPLICATE_EDGE', `Duplicate edge ${key}`, { edge }))
    }
    seenEdges.add(key)
  }

  const granted = new Set(manifest.permissions?.capabilities ?? [])
  const graph = compileGraph(manifest, diagnostics, unsupportedNodeTypes, granted, options, 0, new Set(), false)

  const stack = [...(options.compilationStack ?? [])]
  if (options.currentWorkflowId) stack.push(options.currentWorkflowId)
  collectDependencies(manifest, allNodes, diagnostics, options, stack)

  if (manifest.instructionsFile) {
    const path = checkBundleRelativePath(manifest.instructionsFile)
    if (!path.ok) {
      diagnostics.push(diagnostic('ASSET_UNSAFE', `instructionsFile: ${path.reason}`, { path: manifest.instructionsFile }))
    } else if (options.knownAssets && !options.knownAssets.has(path.relativePath)) {
      diagnostics.push(
        diagnostic('ASSET_MISSING', `Missing instructions asset ${path.relativePath}`, { path: path.relativePath })
      )
    }
  }

  const runnable =
    !hasErrorDiagnostics(diagnostics) &&
    unsupportedNodeTypes.length === 0 &&
    manifest.schemaVersion === WORKFLOW_FORMAT_SCHEMA_VERSION

  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    slug: manifest.slug,
    description: manifest.description,
    instructionsFile: manifest.instructionsFile,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    limits: manifest.limits ?? {},
    permissions: [...granted],
    dependencies: manifest.dependencyPolicy?.dependencies ?? [],
    graph,
    diagnostics,
    runnable,
    unsupportedNodeTypes,
    semanticSource: manifest
  }
}

function collectGraph(
  graph: WorkflowGraph,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  depth: number,
  diagnostics: WorkflowDiagnostic[]
): void {
  if (depth > WORKFLOW_MAX_NESTING_DEPTH) {
    diagnostics.push(diagnostic('GRAPH_TOO_LARGE', 'Nested graph exceeds maximum depth'))
    return
  }
  nodes.push(...graph.nodes)
  edges.push(...graph.edges)
  for (const node of graph.nodes) {
    for (const raw of walkRawSubgraphs(node)) {
      if (!isPlainObject(raw)) continue
      const nestedNodes = Array.isArray(raw.nodes) ? raw.nodes : []
      const nestedEdges = Array.isArray(raw.edges) ? raw.edges : []
      const nestedGraph: WorkflowGraph = {
        entryNodeId: typeof raw.entryNodeId === 'string' ? raw.entryNodeId : '',
        nodes: nestedNodes.filter(isPlainObject).map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          type: typeof item.type === 'string' ? item.type : '',
          version: typeof item.version === 'number' ? item.version : 1,
          config: isPlainObject(item.config) ? item.config : {},
          inputs: undefined
        })),
        edges: nestedEdges.filter(isPlainObject).map((item) => ({
          from: String(item.from ?? ''),
          port: String(item.port ?? ''),
          to: String(item.to ?? '')
        }))
      }
      collectGraph(nestedGraph, nodes, edges, depth + 1, diagnostics)
    }
  }
}

function walkRawSubgraphs(node: WorkflowNode): unknown[] {
  const cfg = node.config
  const out: unknown[] = []
  if (isPlainObject(cfg.subgraph)) out.push(cfg.subgraph)
  if (Array.isArray(cfg.branches)) {
    for (const branch of cfg.branches) {
      if (isPlainObject(branch) && isPlainObject(branch.subgraph)) out.push(branch.subgraph)
    }
  }
  if (isPlainObject(cfg.try)) out.push(cfg.try)
  if (isPlainObject(cfg.catch)) out.push(cfg.catch)
  if (node.type === 'try-catch' && isPlainObject(cfg.finally)) out.push(cfg.finally)
  if (node.type === 'finally' && isPlainObject(cfg.body)) out.push(cfg.body)
  return out
}

function compileGraph(
  graph: WorkflowGraph,
  diagnostics: WorkflowDiagnostic[],
  unsupportedNodeTypes: string[],
  granted: Set<string>,
  options: CompileWorkflowOptions,
  depth: number,
  parentAvailable: Set<string>,
  loopAllowed: boolean
): CompiledGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const compiledNodes: CompiledNode[] = []

  if (!graph.entryNodeId || !nodeById.has(graph.entryNodeId)) {
    diagnostics.push(diagnostic('MISSING_ENTRY', `entryNodeId "${graph.entryNodeId}" does not exist`))
  } else {
    const entry = nodeById.get(graph.entryNodeId)!
    if (depth === 0 && entry.type !== 'start') {
      diagnostics.push(diagnostic('INVALID_ENTRY', 'Root entryNodeId must be a start node', { nodeId: entry.id }))
    }
  }

  const startNodes = graph.nodes.filter((node) => node.type === 'start')
  if (depth === 0 && startNodes.length !== 1) {
    diagnostics.push(diagnostic('INVALID_ENTRY', 'Each graph must contain exactly one start node'))
  }

  for (const node of graph.nodes) {
    compiledNodes.push(
      compileNode(node, diagnostics, unsupportedNodeTypes, granted, options, depth, parentAvailable, loopAllowed)
    )
  }

  const compiledById = new Map(compiledNodes.map((node) => [node.id, node]))
  const edges: CompiledControlEdge[] = []
  const outgoing = new Map<string, CompiledControlEdge[]>()
  const incoming = new Map<string, CompiledControlEdge[]>()

  for (const edge of graph.edges) {
    const from = compiledById.get(edge.from)
    const to = compiledById.get(edge.to)
    if (!from || !to) {
      diagnostics.push(
        diagnostic('MISSING_REF', `Edge ${edge.from} -${edge.port}-> ${edge.to} references a missing node`, {
          edge
        })
      )
      continue
    }
    if (!from.runtime) {
      diagnostics.push(
        diagnostic('INVALID_PORT', `Annotation node ${from.id} cannot emit control edges`, { edge, nodeId: from.id })
      )
      continue
    }
    if (!to.runtime) {
      diagnostics.push(
        diagnostic('INVALID_PORT', `Annotation node ${to.id} cannot receive control edges`, { edge, nodeId: to.id })
      )
      continue
    }
    if (from.terminal) {
      diagnostics.push(diagnostic('INVALID_PORT', `Terminal node ${from.id} cannot have outgoing edges`, { edge }))
      continue
    }
    if (!from.controlOutPorts.includes(edge.port)) {
      diagnostics.push(
        diagnostic('INVALID_PORT', `Node ${from.id} (${from.type}) has no control port "${edge.port}"`, {
          edge,
          nodeId: from.id
        })
      )
      continue
    }
    const compiledEdge = { from: edge.from, port: edge.port, to: edge.to }
    edges.push(compiledEdge)
    push(outgoing, edge.from, compiledEdge)
    push(incoming, edge.to, compiledEdge)
  }

  for (const node of compiledNodes) {
    if (!node.runtime || node.terminal || !node.supported) continue
    const catalog = getNodeCatalogEntry(node.type)
    if (!catalog) continue
    for (const port of catalog.controlOutPorts) {
      if (!port.required || port.dynamic) continue
      const has = (outgoing.get(node.id) ?? []).some((edge) => edge.port === port.name)
      if (!has) {
        diagnostics.push(
          diagnostic('MISSING_CONTROL_EDGE', `Node ${node.id} is missing required control edge on port "${port.name}"`, {
            nodeId: node.id
          })
        )
      }
    }
  }

  const runtimeIds = compiledNodes.filter((node) => node.runtime).map((node) => node.id)
  if (graph.entryNodeId && nodeById.has(graph.entryNodeId)) {
    const reachable = bfs(graph.entryNodeId, outgoing)
    for (const id of runtimeIds) {
      if (!reachable.has(id)) {
        diagnostics.push(diagnostic('UNREACHABLE_NODE', `Runtime node "${id}" is not reachable from the entry`, { nodeId: id }))
      }
    }
    const cycle = findCycle(graph.entryNodeId, outgoing, runtimeIds)
    if (cycle) {
      diagnostics.push(diagnostic('CYCLE_DETECTED', `Raw control cycle is not allowed: ${cycle.join(' -> ')}`))
    }
    const terminals = compiledNodes.filter((node) => node.terminal).map((node) => node.id)
    const reverse = reverseAdjacency(edges)
    for (const id of [...reachable]) {
      const node = compiledById.get(id)
      if (!node?.runtime) continue
      if (node.terminal) continue
      if (!canReachAny(id, terminals, outgoing)) {
        diagnostics.push(
          diagnostic('MISSING_TERMINAL', `Node "${id}" has no path to an end or fail terminal`, { nodeId: id })
        )
      }
    }
    void reverse

    const available = computeAvailability(graph.entryNodeId, compiledNodes, incoming, parentAvailable)
    validateBindings(compiledNodes, available, diagnostics, loopAllowed)
    validateJoins(compiledNodes, compiledById, available, diagnostics)
  }

  return {
    entryNodeId: graph.entryNodeId,
    nodes: compiledNodes,
    edges,
    nodeIds: compiledNodes.map((node) => node.id)
  }
}

function compileNode(
  node: WorkflowNode,
  diagnostics: WorkflowDiagnostic[],
  unsupportedNodeTypes: string[],
  granted: Set<string>,
  options: CompileWorkflowOptions,
  depth: number,
  parentAvailable: Set<string>,
  loopAllowed: boolean
): CompiledNode {
  const catalog = getNodeCatalogEntry(node.type)
  if (!catalog) {
    if (!unsupportedNodeTypes.includes(node.type)) unsupportedNodeTypes.push(node.type)
    diagnostics.push(
      diagnostic('UNSUPPORTED_NODE', `Unknown node type "${node.type}" is preserved but cannot run`, {
        nodeId: node.id,
        severity: 'error'
      })
    )
    return {
      id: node.id,
      type: node.type,
      version: node.version,
      supported: false,
      runtime: false,
      terminal: false,
      effect: node.effect ?? 'unknown',
      timeoutMs: node.timeoutMs,
      retry: node.retry,
      inputs: node.inputs ?? {},
      config: node.config,
      requiredCapabilities: [],
      controlOutPorts: [],
      sourcePreserved: true
    }
  }

  if (!catalog.supportedVersions.includes(node.version)) {
    diagnostics.push(
      diagnostic('INVALID_NODE_VERSION', `Node ${node.id} version ${node.version} is not supported for ${node.type}`, {
        nodeId: node.id
      })
    )
  }
  if (node.effect && !EFFECT_CLASSES.includes(node.effect)) {
    diagnostics.push(diagnostic('INVALID_EFFECT', `Invalid effect "${node.effect}"`, { nodeId: node.id }))
  }
  if (node.retry && (node.retry.maxAttempts < 1 || node.retry.maxAttempts > WORKFLOW_MAX_RETRY_ATTEMPTS)) {
    diagnostics.push(diagnostic('INVALID_RETRY', `retry.maxAttempts must be 1..${WORKFLOW_MAX_RETRY_ATTEMPTS}`, { nodeId: node.id }))
  }

  const missingCaps = catalog.requiredCapabilities.filter((cap) => !granted.has(cap))
  for (const cap of missingCaps) {
    diagnostics.push(
      diagnostic('MISSING_CAPABILITY', `Node ${node.id} requires capability "${cap}"`, { nodeId: node.id })
    )
  }

  const controlOutPorts = resolveControlPorts(node, catalog.type, diagnostics)
  const subgraphs: Record<string, CompiledGraph> = {}
  const nestedLoop = node.type === 'for-each' || node.type === 'bounded-repeat'
  for (const [name, subgraph] of Object.entries(extractNamedSubgraphs(node, diagnostics))) {
    subgraphs[name] = compileGraph(
      subgraph,
      diagnostics,
      unsupportedNodeTypes,
      granted,
      options,
      depth + 1,
      parentAvailable,
      nestedLoop || loopAllowed
    )
  }

  validateTypedConfig(node, catalog.type, diagnostics, options)

  let expression = undefined
  if (node.type === 'condition' || node.type === 'wait-for-condition') {
    const parsed = parseWorkflowExpression(node.config.expression)
    if (!parsed.ok) {
      diagnostics.push(diagnostic('INVALID_EXPRESSION', parsed.error, { nodeId: node.id }))
    } else {
      expression = parsed.expression
    }
  }

  return {
    id: node.id,
    type: catalog.type,
    version: node.version,
    supported: true,
    runtime: catalog.runtime,
    terminal: catalog.terminal,
    effect: node.effect ?? catalog.defaultEffect,
    timeoutMs: node.timeoutMs,
    retry: node.retry,
    inputs: node.inputs ?? {},
    config: node.config,
    requiredCapabilities: [...catalog.requiredCapabilities],
    controlOutPorts,
    subgraphs: Object.keys(subgraphs).length > 0 ? subgraphs : undefined,
    expression,
    sourcePreserved: true
  }
}

function resolveControlPorts(
  node: WorkflowNode,
  type: WorkflowNodeType,
  diagnostics: WorkflowDiagnostic[]
): string[] {
  const catalog = getNodeCatalogEntry(type)!
  const ports = catalog.controlOutPorts.filter((port) => !port.dynamic).map((port) => port.name)
  if (type === 'switch') {
    const cases = Array.isArray(node.config.cases) ? node.config.cases : []
    if (cases.length > WORKFLOW_MAX_SWITCH_CASES) {
      diagnostics.push(diagnostic('INVALID_NODE_CONFIG', 'switch has too many cases', { nodeId: node.id }))
    }
    for (const item of cases) {
      if (isPlainObject(item) && typeof item.key === 'string' && item.key && !ports.includes(item.key)) {
        ports.push(item.key)
      }
    }
  }
  return ports
}

function validateTypedConfig(
  node: WorkflowNode,
  type: WorkflowNodeType,
  diagnostics: WorkflowDiagnostic[],
  options: CompileWorkflowOptions
): void {
  const cfg = node.config
  const fail = (message: string) =>
    diagnostics.push(diagnostic('INVALID_NODE_CONFIG', message, { nodeId: node.id }))

  switch (type) {
    case 'script': {
      if (!['node', 'python', 'powershell', 'bash'].includes(String(cfg.runtime))) fail('script.runtime is invalid')
      if (typeof cfg.file !== 'string') fail('script.file is required')
      else {
        const path = checkBundleRelativePath(cfg.file)
        if (!path.ok) diagnostics.push(diagnostic('ASSET_UNSAFE', `script.file: ${path.reason}`, { nodeId: node.id }))
        else if (options.knownAssets && !options.knownAssets.has(path.relativePath)) {
          diagnostics.push(diagnostic('ASSET_MISSING', `Missing script asset ${path.relativePath}`, { nodeId: node.id }))
        }
      }
      if (cfg.executionMode !== 'trusted-local' && cfg.executionMode !== 'sandboxed') {
        fail('script.executionMode must be trusted-local or sandboxed')
      }
      if (cfg.fileInputs !== undefined) validateFileInputs(cfg.fileInputs, node.id, diagnostics)
      if (cfg.outputSchema !== undefined) {
        diagnostics.push(
          ...boundedJsonSchemaSubsetValidator.validateDocument(cfg.outputSchema, `/${node.id}/outputSchema`).diagnostics
        )
      }
      break
    }
    case 'agent': {
      if (!isPlainObject(cfg.agent) || (cfg.agent.kind !== 'main' && cfg.agent.kind !== 'user')) {
        fail('agent.agent.kind must be main or user')
      } else if (cfg.agent.kind === 'user' && typeof cfg.agent.definitionId !== 'string') {
        fail('user agent requires definitionId')
      }
      if (typeof cfg.instructions !== 'string' || !cfg.instructions) fail('agent.instructions is required')
      if (cfg.outputSchema !== undefined) {
        diagnostics.push(
          ...boundedJsonSchemaSubsetValidator.validateDocument(cfg.outputSchema, `/${node.id}/outputSchema`).diagnostics
        )
      }
      break
    }
    case 'instruction':
      if (typeof cfg.text !== 'string' && typeof cfg.instructions !== 'string') fail('instruction requires text')
      break
    case 'prompt-template':
      if (typeof cfg.template !== 'string' && !isPlainObject(cfg.template)) fail('prompt-template.template is required')
      break
    case 'transform':
      if (cfg.value === undefined && cfg.expression === undefined) fail('transform requires value or expression')
      if (cfg.value !== undefined && !parseWorkflowBinding(cfg.value).ok) fail('transform.value is not a valid binding')
      if (cfg.expression !== undefined && !parseWorkflowExpression(cfg.expression).ok) {
        fail('transform.expression is not a valid expression')
      }
      break
    case 'select-fields':
      if (!Array.isArray(cfg.fields) || !cfg.fields.every((item) => typeof item === 'string')) {
        fail('select-fields.fields must be a string array')
      }
      break
    case 'filter':
      if (cfg.predicate === undefined || !parseWorkflowExpression(cfg.predicate).ok) fail('filter.predicate is required')
      break
    case 'reduce':
      if (cfg.reducer === undefined || !parseWorkflowExpression(cfg.reducer).ok) fail('reduce.reducer is required')
      break
    case 'format':
      if (typeof cfg.template !== 'string') fail('format.template is required')
      break
    case 'tool':
      if (!isPlainObject(cfg.tool) || typeof cfg.tool.id !== 'string') fail('tool.id is required')
      break
    case 'mcp-tool':
      if (typeof cfg.serverId !== 'string' || typeof cfg.toolName !== 'string') {
        fail('mcp-tool requires serverId and toolName')
      }
      break
    case 'load-skill':
      if (!isPlainObject(cfg.skill) || typeof cfg.skill.id !== 'string') fail('load-skill.skill.id is required')
      break
    case 'browser-session':
    case 'browser-observe':
    case 'browser-action':
    case 'browser-extract':
    case 'browser-task':
      break
    case 'condition':
      if (cfg.expression === undefined) fail('condition.expression is required')
      break
    case 'switch':
      if (cfg.value === undefined || !parseWorkflowBinding(cfg.value).ok) fail('switch.value is required')
      if (!Array.isArray(cfg.cases) || cfg.cases.length === 0) fail('switch.cases is required')
      break
    case 'for-each':
      if (cfg.items === undefined || !parseWorkflowBinding(cfg.items).ok) fail('for-each.items is required')
      validateLoopBounds(cfg, node.id, diagnostics)
      if (!isSubgraph(cfg.subgraph)) fail('for-each.subgraph is required')
      break
    case 'bounded-repeat':
      validateLoopBounds(cfg, node.id, diagnostics)
      if (!isSubgraph(cfg.subgraph)) fail('bounded-repeat.subgraph is required')
      break
    case 'parallel':
      if (!Array.isArray(cfg.branches) || cfg.branches.length === 0) fail('parallel.branches is required')
      else if (cfg.branches.length > WORKFLOW_MAX_PARALLEL_BRANCHES) fail('parallel has too many branches')
      break
    case 'join':
      if (typeof cfg.parallelNodeId !== 'string') fail('join.parallelNodeId is required')
      if (!JOIN_POLICIES.includes(cfg.policy as never)) fail('join.policy must be all-success, collect-results, or first-success')
      break
    case 'subworkflow':
      if (!isPlainObject(cfg.workflow) || (typeof cfg.workflow.id !== 'string' && typeof cfg.workflow.slug !== 'string')) {
        fail('subworkflow.workflow id or slug is required')
      }
      break
    case 'ask-user':
      if (typeof cfg.prompt !== 'string') fail('ask-user.prompt is required')
      break
    case 'approval':
      if (typeof cfg.action !== 'string' && typeof cfg.proposal !== 'string') fail('approval.action is required')
      break
    case 'delay':
      if (!isFiniteInteger(cfg.durationMs) || cfg.durationMs < 0) fail('delay.durationMs must be a non-negative integer')
      break
    case 'wait-for-condition':
      if (cfg.expression === undefined) fail('wait-for-condition.expression is required')
      if (!isFiniteInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0) fail('wait-for-condition.timeoutMs is required')
      break
    case 'read-input':
      if (typeof cfg.pointer !== 'string' && cfg.path === undefined) fail('read-input requires pointer or path')
      break
    case 'write-artifact':
      if (typeof cfg.name !== 'string') fail('write-artifact.name is required')
      break
    case 'render-report':
      if (typeof cfg.template !== 'string' && typeof cfg.title !== 'string') fail('render-report.template is required')
      break
    case 'try-catch':
      if (!isSubgraph(cfg.try)) fail('try-catch.try subgraph is required')
      if (!isSubgraph(cfg.catch)) fail('try-catch.catch subgraph is required')
      break
    case 'finally':
      if (!isSubgraph(cfg.body)) fail('finally.body subgraph is required')
      break
    case 'fail':
      if (typeof cfg.message !== 'string' && cfg.message === undefined) fail('fail.message is required')
      break
    case 'note':
    case 'group':
    case 'start':
    case 'end':
      break
    default:
      break
  }
}

function validateLoopBounds(
  cfg: Record<string, unknown>,
  nodeId: string,
  diagnostics: WorkflowDiagnostic[]
): void {
  if (!isFiniteInteger(cfg.maxIterations) || cfg.maxIterations < 1 || cfg.maxIterations > WORKFLOW_MAX_LOOP_ITERATIONS) {
    diagnostics.push(
      diagnostic(
        'UNBOUNDED_LOOP',
        `Loop ${nodeId} must declare maxIterations between 1 and ${WORKFLOW_MAX_LOOP_ITERATIONS}`,
        { nodeId }
      )
    )
  }
}

function validateFileInputs(
  raw: unknown,
  nodeId: string,
  diagnostics: WorkflowDiagnostic[]
): void {
  if (!Array.isArray(raw)) {
    diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs must be an array', { nodeId }))
    return
  }
  for (const item of raw) {
    if (!isPlainObject(item)) {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs entries must be objects', { nodeId }))
      continue
    }
    const declaration = item as unknown as WorkflowFileInputDeclaration
    if (!isJsonPointer(declaration.pointer)) {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs.pointer must be a JSON pointer', { nodeId }))
    }
    if (!['thread-workspace', 'artifact', 'staged'].includes(String(declaration.source))) {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs.source is invalid', { nodeId }))
    }
    if (typeof declaration.destination !== 'string' || checkBundleRelativePath(declaration.destination).ok === false) {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs.destination is not a safe relative name', { nodeId }))
    }
    if (declaration.rewrite !== 'relative-staged-paths') {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs.rewrite must be relative-staged-paths', { nodeId }))
    }
    if (!isFiniteInteger(declaration.maxTotalBytes) || declaration.maxTotalBytes <= 0) {
      diagnostics.push(diagnostic('INVALID_FILE_INPUTS', 'fileInputs.maxTotalBytes must be a positive integer', { nodeId }))
    }
  }
}

function extractNamedSubgraphs(
  node: WorkflowNode,
  diagnostics: WorkflowDiagnostic[]
): Record<string, WorkflowSubgraph> {
  const out: Record<string, WorkflowSubgraph> = {}
  const cfg = node.config
  const take = (name: string, raw: unknown) => {
    if (raw === undefined) return
    const parsed = parseWorkflowGraph(raw, diagnostics)
    if (parsed) out[name] = parsed
  }
  if (node.type === 'for-each' || node.type === 'bounded-repeat') take('body', cfg.subgraph)
  if (node.type === 'parallel' && Array.isArray(cfg.branches)) {
    for (const branch of cfg.branches) {
      if (isPlainObject(branch) && typeof branch.id === 'string') take(`branch:${branch.id}`, branch.subgraph)
    }
  }
  if (node.type === 'try-catch') {
    take('try', cfg.try)
    take('catch', cfg.catch)
    take('finally', cfg.finally)
  }
  if (node.type === 'finally') take('body', cfg.body)
  return out
}

function isSubgraph(value: unknown): value is WorkflowSubgraph {
  return isPlainObject(value) && typeof value.entryNodeId === 'string' && Array.isArray(value.nodes) && Array.isArray(value.edges)
}

function collectDependencies(
  manifest: WorkflowManifest,
  nodes: WorkflowNode[],
  diagnostics: WorkflowDiagnostic[],
  options: CompileWorkflowOptions,
  stack: string[]
): void {
  const resolver = options.dependencyResolver
  if (stack.length > WORKFLOW_MAX_SUBWORKFLOW_DEPTH) {
    diagnostics.push(diagnostic('SUBWORKFLOW_CYCLE', 'Subworkflow nesting exceeds the maximum depth'))
  }
  for (const node of nodes) {
    if (node.type === 'subworkflow' && isPlainObject(node.config.workflow)) {
      const ref = node.config.workflow as { id?: string; slug?: string; revision?: string }
      const id = ref.id
      if (id && stack.includes(id)) {
        diagnostics.push(
          diagnostic('SUBWORKFLOW_CYCLE', `Recursive subworkflow reference to ${id}`, { nodeId: node.id })
        )
      }
      if (resolver?.hasWorkflow && !resolver.hasWorkflow(ref)) {
        diagnostics.push(
          diagnostic('MISSING_DEPENDENCY', `Subworkflow ${ref.id ?? ref.slug ?? '?'} is not available`, {
            nodeId: node.id
          })
        )
      }
    }
    if (node.type === 'agent' && isPlainObject(node.config.agent) && node.config.agent.kind === 'user') {
      const ref = node.config.agent as { definitionId?: string; kind: string; revision?: string }
      if (resolver?.hasAgent && !resolver.hasAgent(ref)) {
        diagnostics.push(diagnostic('MISSING_DEPENDENCY', `Agent ${ref.definitionId} is not available`, { nodeId: node.id }))
      }
    }
    if (node.type === 'load-skill' && isPlainObject(node.config.skill)) {
      const ref = node.config.skill as { id: string; revision?: string }
      if (resolver?.hasSkill && !resolver.hasSkill(ref)) {
        diagnostics.push(diagnostic('MISSING_DEPENDENCY', `Skill ${ref.id} is not available`, { nodeId: node.id }))
      }
    }
    if (node.type === 'mcp-tool' && resolver?.hasMcpTool) {
      const id = `${String(node.config.serverId)}/${String(node.config.toolName)}`
      if (!resolver.hasMcpTool({ id })) {
        diagnostics.push(diagnostic('MISSING_DEPENDENCY', `MCP tool ${id} is not available`, { nodeId: node.id }))
      }
    }
    if (node.type === 'tool' && isPlainObject(node.config.tool) && resolver?.hasTool) {
      const id = String(node.config.tool.id)
      if (!resolver.hasTool({ id })) {
        diagnostics.push(diagnostic('MISSING_DEPENDENCY', `Tool ${id} is not available`, { nodeId: node.id }))
      }
    }
  }
  if (options.mode === 'publish') {
    for (const dep of manifest.dependencyPolicy?.dependencies ?? []) {
      if (!dep.revision && !dep.hash) {
        diagnostics.push(
          diagnostic('MISSING_DEPENDENCY', `Published dependency ${dep.kind}:${dep.id} must be pinned`)
        )
      }
    }
  }
}

function computeAvailability(
  entryId: string,
  nodes: CompiledNode[],
  incoming: Map<string, CompiledControlEdge[]>,
  parentAvailable: Set<string>
): Map<string, Set<string>> {
  const ids = nodes.filter((node) => node.runtime).map((node) => node.id)
  const available = new Map<string, Set<string>>()
  const pending = [...ids]
  let guard = 0
  while (pending.length > 0 && guard < ids.length * ids.length + 4) {
    guard += 1
    const id = pending.shift()!
    const ins = incoming.get(id) ?? []
    let next: Set<string>
    if (id === entryId) {
      next = new Set(parentAvailable)
      next.add(id)
    } else if (ins.length === 0) {
      next = new Set(parentAvailable)
      next.add(id)
    } else {
      const sets = ins.map((edge) => {
        const pred = available.get(edge.from)
        const copy = new Set(pred ?? parentAvailable)
        copy.add(edge.from)
        return copy
      })
      next = intersect(sets)
      next.add(id)
    }
    const prev = available.get(id)
    if (!prev || !setEquals(prev, next)) {
      available.set(id, next)
      pending.push(...ids.filter((other) => other !== id))
    }
  }
  return available
}

function validateBindings(
  nodes: CompiledNode[],
  available: Map<string, Set<string>>,
  diagnostics: WorkflowDiagnostic[],
  loopAllowed: boolean
): void {
  const ids = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    const incoming = new Set(available.get(node.id) ?? [])
    incoming.delete(node.id)
    const checkBinding = (binding: WorkflowBinding, path: string) => {
      if ('ref' in binding && binding.ref === 'node') {
        if (!ids.has(binding.nodeId) && !incoming.has(binding.nodeId)) {
          // node may live in a parent graph
          if (!incoming.has(binding.nodeId)) {
            diagnostics.push(
              diagnostic(
                incoming.has(binding.nodeId) ? 'DATA_UNAVAILABLE' : 'MISSING_REF',
                `Node ${node.id} references ${binding.nodeId} which is missing or not available on every path`,
                { nodeId: node.id, path }
              )
            )
          }
        } else if (!incoming.has(binding.nodeId)) {
          diagnostics.push(
            diagnostic(
              'BRANCH_OUTPUT_MISUSE',
              `Node ${node.id} reads ${binding.nodeId} which is not produced on every incoming path`,
              { nodeId: node.id, path }
            )
          )
        }
      }
      if ('ref' in binding && (binding.ref === 'loop' || binding.ref === 'item' || binding.ref === 'index')) {
        if (!loopAllowed) {
          diagnostics.push(
            diagnostic('INVALID_BINDING', `Loop binding is only valid inside an explicit loop subgraph`, {
              nodeId: node.id,
              path
            })
          )
        }
      }
    }
    for (const [key, binding] of Object.entries(node.inputs)) {
      for (const ref of bindingNodeRefs(binding)) {
        if (!incoming.has(ref)) {
          diagnostics.push(
            diagnostic(
              incoming.size === 0 ? 'MISSING_REF' : 'BRANCH_OUTPUT_MISUSE',
              `Input ${key} on ${node.id} reads node ${ref} which is not available on every path`,
              { nodeId: node.id, path: key }
            )
          )
        }
      }
      checkBinding(binding, key)
    }
    if (node.expression) {
      for (const ref of expressionNodeRefs(node.expression)) {
        if (!incoming.has(ref)) {
          diagnostics.push(
            diagnostic(
              'DATA_UNAVAILABLE',
              `Expression on ${node.id} reads node ${ref} which is not available on every path`,
              { nodeId: node.id }
            )
          )
        }
      }
    }
    if (node.config.value) {
      const parsed = parseWorkflowBinding(node.config.value)
      if (parsed.ok) {
        for (const ref of bindingNodeRefs(parsed.binding)) {
          if (!incoming.has(ref)) {
            diagnostics.push(
              diagnostic('DATA_UNAVAILABLE', `Config value on ${node.id} reads unavailable node ${ref}`, {
                nodeId: node.id
              })
            )
          }
        }
      }
    }
  }
}

function validateJoins(
  nodes: CompiledNode[],
  byId: Map<string, CompiledNode>,
  available: Map<string, Set<string>>,
  diagnostics: WorkflowDiagnostic[]
): void {
  for (const node of nodes) {
    if (node.type !== 'join') continue
    const parallelId = typeof node.config.parallelNodeId === 'string' ? node.config.parallelNodeId : ''
    const parallel = byId.get(parallelId)
    if (!parallel || parallel.type !== 'parallel') {
      diagnostics.push(
        diagnostic('JOIN_MISMATCH', `Join ${node.id} does not reference a parallel node`, { nodeId: node.id })
      )
      continue
    }
    const avail = available.get(node.id)
    if (avail && !avail.has(parallelId)) {
      diagnostics.push(
        diagnostic('JOIN_MISMATCH', `Join ${node.id} is not on a control path from parallel ${parallelId}`, {
          nodeId: node.id
        })
      )
    }
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function bfs(entry: string, outgoing: Map<string, CompiledControlEdge[]>): Set<string> {
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const edge of outgoing.get(id) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return seen
}

function findCycle(
  entry: string,
  outgoing: Map<string, CompiledControlEdge[]>,
  runtimeIds: string[]
): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1)
    stack.push(id)
    for (const edge of outgoing.get(id) ?? []) {
      const mark = state.get(edge.to) ?? 0
      if (mark === 1) {
        const start = stack.indexOf(edge.to)
        return [...stack.slice(start), edge.to]
      }
      if (mark === 0) {
        const found = visit(edge.to)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return undefined
  }
  for (const id of [entry, ...runtimeIds]) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id)
      if (found) return found
    }
  }
  return undefined
}

function canReachAny(
  from: string,
  terminals: string[],
  outgoing: Map<string, CompiledControlEdge[]>
): boolean {
  if (terminals.includes(from)) return true
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const edge of outgoing.get(id) ?? []) {
      if (terminals.includes(edge.to)) return true
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return false
}

function reverseAdjacency(edges: CompiledControlEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of edges) {
    push(map, edge.to, edge.from)
  }
  return map
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set()
  const [first, ...rest] = sets
  const out = new Set<string>()
  for (const value of first!) {
    if (rest.every((set) => set.has(value))) out.add(value)
  }
  return out
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}
