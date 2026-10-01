export type WorkflowDiagnosticSeverity = 'error' | 'warning' | 'info'

export type WorkflowDiagnosticCode =
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_MANIFEST'
  | 'INVALID_ID'
  | 'INVALID_SLUG'
  | 'RESERVED_SLUG'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE'
  | 'UNKNOWN_NODE_TYPE'
  | 'UNSUPPORTED_NODE'
  | 'INVALID_NODE_VERSION'
  | 'INVALID_NODE_CONFIG'
  | 'INVALID_PORT'
  | 'MISSING_ENTRY'
  | 'INVALID_ENTRY'
  | 'UNREACHABLE_NODE'
  | 'CYCLE_DETECTED'
  | 'UNBOUNDED_LOOP'
  | 'INVALID_LOOP'
  | 'MISSING_TERMINAL'
  | 'MISSING_CONTROL_EDGE'
  | 'MISSING_REF'
  | 'INVALID_BINDING'
  | 'INVALID_EXPRESSION'
  | 'INVALID_POINTER'
  | 'DATA_UNAVAILABLE'
  | 'BRANCH_OUTPUT_MISUSE'
  | 'JOIN_MISMATCH'
  | 'SUBWORKFLOW_CYCLE'
  | 'MISSING_DEPENDENCY'
  | 'MISSING_CAPABILITY'
  | 'INVALID_SCHEMA'
  | 'RESTRICTED_SCHEMA_KEYWORD'
  | 'REMOTE_SCHEMA_REF'
  | 'SCHEMA_TOO_COMPLEX'
  | 'GRAPH_TOO_LARGE'
  | 'ASSET_UNSAFE'
  | 'ASSET_MISSING'
  | 'INVALID_LIMITS'
  | 'INVALID_RETRY'
  | 'INVALID_EFFECT'
  | 'INVALID_FILE_INPUTS'
  | 'PROTOTYPE_KEY'
  | 'MALFORMED_SOURCE'

export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode
  severity: WorkflowDiagnosticSeverity
  message: string
  nodeId?: string
  edge?: { from: string; port: string; to: string }
  path?: string
}

export function diagnostic(
  code: WorkflowDiagnosticCode,
  message: string,
  extra: Omit<WorkflowDiagnostic, 'code' | 'message' | 'severity'> & {
    severity?: WorkflowDiagnosticSeverity
  } = {}
): WorkflowDiagnostic {
  const { severity = 'error', ...rest } = extra
  return { code, severity, message, ...rest }
}

export function hasErrorDiagnostics(diagnostics: readonly WorkflowDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'error')
}
