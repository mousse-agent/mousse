import type { CursorChatInput, CursorChatResult } from '../../../harness/cursor/session'
import { mousseOrchestrationInstructions } from '../../mcp/instructions'
import type { ProviderRef } from '../../types'
import type { AdapterHost, ModelInfo, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../ProviderAdapter'
import { promptStreams, runtimeToolEvent, withAppletGuidance } from '../shared/promptRuntime'

/**
 * Cursor runs its own agent loop and tools in the project workspace (weak containment) through
 * the Cursor SDK in a host process. It streams text, thinking and tool calls (rich events),
 * approves its tools itself, and keeps its own agent per thread, resumed while the history
 * fingerprint matches. Steers cancel the run and are sent as the next one.
 */
export const CURSOR_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: 'interrupt_restart',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  // Cursor cannot hold a delegated child to read-only.
  childPolicy: 'isolated_only'
})

/** The slice of the Cursor runtime a turn drives. */
export interface CursorTurnClient {
  chat(input: CursorChatInput): Promise<CursorChatResult>
  commitConversation(threadId: string, history: string): void
  configured(): boolean
  interrupt(agentId: string | undefined): Promise<'interrupted' | 'not_active'>
}

export class CursorAdapter implements ProviderAdapter {
  readonly driver = 'cursor' as const
  readonly capabilities = CURSOR_CAPABILITIES

  constructor(private readonly client: () => CursorTurnClient | null, private readonly label = 'Cursor') {}

  /** Cursor reports usage per turn but publishes no context window. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'none' }
  }

  configured(): boolean {
    return this.client()?.configured() ?? false
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    const client = this.client()
    if (!client || !input.cwd) throw new Error(`${this.label} requires a project workspace`)
    const startedAt = Date.now()
    const providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const streams = promptStreams(sink)
    const progress = (): void => {
      sink.progress()
      ctl.heartbeat()
    }
    const result = await client.chat({
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      ...(input.mode === 'plan' ? { mode: 'plan' as const } : {}),
      prompt: input.prompt,
      ...(input.images ? { images: input.images } : {}),
      signal: input.signal,
      ...(withAppletGuidance(input.appletInstructions) ? { appletInstructions: withAppletGuidance(input.appletInstructions) } : {}),
      ...(input.nativeHistory !== undefined ? { history: input.nativeHistory } : {}),
      // SPEC §15.2: the Mousse MCP server over HTTP, and the shared guidance in the first prompt.
      mcp: host.mcp ?? null,
      ...(host.mcp ? { orchestrationInstructions: mousseOrchestrationInstructions() } : {}),
      drainSteer: () => ctl.drainSteer(),
      onSteer: (steer) => {
        progress()
        sink.steerAccepted(steer)
      },
      onText: (content) => {
        progress()
        streams.text.update(content)
      },
      onThinking: (content) => {
        progress()
        streams.thinking.update(content)
      },
      onTool: (event) => {
        progress()
        sink.tool(runtimeToolEvent(event))
      },
      // The ref names the agent once there is one, so stop and terminate find its run.
      onSession: (agentId) => sink.providerRef({ ...providerRef, sessionId: agentId })
    })
    streams.thinking.complete()
    const usage = result.usage
      ? { input: result.usage.inputTokens, output: result.usage.outputTokens, cacheRead: result.usage.cacheReadTokens, cacheWrite: result.usage.cacheWriteTokens }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    if (result.usage) sink.usage(usage)
    // The reply joins the transcript once, stopped or not. A turn whose host ended commits nothing:
    // its agent is gone, so the next turn hands the history over.
    client.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(result.text))
    const aborted = result.interrupted || input.signal.aborted
    // A stopped reply stays open: the orchestrator keeps it as the incomplete reply.
    if (!aborted) streams.text.complete(result.text)
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text: result.text,
      // A stopped turn, or one whose host ended, ends as interrupted and is never replayed.
      aborted,
      modelName: input.model,
      totalResponseTimeMs: Date.now() - startedAt,
      ...(result.usage ? { totalTokensUsed: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } : {}),
      usage,
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef
    }
  }

  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const client = this.client()
    return client ? client.interrupt(ref.sessionId) : 'not_active'
  }

  /** No native fork: a fork uses the portable handoff (SPEC §16.2). */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
