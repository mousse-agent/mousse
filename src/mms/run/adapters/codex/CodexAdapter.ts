import {
  CODEX_PROVIDER_ID,
  type CodexChatInput,
  type CodexChatResult,
  type CodexProviderService
} from '../../../providers/codex/CodexProviderService'
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
export type CodexClient = Pick<
  CodexProviderService,
  'chat' | 'commitConversation' | 'standaloneWorkspace' | 'configured' | 'interrupt' | 'steer'
>

/**
 * `steer: 'native'`: `turn/steer` adds the text to the running turn. Checked live against
 * codex-cli 0.162: a steer sent while a shell command ran returned the running turn's id, the
 * command finished normally (exit 0), and the same turn went on to answer with the steer applied.
 * Nothing is cancelled, so reconciler rule 4 may deliver delegation notices into a live run.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true
})

/**
 * Codex through `codex app-server` on the user's ChatGPT sign-in (SPEC §13.4). Codex runs its
 * own loop and tools inside the workspace (weak containment) and keeps its own thread, resumed
 * while the history fingerprint matches; prior turns otherwise go in as a prompt preamble. The
 * provider ref names the Codex thread (`sessionId`) and turn (`nativeTurnId`), so Stop and steer
 * reach the live turn through `interrupt` / `steer` as well as through the turn's signal.
 *
 * The service is read through `service()` on every turn: the profile installs it after the
 * orchestrator (and its adapter registry) is built.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly id = CODEX_PROVIDER_ID
  readonly capabilities = CODEX_CAPABILITIES

  constructor(private readonly service: () => CodexClient | null) {}

  /** Codex reports token usage and the model's context window. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'reported' }
  }

  configured(): boolean {
    return this.service()?.configured() ?? false
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    const service = this.service()
    if (!service) throw new Error(`${input.llmProvider} is not available in this profile`)
    const startedAt = Date.now()
    let providerRef: ProviderRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const cwd = input.cwd ?? service.standaloneWorkspace(input.threadId)
    let history = host.context.prepareNativeContext(input.llmProvider, input.model)?.nativeHistory ?? input.nativeHistory
    const streams = promptStreams(sink)
    // Output, an accepted steer or a tool makes a replay after context overflow unsafe.
    let progressed = false
    const progress = (): void => {
      progressed = true
      sink.progress()
      ctl.heartbeat()
    }
    const chatInput = (): CodexChatInput => ({
      mode: input.mode === 'plan' ? 'plan' : 'default',
      threadId: input.threadId,
      cwd,
      model: input.model,
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      appletInstructions: withAppletGuidance(input.appletInstructions),
      history,
      // SPEC §15.2/§15.3: the Mousse MCP server in the thread's config, the shared guidance as
      // developer instructions.
      mcp: host.mcp ?? null,
      developerInstructions: host.mcp ? mousseOrchestrationInstructions() : undefined,
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
        sink.tool(runtimeToolEvent(event))
      },
      onLineEdits: (lines) => sink.lineEdits(lines),
      onRetry: (attempt) => {
        ctl.heartbeat()
        sink.retry(attempt)
      },
      onSession: ({ codexThreadId, turnId }) => {
        ctl.heartbeat()
        providerRef = { ...providerRef, sessionId: codexThreadId, ...(turnId ? { nativeTurnId: turnId } : {}) }
        sink.providerRef(providerRef)
      }
    })
    const result: CodexChatResult = await retryContextOverflowOnce(
      () => service.chat(chatInput()),
      () => {
        const recovered = host.context.recoverOverflow()
        if (!recovered) return false
        history = recovered.nativeHistory
        return true
      },
      () => !progressed && !input.signal.aborted
    )
    const totalResponseTimeMs = Date.now() - startedAt
    const usage = {
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      cacheRead: result.usage?.cacheRead ?? 0,
      cacheWrite: result.usage?.cacheWrite ?? 0
    }
    const totalTokensUsed = result.usage?.totalTokens
    const tokensPerSecond =
      result.usage && totalResponseTimeMs > 0 ? Math.round((usage.output / totalResponseTimeMs) * 1000 * 10) / 10 : undefined
    const realModelName = result.model !== input.model ? result.model : undefined
    if (result.usage) {
      sink.providerMetrics({
        realModelName,
        totalResponseTimeMs,
        totalTokensUsed,
        tokensPerSecond,
        usage: {
          ...usage,
          ...(result.usage.reasoning !== undefined ? { reasoning: result.usage.reasoning } : {}),
          totalTokens: result.usage.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        context: result.usage.context ? { ...result.usage.context, modelName: result.model } : undefined
      })
      sink.usage(usage)
    } else sink.providerMetrics({ realModelName, totalResponseTimeMs })
    streams.thinking.complete()
    service.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(result.text))
    streams.text.complete(result.text)
    const contextKey = `${this.id}:${input.model}`
    return {
      text: result.text,
      aborted: input.signal.aborted,
      modelName: realModelName ?? input.model,
      totalResponseTimeMs,
      totalTokensUsed,
      tokensPerSecond,
      usage,
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef: { ...providerRef, sessionId: result.codexThreadId, nativeTurnId: result.turnId },
      threadDisposition: result.threadDisposition
    }
  }

  /** Interrupts the live Codex turn of `ref` (`turn/interrupt`); Stop also aborts the turn's signal. */
  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return (await this.service()?.interrupt(ref.sessionId)) ?? 'not_active'
  }

  /** Adds `text` to the live Codex turn of `ref` without cancelling it (`turn/steer`). */
  async steer(ref: ProviderRef, text: string): Promise<'delivered' | 'not_active'> {
    return (await this.service()?.steer(ref.sessionId, text)) ?? 'not_active'
  }

  /**
   * No native fork yet: `thread/fork` exists but Mousse does not map turn ordinals to Codex turns.
   * Null makes a fork use the portable `full_summary` handoff (SPEC §16.2).
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
