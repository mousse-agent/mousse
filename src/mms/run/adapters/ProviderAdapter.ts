import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ChatImageAttachment, ChatMode } from '../../../shared/types'
import type {
  LlmChatOptions,
  StreamingLlmTextEvent,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent,
  ToolLoopSafetyOptions
} from '../../orchestrator/LlmClient'
import type { NativeMessageCheckpoint } from '../../orchestrator/nativeContext'
import type { ProviderRef } from '../types'

/**
 * Static capability manifest of a provider adapter (docs/run-engine/SPEC.md §13.2). Every key
 * has a reader outside `adapters/` (`CommandPolicy`, `policy/featureGates`); the
 * `capabilityReaders` test fails when a key gains no reader.
 */
export interface ProviderCapabilities {
  /** `CommandPolicy.steerStrategy`. */
  steer: 'native' | 'interrupt_restart' | 'queue_only'
  /** `CommandPolicy.stopStrategy`. */
  interrupt: boolean
  /** `featureGates.canUndoNatively` (Phase 6). */
  rollback: 'native' | 'none'
  /** `featureGates.forkStrategy` (Phase 6). */
  fork: 'native' | 'portable'
  /** `CommandPolicy.heartbeatToleranceMs`: sparse event streams get 6x the heartbeat window. */
  events: 'rich' | 'sparse'
  /** `featureGates.restoreMode` (Phase 6): weak containment never auto-restores. */
  containment: 'strong' | 'weak'
  /** `featureGates.handoffDelivery` (Phase 6). */
  historyInjection: 'native' | 'prompt'
  /** `featureGates.mcpAttachable` (Phase 5). */
  mcp: boolean
}

/** One provider turn, built by the `turn.start` executor from the thread's state. */
export interface TurnInput {
  runId: string
  attemptId: string
  threadId: string
  /** Project working directory; null for a thread without a project. */
  cwd: string | null
  /** Resolved selection; routes the turn (`AdapterRegistry`) and names the `ProviderRef`. */
  model: string
  llmProvider: string
  /**
   * The thread or caller pinned `model`/`llmProvider`. When false the selection is the configured
   * default for `mode`, and an adapter whose runtime resolves its own default (the pi loop's
   * `LlmClient`) is left to do so, exactly as before adapters.
   */
  modelPinned: boolean
  mode: ChatMode
  /** Text of the admitted user message; prompt-based adapters send it as the turn's prompt. */
  prompt: string
  /** Active pi-ai transcript, ending with the admitted user message. */
  messages: Message[]
  /** Generated compaction memory for the active transcript. */
  contextSummary?: string
  /**
   * Images of the admitted user message. Transcript-native adapters (pi) already carry them in
   * `messages`; prompt-based adapters send them with the prompt.
   */
  images?: ChatImageAttachment[]
  /**
   * Catalogue of this conversation's applets; undefined when applets are off. The pi loop's system
   * prompt already carries the applet guidance; vendor runtimes have their own system prompt and
   * prefix `APPLET_GENERATION_GUIDANCE` themselves.
   */
  appletInstructions?: string
  /**
   * Prior turns serialised for prompt injection (`nativeAgentHistory`, ending before the admitted
   * user message). Read by adapters whose `historyInjection` is `prompt`; a compaction during the
   * turn hands back a fresh copy (`RecoveredContext.nativeHistory`).
   */
  nativeHistory?: string
  /** Aborted by the orchestrator on Stop, effect timeout or shutdown. */
  signal: AbortSignal
}

/**
 * Where an adapter reports what happened during a turn. The orchestrator forwards these into its
 * transcript and stream emitters; adapters never touch transcript state directly.
 */
export interface TurnSink {
  text(event: StreamingLlmTextEvent): void
  thinking(event: StreamingLlmThinkingEvent): void
  tool(event: StreamingLlmToolEvent): void
  /** The adapter's live native transcript after each append (crash-safe checkpointing). */
  nativeMessages(messages: Message[], checkpoint?: NativeMessageCheckpoint): void
  compaction(phase: 'start' | 'complete' | 'unchanged'): void
  retry(attempt: number): void
  /** The provider produced output; a context-overflow retry is no longer safe. */
  progress(): void
  /**
   * Token usage for runtimes that do not record it themselves; the orchestrator adds it to the
   * usage statistics, attributed to the latest `providerMetrics` model. The pi loop's `LlmClient`
   * records its own usage, so the pi adapter does not report here (no double counting).
   */
  usage(u: { input: number; output: number; cacheRead: number; cacheWrite: number }): void
  /** The provider session reference, as soon as it is known and whenever it changes (§13.1 `nativeRef`). */
  providerRef(ref: ProviderRef): void
  /**
   * A drained steer reached a runtime that keeps its own transcript. The orchestrator appends it
   * to the canonical transcript and acknowledges the drained queue items. (The pi loop reports
   * steers through `nativeMessages` instead.)
   */
  steerAccepted(text: string): void
  /** Turn-level measurements from a runtime that reports them (may arrive on failure too). */
  providerMetrics(metrics: ProviderMetrics): void
  /** Lines the runtime edited in the workspace. */
  lineEdits(lines: number): void
}

/** Measurements a vendor runtime reports for one turn. */
export interface ProviderMetrics {
  /** Model the runtime actually used, when it differs from the selected alias. */
  realModelName?: string
  totalResponseTimeMs: number
  totalTokensUsed?: number
  tokensPerSecond?: number
  /** Usage stored on the turn's assistant message in the canonical transcript. */
  usage?: AssistantMessage['usage']
  /** Prompt-side size of the runtime's own context after the turn, and its window when known. */
  context?: {
    input: number
    cacheRead: number
    cacheWrite: number
    contextWindow?: number
    modelName?: string
  }
}

export interface TurnControl {
  /** Pending steer text for the live turn, or undefined. */
  drainSteer(): string | undefined
  /** Liveness touch; the orchestrator throttles the store write. */
  heartbeat(): void
}

export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface TurnResult {
  text: string
  aborted: boolean
  modelName: string
  totalResponseTimeMs: number
  /** Absent when the runtime reports no token count. */
  totalTokensUsed?: number
  tokensPerSecond?: number
  usage: TurnUsage
  /** Prompt/tool material signature for context accounting (`recordLastTurnUsage`). */
  contextSignature: string
  /** Model key paired with `contextSignature`. */
  contextModelKey?: string
  /**
   * Complete native active transcript after the turn. Empty for prompt-injected runtimes: their
   * reply reaches the canonical transcript through `AdapterHost.context.nativeHistoryAfterTurn`.
   */
  nativeMessages: Message[]
  providerRef: ProviderRef
}

/**
 * Mousse tools an in-process loop calls directly (SPEC §13.1 `ToolHost`). Vendor runtimes reach
 * the same tools over the Mousse MCP server (`AdapterHost.mcp`, SPEC §15). Every field is minted
 * by the daemon for this turn; none comes from protocol input.
 */
export type ToolHost = Pick<
  LlmChatOptions,
  'delegation' | 'toolAccess' | 'toolLedger' | 'browser' | 'onPublishApplet'
>

/** One compaction of the thread's transcript: the compacted context to (re)send. */
export interface RecoveredContext {
  messages: Message[]
  contextSummary?: string
  /** `TurnInput.nativeHistory` recomputed from the compacted transcript. */
  nativeHistory: string
}

/**
 * What a turn needs from the orchestrator besides its input: the tool host and the transcript
 * operations that stay with the transcript's owner. Provider clients are adapter dependencies
 * (constructor getters), not host fields, so the host stays provider-neutral.
 */
export interface AdapterHost {
  tools: ToolHost
  /**
   * The Mousse MCP server and this run's bearer token (SPEC §15.2), minted by the `turn.start`
   * executor when the adapter's `caps.mcp` is true and revoked when the turn ends. Absent or null:
   * attach nothing, so the orchestration tools are simply not offered.
   */
  mcp?: { url: string; token: string } | null
  context: {
    /** Safe-boundary compaction inside a long tool loop; absent when compaction is disabled. */
    toolLoopSafety?: ToolLoopSafetyOptions
    /**
     * Compacts the thread's transcript after a context-overflow failure. Returns the compacted
     * active transcript to retry with, or null when it cannot (compaction disabled or a no-op, or
     * the turn already had side effects the host knows about).
     */
    recoverOverflow(): RecoveredContext | null
    /**
     * Pre-turn compaction for a runtime that measures its own context: compacts when the last
     * measured usage of `provider:model` (or the transcript estimate) crosses the configured
     * threshold. Returns the compacted context, or null when nothing changed.
     */
    prepareNativeContext(provider: string, model: string): RecoveredContext | null
    /**
     * Appends the turn's reply (with the metrics reported through `TurnSink.providerMetrics`) to
     * the canonical transcript, once, persists it and returns the serialised history the runtime
     * fingerprints for session resume (`commitConversation`).
     */
    nativeHistoryAfterTurn(text: string): string
  }
}

/** Per-model facts the orchestrator needs outside a turn (SPEC §13.1 `describe`). */
export interface ModelInfo {
  /**
   * `reported`: the runtime reports its context size and window (`ProviderMetrics.context`), so
   * Mousse shows a measured context gauge. `none`: the runtime owns its context and publishes no
   * window; Mousse shows no measurement rather than a fabricated one.
   */
  contextUsage: 'reported' | 'none'
}

export interface ProviderAdapter {
  /** `'pi' | 'claude-subscription' | 'antigravity'`; resolved by `AdapterRegistry`. */
  readonly id: string
  readonly capabilities: ProviderCapabilities
  /** Facts about `model`; adapters whose context Mousse measures itself (the pi loop) omit it. */
  describe?(model: string): ModelInfo
  /** The runtime is signed in and installed, so its models can be selected by default. */
  configured?(): boolean
  /**
   * Runs one turn. Settling is the turn's terminal signal for every adapter: the vendor runtimes
   * resolve when their stream closes, so there is no separate "stream closed without a terminal
   * event" state to time out (a hung stream is caught by reconciler rule 2's heartbeat window).
   */
  startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult>
  interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'>
  steer?(ref: ProviderRef, text: string): Promise<'delivered' | 'not_active'>
  /**
   * SPEC §16.2 native fork: a new provider session branched from `ref` after `atTurnOrdinal`, or
   * null when the runtime cannot branch it (the fork then falls back to a portable handoff). Only
   * called when `featureGates.forkStrategy(caps)` is `native` and `ref` names a session.
   */
  forkSession?(ref: ProviderRef, atTurnOrdinal: number): Promise<ProviderRef | null>
}
