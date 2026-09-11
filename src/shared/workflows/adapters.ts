import type {
  ArtifactReference,
  EffectClass,
  ExecutionContext,
  ExecutionPolicySnapshot
} from '../execution/types'
import type { BoundedJsonSchema } from './schema'

export const WORKFLOW_WORKING_DIRECTORIES = ['thread-workspace', 'run-staging', 'profile-sandbox'] as const
export type WorkflowWorkingDirectory = (typeof WORKFLOW_WORKING_DIRECTORIES)[number]

export function isWorkflowWorkingDirectory(value: unknown): value is WorkflowWorkingDirectory {
  return value === 'thread-workspace' || value === 'run-staging' || value === 'profile-sandbox'
}

export interface WorkspaceExecutionRoot {
  cwd: string
}

export interface WorkspaceFileAdapter {
  readonly kind: 'workspace'
  readAuthorizedFile(relativePath: string, context: ExecutionContext): Promise<{ bytes: Uint8Array; name: string }>
  /** Resolve script cwd. Absence is not a fallback to staging for thread-workspace or profile-sandbox. */
  resolveWorkingDirectory?(request: {
    workingDirectory: WorkflowWorkingDirectory
    context: ExecutionContext
    stagingDir: string
    signal: AbortSignal
  }): Promise<WorkspaceExecutionRoot>
}

export interface ArtifactStoreAdapter {
  put(input: {
    profileId: string
    runId: string
    bytes: Uint8Array
    mediaType: string
    displayName: string
  }): Promise<ArtifactReference>
  get(id: string, profileId: string): Promise<{ bytes: Uint8Array; ref: ArtifactReference }>
}

export interface AgentExecutorAdapter {
  readonly kind: 'agent'
  invoke(request: {
    context: ExecutionContext
    policy: ExecutionPolicySnapshot
    agent: { kind: 'main' | 'user'; definitionId?: string; revision?: string }
    instructions: string
    input: unknown
    outputSchema?: BoundedJsonSchema
    signal: AbortSignal
    idempotencyKey: string
  }): Promise<{ output: unknown; tokens?: number; cost?: number }>
}

export interface ToolExecutorAdapter {
  readonly kind: 'tool'
  invoke(request: {
    context: ExecutionContext
    policy: ExecutionPolicySnapshot
    toolId: string
    input: unknown
    signal: AbortSignal
    idempotencyKey: string
  }): Promise<{ output: unknown; effect: EffectClass }>
}

export interface McpExecutorAdapter {
  readonly kind: 'mcp'
  invoke(request: {
    context: ExecutionContext
    policy: ExecutionPolicySnapshot
    serverId: string
    toolName: string
    input: unknown
    signal: AbortSignal
    idempotencyKey: string
  }): Promise<{ output: unknown; effect: EffectClass }>
}

export interface SkillLoaderAdapter {
  readonly kind: 'skill'
  load(request: {
    context: ExecutionContext
    skillId: string
    revision?: string
  }): Promise<{ skillContext: unknown; instructions?: string }>
}

export interface BrowserExecutorAdapter {
  readonly kind: 'browser'
  invoke(request: {
    context: ExecutionContext
    policy: ExecutionPolicySnapshot
    nodeType: string
    config: Record<string, unknown>
    input: unknown
    signal: AbortSignal
    idempotencyKey: string
  }): Promise<{ output: unknown; artifacts?: ArtifactReference[] }>
}

export interface SandboxAdapter {
  readonly kind: 'sandbox'
  readonly platform: string
  /**
   * Absolute sandbox filesystem root for `workingDirectory: profile-sandbox`.
   * A Node child plus env whitelist is not a sandbox root. Absence fails closed.
   */
  readonly workspaceRoot?: string
  execute(request: ScriptSpawnRequest): Promise<ScriptSpawnResult>
}

export interface InterpreterResolver {
  resolve(runtime: 'node' | 'python' | 'powershell' | 'bash'): { command: string; prefixArgs: string[] }
}

export interface ScriptSpawnRequest {
  runtime: 'node' | 'python' | 'powershell' | 'bash'
  scriptPath: string
  scriptHash: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  signal: AbortSignal
}

export interface ScriptSpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  pid?: number
  timedOut: boolean
  truncated: boolean
}

export interface ApprovalHostAdapter {
  /** Optional UI/channel notifier. Decisions are stored by ApprovalService, not invented here. */
  notify?(record: {
    approvalId: string
    profileId: string
    runId: string
    description: string
    unattended: boolean
  }): Promise<void>
}

export interface WorkflowExecutionAdapters {
  workspace?: WorkspaceFileAdapter
  artifacts?: ArtifactStoreAdapter
  agent?: AgentExecutorAdapter
  tool?: ToolExecutorAdapter
  mcp?: McpExecutorAdapter
  skill?: SkillLoaderAdapter
  browser?: BrowserExecutorAdapter
  sandbox?: SandboxAdapter
  interpreters?: InterpreterResolver
  approvalHost?: ApprovalHostAdapter
}
