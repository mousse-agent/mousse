import { knownAppError } from '../../shared/errors'
import { retryConnectionFailures } from './connectionRetry'
import { normalizeProviderError, providerErrors, type ProviderFailureResponse } from './providerErrors'
import type { AgentToolAccess } from '../agents/WorkspaceAccessPolicy'
import { createHash } from 'crypto'

import {
  Type,
  type AssistantMessage,
  type ProviderResponse,
  type Api,
  type Message,
  type Model,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type UserMessage
} from '@earendil-works/pi-ai'

import type { McpToolDescriptor } from '../../shared/integrations'
import type { IntegrationActor } from '../../shared/integrations/actor'
import { defaultIntegrationActor } from '../../shared/integrations/actor'
import type {
  AgentExecutionBudget,
  AgentExecutionLimit,
  AgentRuntimeEffectTracker,
  AgentRuntimePolicy,
  AgentRuntimeToolApprovalCallback
} from '../../shared/agents/execution'
import type { EffectiveAgentGrants } from '../../shared/agents/types'
import {
  authorizeTrustedToolDispatch,
  canonicalizeBuiltinToolName,
  isToolPermittedByPolicy,
  prepareTrustedToolDispatch
} from '../agentDefinitions/runtimePolicy'

import type { ChatMode } from '../../shared/types'

import { normalizeChatMode } from '../../shared/chatMode'
import { isToolAllowedForMode } from '../../shared/modes'
import { permissionModeAllows, type PermissionMode } from '../../shared/permissionMode'
import { piPermissionKey, piToolAction } from '../../shared/permissionKeys'
import { modeRegistry as defaultModeRegistry, type ModeRegistry } from '../modes/ModeRegistry'

import { resolveModelForMode, resolveTitleModel, normalizeContextSettings, resolveContextCompactionTokens } from '../../shared/settings'

import { EFFORT_SUFFIXES, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'

import { getModelEffortLevels } from '../../shared/modelEfforts'

import type { SettingsStore } from '../settings/SettingsStore'

import type { ProviderAuthService } from '../providers/ProviderAuthService'

import type { McpManager } from '../integrations/mcp/McpManager'

import type { SkillsRegistry } from '../integrations/skills/SkillsRegistry'

import type { FileService } from '../files/FileService'

import type { GitService } from '../git/GitService'

import { BuildModeTools } from './BuildModeTools'
import { PiCodingTools, piToolSetForMode } from './PiCodingTools'
import { DevGuiTools } from '../devgui/DevGuiTools'
import { QuickActionTools, type CreatedQuickAction } from './QuickActionTools'
import { userQuestionService as defaultUserQuestionService, UserQuestionService } from './UserQuestionService'
import type { DocumentOpenPayload } from '../../shared/types'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import type { TaskQueue } from '../tasks/TaskQueue'
import { WebTools } from './WebTools'

import { buildOrchestratorSystemPrompt, DELEGATION_PROMPT } from './systemPrompt'
import {
  createAppToolRegistry,
  type AppToolFamily,
  type AppToolTurn,
  type InProcessAuthority,
  type ToolOutcome,
  type ToolRegistry,
  type ToolTimeline,
  unattendedRefusal
} from '../run/mcp/appTools'
import { DELEGATION_TOOL_NAMES, delegationToolDefinitions, type DelegationToolHost } from '../run/mcp/appTools/delegation'
import { PUBLISH_APPLET_TOOL } from '../run/mcp/appTools/applets'
import { modeFactsFor, offeredDefinitions, prepareSkills, settingsToolEnabled } from '../run/mcp/appTools/assemble'
import { callUserMcpTool, userMcpTool } from '../run/mcp/appTools/userMcp'
import { questionApproval } from '../run/mcp/appTools/quickActions'
import type { BrowserRuntimePort } from '../../shared/browser/runtime'
import { type BrowserExecutionBinding, snapshotBrowserExecutionBinding } from './browser'
import {
  estimateActiveContextTokens,
  shouldCompactNativeContext,
  type NativeMessageCheckpoint
} from './nativeContext'
import { appendSteerToToolResultContent, formatSteerMarker } from './steer'
import type { LlmTextEventHandler, LlmThinkingEventHandler, LlmToolEvent, LlmToolEventHandler } from '../harness/turnEvents'
import {
  assertAssistantResponseSucceeded,
  consumeAssistantStream,
  DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
  getCacheSessionId,
  getReasoningStreamOptions,
  resolveStreamInactivityTimeout
} from '../harness/drivers/pi/stream'
import {
  accumulateProviderUsage,
  applySafeBoundaryCompaction,
  emptyAccumulatedUsage,
  type ToolLoopSafetyOptions
} from './toolLoopSafety'

export {
  type ToolLoopSafetyOptions,
  type ToolLoopAccumulatedUsage
} from './toolLoopSafety'

export interface LlmMessageImage {
  mimeType: string
  data: string
  name?: string
}

export interface LlmMessage {

  role: 'user' | 'assistant'

  content: string

  images?: LlmMessageImage[]

}



export interface LlmChatOptions {
  appletInstructions?: string
  onPublishApplet?: (source: unknown) => unknown

  /** Host-owned isolated inventory. Never accepted from a protocol DTO. */
  runtimeContext?: {
    systemPrompt: string
    tools: Tool[]
    executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage>
  }
  delegation?: DelegationToolHost

  /**
   * The thread's permission mode for this turn (`ask`, `accept_edits`, `full`). A tool the mode does
   * not allow without asking (a command, a file edit, an integration) asks the thread's user first.
   * Absent for turns without a person behind them (definitions, workflow steps): no gate.
   */
  permissionMode?: PermissionMode

  /** Daemon-minted episode capability; never accepted from protocol input. */
  toolAccess?: AgentToolAccess

  /**
   * Run Engine tool ledger (docs/run-engine/SPEC.md §12.6). `start` runs before a tool executes
   * and returns the invocation id (undefined skips the ledger for that call); `commit` or
   * `failed` follows once the outcome is known. Host-supplied; never from protocol input.
   */
  toolLedger?: {
    /** `idempotent`: the call's class says so (a bot gate's built-in); absent, the tool's name decides. */
    start(call: ToolCall, options?: { idempotent?: boolean }): string | undefined
    commit(id: string): void
    failed(id: string): void
  }


  mode?: ChatMode

  llmProvider?: string

  model?: string

  /** Optional reasoning effort override for a delegated Mousse subagent. */
  effort?: string

  /**
   * When true, the model is a Mousse subagent implementing a delegated task.
   * Uses coding tools without orchestration instructions.
   */
  subagent?: boolean
  /** `never`: Mousse tools that wait for the user (approvals, questions) are refused (`RunPolicy.approvals`). */
  approvals?: 'never'

  /** Read-only pre-allocation phase; declares its edit surface through a native tool. */
  subagentDiscovery?: {
    onDeclareFiles: (files: string[], rationale?: string) => void
  }

  /** Overrides the active project for a turn running in an isolated worktree. */
  projectPath?: string

  /** Explicit thread for pending questions / daemon ownership (Phase 4). */
  threadId?: string

  /** The run engine run this loop turn belongs to; its app tools act for it (`InProcessAuthority`). */
  runId?: string
  /** Whether `runId` is still its thread's active run; an app tool call after that is refused. Host-supplied. */
  runActive?: () => boolean

  /** Abort in-flight stream and tool loop. */
  signal?: AbortSignal

  /**
   * Maximum silence between provider stream events. Every provider defaults to a
   * bounded value so a dead connection surfaces as a retryable stall instead of
   * an infinite spinner; tests and advanced callers may override it. Set to 0 to disable.
   */
  streamInactivityTimeoutMs?: number
  onRetry?: (attempt: number) => void
  onProviderProgress?: () => void
  /** Trusted testing/host override; no protocol caller controls retry timing. */
  retryDelayMs?: number

  /**
   * Drain pending mid-turn steer text after each completed tool call.
   * Injected into that tool result with OOB markers (not a new user role).
   */
  drainSteer?: () => string | undefined

  /** Called after each assistant/tool-result append so long turns can be crash-safe. */
  onNativeMessages?: (messages: Message[], checkpoint?: NativeMessageCheckpoint) => void
  onCompaction?: (phase: 'start' | 'complete' | 'unchanged') => void

  /** Generated memory from a durable compaction checkpoint; never user-authored. */
  contextSummary?: string

  /** Optional safe-boundary context maintenance for long-running tool loops. */
  toolLoopSafety?: ToolLoopSafetyOptions

  /**
   * Effective actor used for Skills/MCP grants. Native Mousse children must pass
   * a child actor; omitted values follow main-agent gates for compatibility.
   */
  actor?: IntegrationActor

  /** Trusted internal seam for immutable user-created agent definitions. */
  trustedAgent?: TrustedAgentExecutionOptions

  /**
   * Per-turn trusted browser binding. Root supplies source/profile/thread/turn
   * identity; models cannot create this object. Falls back to bindBrowserExecution.
   */
  browser?: BrowserExecutionBinding

}

export interface TrustedAgentExecutionOptions {
  systemPrompt: string
  grants: EffectiveAgentGrants
  budget: AgentExecutionBudget
  policy?: AgentRuntimePolicy
  approveToolRequest?: AgentRuntimeToolApprovalCallback
  effects?: AgentRuntimeEffectTracker
}



function extractAssistantText(message: AssistantMessage): string {

  assertAssistantResponseSucceeded(message)



  return message.content

    .filter((block) => block.type === 'text')

    .map((block) => block.text)

    .join('')

}



function toPiMessages(history: LlmMessage[]): Message[] {

  const now = Date.now()

  return history.map((message) => {

    if (message.role === 'user') {
      const images = message.images?.filter((img) => img.data && img.mimeType) ?? []
      if (images.length > 0) {
        return {
          role: 'user',
          content: [
            ...(message.content.trim()
              ? [{ type: 'text' as const, text: message.content }]
              : [{ type: 'text' as const, text: '(image attachment)' }]),
            ...images.map((img) => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType
            }))
          ],
          timestamp: now
        } satisfies UserMessage
      }

      return {

        role: 'user',

        content: message.content,

        timestamp: now

      } satisfies UserMessage

    }



    return {

      role: 'assistant',

      content: [{ type: 'text', text: message.content }],

      api: 'openai-completions',

      provider: 'openai',

      model: 'history',

      usage: {

        input: 0,

        output: 0,

        cacheRead: 0,

        cacheWrite: 0,

        totalTokens: 0,

        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

      },

      stopReason: 'stop',

      timestamp: now

    } satisfies AssistantMessage

  })

}



export interface LlmChatResult {

  text: string

  usage: Usage

  /** Display name of the model that generated this response. */
  modelName: string

  /** Elapsed time for the complete LLM turn, including any tool loop. */
  totalResponseTimeMs: number

  /**
   * Aggregate processed tokens for the turn: sum of provider usage.totalTokens
   * across every model call. Not context occupancy and not cost.
   */
  totalTokensUsed: number

  /** Output tokens per second while consuming LLM streams, when both inputs are available. */
  tokensPerSecond?: number

  /** Dynamic prompt/tool material used for this request, for context accounting. */
  contextInputs: LlmContextInputs

  toolEvents: LlmToolEvent[]

  aborted?: boolean

  /** Complete Pi-native active transcript, including every assistant and tool result. */
  nativeMessages: Message[]

  /** Set when a trusted definition limit stopped the provider loop. */
  limitExceeded?: AgentExecutionLimit

}



export interface LlmContextInputs {
  systemPromptText: string
  /** System prompt before generated compaction memory is appended. */
  baseSystemPromptText?: string
  mcpToolsText: string
  otherToolsText: string
  signature: string
  modelKey?: string
}

export class LlmClient {

  private readonly questions: UserQuestionService
  private readonly modeRegistry: ModeRegistry

  private buildTools: BuildModeTools

  private piCodingTools: PiCodingTools

  /** The app tools (plans, tasks, skills, browser, quick actions, web, dev GUI, applets, delegation) over this client's dependencies. */
  private readonly appTools: { registry: ToolRegistry; families: Record<AppToolFamily, string[]> }

  private browserRuntime?: BrowserRuntimePort

  private browserBinding?: BrowserExecutionBinding

  private readonly customModel?: (provider: string, modelId: string) => Model<Api> | undefined

  constructor(

    private settingsStore: SettingsStore,

    private providerAuth: ProviderAuthService,

    private mcpManager?: McpManager,

    private skillsRegistry?: SkillsRegistry,

    private getProjectPath?: () => string | undefined,

    fileService?: FileService,

    gitService?: GitService,

    private lineEditStats?: LineEditStatsStore,

    private onOpenDocument?: (payload: DocumentOpenPayload) => void,

    tasks?: TaskQueue,

    private onQuickActionCreated?: (action: CreatedQuickAction) => void,

    private onPresentPlan?: (payload: { title: string; markdown: string }, threadId?: string) => void,

    runtime?: {
      questions?: UserQuestionService
      modeRegistry?: ModeRegistry
      browserRuntime?: BrowserRuntimePort
      /** A model the user added to a provider (Settings → Providers) that its catalog does not list. */
      customModel?: (provider: string, modelId: string) => Model<Api> | undefined
    }

  ) {
    this.customModel = runtime?.customModel
    this.questions = runtime?.questions ?? defaultUserQuestionService
    this.modeRegistry = runtime?.modeRegistry ?? defaultModeRegistry
    this.browserRuntime = runtime?.browserRuntime

    this.buildTools = new BuildModeTools(fileService!, gitService!, lineEditStats)
    this.piCodingTools = new PiCodingTools(lineEditStats)

    // The same modules the Mousse MCP server serves, over this client's own dependencies.
    this.appTools = createAppToolRegistry({
      host: {
        delegation: () => {
          throw new Error('Delegation tools run with the turn that has them.')
        },
        askUser: (threadId, questions, options) => this.questions.requestAnswers(questions, threadId, options),
        dismissQuestions: (threadId) => this.questions.dismissAllForThread(threadId),
        // The turn carries its permission mode (`AppToolTurn.permissionMode`); a tool that edits the workspace asks here.
        askApproval: (threadId, questions, options) => this.questions.requestAnswers(questions, threadId, options),
        presentPlan: (threadId, payload) => this.onPresentPlan?.(payload, threadId),
        openDocument: (payload) => this.onOpenDocument?.(payload),
        tasks: () => tasks ?? null,
        browserRuntime: () => this.browserRuntime,
        skills: () => this.skillsRegistry,
        quickActions: new QuickActionTools(
          questionApproval(this.questions),
          (action) => this.onQuickActionCreated?.(action)
        ),
        web: new WebTools(this.providerAuth.credentials),
        devGui: new DevGuiTools()
      }
    })

  }

  /** The provider's catalog model, else a custom model the user added to that provider. */
  private catalogModel(provider: string, modelId: string): Model<Api> | undefined {
    return this.providerAuth.models.getModel(provider, modelId) ?? this.customModel?.(provider, modelId)
  }

  /** Host-injected dispatcher. Never accept a model-supplied port. */
  setBrowserRuntime(port: BrowserRuntimePort | undefined): void {
    this.browserRuntime = port
  }

  /**
   * Default trusted browser context for this client. Isolated definition-run
   * clients use this because createNativeAgentRuntime cannot carry a per-call field.
   */
  bindBrowserExecution(binding: BrowserExecutionBinding | undefined): void {
    this.browserBinding = binding ? snapshotBrowserExecutionBinding(binding) : undefined
  }


  async chat(
    messages: Message[],

    onToolEvent?: LlmToolEventHandler,

    options: LlmChatOptions = {},

    onThinkingEvent?: LlmThinkingEventHandler,

    onTextEvent?: LlmTextEventHandler

  ): Promise<LlmChatResult> {
    return this.chatInner(messages, onToolEvent, options, onThinkingEvent, onTextEvent)
  }

  private async chatInner(
    messages: Message[],
    onToolEvent?: LlmToolEventHandler,
    options: LlmChatOptions = {},
    onThinkingEvent?: LlmThinkingEventHandler,
    onTextEvent?: LlmTextEventHandler
  ): Promise<LlmChatResult> {
    const isolated = options.runtimeContext
    if (
      isolated &&
      (options.delegation ||
        options.browser ||
        this.browserBinding ||
        options.subagentDiscovery ||
        options.contextSummary ||
        options.toolLoopSafety ||
        options.trustedAgent ||
        options.toolAccess ||
        options.projectPath ||
        this.getProjectPath?.())
    ) {
      throw new Error('Isolated runtime context cannot share local tools, browser, project or memory context.')
    }
    const runtimeContext = isolated
      ? {
          systemPrompt: isolated.systemPrompt,
          tools: structuredClone(isolated.tools),
          executeTool: isolated.executeTool.bind(isolated)
        }
      : undefined
    const discovery = options.subagentDiscovery
    const subagent = options.subagent === true || Boolean(discovery)
    const trustedAgent = options.trustedAgent
    const requestedBrowserBinding = options.browser ?? this.browserBinding
    let browserBinding = requestedBrowserBinding
      ? snapshotBrowserExecutionBinding(requestedBrowserBinding)
      : undefined
    if (browserBinding && browserBinding.mode !== 'disabled' && !this.browserRuntime) {
      throw knownAppError({ code: 'browser_runtime_unbound', message: 'Browser runtime is not bound. Call setBrowserRuntime with a BrowserRuntimePort before enabling browser tools.' })
    }
    const budgetSignal = trustedAgent && trustedAgent.budget.maxElapsedMs > 0
      ? AbortSignal.timeout(trustedAgent.budget.maxElapsedMs)
      : undefined
    const requestSignal = trustedAgent && budgetSignal
      ? options.signal
        ? AbortSignal.any([options.signal, budgetSignal])
        : budgetSignal
      : options.signal
    // Subagents implement work with the full coding tool set (same as Build).
    const mode = discovery ? ('plan' as const) : subagent ? ('build' as const) : normalizeChatMode(options.mode)

    const { llmProvider, model: modelId } = this.resolveProviderModel(
      subagent ? normalizeChatMode(options.mode) : mode,
      options
    )



    if (!this.providerAuth.has(llmProvider)) {

      throw providerErrors.create('provider_not_connected', undefined, { provider: llmProvider })

    }



    const { baseId: catalogModelId, effort: modelEffort } = parseThinkingSuffixFromModelId(modelId)
    const requestedEffort = options.effort
    if (requestedEffort && !EFFORT_SUFFIXES.has(requestedEffort)) {
      throw providerErrors.create('provider_effort_invalid')
    }
    if (requestedEffort && modelEffort) {
      throw providerErrors.create('provider_effort_conflict')
    }
    const reasoningLevel = requestedEffort ?? modelEffort

    const model =
      this.catalogModel(llmProvider, catalogModelId) ??
      this.catalogModel(llmProvider, modelId)

    if (!model) {

      throw providerErrors.create('provider_model_unknown', undefined, { provider: llmProvider })

    }

    if (browserBinding) {
      browserBinding = snapshotBrowserExecutionBinding({ ...browserBinding, vision: model.input.includes('image') })
    }

    if (requestedEffort && requestedEffort !== 'off') {
      const supportedEfforts = getModelEffortLevels(model)
      if (!supportedEfforts?.includes(requestedEffort)) {
        throw providerErrors.create('provider_effort_unsupported', undefined, { provider: llmProvider })
      }
    }



    const auth = await this.providerAuth.models.getAuth(model)

    if (!auth) {

      throw providerErrors.create('provider_not_connected', undefined, { provider: llmProvider })

    }



    const projectPath = options.projectPath ?? this.getProjectPath?.()
    const userContent = extractLastUserText(messages)
    const cacheSessionId = getCacheSessionId(options.threadId)
    const streamInactivityTimeoutMs = resolveStreamInactivityTimeout(
      options.streamInactivityTimeoutMs
    )

    const actor = options.actor ?? defaultIntegrationActor(subagent)
    const requestContext: Awaited<ReturnType<LlmClient['prepareRequestContext']>> = runtimeContext ? {
      enabledSkills: [],
      loadedSkills: [],
      mcpTools: [],
      tools: runtimeContext.tools,
      systemPrompt: runtimeContext.systemPrompt,
      contextInputs: {
        systemPromptText: runtimeContext.systemPrompt,
        mcpToolsText: '',
        otherToolsText: serializeToolDefinitions(runtimeContext.tools),
        signature: '',
        modelKey: ''
      },
      appTurn: undefined
    } : await this.prepareRequestContext(
      mode,
      userContent,
      projectPath,
      llmProvider,
      subagent,
      discovery,
      actor,
      trustedAgent,
      browserBinding,
      options.threadId
    )
    let { enabledSkills, loadedSkills, mcpTools, tools, systemPrompt, contextInputs } = requestContext
    // The turn the app tools act in: this request's selection, plus what the host minted for it.
    const appTurn: AppToolTurn | undefined = requestContext.appTurn && {
      ...requestContext.appTurn,
      runId: options.runId ?? '',
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      ...(options.onPublishApplet && !subagent ? { onPublishApplet: options.onPublishApplet } : {}),
      ...(options.delegation ? { delegation: options.delegation } : {}),
      ...(options.toolAccess ? { toolAccess: options.toolAccess } : {}),
      ...(options.approvals === 'never' ? { approvals: 'never' as const } : {})
    }
    // A run nobody answers is not offered the Mousse tools that wait for the user (they are refused if called).
    if (appTurn?.approvals === 'never')
      tools = tools.filter((tool) => {
        const appTool = this.appTools.registry.get(tool.name)
        return !appTool || !unattendedRefusal(appTool, appTurn)
      })
    if (options.onPublishApplet && !runtimeContext && !subagent) {
      tools = [...tools, PUBLISH_APPLET_TOOL]
      systemPrompt += options.appletInstructions ?? ''
      contextInputs = {...contextInputs, systemPromptText: systemPrompt, otherToolsText: serializeToolDefinitions(tools.filter(tool => !mcpTools.some(mcp => mcp.providerName === tool.name)))}
    }
    if (trustedAgent) {
      enabledSkills = enabledSkills.filter((skill) => trustedAgent.grants.skills.some(
        (grant) => grant.id === skill.id || grant.id === skill.installationId
      ))
      loadedSkills = loadedSkills.filter((skill) => enabledSkills.some((allowed) => allowed.name === skill.name))
      mcpTools = mcpTools.filter((tool) => {
        const grant = trustedAgent.grants.mcpTools.find(
          (entry) => (entry.serverId === tool.serverId || entry.serverId === tool.installationId) && entry.toolName === tool.toolName
        )
        if (!grant) return false
        if (grant.revision && tool.configRevision !== grant.revision) {
          throw new Error(`Granted MCP tool changed after agent resolution: ${grant.id}.`)
        }
        return true
      })
      tools = tools.filter((tool) => {
        if (!isTrustedToolAllowed(tool.name, mcpTools, trustedAgent.grants)) return false
        const mcp = mcpTools.some((entry) => entry.providerName === tool.name)
        return isToolPermittedByPolicy(tool.name, trustedAgent.policy, mcp)
      })
      const grantedSkillText = loadedSkills.map((skill) => `Granted skill ${skill.name}:\n${skill.content}`).join('\n\n')
      systemPrompt = [trustedAgent.systemPrompt, grantedSkillText].filter(Boolean).join('\n\n')
      contextInputs = {
        systemPromptText: systemPrompt,
        mcpToolsText: serializeToolDefinitions(mcpTools.map(userMcpTool)),
        otherToolsText: serializeToolDefinitions(tools.filter((tool) => !mcpTools.some((mcp) => mcp.providerName === tool.name))),
        signature: '',
        modelKey: ''
      }
    }
    if (options.delegation) {
      if (trustedAgent) throw new Error('Delegation requires an explicit supported agent capability grant')
      systemPrompt = `${systemPrompt}\n\n${DELEGATION_PROMPT}`
      tools = [...tools, ...delegationToolDefinitions()]
      contextInputs = { ...contextInputs, systemPromptText: systemPrompt,
        otherToolsText: serializeToolDefinitions(tools.filter((tool) => !mcpTools.some((mcp) => mcp.providerName === tool.name))) }
    }
    if (options.toolAccess) {
      tools = tools.filter((tool) => options.toolAccess!.allows(tool.name))
      mcpTools = mcpTools.filter((tool) => options.toolAccess!.allows(tool.providerName))
      contextInputs = { ...contextInputs, mcpToolsText: serializeToolDefinitions(mcpTools.map(userMcpTool)),
        otherToolsText: serializeToolDefinitions(tools.filter((tool) => !mcpTools.some((mcp) => mcp.providerName === tool.name))) }
    }
    const systemPromptWithoutMemory = systemPrompt
    contextInputs = { ...contextInputs, baseSystemPromptText: systemPromptWithoutMemory }
    let activeContextSummary = options.contextSummary?.trim() || undefined
    if (activeContextSummary) {
      systemPrompt = withGeneratedMemory(systemPromptWithoutMemory, activeContextSummary)
      contextInputs = { ...contextInputs, systemPromptText: systemPrompt }
    }
    const modelKey = `${llmProvider}:${model.id}:${model.api}:${reasoningLevel ?? 'off'}`
    contextInputs = {
      ...contextInputs,
      modelKey,
      signature: createHash('sha256').update([
        modelKey,
        contextInputs.systemPromptText,
        contextInputs.mcpToolsText,
        contextInputs.otherToolsText
      ].join('\u0000')).digest('hex')
    }

    const toolEvents: LlmToolEvent[] = []



    loadedSkills.forEach((skill) => {

      const event: LlmToolEvent = {

        kind: 'skill_loaded',

        title: `Loaded skill ${skill.name}`,

        summary: 'Loaded Skill instructions into the orchestrator context.',

        details: [`Skill: ${skill.name}`, `Characters: ${skill.content.length}`]

      }

      toolEvents.push(event)

      onToolEvent?.({ ...event, phase: 'complete' })

    })



    // Keep Pi messages native. AgentSession is deliberately not used because Mousse owns
    // its MCP/tool execution and renderer timeline; this is the same canonical Context
    // contract without flattening provider identities, thinking, signatures, or tool data.
    const piMessages = structuredClone(messages)



    const responseStartedAt = Date.now()
    let response: AssistantMessage | null = null
    // Aggregate processed usage (sum of provider totalTokens) — not context occupancy.
    let accumulatedUsage = emptyAccumulatedUsage()
    let accumulatedCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    // Provider-reported output tokens are the authoritative numerator for TPS. Keep
    // LLM stream time separate so tool execution and prompt tokens do not skew it.
    let outputTokens = 0
    let streamDurationMs = 0
    let aborted = Boolean(requestSignal?.aborted)
    let modelCalls = 0
    let toolCallsUsed = 0
    let limitExceeded: AgentExecutionLimit | undefined
    const recordAttempt = (): void => {
      if (!trustedAgent?.effects) return
      trustedAgent.effects.attemptUsage = {
        inputTokens: accumulatedUsage.input,
        outputTokens: accumulatedUsage.output,
        costUsd: accumulatedCost.total,
        turns: modelCalls,
        toolCalls: toolCallsUsed
      }
    }

    const safetyOptions = options.toolLoopSafety
    let activeTokensAfterLastCompaction: number | undefined
    let activeTokensAtLastSkippedCompaction: number | undefined

    // Intentionally unbounded: explicit abort, model completion, or a real error ends the loop.
    for (;;) {
      if (requestSignal?.aborted) {
        if (budgetSignal?.aborted && trustedAgent) {
          limitExceeded = { kind: 'elapsed_ms', limit: trustedAgent.budget.maxElapsedMs }
        }
        aborted = true
        break
      }

      if (trustedAgent && modelCalls >= trustedAgent.budget.maxTurns) {
        limitExceeded = { kind: 'turns', limit: trustedAgent.budget.maxTurns, actual: modelCalls }
        break
      }

      // Compaction only between completed tool batches and the next model request.
      // Trigger from actual active-context occupancy. Cumulative processed usage
      // remains telemetry and must never drive compaction frequency.
      const activeContextTokens = estimateActiveContextTokens(piMessages, activeContextSummary) +
        Math.ceil((systemPromptWithoutMemory.length + contextInputs.mcpToolsText.length + contextInputs.otherToolsText.length) / 4)
      const enoughGrowthSinceCompaction = activeTokensAfterLastCompaction === undefined ||
        activeContextTokens - activeTokensAfterLastCompaction >= 8_192
      const configuredCompactionDue = Boolean(safetyOptions?.compactNativeMessages) &&
        safetyOptions?.compactionThresholdTokens != null &&
        activeContextTokens >= safetyOptions.compactionThresholdTokens &&
        enoughGrowthSinceCompaction
      const occupancyCompactionDue = Boolean(safetyOptions?.compactNativeMessages) &&
        enoughGrowthSinceCompaction &&
        shouldCompactNativeContext(activeContextTokens, model.contextWindow)
      const enoughGrowthSinceSkipped = activeTokensAtLastSkippedCompaction === undefined ||
        activeContextTokens - activeTokensAtLastSkippedCompaction >= 4_096
      if (modelCalls > 0 && enoughGrowthSinceSkipped && (configuredCompactionDue || occupancyCompactionDue)) {
        options.onCompaction?.('start')
        if (options.onCompaction) await new Promise<void>((resolve) => setTimeout(resolve, 30))
        const compacted = await applySafeBoundaryCompaction(
          piMessages,
          safetyOptions,
          activeContextTokens,
          model.contextWindow
        )
        const contextChanged = compacted.changed && Boolean(compacted.checkpoint)
        if (contextChanged) {
          piMessages.length = 0
          piMessages.push(...compacted.messages)
          activeContextSummary = compacted.checkpoint!.summary
          activeTokensAfterLastCompaction = compacted.checkpoint!.tokensAfter +
            Math.ceil((systemPromptWithoutMemory.length + contextInputs.mcpToolsText.length + contextInputs.otherToolsText.length) / 4)
          systemPrompt = withGeneratedMemory(systemPromptWithoutMemory, activeContextSummary)
          contextInputs = {
            ...contextInputs,
            systemPromptText: systemPrompt,
            signature: createHash('sha256').update([
              contextInputs.modelKey,
              systemPrompt,
              contextInputs.mcpToolsText,
              contextInputs.otherToolsText
            ].join('\u0000')).digest('hex')
          }
          options.onNativeMessages?.(structuredClone(piMessages), compacted.checkpoint)
          activeTokensAtLastSkippedCompaction = undefined
        } else {
          activeTokensAtLastSkippedCompaction = activeContextTokens
        }
        options.onCompaction?.(contextChanged ? 'complete' : 'unchanged')
      }

      modelCalls += 1

      let requestProgress = false
      const markProgress = () => { requestProgress = true; options.onProviderProgress?.() }
      const streamStartedAt = Date.now()
      try {
        response = await retryConnectionFailures(async () => {
          const stallAbort = new AbortController()
          let failureResponse: ProviderFailureResponse | undefined
          const captureResponse = (response: ProviderResponse) => {
            if (response.status >= 400) failureResponse = { status: response.status, retryAfter: Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] }
          }
          const streamSignal = requestSignal ? AbortSignal.any([requestSignal, stallAbort.signal]) : stallAbort.signal
          try {
            // Pi SDK adapters turn HTTP errors into strings before onResponse runs.
            // Capture only status and retry delay at the HTTP boundary; never read bodies.
            const capturesHttp = ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api)
            const streamOptions = {
              ...getReasoningStreamOptions(model.api, (reasoningLevel ?? 'off') as ThinkingLevel, streamSignal, cacheSessionId, llmProvider),
              maxRetries: 0,
              onResponse: captureResponse,
              ...(capturesHttp ? { fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
                const response = await globalThis.fetch(...args)
                captureResponse({ status: response.status, headers: { 'retry-after': response.headers.get('retry-after') ?? '' } })
                return response
              }) as typeof globalThis.fetch } : {})
            }
            const context = { systemPrompt, messages: piMessages, tools: tools.length > 0 ? tools : undefined }
            const stream = this.providerAuth.models.streamSimple(model, context, streamOptions as { reasoning: ThinkingLevel; signal?: AbortSignal })
            const candidate = await consumeAssistantStream(stream, { onThinking: onThinkingEvent, onText: onTextEvent }, {
              inactivityTimeoutMs: streamInactivityTimeoutMs, signal: streamSignal,
              onTimeout: () => stallAbort.abort(), onProgress: markProgress
            })
            if (candidate.errorMessage && candidate.stopReason !== 'aborted') {
              // Failed requests can still report billable usage. Account before retry.
              accumulatedUsage = accumulateProviderUsage(accumulatedUsage, candidate.usage)
              for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) accumulatedCost[key] += candidate.usage.cost[key] || 0
              outputTokens += candidate.usage.output
              recordAttempt()
              assertAssistantResponseSucceeded(candidate, failureResponse)
            }
            return candidate
          } catch (error) {
            throw normalizeProviderError(error, llmProvider, failureResponse)
          } finally {
            // Shut down each attempt before starting another one.
            stallAbort.abort()
          }
        }, options.onRetry ?? (() => {}), {
          signal: requestSignal, delayMs: options.retryDelayMs,
          canRetry: () => {
            if (requestProgress) return false
            if (trustedAgent) {
              const budget = trustedAgent.budget
              if (budget.maxInputTokens !== undefined && accumulatedUsage.input > budget.maxInputTokens) limitExceeded = { kind: 'input_tokens', limit: budget.maxInputTokens, actual: accumulatedUsage.input }
              else if (budget.maxOutputTokens !== undefined && accumulatedUsage.output > budget.maxOutputTokens) limitExceeded = { kind: 'output_tokens', limit: budget.maxOutputTokens, actual: accumulatedUsage.output }
              else if (budget.maxCostUsd !== undefined && accumulatedCost.total > budget.maxCostUsd) limitExceeded = { kind: 'cost_usd', limit: budget.maxCostUsd, actual: accumulatedCost.total }
            }
            return !limitExceeded
          }
        })
      } catch (error) {
        recordAttempt()
        if (budgetSignal?.aborted && trustedAgent) limitExceeded = { kind: 'elapsed_ms', limit: trustedAgent.budget.maxElapsedMs }
        if (limitExceeded) { aborted = true; break }
        throw error
      }
      streamDurationMs += Date.now() - streamStartedAt
      accumulatedUsage = accumulateProviderUsage(accumulatedUsage, response.usage)
      accumulatedCost = {
        input: accumulatedCost.input + (response.usage.cost.input || 0),
        output: accumulatedCost.output + (response.usage.cost.output || 0),
        cacheRead: accumulatedCost.cacheRead + (response.usage.cost.cacheRead || 0),
        cacheWrite: accumulatedCost.cacheWrite + (response.usage.cost.cacheWrite || 0),
        total: accumulatedCost.total + (response.usage.cost.total || 0)
      }
      outputTokens += response.usage.output
      if (trustedAgent) {
        const budget = trustedAgent.budget
        if (budget.maxInputTokens !== undefined && accumulatedUsage.input > budget.maxInputTokens) {
          limitExceeded = { kind: 'input_tokens', limit: budget.maxInputTokens, actual: accumulatedUsage.input }
        } else if (budget.maxOutputTokens !== undefined && accumulatedUsage.output > budget.maxOutputTokens) {
          limitExceeded = { kind: 'output_tokens', limit: budget.maxOutputTokens, actual: accumulatedUsage.output }
        } else if (budget.maxCostUsd !== undefined && accumulatedCost.total > budget.maxCostUsd) {
          limitExceeded = { kind: 'cost_usd', limit: budget.maxCostUsd, actual: accumulatedCost.total }
        }
      }
      recordAttempt()

      // Provider APIs can encode a retryable server failure as an AssistantMessage rather
      // than rejecting the stream. Throw before checkpointing so a retry resumes from the
      // last valid user/tool result instead of sending an error assistant back as history.
      assertAssistantResponseSucceeded(response)

      // Checkpoint assistant first so a safety stop never discards partial work.
      piMessages.push(response)
      options.onNativeMessages?.(structuredClone(piMessages))

      if (response.stopReason === 'aborted' || requestSignal?.aborted) {
        aborted = true
        break
      }

      const toolCalls = response.content.filter((block): block is ToolCall => block.type === 'toolCall')

      if (response.stopReason !== 'toolUse' || toolCalls.length === 0) {
        // Steer arriving during a tool-less turn (streaming/thinking/plain answer)
        // would otherwise be silently dropped: the old code only drained steer
        // after a completed tool call. Inject it as an OOB user message and ask
        // the model again instead of finishing the turn.
        const steerText = options.drainSteer?.()?.trim()
        if (steerText) {
          const marker = formatSteerMarker(steerText)
          if (marker) {
            piMessages.push({
              role: 'user',
              content: marker.trim(),
              timestamp: Date.now()
            } satisfies UserMessage)
            options.onNativeMessages?.(structuredClone(piMessages))
            continue
          }
        }
        break
      }

      for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
        const toolCall = toolCalls[toolIndex]
        if (requestSignal?.aborted) {
          aborted = true
          break
        }

        if (trustedAgent && toolCallsUsed >= trustedAgent.budget.maxToolCalls) {
          limitExceeded = { kind: 'tool_calls', limit: trustedAgent.budget.maxToolCalls, actual: toolCallsUsed }
          for (const skippedCall of toolCalls.slice(toolIndex)) {
            piMessages.push(toolResult(skippedCall, 'Tool call budget exhausted for this agent definition.', true))
          }
          break
        }
        toolCallsUsed += 1
        recordAttempt()

        // The caller writes the ledger row of every call, app tools included (the registry writes none in process).
        const ledgerId = options.toolLedger?.start(toolCall)
        const authority: InProcessAuthority = trustedAgent || !options.runId
          ? { kind: 'trusted', ledgerEntryId: ledgerId }
          : { kind: 'run', runId: options.runId, ledgerEntryId: ledgerId, ...(options.runActive ? { active: options.runActive } : {}) }
        const dispatch = async (): Promise<ToolResultMessage> => {
          if (runtimeContext) return runtimeContext.executeTool(toolCall, requestSignal)
          if (appTurn && ((toolCall.name === 'publish_applet' && options.onPublishApplet) ||
              (options.delegation && DELEGATION_TOOL_NAMES.has(toolCall.name)))) {
            return this.callAppTool(toolCall, appTurn, authority, toolEvents, onToolEvent, requestSignal)
          }
          return this.executeToolCall(
          toolCall,
          mcpTools,
          projectPath,
          mode,
          toolEvents,
          onToolEvent,
          requestSignal,
          appTurn,
          authority,
          discovery,
          actor,
          trustedAgent,
          options.permissionMode
        )
        }
        let result: ToolResultMessage
        try {
          result = options.toolAccess
            ? await options.toolAccess.execute(toolCall.name, (toolCall.arguments ?? {}) as Record<string, unknown>, dispatch)
            : await dispatch()
        } catch (error) {
          result = toolResult(toolCall, error instanceof Error ? error.message : String(error), true)
        }
        if (ledgerId) {
          if (result.isError) options.toolLedger?.failed(ledgerId)
          else options.toolLedger?.commit(ledgerId)
        }

        piMessages.push(result)

        // A steer received while this tool was running must take effect at this boundary,
        // rather than waiting for every tool in the model's batch to execute.
        const steerText = options.drainSteer?.()?.trim()
        if (steerText) {
          result.content = appendSteerToToolResultContent(
            result.content as Array<{ type: string; text?: string }>,
            steerText
          ) as ToolResultMessage['content']
          result.details = {
            ...(result.details && typeof result.details === 'object' ? result.details : {}),
            mousseUserSteer: steerText
          }

          // Provider protocols require one result for every tool call in the assistant
          // message. Mark the unstarted calls as interrupted before asking the model to
          // reconsider them in light of the steer.
          for (const skippedCall of toolCalls.slice(toolIndex + 1)) {
            piMessages.push(toolResult(
              skippedCall,
              'Tool call not started because the user sent mid-turn guidance.',
              true
            ))
          }
          options.onNativeMessages?.(structuredClone(piMessages))
          break
        }

        options.onNativeMessages?.(structuredClone(piMessages))
      }

      if (aborted || limitExceeded) break

    }

    // totalTokensUsed reports aggregate processed usage for the turn.
    const totalTokensUsed = accumulatedUsage.processedTokens

    if (!response) {
      if (aborted || limitExceeded) {
        return {
          text: '',
          usage: emptyUsage(),
          modelName: model.name,
          totalResponseTimeMs: Date.now() - responseStartedAt,
          totalTokensUsed,
          tokensPerSecond: calculateTokensPerSecond(outputTokens, streamDurationMs),
          contextInputs,
          toolEvents,
          aborted,
          nativeMessages: piMessages,
          limitExceeded
        }
      }
      throw new Error('LLM returned no response.')
    }

    this.lineEditStats?.recordUsage({
      timestamp: new Date().toISOString(),
      provider: llmProvider,
      model: model.id,
      input: accumulatedUsage.input,
      output: accumulatedUsage.output,
      cacheRead: accumulatedUsage.cacheRead,
      cacheWrite: accumulatedUsage.cacheWrite
    })

    return {
      text: extractAssistantText(response),
      usage: trustedAgent ? {
        input: accumulatedUsage.input,
        output: accumulatedUsage.output,
        cacheRead: accumulatedUsage.cacheRead,
        cacheWrite: accumulatedUsage.cacheWrite,
        totalTokens: accumulatedUsage.processedTokens,
        cost: accumulatedCost
      } : response.usage,
      modelName: model.name,
      totalResponseTimeMs: Date.now() - responseStartedAt,
      totalTokensUsed,
      tokensPerSecond: calculateTokensPerSecond(outputTokens, streamDurationMs),
      contextInputs,
      toolEvents,
      aborted: aborted || response.stopReason === 'aborted',
      nativeMessages: piMessages,
      limitExceeded
    }

  }



  /**
   * `selection` is the title model the harness gateway resolved and admitted (an API provider's
   * model); it runs as is. Absent, the stored title setting is resolved against the configured
   * providers.
   */
  async generateTitle(
    userRequest: string,
    firstResponse?: string,
    threadId?: string,
    selection?: { instanceId?: string; llmProvider: string; model: string }
  ): Promise<string> {
    const prompt = [
      'Write a concise title for this chat (maximum 7 words).',
      'Return only the title: no quotes, markdown, or ending punctuation.',
      '',
      `User request: ${userRequest.slice(0, 4000)}`,
      ...(firstResponse?.trim() ? [`First response: ${firstResponse.slice(0, 6000)}`] : [])
    ].join('\n')
    const text = await this.completeWithTitleModel(
      'You name chat threads clearly and specifically.',
      prompt,
      threadId ?? `title:${userRequest}`,
      selection
    )
    return text
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?:;]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
  }

  /**
   * Proposes a pull request's title and description with the title model: the same selection,
   * stream path and timeouts as `generateTitle`. Returns the model's raw answer; the caller parses it.
   */
  async draftPullRequest(
    systemPrompt: string,
    prompt: string,
    threadId?: string,
    selection?: { instanceId?: string; llmProvider: string; model: string }
  ): Promise<string> {
    return this.completeWithTitleModel(systemPrompt, prompt, `pull-request-draft:${threadId ?? prompt.slice(0, 200)}`, selection)
  }

  /**
   * Proposes a commit message with the title model: the same selection, stream path and timeouts as
   * `generateTitle`. Returns the model's raw answer; the caller parses it.
   */
  async generateCommitMessage(
    systemPrompt: string,
    prompt: string,
    threadId?: string,
    selection?: { instanceId?: string; llmProvider: string; model: string }
  ): Promise<string> {
    return this.completeWithTitleModel(systemPrompt, prompt, `commit-message:${threadId ?? prompt.slice(0, 200)}`, selection)
  }

  /** One short, tool-free completion on the title model; `sessionKey` only names the provider's cache session. */
  private async completeWithTitleModel(
    systemPrompt: string,
    prompt: string,
    sessionKey: string,
    selection?: { instanceId?: string; llmProvider: string; model: string }
  ): Promise<string> {
    const { llmProvider, model: selectedModelId } = selection ?? resolveTitleModel(this.settingsStore.get(), this.providerAuth.getConfiguredLlmProviders())
    if (!llmProvider || !selectedModelId) {
      throw new Error('Connect a provider with a title model before generating a chat title.')
    }

    const { baseId, effort } = parseThinkingSuffixFromModelId(selectedModelId)
    const model = this.catalogModel(llmProvider, baseId)
    if (!model) throw new Error(`Unknown title model "${selectedModelId}" for provider "${llmProvider}"`)
    if (!(await this.providerAuth.models.getAuth(model))) {
      throw new Error(`Title provider "${llmProvider}" is not configured.`)
    }

    const titleContext = {
      systemPrompt,
      messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }]
    }
    const reasoning = (effort ?? 'off') as ThinkingLevel
    const titleSessionId = getCacheSessionId(sessionKey)
    const streamOptions = getReasoningStreamOptions(
      model.api,
      reasoning,
      undefined,
      titleSessionId,
      llmProvider
    )
    const stream = this.providerAuth.models.streamSimple(model, titleContext, streamOptions as { reasoning: ThinkingLevel })
    // Bounded like main turns: a dead title connection must fail fast (the caller
    // falls back to a heuristic) instead of leaking a pending promise forever.
    const response = await consumeAssistantStream(
      stream,
      {},
      { inactivityTimeoutMs: DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS }
    )
    return extractAssistantText(response)
  }

  getSelectedModelContextLimit(
    mode: ChatMode = 'agent',
    options: Pick<LlmChatOptions, 'llmProvider' | 'model'> = {}
  ): { limit: number; modelName: string | null } {

    const { llmProvider, model: modelId } = this.resolveProviderModel(mode, options)

    if (!llmProvider || !modelId) {

      return { limit: 128_000, modelName: null }

    }



    const { baseId: catalogModelId } = parseThinkingSuffixFromModelId(modelId)

    const model =
      this.catalogModel(llmProvider, catalogModelId) ??
      this.catalogModel(llmProvider, modelId)

    if (!model) {

      return { limit: 128_000, modelName: null }

    }



    return { limit: model.contextWindow, modelName: model.name }

  }

  getContextCompactionThreshold(mode: ChatMode, options: Pick<LlmChatOptions, 'llmProvider' | 'model'> = {}): number | undefined {
    const settings = normalizeContextSettings(this.settingsStore.get().context)
    return settings.compactionEnabled
      ? resolveContextCompactionTokens(settings.compactionTokens, this.getSelectedModelContextLimit(mode, options).limit)
      : undefined
  }



  getSystemPromptForMode(mode: ChatMode = 'agent'): string {
    const { llmProvider } = this.resolveProviderModel(mode)
    return buildOrchestratorSystemPrompt({
      mode,
      providerId: llmProvider,
      projectPath: this.getProjectPath?.(),
      modeRegistry: this.modeRegistry
    })
  }

  async getContextInputs(
    mode: ChatMode = 'agent',
    userContent = '',
    options: Pick<LlmChatOptions,
      'llmProvider' | 'model' | 'effort' | 'projectPath' | 'subagent' | 'actor' | 'browser' | 'contextSummary'> = {}
  ): Promise<LlmContextInputs> {
    const normalizedMode = normalizeChatMode(mode)
    const { llmProvider, model: modelId } = this.resolveProviderModel(normalizedMode, options)
    const { baseId, effort } = parseThinkingSuffixFromModelId(modelId)
    const model = this.catalogModel(llmProvider, baseId) ??
      this.catalogModel(llmProvider, modelId)
    if (!model) throw new Error(`Unknown model "${modelId}" for provider "${llmProvider}"`)
    const projectPath = options.projectPath ?? this.getProjectPath?.()
    const prepared = await this.prepareRequestContext(
      normalizedMode,
      userContent,
      projectPath,
      llmProvider,
      options.subagent === true,
      undefined,
      options.actor ?? defaultIntegrationActor(options.subagent === true),
      undefined,
      options.browser
    )
    const memory = options.contextSummary?.trim()
    const systemPromptText = memory
      ? withGeneratedMemory(prepared.systemPrompt, memory)
      : prepared.contextInputs.systemPromptText
    const modelKey = `${llmProvider}:${model.id}:${model.api}:${options.effort ?? effort ?? 'off'}`
    return {
      ...prepared.contextInputs,
      systemPromptText,
      baseSystemPromptText: prepared.systemPrompt,
      modelKey,
      signature: createHash('sha256').update([
        modelKey,
        systemPromptText,
        prepared.contextInputs.mcpToolsText,
        prepared.contextInputs.otherToolsText
      ].join('\u0000')).digest('hex')
    }
  }

  /** Validate an optional Mousse subagent model override before allocating its worktree. */
  resolveSubagentAssignment(options: Pick<LlmChatOptions, 'llmProvider' | 'model' | 'effort'>) {
    const selected = this.resolveProviderModel('build', options)
    const parsed = parseThinkingSuffixFromModelId(selected.model)
    const assignment = { provider: selected.llmProvider, model: parsed.baseId, effort: options.effort ?? parsed.effort }
    this.validateSubagentLaunch({ llmProvider: assignment.provider, model: assignment.model, effort: assignment.effort })
    return assignment
  }

  validateSubagentLaunch(options: Pick<LlmChatOptions, 'llmProvider' | 'model' | 'effort'>): void {
    const { llmProvider, model: modelId } = this.resolveProviderModel('agent', options)
    if (!this.providerAuth.has(llmProvider)) {
      throw new Error(`Provider "${llmProvider}" is not connected.`)
    }

    const { baseId, effort: modelEffort } = parseThinkingSuffixFromModelId(modelId)
    if (options.effort && !EFFORT_SUFFIXES.has(options.effort)) {
      throw new Error(`Unknown reasoning effort "${options.effort}"`)
    }
    if (options.effort && modelEffort) {
      throw new Error('Specify reasoning effort either in the model id or as effort, not both.')
    }

    const model =
      this.catalogModel(llmProvider, baseId) ??
      this.catalogModel(llmProvider, modelId)
    if (!model) throw new Error(`Unknown model "${modelId}" for provider "${llmProvider}"`)

    if (options.effort && options.effort !== 'off') {
      const supportedEfforts = getModelEffortLevels(model)
      if (!supportedEfforts?.includes(options.effort)) {
        throw new Error(
          `Model "${baseId}" for provider "${llmProvider}" does not support reasoning effort "${options.effort}"`
        )
      }
    }
  }



  private resolveProviderModel(mode: ChatMode, options: LlmChatOptions = {}): { llmProvider: string; model: string } {

    if (Boolean(options.llmProvider) !== Boolean(options.model)) {
      throw new Error('Subagent provider and model overrides must be supplied together.')
    }

    if (options.llmProvider && options.model) {

      return { llmProvider: options.llmProvider, model: options.model }

    }

    const connected = this.providerAuth.credentials.listProviderIds()

    return resolveModelForMode(this.settingsStore.get(), mode, connected)

  }

  private async prepareRequestContext(
    mode: ChatMode,
    userContent: string,
    projectPath: string | undefined,
    llmProvider: string,
    subagent: boolean,
    discovery?: LlmChatOptions['subagentDiscovery'],
    actor: IntegrationActor = defaultIntegrationActor(false),
    trustedAgent?: TrustedAgentExecutionOptions,
    browserBinding?: BrowserExecutionBinding,
    threadId?: string
  ) {
    const modeFacts = modeFactsFor(this.modeRegistry, mode, projectPath)
    const [{ enabledSkills, loadedSkills }, mcpTools] = await Promise.all([
      prepareSkills({
        registry: this.skillsRegistry,
        settings: () => this.settingsStore.get().integrations.skills,
        projectPath,
        mode,
        userContent,
        actor,
        grants: trustedAgent?.grants
      }),
      modeFacts.build && !subagent
        ? Promise.resolve([] as McpToolDescriptor[])
        : this.getMcpTools(projectPath, actor)
    ])

    const toolEnabled = (name: string): boolean => trustedAgent ? true : settingsToolEnabled(this.settingsStore.get().integrations.tools, name)
    // The turn the app tools are selected for and act in (the request adds what its host minted).
    const appTurn: AppToolTurn = {
      threadId: threadId ?? '',
      runId: '',
      turnToken: '',
      mode,
      modeFacts,
      modeCeiling: mode === 'plan' ? 'plan' : 'default',
      subagent,
      discovery: Boolean(discovery),
      projectPath,
      actor,
      browser: browserBinding,
      enabledSkills,
      loadedSkills,
      settingsEnabled: toolEnabled,
      trusted: Boolean(trustedAgent)
    }
    const app = offeredDefinitions(this.appTools.registry, this.appTools.families, appTurn)
    const mcpToolDefs = mcpTools.map(userMcpTool)
    const piToolSet = projectPath ? piToolSetForMode(mode, projectPath, this.modeRegistry) : null
    const unfilteredPiToolDefs =
      projectPath && piToolSet
        ? await this.piCodingTools.getToolDefinitions(projectPath, piToolSet)
        : []
    const unfilteredGitToolDefs =
      modeFacts.build && projectPath ? this.buildTools.getGitToolDefinitions() : []
    const piCodingToolDefs = unfilteredPiToolDefs.filter((tool) =>
      toolEnabled(tool.name)
    )
    const buildGitToolDefs = unfilteredGitToolDefs.filter((tool) =>
      toolEnabled(tool.name)
    )
    // The pi loop's order: skills, coding and git tools, then plan, task, quick-action, dev GUI, web
    // and browser tools (app tools come from the registry's selection for this turn).
    const otherToolDefs: Tool[] = [
      ...app.skills,
      ...piCodingToolDefs,
      ...buildGitToolDefs,
      ...app.plans,
      ...app.tasks,
      ...app.quickActions,
      ...app.devGui,
      ...app.web,
      ...app.browser
    ]
    if (discovery) {
      otherToolDefs.push({
        name: 'declare_files',
        description: 'Declare the exact repository files this delegated task needs to edit or create.',
        parameters: Type.Object({
          files: Type.Array(Type.String({ description: 'Exact repository-relative existing or planned file path.' }), { minItems: 1 }),
          rationale: Type.Optional(Type.String({ description: 'Brief explanation of the chosen edit surface.' }))
        })
      })
    }
    const tools = [...mcpToolDefs, ...otherToolDefs]
    const systemPrompt = buildOrchestratorSystemPrompt({
      mode: discovery ? 'plan' : subagent ? 'build' : mode,
      providerId: llmProvider,
      projectPath,
      skills: enabledSkills,
      loadedSkills,
      subagent: subagent && !discovery,
      subagentDiscovery: Boolean(discovery),
      modeRegistry: this.modeRegistry
    })
    const mcpToolsText = serializeToolDefinitions(mcpToolDefs)
    const otherToolsText = serializeToolDefinitions(otherToolDefs)
    const contextInputs: LlmContextInputs = {
      systemPromptText: systemPrompt,
      mcpToolsText,
      otherToolsText,
      signature: '',
      modelKey: ''
    }

    return { enabledSkills, loadedSkills, mcpTools, tools, systemPrompt, contextInputs, appTurn: appTurn as AppToolTurn | undefined }
  }

  private async getMcpTools(
    projectPath?: string,
    actor: IntegrationActor = defaultIntegrationActor(false)
  ): Promise<McpToolDescriptor[]> {

    if (!this.mcpManager) return []
    // Context usage and the live request must observe the same schemas. Surface discovery
    // failures instead of silently presenting stale/under-counted context numbers.
    return this.mcpManager.getEnabledTools(projectPath, actor)

  }

  /**
   * One app tool through the registry (`callInProcess`), written to this turn's timeline as the
   * pi loop always has. The caller already wrote the ledger row and applied a read-only child's
   * workspace capability and a definition's grants.
   */
  private async callAppTool(
    toolCall: ToolCall,
    turn: AppToolTurn,
    authority: InProcessAuthority,
    toolEvents: LlmToolEvent[],
    onToolEvent: LlmToolEventHandler | undefined,
    signal: AbortSignal | undefined,
    trustedAgent?: TrustedAgentExecutionOptions
  ): Promise<ToolResultMessage> {
    const timeline: ToolTimeline = {
      record: (event, phase, extra) => {
        toolEvents.push(event)
        onToolEvent?.({ ...event, phase, callId: toolCall.id, ...extra })
      },
      emit: (event, phase) => onToolEvent?.({ ...event, phase, callId: toolCall.id })
    }
    const outcome = await this.appTools.registry.callInProcess(
      toolCall.name,
      (toolCall.arguments ?? {}) as Record<string, unknown>,
      authority,
      {
        turn,
        toolCallId: toolCall.id,
        signal: signal ?? new AbortController().signal,
        timeline,
        markEffect: () => {
          if (trustedAgent?.effects) trustedAgent.effects.dispatched = true
        }
      }
    )
    return appToolResult(toolCall, outcome)
  }


  /**
   * Asks the thread's user before a tool the permission mode does not allow without asking. Returns
   * the tool error to hand the model when the user rejects (or dismisses) the call, and null when
   * the call may run.
   */
  private async askPermission(
    toolCall: ToolCall,
    permissionMode: PermissionMode,
    action: 'command' | 'edit',
    permissionKey: string,
    threadId: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<ToolResultMessage | null> {
    if (permissionModeAllows(permissionMode, action)) return null
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>
    const detail = typeof args.command === 'string'
      ? [args.command, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ')
      : typeof args.path === 'string' ? args.path : JSON.stringify(args)
    const what = action === 'command' ? 'run this command' : 'edit this file'
    try {
      const answer = await this.questions.requestAnswers(
        [
          {
            id: 'permission',
            prompt: `Allow Mousse to ${what}?\n${detail.slice(0, 4000)}`,
            options: [
              { id: 'allow', label: 'Allow once' },
              { id: 'reject', label: 'Reject' }
            ]
          }
        ],
        threadId ?? '__unbound__',
        {
          ...(signal ? { signal } : {}),
          approval: {
            action,
            permissionKey,
            options: [
              { id: 'allow', decision: 'allow', scope: 'once' },
              { id: 'reject', decision: 'reject' }
            ]
          }
        }
      )
      if (answer.permission === 'allow' && !signal?.aborted) return null
      return toolResult(toolCall, `The user rejected the request to ${what}. Do not retry it unless they ask.`, true)
    } catch {
      return toolResult(toolCall, `The user did not approve the request to ${what}.`, true)
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    mcpTools: McpToolDescriptor[],
    projectPath: string | undefined,
    mode: ChatMode,
    toolEvents: LlmToolEvent[],
    onToolEvent: LlmToolEventHandler | undefined,
    signal: AbortSignal | undefined,
    appTurn: AppToolTurn | undefined,
    authority: InProcessAuthority,
    discovery?: LlmChatOptions['subagentDiscovery'],
    actor: IntegrationActor = defaultIntegrationActor(false),
    trustedAgent?: TrustedAgentExecutionOptions,
    permissionMode?: PermissionMode
  ): Promise<ToolResultMessage> {

    try {
      const settingsEnabled = (name: string): boolean => Boolean(trustedAgent) || settingsToolEnabled(this.settingsStore.get().integrations.tools, name)
      const markTrustedEffect = (): void => {
        if (trustedAgent?.effects) trustedAgent.effects.dispatched = true
      }

      if (trustedAgent && !isTrustedToolAllowed(toolCall.name, mcpTools, trustedAgent.grants)) {
        return toolResult(toolCall, `Tool "${toolCall.name}" is not granted to this agent definition.`, true)
      }

      if (trustedAgent?.policy) {
        const isMcp = mcpTools.some((tool) => tool.providerName === toolCall.name)
        const prepared = prepareTrustedToolDispatch({
          policy: trustedAgent.policy,
          grants: trustedAgent.grants,
          toolName: toolCall.name,
          args: (toolCall.arguments ?? {}) as Record<string, unknown>,
          isMcp,
          projectPath
        })
        const authorized = await authorizeTrustedToolDispatch({
          prepared,
          policy: trustedAgent.policy,
          grants: trustedAgent.grants,
          toolName: toolCall.name,
          args: (toolCall.arguments ?? {}) as Record<string, unknown>,
          isMcp,
          projectPath,
          signal,
          approveToolRequest: trustedAgent.approveToolRequest
        })
        if (!authorized.allowed) {
          return toolResult(toolCall, authorized.message, true)
        }
      }

      // App tools run through the registry; delegation and applets only where the request has them
      // (see `dispatch`), as before.
      const appTool = this.appTools.registry.get(toolCall.name)
      if (appTool && appTurn && appTool.class !== 'delegation' && toolCall.name !== PUBLISH_APPLET_TOOL.name) {
        return this.callAppTool(toolCall, appTurn, authority, toolEvents, onToolEvent, signal, trustedAgent)
      }

      if (toolCall.name === 'declare_files' && discovery) {
        const rawFiles = Array.isArray(toolCall.arguments.files) ? toolCall.arguments.files : []
        const files = [...new Set(rawFiles.map(String).map((file) => file.trim()).filter(Boolean))]
        if (files.length === 0) return toolResult(toolCall, 'At least one file is required.', true)
        const rationale = typeof toolCall.arguments.rationale === 'string'
          ? toolCall.arguments.rationale.trim()
          : undefined
        markTrustedEffect()
        discovery.onDeclareFiles(files, rationale)
        const event: LlmToolEvent = {
          kind: 'build_tool_result',
          title: 'Declared edit files',
          summary: `Declared ${files.length} file${files.length === 1 ? '' : 's'} for sparse allocation.`,
          details: files,
          response: rationale
        }
        toolEvents.push(event)
        onToolEvent?.({ ...event, phase: 'complete', callId: toolCall.id })
        return toolResult(toolCall, `Declaration accepted for ${files.length} tracked file(s).`)
      }

      if (this.piCodingTools.isPiTool(toolCall.name) || this.buildTools.isGitTool(toolCall.name) || this.buildTools.isBuildTool(toolCall.name)) {
        const normalizedMode = normalizeChatMode(mode)
        if (typeof normalizedMode === 'string') {
          const descriptor = this.modeRegistry.getModeSync(normalizedMode, { projectPath })
          if (descriptor && !isToolAllowedForMode(descriptor, toolCall.name)) {
            return toolResult(toolCall, `Tool "${toolCall.name}" is not available in mode "${descriptor.id}". Permissions: ${JSON.stringify(descriptor.permission)}`, true)
          }
          if (!descriptor && normalizedMode === 'plan') {
            const allowedPlanPiTools = new Set(['read', 'grep', 'find', 'ls', 'read_file', 'list_dir'])
            if (this.piCodingTools.isPiTool(toolCall.name) && !allowedPlanPiTools.has(toolCall.name)) {
              return toolResult(toolCall, `Tool "${toolCall.name}" is not available in plan mode. Plan mode is read-only.`, true)
            }
            if (this.buildTools.isGitTool(toolCall.name) || (this.buildTools.isBuildTool(toolCall.name) && !allowedPlanPiTools.has(toolCall.name))) {
              return toolResult(toolCall, `Tool "${toolCall.name}" is not available in plan mode.`, true)
            }
          }
        }

        if (!projectPath) {

          return toolResult(toolCall, 'No project root selected for project tools.', true)

        }

        if (!settingsEnabled(toolCall.name)) {
          return toolResult(toolCall, `Tool "${toolCall.name}" is disabled in Settings → Skills & MCP.`, true)
        }

        // The thread's permission mode: a command (and, under Ask, an edit) asks the user first.
        // The Pi RPC route that takes over these tool calls (`harness/pi/extension`, provider
        // abstraction PR 2) must call `permissionModeAllows` and this same prompt before it runs one,
        // and `tests/piLoopApprovals.test.ts` is pointed at that route.
        const permissionAction = permissionMode !== undefined ? piToolAction(toolCall.name) : null
        if (permissionAction) {
          const refusal = await this.askPermission(toolCall, permissionMode!, permissionAction, piPermissionKey(permissionAction), appTurn?.threadId || undefined, signal)
          if (refusal) return refusal
        }

        const callEvent: LlmToolEvent = {

          kind: 'build_tool_call',

          title: `Tool ${toolCall.name}`,

          summary: 'Called a local project tool (Pi coding-agent SDK).',

          details: [`Tool: ${toolCall.name}`],

          response: JSON.stringify(toolCall.arguments, null, 2)

        }

        toolEvents.push(callEvent)

        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })



        markTrustedEffect()
        const result = this.piCodingTools.isPiTool(toolCall.name)
          ? await this.piCodingTools.execute(
              toolCall.name,
              toolCall.arguments as Record<string, unknown>,
              projectPath,
              toolCall.id,
              signal
            )
          : await this.buildTools.execute(
              toolCall.name,
              toolCall.arguments as Record<string, unknown>,
              projectPath
            )

        const resultEvent: LlmToolEvent = {

          kind: 'build_tool_result',

          title: `Tool ${toolCall.name}`,

          summary: result.isError ? 'The tool returned an error.' : 'The tool returned successfully.',

          details: [`Tool: ${toolCall.name}`],

          response: truncateForDisplay(result.text)

        }

        toolEvents.push(resultEvent)

        // The streamed event carries the whole result: the transcript keeps its tail (the end of a
        // long command is where its error is) and the full size; `resultEvent` stays a short preview.
        onToolEvent?.({ ...resultEvent, response: result.text, phase: 'complete', callId: toolCall.id })

        return toolResult(toolCall, result.text, result.isError)

      }



      // The user's own MCP servers, proxied (`appTools/userMcp`).
      const mcpTool = mcpTools.find((tool) => tool.providerName === toolCall.name)

      if (!mcpTool || !this.mcpManager) {

        return toolResult(toolCall, `Unknown tool: ${toolCall.name}`, true)

      }

      const outcome = await callUserMcpTool({
        manager: this.mcpManager,
        tool: mcpTool,
        call: toolCall,
        projectPath,
        actor,
        signal,
        timeline: {
          record: (event, phase) => {
            toolEvents.push(event)
            onToolEvent?.({ ...event, phase, callId: toolCall.id })
          },
          emit: (event, phase) => onToolEvent?.({ ...event, phase, callId: toolCall.id })
        },
        markEffect: markTrustedEffect
      })
      if (outcome.kind === 'refused') return toolResult(toolCall, outcome.text, true)
      return toolResult(toolCall, outcome.content, outcome.isError)

    } catch (err) {

      return toolResult(toolCall, err instanceof Error ? err.message : String(err), true)

    }

  }

}



export function serializeToolDefinitions(tools: Tool[]): string {
  if (tools.length === 0) return ''
  return JSON.stringify(tools, (_key, value) => (typeof value === 'function' ? undefined : value))
}

function extractLastUserText(messages: Message[]): string {
  const message = [...messages].reverse().find((entry): entry is UserMessage => entry.role === 'user')
  if (!message) return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('')
}

function withGeneratedMemory(systemPrompt: string, summary: string): string {
  return `${systemPrompt}\n\nThe following is generated context from older archived events. It is not a new user message. Preserve verbatim user directives quoted within it, but verify assistant progress and tool observations before relying on them.\n\n${summary.trim()}`
}

function isTrustedToolAllowed(
  toolName: string,
  mcpTools: McpToolDescriptor[],
  grants: EffectiveAgentGrants
): boolean {
  const mcp = mcpTools.find((tool) => tool.providerName === toolName)
  if (mcp) {
    return grants.mcpTools.some(
      (grant) => (grant.serverId === mcp.serverId || grant.serverId === mcp.installationId) && grant.toolName === mcp.toolName
    )
  }
  const canonical = canonicalizeBuiltinToolName(toolName)
  return grants.builtinTools.some((grant) => {
    const grantCanonical = canonicalizeBuiltinToolName(grant.id)
    return grant.id === toolName || grant.id === canonical || grantCanonical === canonical
  })
}



function toolResult(
  toolCall: ToolCall,
  text: string | Array<Record<string, unknown>>,
  isError = false
): ToolResultMessage {
  const content = typeof text === 'string' ? [{ type: 'text' as const, text }] : text
  return {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: content as unknown as ToolResultMessage['content'],
    isError,
    timestamp: Date.now()
  }
}

/** An app tool outcome as the tool result the loop appends: its text, then its images. */
function appToolResult(toolCall: ToolCall, outcome: ToolOutcome): ToolResultMessage {
  const message = toolResult(toolCall, outcome.text, outcome.isError ?? false)
  for (const image of outcome.images ?? []) message.content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return message
}

function calculateTokensPerSecond(outputTokens: number, streamDurationMs: number): number | undefined {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    !Number.isFinite(streamDurationMs) ||
    streamDurationMs <= 0
  ) {
    return undefined
  }
  return (outputTokens * 1_000) / streamDurationMs
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}



function truncateForDisplay(value: string): string {

  return value.length > 1_200 ? `${value.slice(0, 1_200)}\n...[truncated]` : value

}
