import type { AcpChatInput } from '../../../harness/acp/session'
import { INTERRUPTED_SUMMARY } from '../../../../shared/agentActivity'
import type { ProviderDriverKind } from '../../../../shared/providerInstances'
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
import { promptStreams, runtimeToolEvent } from '../shared/promptRuntime'

type AcpToolEvent = Parameters<NonNullable<AcpChatInput['onTool']>>[0]

/**
 * How the agent's tool call ended, as the timeline's closure contract wants it: a call the turn
 * ended before reporting (`unfinished`) is interrupted, never done, and a failed call is failed.
 */
export function withClosure(event: AcpToolEvent, aborted: boolean): AcpToolEvent {
  if (event.phase !== 'complete') return event
  if (event.status === 'unfinished') {
    const interruptedBy = aborted ? 'stop' : 'no_result'
    return { ...event, activity: { ...event.activity, status: 'interrupted', interruptedBy, summary: INTERRUPTED_SUMMARY[interruptedBy] } }
  }
  if (event.status === 'failed') return { ...event, activity: { ...event.activity, status: 'failed' } }
  return event
}

/** The slice of an ACP agent's runtime a turn drives. */
export interface AcpTurnClient {
  chat(input: AcpChatInput): Promise<string>
  commitConversation(threadId: string, history: string): void
  configured(): boolean
  /** The native cancel of the session's running prompt; without it, stop works through the turn's signal. */
  interrupt?(sessionId: string | undefined): Promise<'interrupted' | 'not_active'>
}

export interface AcpAdapterOptions {
  driver: ProviderDriverKind
  /** The agent's name in errors. */
  label: string
  capabilities: ProviderCapabilities
  /** The agent offers a plan mode (from its runtime facts); otherwise a plan turn is refused. */
  planMode?: () => boolean
}

/**
 * An agent over the Agent Client Protocol (SPEC §13.4). The agent runs its own loop and tools
 * inside the project workspace (weak containment), reports text and tool calls only (sparse
 * events: no thinking, no usage), and keeps its own ACP session, resumed while the history
 * fingerprint matches. Steers cancel the active prompt and are sent as the next one.
 *
 * The runtime is read through `client()` on every turn: a profile installs its services after the
 * orchestrator (and its adapter registry) is built.
 */
export class AcpAdapter implements ProviderAdapter {
  readonly driver: ProviderDriverKind
  readonly capabilities: ProviderCapabilities

  constructor(private readonly client: () => AcpTurnClient | null, private readonly options: AcpAdapterOptions) {
    this.driver = options.driver
    this.capabilities = options.capabilities
  }

  /** The agent publishes no context window or usage. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'none' }
  }

  configured(): boolean {
    return this.client()?.configured() ?? false
  }

  async startTurn(
    input: TurnInput,
    sink: TurnSink,
    ctl: TurnControl,
    host: AdapterHost
  ): Promise<TurnResult> {
    const plan = input.mode === 'plan'
    if (plan && !this.options.planMode?.()) throw new Error(`Use ${this.options.label}’s /plan command in a chat turn`)
    const client = this.client()
    if (!client || !input.cwd) throw new Error(`${input.llmProvider || this.options.label} requires a project workspace`)
    const startedAt = Date.now()
    // The ACP session id stays inside the runtime's saved sessions; the ref names the runtime.
    const providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const streams = promptStreams(sink)
    const progress = (): void => {
      sink.progress()
      ctl.heartbeat()
    }
    // The drained-turn proof for the bearer: ACP updates do not name the MCP server, so every tool call
    // the agent started must reach a completed update (none failed, none left open).
    const toolCalls = new Map<string, 'running' | 'completed' | 'failed'>()
    const text = await client.chat({
      threadId: input.threadId,
      instanceId: input.instanceId,
      cwd: input.cwd,
      model: input.model,
      ...(plan ? { mode: 'plan' as const } : {}),
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      turnPreamble: host.bridge?.turnPreamble || undefined,
      history: input.nativeHistory,
      // SPEC §15.2: the Mousse MCP server in the ACP session (HTTP, or the stdio bridge when the
      // agent does not advertise HTTP) and the session instructions in the session's first prompt.
      mcp: host.bridge?.mcp ?? null,
      orchestrationInstructions: host.bridge?.sessionInstructions || undefined,
      ...(host.bridge?.permission ? { prompter: host.bridge.permission } : {}),
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
        if (event.phase === 'start') toolCalls.set(event.callId, 'running')
        else toolCalls.set(event.callId, event.status === 'completed' ? 'completed' : 'failed')
        sink.tool(runtimeToolEvent(withClosure(event, input.signal.aborted)))
      },
      // The ref names the agent's session once there is one, so stop and terminate find it.
      ...(client.interrupt ? { onSession: (sessionId: string) => sink.providerRef({ ...providerRef, sessionId }) } : {})
    })
    client.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(text))
    streams.text.complete(text)
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text,
      aborted: input.signal.aborted,
      modelName: input.model,
      totalResponseTimeMs: Date.now() - startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextSignature: contextKey,
      contextModelKey: contextKey,
      nativeMessages: [],
      providerRef,
      drain: { toolCalls: toolCalls.size, toolsSettled: [...toolCalls.values()].every((status) => status === 'completed') }
    }
  }

  /**
   * A runtime with a native cancel stops the running prompt (the gateway kills the process when it
   * misses its deadline); otherwise stop reaches the agent through `TurnInput.signal`: the runtime
   * rejects pending permission prompts and closes the ACP process when the orchestrator aborts the turn.
   */
  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const client = this.client()
    return client?.interrupt ? client.interrupt(ref.sessionId) : 'not_active'
  }

  /**
   * No native fork yet. Null makes a fork use the portable `full_summary` handoff (SPEC §16.2); a
   * native fork lands here once the agent advertises `session/fork`.
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
