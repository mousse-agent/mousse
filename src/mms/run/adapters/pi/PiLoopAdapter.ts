import type { Message } from '@earendil-works/pi-ai'
import type { LlmChatResult, LlmClient } from '../../../orchestrator/LlmClient'
import type { ProviderRef } from '../../types'
import type {
  AdapterHost,
  ProviderAdapter,
  ProviderCapabilities,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../ProviderAdapter'
import { retryContextOverflowOnce } from '../shared/retryContextOverflow'

/** The slice of `LlmClient` the pi loop drives. */
export type PiChatClient = Pick<LlmClient, 'chat'>

export const PI_LOOP_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'strong',
  historyInjection: 'native',
  mcp: false,
  childPolicy: 'enforced'
})

/**
 * The in-process pi-ai tool loop (`LlmClient.chat`) behind the adapter interface (SPEC §13.4).
 * Mousse runs the tools, so containment is strong and steer is native (drained after each tool
 * result). The client is read through `client()` on every turn: profile wiring and tests replace
 * the orchestrator's `LlmClient` after the adapter is built.
 */
export class PiLoopAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_LOOP_CAPABILITIES

  constructor(private readonly client: () => PiChatClient) {}

  async startTurn(
    input: TurnInput,
    sink: TurnSink,
    ctl: TurnControl,
    host: AdapterHost
  ): Promise<TurnResult> {
    const providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    // Output or tool side effects make a replay after context overflow unsafe.
    let progressed = false
    let messages: Message[] = input.messages
    let contextSummary = input.contextSummary
    const run = (): Promise<LlmChatResult> =>
      this.client().chat(
        messages,
        (event) => {
          if (event.kind !== 'skill_loaded') progressed = true
          sink.tool(event)
          ctl.heartbeat()
        },
        {
          mode: input.mode,
          appletInstructions: input.appletInstructions,
          onPublishApplet: host.tools.onPublishApplet,
          llmProvider: input.modelPinned ? input.llmProvider : undefined,
          model: input.modelPinned ? input.model : undefined,
          projectPath: input.cwd ?? undefined,
          threadId: input.threadId,
          runId: input.runId,
          browser: host.tools.browser,
          delegation: host.tools.delegation,
          toolAccess: host.tools.toolAccess,
          signal: input.signal,
          onRetry: (attempt) => {
            sink.retry(attempt)
            ctl.heartbeat()
          },
          onProviderProgress: () => {
            progressed = true
            sink.progress()
            ctl.heartbeat()
          },
          drainSteer: () => ctl.drainSteer(),
          contextSummary,
          onNativeMessages: (nativeMessages, checkpoint) => {
            sink.nativeMessages(nativeMessages, checkpoint)
            ctl.heartbeat()
          },
          toolLedger: host.tools.toolLedger,
          runActive: host.tools.runActive,
          onCompaction: (phase) => {
            sink.compaction(phase)
            ctl.heartbeat()
          },
          toolLoopSafety: host.context.toolLoopSafety
        },
        (event) => {
          sink.thinking(event)
          ctl.heartbeat()
        },
        (event) => {
          sink.text(event)
          ctl.heartbeat()
        }
      )
    const result = await retryContextOverflowOnce(
      run,
      () => {
        const recovered = host.context.recoverOverflow()
        if (!recovered) return false
        messages = recovered.messages
        contextSummary = recovered.contextSummary
        return true
      },
      () => !progressed
    )
    return {
      text: result.text,
      aborted: Boolean(result.aborted),
      modelName: result.modelName,
      totalResponseTimeMs: result.totalResponseTimeMs,
      totalTokensUsed: result.totalTokensUsed,
      tokensPerSecond: result.tokensPerSecond,
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite
      },
      contextSignature: result.contextInputs.signature,
      contextModelKey: result.contextInputs.modelKey,
      nativeMessages: result.nativeMessages,
      providerRef
    }
  }

  /**
   * The loop runs in this process and stops through `TurnInput.signal`, which the orchestrator
   * aborts on Stop; there is no provider session to interrupt separately.
   */
  async interrupt(_ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  /**
   * No native fork yet: the pi loop keeps no provider session to branch (Mousse owns its transcript).
   * Null makes a fork use the portable `full_summary` handoff (SPEC §16.2); a native fork lands
   * here once the runtime exposes session branching.
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
