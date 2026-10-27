import type { AssistantMessage, Message } from '../../../shared/transcript'
import type { ProviderDriverKind } from '../../../shared/providerInstances'
import type { PermissionMode } from '../../../shared/permissionMode'
import type { ChatImageAttachment, ChatMode } from '../../../shared/types'
import type { LlmChatOptions, LlmClient, ToolLoopSafetyOptions } from '../../orchestrator/LlmClient'
import type { AgentExecutionBudget, AgentExecutionLimit, AgentRuntimeEffectTracker } from '../../../shared/agents/execution'
import type { IntegrationActor } from '../../../shared/integrations/actor'
import type { StreamingLlmTextEvent, StreamingLlmThinkingEvent, StreamingLlmToolEvent } from '../../harness/turnEvents'
import type { NativeMessageCheckpoint } from '../../orchestrator/nativeContext'
import type { ChildPreflightContext, SubagentRefusal } from '../policy/featureGates'
import type { PermissionPrompter } from '../../harness/acp/permissions'
import type { TurnBudget } from '../../harness/budget'
import type { DefinitionAuthority } from '../../agentDefinitions/definitionGate'
import type { BotAuthority } from '../../../shared/bots/personal/authority'
import type { ProviderRef } from '../types'

/**
 * Static capability manifest of a provider adapter (docs/run-engine/SPEC.md §13.2). Every key
 * has a reader outside `adapters/` (`CommandPolicy`, `policy/featureGates`); the
 * `capabilityReaders` test fails when a key gains no reader.
 */
export interface ProviderCapabilities {
  /**
   * How steer text reaches a live turn; read by `CommandPolicy.steerStrategy`.
   * - `native`: the text joins the live turn without cancelling in-flight work (a running tool
   *   call finishes; the model sees the text at its next step). Only this lets reconciler rule 4
   *   deliver a delegation notice into a live run (SPEC §14.3).
   * - `interrupt_restart`: delivered by interrupting the turn and resuming or restarting the
   *   session with the text as a new user message; a tool call in flight is cancelled.
   * - `queue_only`: the text waits for the turn to end.
   */
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
  /**
   * `featureGates.subagentTargetRefusal`. `enforced`: the adapter holds a delegated child to its
   * policy (read-only for a `shared` child, no provider-native subagents, no user MCP servers for a
   * read-only child). `isolated_only`: it cannot hold a child to read-only, so it is refused as the target of a `shared` child and still runs `isolated` ones.
   */
  childPolicy: 'enforced' | 'isolated_only'
}

/**
 * The policy of a delegated child's turn (issue #142), absent for a thread that is not a subagent.
 * Every turn of a child carries it, first or resumed. `readOnly` is a `shared` child, which
 * observes its parent's workspace and must not change it.
 */
export interface ChildTurnPolicy {
  readOnly: boolean
}

/** One provider turn, built by the `turn.start` executor from the thread's state. */
export interface TurnInput {
  runId: string
  attemptId: string
  threadId: string
  /** Project working directory; null for a thread without a project. */
  cwd: string | null
  /** Provider instance the turn runs on (SPEC §13.8); the harness gateway routed the turn by it. */
  instanceId: string
  /** Resolved model of the selection. */
  model: string
  /**
   * @deprecated Derived from `instanceId` (the pi-ai provider id of a `pi:<provider>` instance, the
   * driver's former provider name otherwise). Kept because transcripts, provider refs and the pi
   * loop still name providers this way; route by `instanceId`.
   */
  llmProvider: string
  /**
   * The thread or caller pinned `model`/`instanceId`. When false the selection is the configured
   * default for `mode`, and an adapter whose runtime resolves its own default (the pi loop's
   * `LlmClient`) is left to do so, exactly as before adapters.
   */
  modelPinned: boolean
  mode: ChatMode
  /**
   * The permission mode the turn runs in: the binding's (the thread's mode, or the nearest stricter
   * one the instance can enforce). Each adapter enforces it with its runtime's own controls on every
   * turn; a plan turn carries it unchanged, and it does not matter there.
   */
  permissionMode: PermissionMode
  /** Set when the thread is a delegated child; adapters apply it on every turn of the thread. */
  child?: ChildTurnPolicy
  /**
   * The provider started this turn itself (a background task finished and its runtime woke the
   * thread): the turn reads what the runtime is already doing and `prompt` is only the note shown in
   * the transcript. Set for runs with source `provider-continuation`.
   */
  continuation?: boolean
  /** Which turn the provider started this run is for, when it started several. */
  continuationId?: string
  /**
   * The admitted message was written by another thread's agent: no `/skill` mention in it loads a skill (only a
   * person invokes one). Runtimes that read mentions themselves (the pi loop) skip them for this turn.
   */
  fromAgent?: true
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
   * Catalogue of this conversation's applets for the pi loop's system prompt, which already carries
   * the applet guidance; undefined when applets are off. A runtime with its own loop gets the
   * catalogue in its turn preamble and the guidance in its session instructions (`TurnBridge`).
   */
  appletInstructions?: string
  /**
   * Prior turns serialised for prompt injection (`nativeAgentHistory`, ending before the admitted
   * user message). Read by adapters whose `historyInjection` is `prompt`; a compaction during the
   * turn hands back a fresh copy (`RecoveredContext.nativeHistory`).
   */
  nativeHistory?: string
  /**
   * The orchestrator handed history over in the prompt this turn (a provider switch's handover,
   * which then stands in for the transcript and leaves `nativeHistory` empty, or a fork's portable
   * handover of its parent): no native session the runtime kept for the thread may be resumed in
   * its place.
   */
  historyHandedOver?: boolean
  /**
   * Planning this turn's handoffs failed, so the turn carries its raw history only: whether a native
   * session the runtime kept for the thread is still current (a fork's branch, with turns elsewhere
   * since) is unknown, and such a session is not resumed.
   */
  handoffUnplanned?: boolean
  /**
   * `ephemeral`: the turn runs in a session of its own, made for this turn and not kept for the
   * thread (an agent definition's turn, PR 4 §6); `messages` and `nativeHistory` carry its whole
   * conversation. Only an `exact` runtime is given one (`TurnSpec.session`).
   */
  session?: 'thread' | 'ephemeral'
  /**
   * The turn's own instructions (an agent definition's system prompt): they replace the runtime's
   * default instructions or are appended to them. Only an `exact` runtime is given them.
   */
  instructions?: { text: string; placement: 'replace' | 'append' }
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
  /**
   * Hands back text `drainSteer` returned that the turn could not take (its result had already
   * arrived): it becomes the next turn instead of being lost. Optional for adapters that never refuse a steer.
   */
  returnSteer?(text: string, token?: string): void
  /**
   * `drainSteer` with a token naming this drain, for a provider that takes steers asynchronously and may
   * hand back several: `returnSteer(text, token)` then restores what that drain took and nothing else.
   */
  drainSteerEntry?(): { text: string; token: string } | undefined
  /** The provider took the drain `token` names; it will not be returned. */
  steerTaken?(token?: string): void
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
  /**
   * What the runtime announced of its Mousse MCP calls this turn, for a `drained_turn` bearer (PR 2
   * §2): `mousseCalls`, the calls to Mousse's server it announced (a runtime that names the server);
   * `toolCalls`, every tool call it announced (one that does not); `toolsSettled`, each of those
   * reached a terminal update from the runtime itself.
   */
  drain?: { mousseCalls?: number; toolCalls?: number; toolsSettled?: boolean }
}

/**
 * Mousse tools an in-process loop calls directly (SPEC §13.1 `ToolHost`). Vendor runtimes reach
 * the same tools over the Mousse MCP server (`AdapterHost.bridge`, SPEC §15). Every field is minted
 * by the daemon for this turn; none comes from protocol input.
 */
export type ToolHost = Pick<
  LlmChatOptions,
  'delegation' | 'toolAccess' | 'toolLedger' | 'browser' | 'onPublishApplet' | 'runActive'
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
/**
 * What a runtime with its own loop is given of Mousse for one turn (PR 2 §2 `TurnBridge`), minted by
 * the harness gateway: the Mousse MCP server and the turn's bearer, the turn token a `per_call`
 * runtime stamps on each call, and the two instruction texts.
 */
export interface TurnBridge {
  /** The Mousse MCP server and this turn's bearer (SPEC §15.2); null: attach nothing. */
  mcp: { url: string; token: string } | null
  /** Stamped on every Mousse call of a `per_call` runtime that tags calls by turn (Claude Code). */
  turnToken: string
  /**
   * Stable text the runtime applies as session instructions (Claude's system prompt append, Codex's
   * developer instructions, an ACP session's first prompt). A runtime that resumes a session made
   * with other text puts the new text in that turn's prompt.
   */
  sessionInstructions: string
  /** Prefixed to every prompt: loaded skills, the mode's instructions, the applet catalogue, usable tools. */
  turnPreamble: string
  /** The binding's tool allow/deny list (`RunPolicy.tools`), when it has one. */
  toolPolicy?: { allow: string[]; deny?: string[] }
  /** The user's own MCP servers: attached by the runtime (`native`) or proxied by Mousse (`proxy`). */
  userMcp: 'native' | 'proxy'
  /** Answers the runtime's permission requests for this turn (the thread's questions). */
  permission?: PermissionPrompter
}

export interface AdapterHost {
  tools: ToolHost
  /** Minted by the gateway; absent when the caller gave the turn no app context. The pi loop, fed in process, ignores it. */
  bridge?: TurnBridge
  /**
   * The run's hard count budget (`budgets: 'hard'`), set by the gateway when the binding's policy
   * has a turn or tool-call limit. A runtime that declares `hard` asks it before every model request
   * and every tool call, and refuses the step it refuses.
   */
  budget?: TurnBudget
  /**
   * A definition run's authority over its tool calls (PR 4 §5a), checked before each call the
   * runtime's own tools would run. Set only by the gateway, from the turn's app context, which
   * takes it from the run's `AppToolTurn`: the Mousse MCP registry checks app and MCP tools against
   * that same object.
   */
  definition?: DefinitionAuthority
  /**
   * A bot turn's authority (PR 6 §4), checked before each call the runtime's own tools would run.
   * Set only by the gateway, from the turn's app context; the Mousse MCP registry checks app and
   * MCP tools against the same object.
   */
  bot?: BotAuthority
  /**
   * What a runtime that runs a definition's loop itself (`HarnessCaps.definitionLimits: 'in_loop'`,
   * the legacy engine) needs beside `definition`: the run's own chat client (its own task queue and
   * browser binding), the limits left for this turn, and the effect tracker. Host-minted for a
   * definition turn only; other runtimes ignore it.
   */
  definitionLoop?: DefinitionLoop
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
    /**
     * The serialised canonical history as the next turn will see it, without appending a reply. A
     * runtime that resumes a native session fingerprints it after a stopped turn, so the next turn
     * can resume.
     */
    nativeHistoryNow?(): string
  }
}

/** `AdapterHost.definitionLoop`. */
export interface DefinitionLoop {
  /** A chat client of the definition run's own, made on first use. */
  client(): Pick<LlmClient, 'chat'>
  /** The definition's limits left for this turn (counts, tokens, cost, time). */
  budget: AgentExecutionBudget
  effects: AgentRuntimeEffectTracker
  /** Only the definition's granted skills and MCP tools are visible to the loop. */
  actor: IntegrationActor
  /** The loop reports the limit that ended the turn, if one did. */
  limitReached(limit: AgentExecutionLimit): void
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
  /** The driver kind this adapter implements; the harness gateway maps each instance to it. */
  readonly driver: ProviderDriverKind
  readonly capabilities: ProviderCapabilities
  /** Facts about `model`; adapters whose context Mousse measures itself (the pi loop) omit it. */
  describe?(model: string): ModelInfo
  /** The runtime is signed in and installed, so its models can be selected by default. */
  configured?(): boolean
  /**
   * Issue #142: a check of the user's own setup before a child is created on this adapter, for
   * shared and isolated children alike. Returns why the child cannot be held to its policy (the
   * runtime's native subagents are enabled, or a read-only child would sit beside MCP servers whose
   * tool calls Mousse cannot deny), or null. It reads the setup and never changes it.
   */
  childPreflight?(context: ChildPreflightContext): Promise<SubagentRefusal | null>
  /**
   * Runs one turn. Settling is the turn's terminal signal for every adapter: the vendor runtimes
   * resolve when their stream closes, so there is no separate "stream closed without a terminal
   * event" state to time out (a hung stream is caught by reconciler rule 2's heartbeat window).
   */
  startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult>
  interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'>
  /**
   * Stop reaches the provider's process for `threadId` and ends everything it still runs for the
   * thread (background agents and shells), even when no turn is live. Only adapters whose process
   * outlives a turn have it. Resolves `stopped` when there was a process to end.
   */
  stopThread?(threadId: string): Promise<'stopped' | 'not_active'>
  steer?(ref: ProviderRef, text: string): Promise<'delivered' | 'not_active'>
  /**
   * SPEC §16.2 native fork: a new provider session branched from `ref` after `atTurnOrdinal`, or
   * null when the runtime cannot branch it (the fork then falls back to a portable handoff). Only
   * called when `featureGates.forkStrategy(caps)` is `native` and `ref` names a session.
   */
  /** `target`: the thread the fork belongs to (a runtime that keeps sessions per thread binds the new one to it). */
  forkSession?(ref: ProviderRef, atTurnOrdinal: number, target?: { threadId: string }): Promise<ProviderRef | null>
}
