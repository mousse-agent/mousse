import { harnessAppError, type HarnessError } from '../../../../shared/harness/types'
import {
  CodexTurnFailure,
  type CodexChatInput,
  type CodexChatResult,
  type CodexProviderService
} from '../../../providers/codex/CodexProviderService'
import { codexErrorKind } from '../../../providers/codex/protocol'
import type { ChildPreflightContext, SubagentRefusal } from '../../policy/featureGates'
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
import { readUsageLimit } from '../../../orchestrator/providerErrors'
import { MOUSSE_MCP_SERVER_NAME } from '../../mcp/attachment'
import { promptStreams, runtimeToolEvent } from '../../transcript/promptRuntime'
import { retryContextOverflowOnce } from '../shared/retryContextOverflow'

/** Codex names a Mousse server call `mcp__mousse__<tool>` (`CodexProviderService` tool events). */
const CODEX_MOUSSE_TOOL_PREFIX = `mcp__${MOUSSE_MCP_SERVER_NAME}__`

/** The slice of the provider service a turn drives. */
export type CodexClient = Pick<
  CodexProviderService,
  'chat' | 'commitConversation' | 'standaloneWorkspace' | 'configured' | 'interrupt' | 'steer' | 'userSetup'
> & Partial<Pick<CodexProviderService, 'commitInterrupted'>>

/** How Codex 0.162.1 begins the message of a turn its `auth.command` failed (wire test). */
const TOKEN_COMMAND_FAILED = 'provider auth command '

/**
 * The harness error of a turn a managed Codex (Sign in with ChatGPT) ended as failed. The adapter
 * never retries: Codex has already retried transient failures itself, and the gateway decides
 * the rest. A context overflow is returned unchanged (the overflow recovery reads it), and so is
 * anything that is not a `CodexTurnFailure`.
 */
export function codexHarnessError(error: unknown, instanceId?: string): unknown {
  if (!(error instanceof CodexTurnFailure)) return error
  const kind = codexErrorKind(error.codexErrorInfo)
  if (kind === 'contextWindowExceeded') return error
  // Codex 0.162.1 reports an HTTP failure as its status alone (`httpConnectionFailed`); the
  // upstream `error.code` (`subscription_sharing_*`) is not passed on in any field (wire test), so
  // the mapping reads the kind and the status only.
  const status = error.httpStatus
  const fail = (code: HarnessError['code'], message: string): unknown =>
    harnessAppError({ code, message, ...(instanceId ? { instanceId } : {}) })
  // The token helper failed (signed out, the account changed, Mousse not running): Codex says so
  // in its own words, with no kind or status, and retries without a bearer until it gives up.
  if (kind === 'other' && status === undefined && error.message.startsWith(TOKEN_COMMAND_FAILED))
    return fail('auth_expired', 'Mousse could not give Codex a ChatGPT token. Sign in again in Settings → Providers.')
  if (kind === 'unauthorized' || status === 401)
    return fail('auth_expired', 'ChatGPT did not accept this sign-in. Sign in again in Settings → Providers.')
  if (kind === 'usageLimitExceeded' || status === 429)
    return fail('rate_limited', 'Usage limit reached for your ChatGPT plan. It resets later; see Manage usage on chatgpt.com.')
  if (status === 403)
    return fail('not_eligible', "ChatGPT refused this request for this account or plan. Check the plan, or sign in with another account.")
  if (kind === 'serverOverloaded' || status === 503)
    return fail('service_unavailable', 'ChatGPT is unavailable or busy right now. Try again in a moment.')
  if (kind === 'badRequest' || status === 400)
    return fail('unsupported', 'ChatGPT did not accept this request.')
  return fail('protocol', `Codex ended the turn with an error: ${error.message}`)
}

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
  mcp: true,
  childPolicy: 'enforced'
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
  readonly driver = 'codex' as const
  readonly capabilities = CODEX_CAPABILITIES

  /** `managed`: a Codex Mousse runs on a Sign in with ChatGPT connection, whose failures map to harness errors. */
  constructor(
    private readonly service: () => CodexClient | null,
    private readonly options: { managed?: boolean } = {}
  ) {}

  /** Codex reports token usage and the model's context window. */
  describe(_model: string): ModelInfo {
    return { contextUsage: 'reported' }
  }

  configured(): boolean {
    return this.service()?.configured() ?? false
  }

  /**
   * What the user's own Codex setup allows for a child; nothing is changed. Mousse cannot deny a
   * Codex MCP tool call (it answers command, file and permission approvals and elicitations, but a
   * tool the user's server offers runs under Codex's own rules), so a `shared` child is refused
   * while the config has any enabled MCP server, a Mousse-managed one included, or cannot be read;
   * `isolated` still works. Codex's own subagents are left on: see `NativeHelpers`.
   */
  async childPreflight(context: ChildPreflightContext): Promise<SubagentRefusal | null> {
    const service = this.service()
    if (!service || context.workspace !== 'shared') return null
    const { mcpServers } = await service.userSetup(context.cwd)
    if (mcpServers === null)
      return { code: 'shared_unsupported_for_provider', message: 'A read-only (shared) Codex subagent needs Mousse to read your Codex config, and it could not. Use workspace "isolated", or choose another provider or model.' }
    return mcpServers.length
      ? { code: 'shared_unsupported_for_provider', message: `A read-only (shared) Codex subagent is not possible while your Codex config has MCP servers (${mcpServers.join(', ')}): Mousse cannot stop one of their tools from writing and does not change your Codex config. Use workspace "isolated", or choose another provider or model.` }
      : null
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    const service = this.service()
    if (!service) throw new Error(`${input.llmProvider} is not available in this profile`)
    const startedAt = Date.now()
    let providerRef: ProviderRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
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
    // The drained-turn proof for the bearer: every Mousse server call Codex announced this turn (started
    // or completed) and whether the server itself reported each one completed. The completions the
    // service adds for rows left open when a turn ends are not proof.
    const mousseCalls = new Map<string, boolean>()
    const chatInput = (): CodexChatInput => ({
      mode: input.mode === 'plan' ? 'plan' : 'default',
      child: input.child,
      threadId: input.threadId,
      instanceId: input.instanceId,
      cwd,
      model: input.model,
      prompt: input.prompt,
      images: input.images,
      signal: input.signal,
      turnPreamble: host.bridge?.turnPreamble || undefined,
      history,
      // SPEC §15.2/§15.3: the Mousse MCP server in the thread's config, the session instructions as
      // developer instructions.
      mcp: host.bridge?.mcp ?? null,
      developerInstructions: host.bridge?.sessionInstructions || undefined,
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
      onToolNotification: (event) => {
        if (!event.toolName?.startsWith(CODEX_MOUSSE_TOOL_PREFIX)) return
        mousseCalls.set(event.callId, event.phase === 'complete' || (mousseCalls.get(event.callId) ?? false))
      },
      onHeartbeat: () => ctl.heartbeat(),
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
    let result: CodexChatResult
    try {
      result = await retryContextOverflowOnce(
        () => service.chat(chatInput()),
        () => {
          const recovered = host.context.recoverOverflow()
          if (!recovered) return false
          history = recovered.nativeHistory
          return true
        },
        () => !progressed && !input.signal.aborted
      )
    } catch (error) {
      // A stopped turn, and one a usage limit ended, keep their Codex thread: the next turn resumes it (the request is in it).
      // A turn that failed otherwise leaves the record as it was.
      const limited = readUsageLimit(error) !== undefined
      if ((input.signal.aborted || limited) && host.context.nativeHistoryNow) service.commitInterrupted?.(input.threadId, host.context.nativeHistoryNow())
      // A managed run still reports the failure behind a usage limit to the harness gateway, which maps it itself.
      if (this.options.managed && !input.signal.aborted) throw codexHarnessError(limited ? (error as Error).cause : error, input.instanceId)
      throw error
    }
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
    const contextKey = `${input.llmProvider}:${input.model}`
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
      drain: { mousseCalls: mousseCalls.size, toolsSettled: [...mousseCalls.values()].every(Boolean) }
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
