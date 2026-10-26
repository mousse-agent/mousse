/**
 * The NDJSON protocol between the Cursor driver and its host process (`cursorHost.ts`). One JSON
 * object per line on stdin (requests) and stdout (replies and events). Type-only: neither side
 * imports the other, and nothing here names the Cursor SDK.
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
