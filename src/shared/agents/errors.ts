export const AGENT_DEFINITION_ERROR_CODES = [
  'AGENT_NOT_FOUND',
  'AGENT_ARCHIVED',
  'SLUG_CONFLICT',
  'REVISION_CONFLICT',
  'REVISION_NOT_FOUND',
  'INVALID_BUNDLE',
  'PATH_ESCAPE',
  'PROMPT_TOO_LARGE',
  'DEPENDENCY_MISSING',
  'MODEL_CAPABILITY_MISSING',
  'SETTINGS_UNSUPPORTED',
  'PROFILE_MISMATCH',
  'IMPORT_LIMIT'
] as const

export type AgentDefinitionErrorCode = (typeof AGENT_DEFINITION_ERROR_CODES)[number]

export interface AgentDefinitionIssue {
  code: AgentDefinitionErrorCode
  message: string
  pointer?: string
  retryable: boolean
  details?: Record<string, unknown>
}

export class AgentDefinitionError extends Error {
  readonly code: AgentDefinitionErrorCode
  readonly retryable: boolean
  readonly pointer?: string
  readonly details?: Record<string, unknown>

  constructor(
    code: AgentDefinitionErrorCode,
    message: string,
    options: { retryable?: boolean; pointer?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message)
    this.name = 'AgentDefinitionError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.pointer = options.pointer
    this.details = options.details
  }

  toIssue(): AgentDefinitionIssue {
    return {
      code: this.code,
      message: this.message,
      pointer: this.pointer,
      retryable: this.retryable,
      details: this.details
    }
  }
}

export function isAgentDefinitionError(error: unknown): error is AgentDefinitionError {
  return error instanceof AgentDefinitionError
}
