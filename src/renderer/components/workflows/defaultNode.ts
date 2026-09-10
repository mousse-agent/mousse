import {
  EFFECT_CLASSES,
  getNodeCatalogEntry,
  isWorkflowNodeType,
  type WorkflowBinding,
  type WorkflowNode,
  type WorkflowNodeType
} from '../../../shared/workflows'

export const CATEGORY_LABELS: Record<string, string> = {
  'entry-output': 'Start / end',
  instructions: 'Instructions',
  agents: 'Agents',
  'deterministic-code': 'Scripts',
  functions: 'Functions / transforms',
  integrations: 'Tools / MCP',
  skills: 'Skills',
  browser: 'Browser',
  branching: 'Condition / switch',
  iteration: 'Loops',
  parallelism: 'Parallel / join',
  composition: 'Subworkflow',
  interaction: 'Human input',
  timing: 'Delay',
  'files-artifacts': 'Artifacts',
  resilience: 'Error handling',
  annotation: 'Notes'
}

export const CATEGORY_ORDER = [
  'entry-output',
  'instructions',
  'agents',
  'deterministic-code',
  'functions',
  'integrations',
  'skills',
  'browser',
  'branching',
  'iteration',
  'parallelism',
  'composition',
  'interaction',
  'timing',
  'files-artifacts',
  'resilience',
  'annotation'
] as const

function leafSubgraph(prefix: string) {
  return {
    entryNodeId: `${prefix}-work`,
    nodes: [
      {
        id: `${prefix}-work`,
        type: 'transform',
        version: 1,
        config: { value: { literal: { ok: true } } }
      },
      {
        id: `${prefix}-end`,
        type: 'end',
        version: 1,
        inputs: { result: { ref: 'node', nodeId: `${prefix}-work`, pointer: '' } as WorkflowBinding },
        config: {}
      }
    ],
    edges: [{ from: `${prefix}-work`, port: 'success', to: `${prefix}-end` }]
  }
}

export function defaultConfigForType(type: string, id: string): Record<string, unknown> {
  switch (type) {
    case 'instruction':
      return { text: 'Describe the work for the selected agent.' }
    case 'prompt-template':
      return { template: 'Hello {{input.topic}}' }
    case 'agent':
      return {
        agent: { kind: 'main' },
        instructions: 'Return a structured result.',
        outputSchema: { type: 'object', additionalProperties: true }
      }
    case 'script':
      return {
        runtime: 'node',
        file: 'scripts/main.mjs',
        executionMode: 'trusted-local',
        argv: [],
        fileInputs: []
      }
    case 'transform':
      return { value: { literal: {} } }
    case 'select-fields':
      return { fields: [], from: { ref: 'input', pointer: '' } }
    case 'filter':
      return {
        items: { ref: 'input', pointer: '' },
        predicate: { op: 'eq', args: [{ ref: 'item' }, { literal: true }] }
      }
    case 'reduce':
      return {
        items: { ref: 'input', pointer: '' },
        initial: { literal: 0 },
        reducer: { op: 'add', args: [{ ref: 'loop', pointer: '/previous' }, { ref: 'item' }] }
      }
    case 'format':
      return { template: '{{input}}' }
    case 'tool':
      return { tool: { id: '' } }
    case 'mcp-tool':
      return { serverId: '', toolName: '' }
    case 'load-skill':
      return { skill: { id: '', revision: '' } }
    case 'browser-session':
      return { workspaceId: '' }
    case 'browser-observe':
      return { includeVision: false }
    case 'browser-action':
      return { action: 'click' }
    case 'browser-extract':
      return { schema: { type: 'object' } }
    case 'browser-task':
      return { goal: '' }
    case 'condition':
      return { expression: { op: 'eq', args: [{ literal: true }, { literal: true }] } }
    case 'switch':
      return { value: { ref: 'input', pointer: '' }, cases: [{ key: 'a', equals: { literal: 'a' } }] }
    case 'for-each':
      return {
        items: { ref: 'input', pointer: '' },
        maxIterations: 8,
        failPolicy: 'fail-fast',
        subgraph: leafSubgraph(`${id}-each`)
      }
    case 'bounded-repeat':
      return { maxIterations: 4, subgraph: leafSubgraph(`${id}-repeat`) }
    case 'parallel':
      return {
        maxConcurrency: 2,
        branches: [
          { id: 'left', subgraph: leafSubgraph(`${id}-left`) },
          { id: 'right', subgraph: leafSubgraph(`${id}-right`) }
        ]
      }
    case 'join':
      return { parallelNodeId: '', policy: 'all-success' }
    case 'subworkflow':
      return { workflow: { id: '', revision: '' } }
    case 'ask-user':
      return { prompt: 'Continue?', answerSchema: { type: 'string' } }
    case 'approval':
      return { action: 'proceed', proposal: 'Approve this action' }
    case 'delay':
      return { durationMs: 1000 }
    case 'wait-for-condition':
      return {
        expression: { op: 'eq', args: [{ literal: true }, { literal: true }] },
        timeoutMs: 30_000
      }
    case 'read-input':
      return { pointer: '' }
    case 'write-artifact':
      return { name: 'output.json', content: { literal: {} } }
    case 'render-report':
      return { title: 'Report', template: '' }
    case 'try-catch':
      return { try: leafSubgraph(`${id}-try`), catch: leafSubgraph(`${id}-catch`) }
    case 'finally':
      return { body: leafSubgraph(`${id}-finally`) }
    case 'fail':
      return { message: 'Stopped' }
    case 'note':
      return { text: '' }
    case 'group':
      return { label: 'Group' }
    default:
      return {}
  }
}

export function createWorkflowNode(type: string, id: string, extras: Partial<WorkflowNode> = {}): WorkflowNode {
  const entry = getNodeCatalogEntry(type)
  const node: WorkflowNode = {
    id,
    type,
    version: entry?.supportedVersions[0] ?? 1,
    config: defaultConfigForType(type, id),
    effect: entry?.defaultEffect,
    ...extras
  }
  if (type === 'end' && !node.inputs) {
    node.inputs = { result: { ref: 'input', pointer: '' } }
  }
  return node
}

export function controlOutPortsForNode(node: WorkflowNode): string[] {
  const entry = getNodeCatalogEntry(node.type)
  if (!entry) return ['unsupported']
  if (node.type === 'switch') {
    const cases = Array.isArray(node.config.cases) ? node.config.cases : []
    const keys = cases
      .map((item) => (item && typeof item === 'object' && 'key' in item ? String((item as { key: unknown }).key) : ''))
      .filter(Boolean)
    return ['default', ...keys]
  }
  return entry.controlOutPorts.map((port) => port.name)
}

export function isKnownNodeType(type: string): type is WorkflowNodeType {
  return isWorkflowNodeType(type)
}

export function isKnownEffect(value: unknown): value is (typeof EFFECT_CLASSES)[number] {
  return typeof value === 'string' && (EFFECT_CLASSES as readonly string[]).includes(value)
}
