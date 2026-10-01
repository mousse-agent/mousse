export const WORKFLOW_NODE_TYPES = [
  'start',
  'end',
  'instruction',
  'prompt-template',
  'agent',
  'script',
  'transform',
  'select-fields',
  'filter',
  'reduce',
  'format',
  'tool',
  'mcp-tool',
  'load-skill',
  'browser-session',
  'browser-observe',
  'browser-action',
  'browser-extract',
  'browser-task',
  'condition',
  'switch',
  'for-each',
  'bounded-repeat',
  'parallel',
  'join',
  'subworkflow',
  'ask-user',
  'approval',
  'delay',
  'wait-for-condition',
  'read-input',
  'write-artifact',
  'render-report',
  'try-catch',
  'finally',
  'fail',
  'note',
  'group'
] as const

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

export type WorkflowNodeCategory =
  | 'entry-output'
  | 'instructions'
  | 'agents'
  | 'deterministic-code'
  | 'functions'
  | 'integrations'
  | 'skills'
  | 'browser'
  | 'branching'
  | 'iteration'
  | 'parallelism'
  | 'composition'
  | 'interaction'
  | 'timing'
  | 'files-artifacts'
  | 'resilience'
  | 'annotation'

export type WorkflowEffectClass = 'pure' | 'read' | 'write' | 'external' | 'unknown'

export type WorkflowJoinPolicy = 'all-success' | 'collect-results' | 'first-success'

export type WorkflowLoopFailPolicy = 'fail-fast' | 'collect-errors'

export type ScriptExecutionMode = 'trusted-local' | 'sandboxed'
export type ScriptRuntime = 'node' | 'python' | 'powershell' | 'bash'
export type FileInputSource = 'thread-workspace' | 'artifact' | 'staged'
export type FileInputRewrite = 'relative-staged-paths'

export interface ControlPortSpec {
  name: string
  required: boolean
  dynamic?: boolean
}

export interface DataPortSpec {
  name: string
  valueType: string
}

export interface NodeCatalogEntry {
  type: WorkflowNodeType
  category: WorkflowNodeCategory
  label: string
  runtime: boolean
  terminal: boolean
  defaultEffect: WorkflowEffectClass
  supportedVersions: readonly number[]
  controlOutPorts: readonly ControlPortSpec[]
  dataOutPorts: readonly DataPortSpec[]
  requiredCapabilities: readonly string[]
  allowsNestedGraph: boolean
}

function entry(
  spec: NodeCatalogEntry
): NodeCatalogEntry {
  return spec
}

const SUCCESS_ERROR: ControlPortSpec[] = [
  { name: 'success', required: true },
  { name: 'error', required: false }
]

export const WORKFLOW_NODE_CATALOG: Record<WorkflowNodeType, NodeCatalogEntry> = {
  start: entry({
    type: 'start',
    category: 'entry-output',
    label: 'Start',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'next', required: true }],
    dataOutPorts: [{ name: 'input', valueType: 'object' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  end: entry({
    type: 'end',
    category: 'entry-output',
    label: 'End',
    runtime: true,
    terminal: true,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [],
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  instruction: entry({
    type: 'instruction',
    category: 'instructions',
    label: 'Instruction',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'text', valueType: 'string' }],
    requiredCapabilities: ['model.invoke'],
    allowsNestedGraph: false
  }),
  'prompt-template': entry({
    type: 'prompt-template',
    category: 'instructions',
    label: 'Prompt template',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'text', valueType: 'string' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  agent: entry({
    type: 'agent',
    category: 'agents',
    label: 'Agent',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'object' }],
    requiredCapabilities: ['model.invoke'],
    allowsNestedGraph: false
  }),
  script: entry({
    type: 'script',
    category: 'deterministic-code',
    label: 'Script',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'object' }],
    requiredCapabilities: ['script.trusted-local'],
    allowsNestedGraph: false
  }),
  transform: entry({
    type: 'transform',
    category: 'functions',
    label: 'Transform',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'value', valueType: 'any' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  'select-fields': entry({
    type: 'select-fields',
    category: 'functions',
    label: 'Select fields',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'value', valueType: 'object' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  filter: entry({
    type: 'filter',
    category: 'functions',
    label: 'Filter',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'value', valueType: 'array' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  reduce: entry({
    type: 'reduce',
    category: 'functions',
    label: 'Reduce',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'value', valueType: 'any' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  format: entry({
    type: 'format',
    category: 'functions',
    label: 'Format',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'text', valueType: 'string' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  tool: entry({
    type: 'tool',
    category: 'integrations',
    label: 'Built-in tool',
    runtime: true,
    terminal: false,
    defaultEffect: 'external',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: ['tool.invoke'],
    allowsNestedGraph: false
  }),
  'mcp-tool': entry({
    type: 'mcp-tool',
    category: 'integrations',
    label: 'MCP tool',
    runtime: true,
    terminal: false,
    defaultEffect: 'external',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: ['mcp.invoke'],
    allowsNestedGraph: false
  }),
  'load-skill': entry({
    type: 'load-skill',
    category: 'skills',
    label: 'Load skill',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'skillContext', valueType: 'object' }],
    requiredCapabilities: ['skill.load'],
    allowsNestedGraph: false
  }),
  'browser-session': entry({
    type: 'browser-session',
    category: 'browser',
    label: 'Browser session',
    runtime: true,
    terminal: false,
    defaultEffect: 'external',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'session', valueType: 'object' }],
    requiredCapabilities: ['browser.session'],
    allowsNestedGraph: false
  }),
  'browser-observe': entry({
    type: 'browser-observe',
    category: 'browser',
    label: 'Browser observe',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'observation', valueType: 'object' }],
    requiredCapabilities: ['browser.observe'],
    allowsNestedGraph: false
  }),
  'browser-action': entry({
    type: 'browser-action',
    category: 'browser',
    label: 'Browser action',
    runtime: true,
    terminal: false,
    defaultEffect: 'external',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'object' }],
    requiredCapabilities: ['browser.action'],
    allowsNestedGraph: false
  }),
  'browser-extract': entry({
    type: 'browser-extract',
    category: 'browser',
    label: 'Browser extract',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: ['browser.extract'],
    allowsNestedGraph: false
  }),
  'browser-task': entry({
    type: 'browser-task',
    category: 'browser',
    label: 'Browser task',
    runtime: true,
    terminal: false,
    defaultEffect: 'external',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'object' }],
    requiredCapabilities: ['browser.task'],
    allowsNestedGraph: false
  }),
  condition: entry({
    type: 'condition',
    category: 'branching',
    label: 'Condition',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'true', required: true },
      { name: 'false', required: true }
    ],
    dataOutPorts: [{ name: 'value', valueType: 'boolean' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  switch: entry({
    type: 'switch',
    category: 'branching',
    label: 'Switch',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'default', required: true },
      { name: 'case', required: false, dynamic: true }
    ],
    dataOutPorts: [{ name: 'matched', valueType: 'string' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  'for-each': entry({
    type: 'for-each',
    category: 'iteration',
    label: 'For each',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'completed', required: true },
      { name: 'error', required: false }
    ],
    dataOutPorts: [{ name: 'results', valueType: 'array' }],
    requiredCapabilities: [],
    allowsNestedGraph: true
  }),
  'bounded-repeat': entry({
    type: 'bounded-repeat',
    category: 'iteration',
    label: 'Bounded repeat',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'completed', required: true },
      { name: 'error', required: false }
    ],
    dataOutPorts: [{ name: 'results', valueType: 'array' }],
    requiredCapabilities: [],
    allowsNestedGraph: true
  }),
  parallel: entry({
    type: 'parallel',
    category: 'parallelism',
    label: 'Parallel',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'success', required: true },
      { name: 'error', required: false }
    ],
    dataOutPorts: [{ name: 'launched', valueType: 'object' }],
    requiredCapabilities: [],
    allowsNestedGraph: true
  }),
  join: entry({
    type: 'join',
    category: 'parallelism',
    label: 'Join',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'results', valueType: 'array' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  subworkflow: entry({
    type: 'subworkflow',
    category: 'composition',
    label: 'Subworkflow',
    runtime: true,
    terminal: false,
    defaultEffect: 'unknown',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'object' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  'ask-user': entry({
    type: 'ask-user',
    category: 'interaction',
    label: 'Ask user',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'success', required: true },
      { name: 'timeout', required: false }
    ],
    dataOutPorts: [{ name: 'answer', valueType: 'any' }],
    requiredCapabilities: ['human.input'],
    allowsNestedGraph: false
  }),
  approval: entry({
    type: 'approval',
    category: 'interaction',
    label: 'Approval',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'approved', required: true },
      { name: 'denied', required: true }
    ],
    dataOutPorts: [{ name: 'decision', valueType: 'object' }],
    requiredCapabilities: ['human.approval'],
    allowsNestedGraph: false
  }),
  delay: entry({
    type: 'delay',
    category: 'timing',
    label: 'Delay',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'success', required: true }],
    dataOutPorts: [{ name: 'elapsedMs', valueType: 'number' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  'wait-for-condition': entry({
    type: 'wait-for-condition',
    category: 'timing',
    label: 'Wait for condition',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: [
      { name: 'success', required: true },
      { name: 'timeout', required: false }
    ],
    dataOutPorts: [{ name: 'matched', valueType: 'boolean' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  'read-input': entry({
    type: 'read-input',
    category: 'files-artifacts',
    label: 'Read input',
    runtime: true,
    terminal: false,
    defaultEffect: 'read',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'content', valueType: 'any' }],
    requiredCapabilities: ['workspace.read'],
    allowsNestedGraph: false
  }),
  'write-artifact': entry({
    type: 'write-artifact',
    category: 'files-artifacts',
    label: 'Write artifact',
    runtime: true,
    terminal: false,
    defaultEffect: 'write',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'artifact', valueType: 'object' }],
    requiredCapabilities: ['artifact.write'],
    allowsNestedGraph: false
  }),
  'render-report': entry({
    type: 'render-report',
    category: 'files-artifacts',
    label: 'Render report',
    runtime: true,
    terminal: false,
    defaultEffect: 'write',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'artifact', valueType: 'object' }],
    requiredCapabilities: ['artifact.write'],
    allowsNestedGraph: false
  }),
  'try-catch': entry({
    type: 'try-catch',
    category: 'resilience',
    label: 'Try/Catch',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: SUCCESS_ERROR,
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: [],
    allowsNestedGraph: true
  }),
  finally: entry({
    type: 'finally',
    category: 'resilience',
    label: 'Finally',
    runtime: true,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [{ name: 'next', required: true }],
    dataOutPorts: [{ name: 'result', valueType: 'any' }],
    requiredCapabilities: [],
    allowsNestedGraph: true
  }),
  fail: entry({
    type: 'fail',
    category: 'resilience',
    label: 'Fail',
    runtime: true,
    terminal: true,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [],
    dataOutPorts: [{ name: 'error', valueType: 'object' }],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  note: entry({
    type: 'note',
    category: 'annotation',
    label: 'Note',
    runtime: false,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [],
    dataOutPorts: [],
    requiredCapabilities: [],
    allowsNestedGraph: false
  }),
  group: entry({
    type: 'group',
    category: 'annotation',
    label: 'Group',
    runtime: false,
    terminal: false,
    defaultEffect: 'pure',
    supportedVersions: [1],
    controlOutPorts: [],
    dataOutPorts: [],
    requiredCapabilities: [],
    allowsNestedGraph: false
  })
}

export const WORKFLOW_NODE_TYPE_SET = new Set<string>(WORKFLOW_NODE_TYPES)

export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === 'string' && WORKFLOW_NODE_TYPE_SET.has(value)
}

export function getNodeCatalogEntry(type: string): NodeCatalogEntry | undefined {
  if (!isWorkflowNodeType(type)) return undefined
  return WORKFLOW_NODE_CATALOG[type]
}

export function nodeTypeRequiresCapability(
  type: WorkflowNodeType,
  granted: ReadonlySet<string>
): string[] {
  return WORKFLOW_NODE_CATALOG[type].requiredCapabilities.filter((cap) => !granted.has(cap))
}
