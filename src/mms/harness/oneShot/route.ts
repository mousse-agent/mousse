/**
 * Route facts for single requests (thread titles, branch names, pull request drafts, commit messages, a bot's name and
 * digest): what a provider's way of running one actually holds. Types only; the label is computed from them
 * (`admission.ts`), never declared. See docs/plans/one-shots-every-provider.md.
 */

/**
 * - `none_offered`: the model is offered no tool.
 * - `refused_before_run`: every tool call passes through Mousse, which refuses it before it runs.
 * - `detected_on_report`: the agent's own tools; Mousse refuses what passes through it and ends the request at the
 *   first tool it reports.
 */
export type OneShotTools = 'none_offered' | 'refused_before_run' | 'detected_on_report'

/** `one`: a failed request is never sent again below Mousse (measured at a stub). `unenforced`: it may be. */
export type OneShotAttempts = 'one' | 'unenforced'

/** `verified`: no user config loads (shown by the effects spike). `env_only`: only the environment is redirected. */
export type OneShotIsolation = 'verified' | 'env_only'

export type OneShotLaunchKind = 'in_process' | 'sealed_child' | 'sealed_host'

/** `own_threads`: a local model names only the threads that run on it. */
export type OneShotAudience = 'any' | 'own_threads'

export interface RouteFacts {
  tools: OneShotTools
  attempts: OneShotAttempts
  isolation: OneShotIsolation
  launch: OneShotLaunchKind
  audience: OneShotAudience
}

/**
 * A route's name. `legacy:<driver>` is a provider still on its own one-shot code until its slice: admitted through the
 * same step, with no facts claimed.
 */
export type OneShotRouteId = 'pi:direct' | 'pi:worker' | 'acp:generic' | 'acp:antigravity' | 'claude:cli' | 'codex:direct' | 'codex:app_server' | 'opencode:sealed' | 'cursor:sdk' | `legacy:${string}`

export interface OneShotRoute {
  id: OneShotRouteId
  /** Absent on a legacy route: it claims nothing. */
  facts?: RouteFacts
}

/** What a driver says about one model of one entry (`HarnessDriver.oneShotRoute`). */
export type OneShotRouteDecision = { route: OneShotRoute } | { refused: string }

/** The operation a single request serves. */
export type OneShotOp = 'thread_title' | 'branch_name' | 'pr_draft' | 'commit_message' | 'bot_name' | 'bot_digest'

/** What a route's transport is handed: the runner builds it, the transport only carries it. */
export interface OneShotWireRequest {
  model: string
  /** The opening no-tools line, when the route can be offered tools at all. */
  instruction?: string
  system: string
  prompt: string
}

/** What a transport reports while the request runs; the runner applies the checks and caps. */
export interface OneShotEvents {
  /** Any sign of life from the provider. */
  activity(): void
  /** Part of the answer as it streams. */
  text(chunk: string): void
  /** A tool the provider used or asked for: the runner ends the request. */
  tool(what: string): void
  /**
   * The transport is about to start its program, `executable` as it resolved it now: the runner checks it is the
   * program admitted, and throws when not, so nothing starts.
   */
  launching(executable: string): void
  /**
   * The request is about to leave for the provider, after the transport's own preparation (a launch, a credential
   * read): the runner checks the entry is still the one admitted and counts the request as sent. Throws when it may
   * not go, and nothing is sent.
   */
  sending(): void
}

/**
 * A route's narrow transport: it sends the request it is given once, reports events, and resolves with the whole
 * answer. It never retries, builds its own prompt or applies its own bounds; the runner does.
 */
export interface OneShotTransport {
  send(request: OneShotWireRequest, events: OneShotEvents, signal: AbortSignal): Promise<string>
}
