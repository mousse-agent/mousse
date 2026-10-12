import type { Message } from '@earendil-works/pi-ai'
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
  /** `featureGates.delegationMode` (Phase 4). */
  nativeSubagents: 'none' | 'observed' | 'managed'
  /** `CommandPolicy.heartbeatToleranceMs`: sparse event streams get 6x the heartbeat window. */
  events: 'rich' | 'sparse'
  /** `featureGates.restoreMode` (Phase 6): weak containment never auto-restores. */
  containment: 'strong' | 'weak'
  /** `featureGates.handoffDelivery` (Phase 6). */
  historyInjection: 'native' | 'prompt'
  /** `CommandPolicy.terminalPolicy`: best-effort runs also end on stream close + 30 s idle. */
  terminalQuality: 'reliable' | 'best_effort'
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
  /** Active pi-ai transcript, ending with the admitted user message. */
  messages: Message[]
  /** Generated compaction memory for the active transcript. */
  contextSummary?: string
  /**
   * Images of the admitted user message. Transcript-native adapters (pi) already carry them in
   * `messages`; prompt-based adapters send them with the prompt.
   */
  images?: ChatImageAttachment[]
  appletInstructions?: string
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
   * Token usage for runtimes that do not record it themselves. The pi loop's `LlmClient` records
   * its own usage, so the pi adapter does not report here (no double counting).
   */
  usage(u: { input: number; output: number; cacheRead: number; cacheWrite: number }): void
  /** The provider session reference, as soon as it is known and whenever it changes (§13.1 `nativeRef`). */
  providerRef(ref: ProviderRef): void
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
  totalTokensUsed: number
  tokensPerSecond?: number
  usage: TurnUsage
  /** Prompt/tool material signature for context accounting (`recordLastTurnUsage`). */
  contextSignature: string
  /** Model key paired with `contextSignature`. */
  contextModelKey?: string
  /** Complete native active transcript after the turn. */
  nativeMessages: Message[]
  providerRef: ProviderRef
}

/**
 * Mousse tools an in-process loop calls directly (SPEC §13.1 `ToolHost`). Vendor runtimes reach
 * them over the Mousse MCP server in Phase 5 and receive no `ToolHost` until then. Every field is
 * minted by the daemon for this turn; none comes from protocol input.
 */
export type ToolHost = Pick<
  LlmChatOptions,
  'delegation' | 'toolAccess' | 'toolLedger' | 'browser' | 'onPublishApplet'
>

/** One context-overflow recovery: the compacted active transcript to retry with. */
export interface RecoveredContext {
  messages: Message[]
  contextSummary?: string
}

/**
 * What a turn needs from the orchestrator besides its input: the tool host and the transcript
 * operations that stay with the transcript's owner. Provider clients are adapter dependencies
 * (constructor getters), not host fields, so the host stays provider-neutral.
 */
export interface AdapterHost {
  tools: ToolHost
  context: {
    /** Safe-boundary compaction inside a long tool loop; absent when compaction is disabled. */
    toolLoopSafety?: ToolLoopSafetyOptions
    /**
     * Compacts the thread's transcript after a context-overflow failure. Returns the compacted
     * active transcript to retry with, or null when it cannot (compaction disabled or a no-op, or
     * the turn already had side effects the host knows about).
     */
    recoverOverflow(): RecoveredContext | null
  }
}

export interface ProviderAdapter {
  /** `'pi' | 'claude-subscription' | 'antigravity'`; resolved by `AdapterRegistry`. */
  readonly id: string
  readonly capabilities: ProviderCapabilities
  startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult>
  interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'>
  steer?(ref: ProviderRef, text: string): Promise<'delivered' | 'not_active'>
}
