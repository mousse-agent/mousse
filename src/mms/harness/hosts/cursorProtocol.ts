/**
 * The NDJSON protocol between the Cursor driver and its host process (`cursorHost.ts`). One JSON
 * object per line on stdin (requests) and stdout (replies and events). Neither side imports the
 * other, and nothing here loads the Cursor SDK.
 */

/** Where an agent's local state lives and which folder it works in. */
export interface CursorLocal {
  cwd: string
  /** `JsonlLocalAgentStore` directory of the instance (`<stateDir>/cursor-store`). */
  storeDir: string
}

export interface CursorModelSelection {
  id: string
  params?: Array<{ id: string; value: string }>
}

export type CursorMcpServers = Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>

export interface CursorAgentSetup extends CursorLocal {
  apiKey: string
  model?: CursorModelSelection
  mode?: 'agent' | 'plan'
  mcpServers?: CursorMcpServers
  /** Ambient settings layers the agent loads (rules, skills, MCP servers): the user's own setup. */
  settingSources: string[]
  /** Cursor's Auto-review classifier gates the agent's tool calls. */
  autoReview: boolean
}

export interface CursorHostMethods {
  create: { params: CursorAgentSetup; result: { agentId: string } }
  resume: { params: CursorAgentSetup & { agentId: string }; result: { agentId: string } }
  /** Starts a run; its updates arrive as `delta` events and its end as one `run_end` event. */
  send: {
    params: { agentId: string; text: string; images?: Array<{ data: string; mimeType: string }>; model?: CursorModelSelection; mode?: 'agent' | 'plan'; mcpServers?: CursorMcpServers }
    result: { runId: string }
  }
  cancel: { params: { runId: string }; result: { cancelled: boolean } }
  listRuns: { params: CursorLocal & { agentId: string; limit?: number }; result: { runs: Array<{ id: string; status: string }> } }
  cancelRun: { params: CursorLocal & { runId: string }; result: Record<string, never> }
  messages: { params: CursorLocal & { agentId: string }; result: { messages: unknown[] } }
  close: { params: { agentId: string }; result: Record<string, never> }
  models: { params: { apiKey: string }; result: { models: CursorModel[] } }
  me: { params: { apiKey: string }; result: CursorUser }
  /** Browser sign-in; the link arrives as a `login_url` event for the same `loginId`. */
  login: { params: { loginId: string }; result: { apiKey: string; apiKeyExpiresAtMs?: number; email?: string } }
  loginCancel: { params: { loginId: string }; result: { cancelled: boolean } }
  /** Removes agents no thread uses any more (their runs and their rows) from the store. */
  prune: { params: { storeDir: string; agentIds: string[] }; result: Record<string, never> }
  /**
   * Where the SDK finds its helpers from this process: the same walk up from the entry script it
   * makes in 1.0.35 (`platform-package-locator`), for the packaged-build check.
   */
  probe: { params: Record<string, never>; result: { rg?: string; sandbox?: string } }
}

export type CursorHostMethod = keyof CursorHostMethods

export interface CursorModel {
  id: string
  displayName?: string
  parameters?: Array<{ id: string; displayName?: string; values: Array<{ value: string; displayName?: string }> }>
  variants?: Array<{ params: Array<{ id: string; value: string }>; displayName: string; isDefault?: boolean }>
}

export interface CursorUser {
  apiKeyName?: string
  userId?: number
  userEmail?: string
}

export interface CursorHostRequest<M extends CursorHostMethod = CursorHostMethod> {
  id: number
  method: M
  params: CursorHostMethods[M]['params']
}

/** A failure the host reports with what the SDK said. */
export interface CursorHostError {
  message: string
  name?: string
  code?: string
  status?: number
  /** The agent already runs another run ("already has active run"). */
  activeRun?: boolean
  /** The SDK refused the credential. */
  auth?: boolean
}

/**
 * Codes the pinned SDK (1.0.35) gives a refused credential: the Connect code, and the error
 * details its `AuthenticationError` carries (which `run.wait()` reduces to a `RunError` code).
 */
const AUTH_CODES = new Set(['unauthenticated', 'unauthorized', 'not_logged_in', 'invalid_auth_id', 'agent_requires_login', 'auth_token_not_found', 'auth_token_expired'])

/**
 * Whether an SDK failure means Cursor refused the credential. The SDK also raises
 * `AuthenticationError` for `NOT_HIGH_ENOUGH_PERMISSIONS`: the key is valid there, so that code
 * never signs the entry out, whether it is thrown or reported as a run's error.
 */
export function isCursorAuthFailure(error: { name?: string; code?: string; status?: number }): boolean {
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : undefined
  if (code === 'not_high_enough_permissions') return false
  return error.name === 'AuthenticationError' || error.status === 401 || (code !== undefined && AUTH_CODES.has(code))
}

/** SDK text for a log line, with anything that looks like a key or a bearer token removed. */
export function redactCursorText(text: string): string {
  return text
    .replace(/(bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/("?(?:api_?key|authorization|token)"?\s*[:=]\s*"?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\b(?:key|crsr|cursor)_[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

export type CursorRunStatus = 'finished' | 'error' | 'cancelled'

export interface CursorUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type CursorHostMessage =
  | { id: number; result: unknown }
  | { id: number; error: CursorHostError }
  | { event: 'ready'; sdkVersion?: string }
  | { event: 'delta'; runId: string; update: Record<string, unknown> }
  | {
      event: 'run_end'
      runId: string
      status: CursorRunStatus
      error?: CursorHostError
      usage?: CursorUsage
      /** The reply was only a transport error dump: the turn failed, it did not answer. */
      transportFailure?: string
    }
  | { event: 'login_url'; loginId: string; url: string }
