import {
  type ClaudeSubscriptionChatInput,
  type ClaudeSubscriptionProviderService
} from '../../../providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { ClaudeSubscriptionMetrics } from '../../../providers/claudeSubscription/metrics'
import { projectAgentInstructionsSection } from '../../../orchestrator/projectInstructions'
import { mousseOrchestrationInstructions } from '../../mcp/instructions'
import type { ProviderRef } from '../../types'
import type {
  AdapterHost,
  ModelInfo,
  ProviderAdapter,
  ProviderCapabilities,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../ProviderAdapter'
import { promptStreams, runtimeToolEvent, withAppletGuidance } from '../shared/promptRuntime'
import { retryContextOverflowOnce } from '../shared/retryContextOverflow'

/** The slice of the provider service a turn drives. */
export type ClaudeSubscriptionClient = Pick<
  ClaudeSubscriptionProviderService,
  'chat' | 'commitConversation' | 'standaloneWorkspace' | 'configured'
>

export const CLAUDE_SUBSCRIPTION_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'interrupt_restart',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true
})

/**
 * Claude Code through the official Agent SDK on the user's subscription (SPEC §13.4). Claude runs
 * its own loop and tools (weak containment) and keeps its own session, resumed while the history
 * fingerprint matches; prior turns otherwise go in as a prompt preamble. Steers are drained by the
 * service's poller and delivered by interrupting and resuming the session.
 *
 * The service is read through `service()` on every turn: the profile installs it after the
 * orchestrator (and its adapter registry) is built.
 */
export class ClaudeSubscriptionAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES

  constructor(private readonly service: () => ClaudeSubscriptionClient | null) {}

  /** Claude reports its context window and prompt usage after each turn. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'reported' }
  }

  configured(): boolean {
    return this.service()?.configured() ?? false
  }

  async startTurn(
    input: TurnInput,
    sink: TurnSink,
    ctl: TurnControl,
    host: AdapterHost
  ): Promise<TurnResult> {
    const service = this.service()
    if (!service) throw new Error(`${input.llmProvider} requires a project workspace`)
    const startedAt = Date.now()
    // The SDK session id stays inside the service's saved sessions; the ref names the runtime.
    const providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const cwd = input.cwd ?? service.standaloneWorkspace(input.threadId)
    let history = host.context.prepareNativeContext(input.llmProvider, input.model)?.nativeHistory ?? input.nativeHistory
    const streams = promptStreams(sink)
    let metrics: ClaudeSubscriptionMetrics | undefined
    // Output, an accepted steer or a tool makes a replay after context overflow unsafe.
    let progressed = false
    let toolStarted = false
    const progress = (): void => {
      progressed = true
      sink.progress()
      ctl.heartbeat()
    }
    const chatInput = (): ClaudeSubscriptionChatInput => ({
      mode: input.mode === 'plan' ? 'plan' : 'default',
      threadId: input.threadId,
      instanceId: input.instanceId,
      cwd,
      model: input.model,
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      appletInstructions: withAppletGuidance(input.appletInstructions),
      history,
      // SPEC §15.2: the Mousse MCP server over HTTP with this run's bearer token, and the shared
      // orchestration guidance appended to the system prompt.
      mcp: host.mcp ?? null,
      // The SDK launches with `settingSources: []`, so it loads no instruction files itself: the
      // project's AGENTS.md is read here on every turn. A projectless thread has none.
      systemPromptAppend: [
        host.mcp ? mousseOrchestrationInstructions() : undefined,
        projectAgentInstructionsSection(input.cwd ?? undefined)
      ].filter(Boolean).join('\n\n') || undefined,
      drainSteer: () => ctl.drainSteer(),
      onSteer: (text) => {
        progress()
        sink.steerAccepted(text)
      },
      onText: (text) => {
        progress()
        streams.text.update(text)
      },
      onThinking: (text) => {
        progress()
        streams.thinking.update(text)
      },
      onTool: (event) => {
        progress()
        toolStarted = true
        sink.tool(runtimeToolEvent(event))
      },
      onMetrics: (report) => {
        metrics = report
        sink.providerMetrics({
          realModelName: report.realModelName,
          totalResponseTimeMs: report.totalResponseTimeMs,
          totalTokensUsed: report.totalTokensUsed,
          tokensPerSecond: report.tokensPerSecond,
          usage: report.usage ?? undefined,
          context: report.context
        })
        if (report.usage)
          sink.usage({
            input: report.usage.input,
            output: report.usage.output,
            cacheRead: report.usage.cacheRead,
            cacheWrite: report.usage.cacheWrite
          })
      },
      onLineEdits: (lines) => sink.lineEdits(lines)
    })
    const text = await retryContextOverflowOnce(
      () => service.chat(chatInput()),
      () => {
        const recovered = host.context.recoverOverflow()
        if (!recovered) return false
        history = recovered.nativeHistory
        return true
      },
      () => !progressed && !toolStarted && !input.signal.aborted
    )
    streams.thinking.complete()
    service.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(text))
    streams.text.complete(text)
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text,
      aborted: input.signal.aborted,
      modelName: metrics?.realModelName ?? input.model,
      totalResponseTimeMs: metrics?.totalResponseTimeMs ?? Date.now() - startedAt,
      totalTokensUsed: metrics?.totalTokensUsed,
      tokensPerSecond: metrics?.tokensPerSecond,
      usage: {
        input: metrics?.usage?.input ?? 0,
        output: metrics?.usage?.output ?? 0,
        cacheRead: metrics?.usage?.cacheRead ?? 0,
        cacheWrite: metrics?.usage?.cacheWrite ?? 0
      },
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef
    }
  }

  /**
   * Stop reaches Claude through `TurnInput.signal`: the service aborts its SDK query and closes
   * the session when the orchestrator aborts the turn. There is no separate session to interrupt.
   */
  async interrupt(_ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  /**
   * No native fork yet: the subscription service keeps its SDK session private and offers no branch call.
   * Null makes a fork use the portable `full_summary` handoff (SPEC §16.2); a native fork lands
   * here once the runtime exposes session branching.
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
