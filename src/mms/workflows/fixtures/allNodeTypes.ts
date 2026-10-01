import {
  WORKFLOW_NODE_CATALOG,
  WORKFLOW_NODE_TYPES,
  type WorkflowEdge,
  type WorkflowManifest,
  type WorkflowNode
} from '../../../shared/workflows'

const ID = '11111111-1111-4111-8111-111111111111'

function node(id: string, type: string, config: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type, version: 1, config, ...extra }
}

function edge(from: string, port: string, to: string): WorkflowEdge {
  return { from, port, to }
}

function leafSubgraph(prefix: string): Record<string, unknown> {
  return {
    entryNodeId: `${prefix}-work`,
    nodes: [
      node(`${prefix}-work`, 'transform', { value: { literal: { ok: true } } }),
      node(`${prefix}-end`, 'end', {}, {
        inputs: { result: { ref: 'node', nodeId: `${prefix}-work`, pointer: '' } }
      })
    ],
    edges: [edge(`${prefix}-work`, 'success', `${prefix}-end`)]
  }
}

export function allCapabilities(): string[] {
  return [...new Set(Object.values(WORKFLOW_NODE_CATALOG).flatMap((entry) => [...entry.requiredCapabilities]))]
}

/** Valid v1 graph containing every catalog node type. Canvas metadata is omitted. */
export function createAllNodeTypesManifest(): WorkflowManifest {
  const nodes: WorkflowNode[] = [
    node('start', 'start', {}),
    node('instruction', 'instruction', { text: 'Do the work.' }),
    node('prompt', 'prompt-template', { template: 'Hello {{input.topic}}' }),
    node('agent', 'agent', {
      agent: { kind: 'main' },
      instructions: 'Return { ok: true }',
      outputSchema: { type: 'object', additionalProperties: true }
    }),
    node('script', 'script', {
      runtime: 'node',
      file: 'scripts/noop.mjs',
      executionMode: 'trusted-local',
      fileInputs: [
        {
          pointer: '/files',
          source: 'thread-workspace',
          destination: 'input-dir',
          rewrite: 'relative-staged-paths',
          maxTotalBytes: 1000
        }
      ]
    }),
    node('transform', 'transform', { value: { literal: { keep: 1 } } }),
    node('select', 'select-fields', { fields: ['keep'], from: { ref: 'node', nodeId: 'transform', pointer: '' } }),
    node('filter', 'filter', {
      items: { literal: [1, 2] },
      predicate: { op: 'gt', args: [{ ref: 'item' }, { literal: 0 }] }
    }),
    node('reduce', 'reduce', {
      items: { literal: [1, 2] },
      initial: { literal: 0 },
      reducer: { op: 'add', args: [{ ref: 'loop', pointer: '/previous' }, { ref: 'item' }] }
    }),
    node('format', 'format', { template: 'ok' }),
    node('tool', 'tool', { tool: { id: 'workspace.read' } }),
    node('mcp', 'mcp-tool', { serverId: 'demo', toolName: 'ping' }),
    node('skill', 'load-skill', { skill: { id: 'code-review', revision: 'abc' } }),
    node('bsess', 'browser-session', { workspaceId: 'default' }),
    node('bobs', 'browser-observe', { includeVision: false }),
    node('bact', 'browser-action', { action: 'click' }),
    node('bext', 'browser-extract', { schema: { type: 'object' } }),
    node('btask', 'browser-task', { goal: 'open about:blank' }),
    node('cond', 'condition', {
      expression: { op: 'eq', args: [{ literal: 1 }, { literal: 1 }] }
    }),
    node('switch', 'switch', {
      value: { literal: 'a' },
      cases: [{ key: 'a', equals: { literal: 'a' } }]
    }),
    node('each', 'for-each', {
      items: { literal: [1] },
      maxIterations: 4,
      maxDurationMs: 1000,
      failPolicy: 'fail-fast',
      subgraph: leafSubgraph('each')
    }),
    node('repeat', 'bounded-repeat', {
      maxIterations: 2,
      maxDurationMs: 1000,
      subgraph: leafSubgraph('repeat')
    }),
    node('par', 'parallel', {
      maxConcurrency: 2,
      branches: [
        { id: 'left', subgraph: leafSubgraph('parL') },
        { id: 'right', subgraph: leafSubgraph('parR') }
      ]
    }),
    node('join', 'join', { parallelNodeId: 'par', policy: 'all-success' }),
    node('sub', 'subworkflow', { workflow: { id: '22222222-2222-4222-8222-222222222222', revision: 'deadbeef' } }),
    node('ask', 'ask-user', { prompt: 'Continue?', answerSchema: { type: 'boolean' } }),
    node('approve', 'approval', { action: 'run-script', proposal: 'Run reviewed script' }),
    node('delay', 'delay', { durationMs: 1 }),
    node('wait', 'wait-for-condition', {
      expression: { op: 'eq', args: [{ literal: true }, { literal: true }] },
      timeoutMs: 10
    }),
    node('read', 'read-input', { pointer: '/files' }),
    node('write', 'write-artifact', { name: 'out.json', content: { literal: { ok: true } } }),
    node('report', 'render-report', { title: 'Report', template: 'done' }),
    node('try', 'try-catch', {
      try: leafSubgraph('try'),
      catch: leafSubgraph('catch')
    }),
    node('fin', 'finally', { body: leafSubgraph('fin') }),
    node('end-ok', 'end', {}),
    node('end-false', 'end', {}),
    node('end-denied', 'end', {}),
    node('fail', 'fail', { message: 'stopped' }),
    node('note', 'note', { text: 'documentation only' }),
    node('group', 'group', { label: 'visual group' })
  ]

  const chain = [
    ['start', 'next', 'instruction'],
    ['instruction', 'success', 'prompt'],
    ['prompt', 'success', 'agent'],
    ['agent', 'success', 'script'],
    ['script', 'success', 'transform'],
    ['transform', 'success', 'select'],
    ['select', 'success', 'filter'],
    ['filter', 'success', 'reduce'],
    ['reduce', 'success', 'format'],
    ['format', 'success', 'tool'],
    ['tool', 'success', 'mcp'],
    ['mcp', 'success', 'skill'],
    ['skill', 'success', 'bsess'],
    ['bsess', 'success', 'bobs'],
    ['bobs', 'success', 'bact'],
    ['bact', 'success', 'bext'],
    ['bext', 'success', 'btask'],
    ['btask', 'success', 'cond'],
    ['cond', 'true', 'switch'],
    ['cond', 'false', 'end-false'],
    ['switch', 'a', 'each'],
    ['switch', 'default', 'fail'],
    ['each', 'completed', 'repeat'],
    ['repeat', 'completed', 'par'],
    ['par', 'success', 'join'],
    ['join', 'success', 'sub'],
    ['sub', 'success', 'ask'],
    ['ask', 'success', 'approve'],
    ['approve', 'approved', 'delay'],
    ['approve', 'denied', 'end-denied'],
    ['delay', 'success', 'wait'],
    ['wait', 'success', 'read'],
    ['read', 'success', 'write'],
    ['write', 'success', 'report'],
    ['report', 'success', 'try'],
    ['try', 'success', 'fin'],
    ['fin', 'next', 'end-ok']
  ] as const

  return {
    schemaVersion: 1,
    id: ID,
    name: 'All node types',
    slug: 'all_node_types',
    description: 'Compiler fixture covering every v1 catalog class.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, maxItems: 4 }
      },
      additionalProperties: false
    },
    outputSchema: { type: 'object', additionalProperties: true },
    entryNodeId: 'start',
    limits: { maxSteps: 80, timeoutMs: 60_000, maxConcurrency: 4 },
    permissions: { capabilities: allCapabilities() },
    nodes,
    edges: chain.map(([from, port, to]) => edge(from, port, to))
  }
}

export function expectedCatalogTypes(): string[] {
  return [...WORKFLOW_NODE_TYPES]
}
