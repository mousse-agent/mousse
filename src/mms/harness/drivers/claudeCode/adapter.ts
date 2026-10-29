import {
  type ClaudeSubscriptionChatInput,
  type ClaudeSubscriptionProviderService
} from '../../vendors/claude/ClaudeSubscriptionProviderService'
import type { ClaudeIntegrationSource, ClaudeTurnIntegrations } from '../../vendors/claude/integrations'
import type { ClaudeSubscriptionMetrics } from '../../vendors/claude/metrics'
import type { ProviderRef } from '../../../run/types'
import type {
  AdapterHost,
  ModelInfo,
  ProviderAdapter,
  ProviderCapabilities,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../../adapter'
import { promptStreams, runtimeToolEvent } from '../../../run/transcript/promptRuntime'
import { AppError } from '../../../../shared/errors'
import type { ClaudeLockedTurn } from '../../claude/locked'
import { systemTempDirs } from '../../../bots/grants/compile'
import { retryContextOverflowOnce } from '../../../run/transcript/retryContextOverflow'

/**
 * A locked instance (PR 6 §3): it runs bot turns only, each under the locked profile. `admit` is read
 * as each turn starts: refused under an organisation's policy or without gate-and-ledger evidence for
 * the CLI version in use; otherwise whether a `shell` grant may run here now (the sandbox is
 * available and has evidence for this version on this platform). `onProcess` gets each Claude Code
 * process.
 */
export interface ClaudeLockedProfile {
  admit(): Promise<{ ok: true; shellContained: boolean } | { ok: false; reason: string }>
  /** An organisation policy arrived while the turn runs (`ClaudeLockedTurn.policyAppeared`). */
  policyAppeared?(): boolean
  onProcess?(pid: number, threadId: string): void
}

/** The slice of the provider service a turn drives. */
export type ClaudeSubscriptionClient = Pick<
  ClaudeSubscriptionProviderService,
  'chat' | 'commitConversation' | 'standaloneWorkspace' | 'configured'
> & Partial<Pick<ClaudeSubscriptionProviderService, 'commitInterrupted' | 'commitFailed' | 'stopThread'>>

export const CLAUDE_SUBSCRIPTION_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'interrupt_restart',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  childPolicy: 'enforced'
})

/**
 * Claude Code through the official Agent SDK on the user's subscription (SPEC §13.4). Claude runs
 * its own loop and tools (weak containment) and keeps its own session, resumed while the history
 * fingerprint matches; prior turns otherwise go in as a prompt preamble. The service keeps one live
 * Claude process per thread, so the background agents and shells it started outlive a turn (see
 * `liveSession.ts`). Steers are drained by the service's poller and pushed into the live process as
 * an immediate message; a thread that has no live process (the cap on processes) interrupts and
 * resumes the session instead.
 *
 * The service is read through `service()` on every turn: the profile installs it after the
 * orchestrator (and its adapter registry) is built.
 */
export class ClaudeSubscriptionAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES

  constructor(
    private readonly service: () => ClaudeSubscriptionClient | null,
    /** The user's Mousse MCP servers and skills; read per turn, like the service. */
    private readonly integrations: () => ClaudeIntegrationSource | null = () => null,
    /** Set for a locked instance, which runs bot turns only. */
    private readonly locked?: ClaudeLockedProfile
  ) {}

  /**
   * A bot runs on Claude Code only under the locked profile, and a locked instance runs nothing but
   * bots: either mismatch is refused before anything starts.
   */
  private async lockedTurn(input: TurnInput, host: AdapterHost, service: ClaudeSubscriptionClient): Promise<ClaudeLockedTurn | undefined> {
    const refuse = (message: string) => new AppError({ code: 'policy_unenforceable', message, errorInfo: { category: 'unavailable', retryable: false } })
    if (!this.locked) {
      if (host.bot) throw refuse('A bot runs on Claude Code only in a locked runtime. Add a bot runtime for it.')
      return undefined
    }
    const bot = host.bot
    if (!bot) throw refuse('This Claude Code runtime is locked for bots, so it runs only bot turns.')
    const admitted = await this.locked.admit()
    if (!admitted.ok) throw refuse(admitted.reason)
    const shellContained = admitted.shellContained
    const onProcess = this.locked.onProcess
    const policyAppeared = this.locked.policyAppeared?.bind(this.locked)
    return {
      authority: bot,
      ...(host.tools.toolLedger ? { ledger: host.tools.toolLedger } : {}),
      // Never a root and never the thread's project folder: the activation's scratch folder, or, for
      // a bot with no folder at all, an empty folder of Mousse's own.
      cwd: bot.workspace?.scratch ?? service.standaloneWorkspace(input.threadId),
      shellContained,
      temps: systemTempDirs(),
      systemPrompt: host.bridge?.sessionInstructions ?? '',
      ...(onProcess ? { onProcess: (pid: number) => onProcess(pid, input.threadId) } : {}),
      ...(policyAppeared ? { policyAppeared } : {})
    }
  }

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
    const locked = await this.lockedTurn(input, host, service)
    const cwd = locked ? locked.cwd : input.cwd ?? service.standaloneWorkspace(input.threadId)
    let history = host.context.prepareNativeContext(input.llmProvider, input.model)?.nativeHistory ?? input.nativeHistory
    const streams = promptStreams(sink)
    // Resolved once per turn so a retry after context overflow runs with the same servers and skills.
    let integrations: ClaudeTurnIntegrations | undefined
    try {
      // A locked turn takes none of the user's MCP servers or skills.
      integrations = locked ? undefined : await this.integrations()?.resolve(input.cwd ?? undefined)
    } catch (error) {
      // The user's integrations are optional; a broken registry cannot block the turn.
      console.warn(`[claude-subscription] integrations unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const warning of integrations?.warnings ?? []) console.warn(`[claude-subscription] ${warning}`)
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
      permissionMode: input.permissionMode,
      child: input.child,
      continuation: input.continuation,
      continuationId: input.continuationId,
      threadId: input.threadId,
      instanceId: input.instanceId,
      cwd,
      model: input.model,
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      turnPreamble: host.bridge?.turnPreamble || undefined,
      history,
      // SPEC §15.2: the Mousse MCP server over HTTP with this turn's bearer; Mousse's hook stamps each
      // Mousse call with the turn's token (`per_call` turn binding).
      mcp: host.bridge?.mcp ?? null,
      mcpTurnToken: host.bridge?.mcp ? host.bridge.turnToken : undefined,
      // Claude Code loads the project's instruction files itself, as in a terminal (CLAUDE.md, and
      // AGENTS.md as its own settings decide), so Mousse appends only its own session instructions.
      // A locked turn's instructions replace Claude Code's own system prompt instead (`locked`).
      systemPromptAppend: locked ? undefined : host.bridge?.sessionInstructions || undefined,
      ...(locked ? { locked } : {}),
      ...(host.bridge?.permission?.approvals === 'never' ? { approvals: 'never' as const } : {}),
      integrations,
      drainSteer: () => ctl.drainSteer(),
      drainSteerEntry: ctl.drainSteerEntry ? () => ctl.drainSteerEntry!() : undefined,
      returnSteer: (text, token) => ctl.returnSteer?.(text, token),
      steerTaken: (token) => ctl.steerTaken?.(token),
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
        // A thought that came before this call keeps its own row, above it; the next one starts below.
        if (event.phase === 'start' && !event.parentCallId) streams.thinking.break()
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
    let text: string
    try {
      text = await retryContextOverflowOnce(
        () => service.chat(chatInput()),
        () => {
          const recovered = host.context.recoverOverflow()
          if (!recovered) return false
          history = recovered.nativeHistory
          return true
        },
        () => !progressed && !toolStarted && !input.signal.aborted
      )
    } catch (error) {
      // A stopped turn keeps its native session: the next turn resumes it (the stopped request is in it).
      if (host.context.nativeHistoryNow) {
        const history = host.context.nativeHistoryNow()
        if (input.signal.aborted) service.commitInterrupted?.(input.threadId, history)
        // A turn that failed leaves the same boundary: the next request continues the live process from it.
        else service.commitFailed?.(input.threadId, history)
      }
      throw error
    }
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
   * An aborted turn (`TurnInput.signal`) interrupts Claude and leaves its process open, which is what
   * question preemption and a run timeout want. Stop is `stopThread`.
   */
  async interrupt(_ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  /** Stop: interrupts the turn and closes the thread's Claude process, which ends its background agents and shells. */
  async stopThread(threadId: string): Promise<'stopped' | 'not_active'> {
    return this.service()?.stopThread?.(threadId) ?? 'not_active'
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
