import type { Api, Model } from '@earendil-works/pi-ai'

/**
 * What Mousse's Pi extension and the Pi RPC engine say to each other over the engine's local
 * bridge (`harness/pi/bridge.ts`): JSON over HTTP on `127.0.0.1`, every request with the
 * process's bearer. Type-only; shared by both sides.
 */

/** `MOUSSE_PI_BRIDGE` (set by the engine, deleted from the extension's `process.env` at load). */
export interface PiBridgeAddress {
  /** `http://127.0.0.1:<port>`; endpoints are `<url>/pi/<name>`. */
  url: string
  /** Bearer of this process; it names the process to the engine. */
  token: string
}

export const PI_BRIDGE_ENV = 'MOUSSE_PI_BRIDGE'

/** The instance's provider, as the factory registers it. */
export interface PiCatalogProvider {
  id: string
  name?: string
  /** A provider pi-ai ships (`builtinProviders()`); otherwise a Mousse custom provider built with the stock APIs. */
  builtin: boolean
  baseUrl?: string
  headers?: Record<string, string>
  /** The full Mousse catalogue of the provider (live lists, overlays, custom models). */
  models: Model<Api>[]
}

/** `/pi/catalog`. */
export interface PiCatalogResponse {
  provider: PiCatalogProvider
  /**
   * The stored API key, answered to the first catalogue request of a process only (the factory's):
   * it never travels in the environment, the arguments or a file.
   */
  apiKey?: string
  catalogRevision: number
}

/** `/pi/ready`, posted at every `session_start` once every provider is guarded. */
export interface PiReadyRequest {
  /** Provider ids whose registration is a guarded one. */
  guarded: string[]
  /** `AWS_MAX_ATTEMPTS` and `AWS_RETRY_MODE` as the extension's own process sees them. */
  aws: { maxAttempts: string | null; retryMode: string | null }
  /** `session_start` reason (`startup`, `resume`, `fork`, …). */
  reason: string
}

/** A Mousse tool as Pi registers it for a turn. */
export interface PiTurnTool {
  name: string
  description: string
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>
  /** `delegation` tools register with `executionMode: 'sequential'`. */
  class: 'read' | 'mutation' | 'delegation'
}

/** `/pi/turn`, fetched at `before_agent_start`. */
export interface PiTurnResponse {
  /** The turn's token: stamped on every Mousse MCP call as `_mousse_turn` and sent to the gate. */
  attemptToken: string
  /** Appended to Pi's system prompt for the turn. */
  sessionInstructions: string
  tools: PiTurnTool[]
  /** Pi's built-in tools active this turn (read-only ones in plan mode and read-only children). */
  activeBuiltins: string[]
  /** The Mousse MCP server and the thread's bearer; null: no Mousse tools. */
  mcp: { url: string; token: string } | null
  /** Re-register the instance provider when it changed since the factory's catalogue. */
  catalogRevision: number
}

/** `/pi/gate`, at every `tool_call`. */
export interface PiGateRequest {
  attemptToken: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

/**
 * `input`: arguments the call must run with instead of its own (a read-only child's path, resolved
 * the way Pi resolves it and checked); the extension applies them before the tool runs.
 */
export type PiGateResponse = { allow: true; input?: Record<string, unknown> } | { allow: false; reason: string }

/**
 * `/pi/request`, before every model request the guarded wrapper lets through (agent requests,
 * compactions, summaries and Pi's own retries alike): Mousse charges it to the live turn's run and
 * may refuse it. Nothing is sent when it is refused or cannot be asked.
 */
export interface PiRequestRequest {
  /** The attempt token of the turn the extension last fetched ('' before the first); informational. */
  attemptToken: string
  kind: 'request'
  /**
   * What the request would spend (every `streamSimple` request; Mousse reserves it when the live
   * turn has token or USD limits). Prices and cap support are Mousse's own, from its catalogue.
   */
  spend?: PiSpendRequest
}

/** One request's reservation ask (`harness/pi/reservation.ts` computes every number). */
export interface PiSpendRequest {
  /** Upper bound of the input tokens. */
  inputBound: number | null
  /** The output cap pi-ai would send as Pi asked for the request; null when it would send none. */
  wireCap: number | null
  /** The thinking budget pi-ai adds to the cap (0 when none). */
  thinkingBudget: number
  /** The request's model: it must be the turn's. */
  model: { provider: string; id: string; api: string }
}

/**
 * `reason`: one of the fixed request-path texts (`messages.ts`), never a number. `reservation`: the
 * request is reserved, and must go with exactly `cap` as its wire cap.
 */
export type PiRequestResponse = { ok: true; reservation?: { id: string; cap: number } } | { ok: false; reason: string }

/**
 * `/pi/settle`, once a reserved request ended: `released` when nothing was sent (refused before
 * the HTTP call), `used` with its usage (`partial` when it failed or stopped after being sent).
 */
export interface PiSettleRequest {
  reservationId: string
  outcome: { kind: 'released' } | { kind: 'used'; input: number; output: number; usd: number; partial?: boolean }
}

/** `/pi/quiesce`: a delegation tool waits here before it runs (no parent mutation authorized or running). */
export interface PiQuiesceRequest {
  attemptToken: string
  toolCallId: string
}

export type PiQuiesceResponse = { ok: true } | { ok: false; reason: string }

/** `/pi/group`: a shell's process group, recorded before its command runs (POSIX). */
export interface PiGroupRequest {
  pgid: number
  /** The group's command ended (the group is retired once empty). */
  ended?: boolean
}

/** `/pi/fatal`: the extension cannot keep the process safe (a failed provider registration after bind). */
export interface PiFatalRequest {
  reason: 'register_provider' | 'catalog'
  message: string
}
