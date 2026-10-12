import {
  ANTIGRAVITY_PROVIDER_ID,
  type AntigravityProviderService
} from '../../../providers/antigravity/AntigravityProviderService'
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

/** The slice of the provider service a turn drives. */
export type AntigravityClient = Pick<AntigravityProviderService, 'chat' | 'commitConversation' | 'configured'>

export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  nativeSubagents: 'none',
  events: 'sparse',
  containment: 'weak',
  historyInjection: 'prompt',
  terminalQuality: 'best_effort',
  mcp: true
})

/**
 * Google Antigravity over the Agent Client Protocol (SPEC §13.4). The agent runs its own loop and
 * tools inside the project workspace (weak containment), reports text and tool calls only (sparse
 * events: no thinking, no usage), and keeps its own ACP session, resumed while the history
 * fingerprint matches. Steers cancel the active prompt and are sent as the next one.
 *
 * The service is read through `service()` on every turn: the profile installs it after the
 * orchestrator (and its adapter registry) is built.
 */
export class AntigravityAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY_PROVIDER_ID
  readonly capabilities = ANTIGRAVITY_CAPABILITIES

  constructor(private readonly service: () => AntigravityClient | null) {}

  /** The agent publishes no context window or usage. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'none' }
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
    if (input.mode === 'plan') throw new Error('Use Antigravity’s /plan command in a chat turn')
    const service = this.service()
    if (!service || !input.cwd) throw new Error(`${input.llmProvider} requires a project workspace`)
    const startedAt = Date.now()
    // The ACP session id stays inside the service's saved sessions; the ref names the runtime.
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const streams = promptStreams(sink)
    const progress = (): void => {
      sink.progress()
      ctl.heartbeat()
    }
    const text = await service.chat({
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      appletInstructions: withAppletGuidance(input.appletInstructions),
      history: input.nativeHistory,
      // SPEC §15.2: the Mousse MCP server in the ACP session (HTTP, or the stdio bridge when the
      // agent does not advertise HTTP) and the shared guidance in the session's first prompt.
      mcp: host.mcp ?? null,
      orchestrationInstructions: host.mcp ? mousseOrchestrationInstructions() : undefined,
      drainSteer: () => ctl.drainSteer(),
      onSteer: (steer) => {
        progress()
        sink.steerAccepted(steer)
      },
      onText: (content) => {
        progress()
        streams.text.update(content)
      },
      onTool: (event) => {
        progress()
        sink.tool(runtimeToolEvent(event))
      }
    })
    service.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(text))
    streams.text.complete(text)
    const contextKey = `${this.id}:${input.model}`
    return {
      text,
      aborted: input.signal.aborted,
      modelName: input.model,
      totalResponseTimeMs: Date.now() - startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef
    }
  }

  /**
   * Stop reaches the agent through `TurnInput.signal`: the service rejects pending permission
   * prompts and closes the ACP process when the orchestrator aborts the turn.
   */
  async interrupt(_ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  /**
   * No native fork yet: ACP has no session fork.
   * Null makes a fork use the portable `full_summary` handoff (SPEC §16.2); a native fork lands
   * here once the runtime exposes session branching.
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
