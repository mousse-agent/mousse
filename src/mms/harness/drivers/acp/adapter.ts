import type { AcpChatInput, AcpTurnUsage } from '../../acp/session'
import { BACKGROUND_SUMMARY, INTERRUPTED_SUMMARY } from '../../../../shared/agentActivity'
import { mousseServerToolOf } from '../../../run/mcp/attachment'
import type { ProviderDriverKind } from '../../../../shared/providerInstances'
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
import { createRuntimeToolMapper, promptStreams } from '../../../run/transcript/promptRuntime'

type AcpToolEvent = Parameters<NonNullable<AcpChatInput['onTool']>>[0]

/**
 * How the agent's tool call ended, as the timeline's closure contract wants it: a call the turn
 * ended before reporting (`unfinished`) is interrupted, never done; a backgrounded call
 * (`background`) closes as done with `BACKGROUND_SUMMARY` so it stays live while background work
 * continues; and a failed call is failed.
 */
export function withClosure(event: AcpToolEvent, aborted: boolean): AcpToolEvent {
  if (event.phase !== 'complete') return event
  if (event.status === 'unfinished') {
    const interruptedBy = aborted ? 'stop' : 'no_result'
    return { ...event, activity: { ...event.activity, status: 'interrupted', interruptedBy, summary: INTERRUPTED_SUMMARY[interruptedBy] } }
  }
  if (event.status === 'background') {
    return { ...event, activity: { ...event.activity, status: 'done', summary: BACKGROUND_SUMMARY } }
  }
  if (event.status === 'failed') return { ...event, activity: { ...event.activity, status: 'failed' } }
  return event
}

/** The slice of an ACP agent's runtime a turn drives. */
export interface AcpTurnClient {
  chat(input: AcpChatInput): Promise<string>
  commitConversation(threadId: string, history: string): void
  /** A turn that did not finish: the history it left, so the next turn may resume the agent's session (`AcpSessions.commitInterrupted`). */
  commitInterrupted?(threadId: string, history: string): void
  /** Per-thread private working directory when a chat has no project workspace. */
  standaloneWorkspace?(threadId: string): string
  configured(): boolean
  /** The native cancel of the session's running prompt; without it, stop works through the turn's signal. */
  interrupt?(sessionId: string | undefined): Promise<'interrupted' | 'not_active'>
  /** Stops background work or an active process for `threadId` (`ProviderAdapter.stopThread`). */
  stopThread?(threadId: string): 'stopped' | 'not_active' | Promise<'stopped' | 'not_active'>
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
 * inside the project workspace (weak containment), reports text, thoughts, tool calls, and
 * turn usage when the agent includes `PromptResponse.usage`, and keeps its own ACP session, resumed while the history
 * fingerprint matches. Steers cancel the active prompt and are sent as the next one, or join it as a second prompt on an
 * agent that takes them so (`AcpQuirks.nativeSteerFrom`).
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

  standaloneWorkspace(threadId: string): string | undefined {
    return this.client()?.standaloneWorkspace?.(threadId)
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
    const cwd = input.cwd ?? client?.standaloneWorkspace?.(input.threadId)
    if (!client || !cwd) throw new Error(`${input.llmProvider || this.options.label} requires a project workspace`)
    const startedAt = Date.now()
    // The output speed uses the monotonic clock: a turn shorter than a millisecond still has one.
    const startedTick = performance.now()
    // The ACP session id stays inside the runtime's saved sessions; the ref names the runtime.
    const providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const streams = promptStreams(sink)
    // One per turn: it follows each call by its id, so a computer use call's row stays held on every event.
    const toolRows = createRuntimeToolMapper({ aborted: () => input.signal.aborted })
    const progress = (): void => {
      sink.progress()
      ctl.heartbeat()
    }
    // The drained-turn proof for the bearer: ACP updates do not name the MCP server, so every tool call
    // the agent started must reach a completed update (none failed, none left open).
    const toolCalls = new Map<string, 'running' | 'completed' | 'failed'>()
    let reportedUsage: AcpTurnUsage | undefined
    let text: string
    try {
      text = await client.chat({
        threadId: input.threadId,
        instanceId: input.instanceId,
        cwd,
        model: input.model,
        ...(plan ? { mode: 'plan' as const } : {}),
        permissionMode: input.permissionMode,
        ...(input.continuation ? { continuation: true } : {}),
        ...(input.continuationId ? { continuationId: input.continuationId } : {}),
        prompt: input.prompt,
        images: input.images,
        signal: input.signal,
        turnPreamble: host.bridge?.turnPreamble || undefined,
        history: input.nativeHistory,
        // SPEC §15.2: the Mousse MCP server in the ACP session (HTTP, or the stdio bridge when the
        // agent does not advertise HTTP) and the session instructions in the session's first prompt.
        mcp: host.bridge?.mcp ?? null,
        orchestrationInstructions: host.bridge?.sessionInstructions || undefined,
        ...(host.bot ? { bot: true as const, botAuthority: host.bot } : {}),
        ...(input.child && !host.bot ? { delegated: true as const } : {}),
        ...(host.bridge?.permission ? { prompter: host.bridge.permission } : {}),
        drainSteer: () => ctl.drainSteer(),
        // Per drain, with its token (docs/design/steer-and-interruptions.md §2.6, §2.7): read only once the prompt that
        // carries it reached the agent, handed back otherwise.
        ...(ctl.drainSteerEntry ? { drainSteerEntry: (opts?: { expect?: Array<'cut' | 'native' | 'hold'> }) => ctl.drainSteerEntry!(opts) } : {}),
        // The hold: offered only for a turn on it.
        ...(ctl.peekSteer ? { peekSteer: () => ctl.peekSteer!() } : {}),
        ...(ctl.mayCut ? { mayCut: (token: string) => ctl.mayCut!(token) } : {}),
        steerTaken: (token) => ctl.steerTaken?.(token),
        returnSteer: (text, token) => ctl.returnSteer?.(text, token),
        onBoundary: () => sink.boundary?.(),
        onProviderTurn: () => {
          sink.providerTurn?.()
          // The prompt reached the agent, so its runtime is up and the model is next: the turn is no longer starting.
          // An agent that sends nothing until its reply (Antigravity) would otherwise read "Starting…" all through it.
          sink.status?.('waiting')
        },
        onToolAwaiting: (callId, waiting) => sink.toolAwaiting?.(callId, waiting),
        onSteer: (steer, token) => {
          progress()
          // The reply goes on below the steered message: what it wrote before keeps its row, above it.
          streams.thinking.break()
          streams.text.break()
          sink.steerAccepted(steer, token)
        },
        onText: (content) => {
          progress()
          // The reply began: the thought before it is done, and one that resumes after it is a new row. Only
          // visible text does that: an empty or whitespace-only chunk leaves the thought open.
          if (streams.text.hasContentDelta(content)) streams.thinking.break()
          streams.text.update(content)
        },
        onTextSeparator: (atOffset, sep) => streams.text.markSyntheticSeparator(atOffset, sep),
        onThinking: (content) => {
          progress()
          // A thought after text keeps the text above it, as a tool call does.
          if (streams.thinking.hasContentDelta(content)) streams.text.break()
          streams.thinking.update(content)
        },
        onTool: (event) => {
          progress()
          // A thought or a note that came before this call keeps its own row, above it; the next one starts below.
          if (event.phase === 'start' && !event.parentCallId) {
            streams.thinking.break()
            streams.text.break()
          }
          if (event.phase === 'start') toolCalls.set(event.callId, 'running')
          // A running call's progress: it still runs (and has not failed).
          else if (event.phase === 'update') toolCalls.set(event.callId, toolCalls.get(event.callId) ?? 'running')
          // A native background tool (`run_command`, `invoke_subagent`) is not a Mousse MCP call: keeping the
          // bearer across its turn lets the reactive continuation still call Mousse MCP tools.
          else toolCalls.set(event.callId, event.status === 'completed' || (event.status === 'background' && !mousseServerToolOf(event.toolName ?? '')) ? 'completed' : 'failed')
          sink.tool(toolRows(withClosure(event, input.signal.aborted)))
        },
        // The ref names the agent's session once there is one, so stop and terminate find it.
        ...(client.interrupt ? { onSession: (sessionId: string) => sink.providerRef({ ...providerRef, sessionId }) } : {}),
        onUsage: (usage) => {
          reportedUsage = usage
        }
      })
    } catch (error) {
      // A stopped or failed turn, or one a usage limit ended: the history it left (its request, no reply), so the next
      // turn resumes the agent's session where the runtime judged that safe, instead of handing the history over again.
      if (host.context.nativeHistoryNow) client.commitInterrupted?.(input.threadId, host.context.nativeHistoryNow())
      throw error
    }
    const totalResponseTimeMs = Math.max(0, Date.now() - startedAt)
    const usage = reportedUsage
      ? { input: reportedUsage.input, output: reportedUsage.output, cacheRead: reportedUsage.cacheRead, cacheWrite: reportedUsage.cacheWrite }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const totalTokensUsed = reportedUsage?.totalTokens
    const elapsedMs = performance.now() - startedTick
    const tokensPerSecond =
      reportedUsage?.hasOutput && elapsedMs > 0
        ? Math.round((usage.output / elapsedMs) * 1000 * 10) / 10
        : undefined
    if (reportedUsage) {
      sink.providerMetrics({
        totalResponseTimeMs,
        totalTokensUsed,
        tokensPerSecond,
        usage: {
          ...usage,
          ...(reportedUsage.reasoning !== undefined ? { reasoning: reportedUsage.reasoning } : {}),
          totalTokens: reportedUsage.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      })
      sink.usage(usage)
    }
    client.commitConversation(input.threadId, host.context.nativeHistoryAfterTurn(text))
    streams.thinking.complete()
    streams.text.complete(text)
    const contextKey = `${input.llmProvider}:${input.model}`
    return {
      text,
      aborted: input.signal.aborted,
      modelName: input.model,
      totalResponseTimeMs,
      ...(totalTokensUsed !== undefined ? { totalTokensUsed } : {}),
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
      usage,
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

  async stopThread(threadId: string): Promise<'stopped' | 'not_active'> {
    const client = this.client()
    return client?.stopThread ? client.stopThread(threadId) : 'not_active'
  }

  /**
   * No native fork yet. Null makes a fork use the portable `full_summary` handoff (SPEC §16.2); a
   * native fork lands here once the agent advertises `session/fork`.
   */
  async forkSession(_ref: ProviderRef, _atTurnOrdinal: number): Promise<ProviderRef | null> {
    return null
  }
}
