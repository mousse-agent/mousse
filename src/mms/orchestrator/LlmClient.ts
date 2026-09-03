import { createHash } from 'crypto'

import {
  Type,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TSchema,
  type Usage,
  type UserMessage
} from '@earendil-works/pi-ai'

import type { McpToolDescriptor, SkillDescriptor, SkillsRegistrySnapshot } from '../../shared/integrations'

import type { ChatMode, OrchestratorAction } from '../../shared/types'

import { allowsOrchestrationActions, filterActionsForMode, getSkillIdFromMode, normalizeChatMode } from '../../shared/chatMode'
import { isToolAllowedForMode } from '../../shared/modes'
import { modeRegistry } from '../modes/ModeRegistry'

import { resolveModelForMode, resolveTitleModel } from '../../shared/settings'

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
import { PlanModeTools } from './PlanModeTools'
import { DevGuiTools, isDevGuiToolsEnabled } from '../devgui/DevGuiTools'
import {
  QuickActionTools,
  describeQuickActionKind,
  type CreatedQuickAction,
  type StagedQuickAction
} from './QuickActionTools'
import { userQuestionService } from './UserQuestionService'
import type { DocumentOpenPayload } from '../../shared/types'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import type { TaskQueue } from '../tasks/TaskQueue'
import { TaskControlTools } from '../tasks/TaskControlTools'

import { buildOrchestratorSystemPrompt } from './systemPrompt'
import { estimateActiveContextTokens, shouldCompactNativeContext } from './nativeContext'
import { appendSteerToToolResultContent, formatSteerMarker } from './steer'
import {
  CURSOR_PROVIDER_ID,
  setCursorSessionProjectScope
} from '../providers/cursorPiProvider'
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

/** Legacy Mousse build-tool names → canonical Mousse tool ids for enablement checks. */
const MOUSSE_TOOL_ALIASES: Record<string, string> = {
  read_file: 'read',
  write_file: 'write',
  list_dir: 'ls',
  run_command: 'bash'
}



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

  mode?: ChatMode

  llmProvider?: string

  model?: string

  /** Optional reasoning effort override for a delegated Mousse subagent. */
  effort?: string

  /**
   * When true, the model is a Mousse subagent implementing a delegated task.
   * Uses coding tools without spawn_agents orchestration instructions.
   */
  subagent?: boolean

  /** Read-only pre-allocation phase; declares its edit surface through a native tool. */
  subagentDiscovery?: {
    onDeclareFiles: (files: string[], rationale?: string) => void
  }

  /** Overrides the active project for a turn running in an isolated worktree. */
  projectPath?: string

  /** Explicit thread for pending questions / daemon ownership (Phase 4). */
  threadId?: string

  /** Abort in-flight stream and tool loop. */
  signal?: AbortSignal

  /**
   * Maximum silence between provider stream events. Every provider defaults to a
   * bounded value so a dead connection surfaces as a retryable stall instead of
   * an infinite spinner; tests and advanced callers may override it. Set to 0 to disable.
   */
  streamInactivityTimeoutMs?: number

  /**
   * Drain pending mid-turn steer text after each completed tool call.
   * Injected into that tool result with OOB markers (not a new user role).
   */
  drainSteer?: () => string | undefined

  /** Called after each assistant/tool-result append so long turns can be crash-safe. */
  onNativeMessages?: (messages: Message[]) => void

  /** Optional safe-boundary context maintenance for long-running tool loops. */
  toolLoopSafety?: ToolLoopSafetyOptions

}



export function assertAssistantResponseSucceeded(message: AssistantMessage): void {

  // Aborted streams may still carry partial text plus an errorMessage.
  if (message.errorMessage && message.stopReason !== 'aborted') {

    throw new Error(message.errorMessage)

  }

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

}



export interface LlmToolEvent {

  kind: 'mcp_tool_call' | 'mcp_tool_result' | 'skill_loaded' | 'build_tool_call' | 'build_tool_result'

  title: string

  summary: string

  details: string[]

  response?: string

}



export interface StreamingLlmToolEvent extends LlmToolEvent {

  phase: 'start' | 'complete'

  callId?: string

}



export type LlmToolEventHandler = (event: StreamingLlmToolEvent) => void

export interface StreamingLlmThinkingEvent {
  phase: 'start' | 'delta' | 'complete'
  content: string
}

export type LlmThinkingEventHandler = (event: StreamingLlmThinkingEvent) => void

export interface StreamingLlmTextEvent {
  phase: 'start' | 'delta' | 'complete'
  content: string
  /** Content-block identity supplied by the provider stream. */
  contentIndex: number
}

export interface LlmContextInputs {
  systemPromptText: string
  mcpToolsText: string
  otherToolsText: string
  signature: string
}

export type LlmTextEventHandler = (event: StreamingLlmTextEvent) => void

export function getReasoningStreamOptions(
  modelApi: string,
  reasoning: ThinkingLevel | 'off',
  signal?: AbortSignal,
  sessionId?: string
) {
  const cacheOptions = sessionId ? { sessionId } : {}
  if (modelApi === 'openai-codex-responses') {
    return {
      reasoningEffort: reasoning === 'off' ? 'none' : reasoning,
      reasoningSummary: 'auto' as const,
      signal,
      ...cacheOptions
    }
  }

  return {
    reasoning,
    signal,
    ...cacheOptions
  }
}

/**
 * Produces a provider-safe prompt-cache affinity key without exposing a thread
 * identifier to providers. Each thread (including an isolated subagent) gets
 * an independent key; all requests in that thread retain the same key.
 */
export function getCacheSessionId(threadId: string | undefined): string | undefined {
  const normalized = threadId?.trim()
  if (!normalized) return undefined
  return `mousse-${createHash('sha256').update(normalized).digest('hex').slice(0, 48)}`
}

/**
 * Default silence budget between provider stream events. A connection that goes
 * quiet for this long is treated as a retryable stall (ProviderStreamStallError)
 * instead of spinning forever — previously only xAI had a bound, so any other
 * provider could hang every concurrent turn on the same network blip with Stop
 * as the only way out.
 */
export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 180_000

/** Kept for compatibility — identical to the default applied to every provider. */
export const XAI_STREAM_INACTIVITY_TIMEOUT_MS = DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS

/**
 * Resolve the effective per-stream inactivity timeout. An explicit override
 * (including 0 to disable) always wins; otherwise every provider gets the
 * bounded default.
 */
export function resolveStreamInactivityTimeout(
  overrideMs?: number
): number | undefined {
  if (overrideMs !== undefined) return overrideMs
  return DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS
}

export class ProviderStreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider connection timed out after ${timeoutMs}ms without a stream event`)
    this.name = 'ProviderStreamStallError'
  }
}

async function nextStreamEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  onTimeout?: () => void
): Promise<IteratorResult<AssistantMessageEvent>> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return iterator.next()

  return new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
    let settled = false
    const finish = (
      result?: IteratorResult<AssistantMessageEvent>,
      error?: unknown
    ): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result!)
    }
    const onAbort = (): void => finish(undefined, new DOMException('Aborted', 'AbortError'))
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          finish(undefined, new ProviderStreamStallError(timeoutMs))
          onTimeout?.()
        }, timeoutMs)
      : undefined
    signal?.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(
      (result) => finish(result),
      (error) => finish(undefined, error)
    )
  })
}

export async function consumeAssistantStream(
  stream: AssistantMessageEventStream,
  handlers: {
    onThinking?: LlmThinkingEventHandler
    onText?: LlmTextEventHandler
  } = {},
  options: {
    inactivityTimeoutMs?: number
    signal?: AbortSignal
    onTimeout?: () => void
  } = {}
): Promise<AssistantMessage> {
  const thinkingContentRef = { current: '' }
  const textContentByIndex = new Map<number, string>()
  const iterator = stream[Symbol.asyncIterator]()

  for (;;) {
    const next = await nextStreamEvent(
      iterator,
      options.inactivityTimeoutMs,
      options.signal,
      options.onTimeout
    )
    if (next.done) break
    const event = next.value
    handleThinkingStreamEvent(event, handlers.onThinking, thinkingContentRef)
    handleTextStreamEvent(event, handlers.onText, textContentByIndex)
  }

  return stream.result()
}

function handleThinkingStreamEvent(
  event: AssistantMessageEvent,
  onThinking: LlmThinkingEventHandler | undefined,
  thinkingContentRef: { current: string }
): void {
  if (!onThinking) return

  if (event.type === 'thinking_start') {
    thinkingContentRef.current = ''
    onThinking({ phase: 'start', content: '' })
    return
  }

  if (event.type === 'thinking_delta') {
    thinkingContentRef.current += event.delta
    onThinking({ phase: 'delta', content: thinkingContentRef.current })
    return
  }

  if (event.type === 'thinking_end') {
    thinkingContentRef.current = event.content
    onThinking({ phase: 'complete', content: event.content })
  }
}

export function handleTextStreamEvent(
  event: AssistantMessageEvent,
  onText: LlmTextEventHandler | undefined,
  textContentByIndex: Map<number, string>
): void {
  if (!onText) return

  if (event.type === 'text_start') {
    textContentByIndex.set(event.contentIndex, '')
    onText({ phase: 'start', content: '', contentIndex: event.contentIndex })
    return
  }

  if (event.type === 'text_delta') {
    if (!textContentByIndex.has(event.contentIndex)) {
      textContentByIndex.set(event.contentIndex, '')
      onText({ phase: 'start', content: '', contentIndex: event.contentIndex })
    }
    const content = `${textContentByIndex.get(event.contentIndex) ?? ''}${event.delta}`
    textContentByIndex.set(event.contentIndex, content)
    onText({ phase: 'delta', content, contentIndex: event.contentIndex })
    return
  }

  if (event.type === 'text_end') {
    const content = event.content ?? textContentByIndex.get(event.contentIndex) ?? ''
    textContentByIndex.set(event.contentIndex, content)
    onText({ phase: 'complete', content, contentIndex: event.contentIndex })
  }
}

export class LlmClient {

  private buildTools: BuildModeTools

  private piCodingTools: PiCodingTools

  private planTools: PlanModeTools

  private taskTools: TaskControlTools | null

  private quickActionTools: QuickActionTools

  private devGuiTools: DevGuiTools



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

    private onPresentPlan?: (payload: { title: string; markdown: string }, threadId?: string) => void

  ) {

    this.buildTools = new BuildModeTools(fileService!, gitService!, lineEditStats)
    this.piCodingTools = new PiCodingTools(lineEditStats)

    this.planTools = new PlanModeTools(
      (questions, threadId) => userQuestionService.requestAnswers(questions, threadId),
      (payload) => this.onOpenDocument?.(payload),
      (payload, threadId) => this.onPresentPlan?.(payload, threadId)
    )
    this.taskTools = tasks ? new TaskControlTools(tasks) : null
    this.quickActionTools = new QuickActionTools(
      (staged, threadId) => this.requestQuickActionApproval(staged, threadId),
      (action) => this.onQuickActionCreated?.(action)
    )
    this.devGuiTools = new DevGuiTools()

  }

  /**
   * Approval gate for agent-created quick actions. Blocks the tool loop on the
   * same user-question flow as ask_user, so approval renders in the existing
   * question UI (modal + inline agent-elements question card).
   */
  private async requestQuickActionApproval(
    staged: StagedQuickAction,
    threadId: string
  ): Promise<boolean> {
    const preview =
      staged.kind === 'bash' ? `$ ${staged.payload}` : staged.payload
    const answers = await userQuestionService.requestAnswers(
      [
        {
          id: 'approval',
          prompt:
            `Create quick action "${staged.label}" (${describeQuickActionKind(staged.kind)})? ` +
            `Content: ${preview.slice(0, 300)}`,
          options: [
            { id: 'approve', label: 'Approve and create' },
            { id: 'reject', label: 'Reject' }
          ]
        }
      ],
      threadId
    )
    const decision = answers['approval']
    return decision === 'approve' || (Array.isArray(decision) && decision.includes('approve'))
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
    const discovery = options.subagentDiscovery
    const subagent = options.subagent === true || Boolean(discovery)
    // Subagents implement work with the full coding tool set (same as Build).
    const mode = discovery ? ('plan' as const) : subagent ? ('build' as const) : normalizeChatMode(options.mode)

    const { llmProvider, model: modelId } = this.resolveProviderModel(
      subagent ? normalizeChatMode(options.mode) : mode,
      options
    )



    if (!this.providerAuth.has(llmProvider)) {

      throw new Error(

        `Provider "${llmProvider}" is not connected. Add and authenticate it in Settings.`

      )

    }



    const { baseId: catalogModelId, effort: modelEffort } = parseThinkingSuffixFromModelId(modelId)
    const requestedEffort = options.effort
    if (requestedEffort && !EFFORT_SUFFIXES.has(requestedEffort)) {
      throw new Error(`Unknown reasoning effort "${requestedEffort}"`)
    }
    if (requestedEffort && modelEffort) {
      throw new Error('Specify reasoning effort either in the model id or as effort, not both.')
    }
    const reasoningLevel = requestedEffort ?? modelEffort

    const model =
      this.providerAuth.models.getModel(llmProvider, catalogModelId) ??
      this.providerAuth.models.getModel(llmProvider, modelId)

    if (!model) {

      throw new Error(`Unknown model "${modelId}" for provider "${llmProvider}"`)

    }

    if (requestedEffort && requestedEffort !== 'off') {
      const supportedEfforts = getModelEffortLevels(model)
      if (!supportedEfforts?.includes(requestedEffort)) {
        throw new Error(
          `Model "${catalogModelId}" for provider "${llmProvider}" does not support reasoning effort "${requestedEffort}"`
        )
      }
    }



    const auth = await this.providerAuth.models.getAuth(model)

    if (!auth) {

      throw new Error(

        `Provider "${llmProvider}" is not configured. Re-authenticate it in Settings.`

      )

    }



    const projectPath = options.projectPath ?? this.getProjectPath?.()
    const userContent = extractLastUserText(messages)
    const cacheSessionId = getCacheSessionId(options.threadId)
    const streamInactivityTimeoutMs = resolveStreamInactivityTimeout(
      options.streamInactivityTimeoutMs
    )

    const requestContext = await this.prepareRequestContext(
      mode,
      userContent,
      projectPath,
      llmProvider,
      subagent,
      discovery
    )
    const { enabledSkills, loadedSkills, mcpTools, tools, systemPrompt, contextInputs } = requestContext

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
    // Provider-reported output tokens are the authoritative numerator for TPS. Keep
    // LLM stream time separate so tool execution and prompt tokens do not skew it.
    let outputTokens = 0
    let streamDurationMs = 0
    let aborted = Boolean(options.signal?.aborted)
    let modelCalls = 0

    const safetyOptions = options.toolLoopSafety
    const compactionInterval = safetyOptions?.compactionThresholdTokens
    let nextCompactionAt =
      compactionInterval != null && compactionInterval > 0
        ? compactionInterval
        : Number.POSITIVE_INFINITY

    // Intentionally unbounded: explicit abort, model completion, or a real error ends the loop.
    for (;;) {
      if (options.signal?.aborted) {
        aborted = true
        break
      }

      // Compaction only between completed tool batches and the next model request.
      // Trigger on either periodic processed usage or actual active-context occupancy;
      // processed usage alone is telemetry and can lag or vastly exceed occupancy.
      const activeContextTokens = estimateActiveContextTokens(piMessages)
      const intervalCompactionDue = accumulatedUsage.processedTokens >= nextCompactionAt
      const occupancyCompactionDue = Boolean(safetyOptions?.compactNativeMessages) &&
        shouldCompactNativeContext(activeContextTokens, model.contextWindow)
      if (modelCalls > 0 && (intervalCompactionDue || occupancyCompactionDue)) {
        const compacted = await applySafeBoundaryCompaction(
          piMessages,
          safetyOptions,
          accumulatedUsage.processedTokens,
          activeContextTokens,
          model.contextWindow
        )
        // Do not repeatedly compact the same transcript on every following tool call.
        // A later periodic compaction is eligible only after another full interval.
        if (intervalCompactionDue) {
          nextCompactionAt =
            accumulatedUsage.processedTokens + (compactionInterval ?? Number.POSITIVE_INFINITY)
        }
        if (compacted !== piMessages) {
          piMessages.length = 0
          piMessages.push(...compacted)
          options.onNativeMessages?.(structuredClone(piMessages))
        }
      }

      modelCalls += 1

      const stallAbort = new AbortController()
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, stallAbort.signal])
        : stallAbort.signal
      const streamOptions = getReasoningStreamOptions(
        model.api,
        (reasoningLevel ?? 'off') as ThinkingLevel,
        requestSignal,
        cacheSessionId
      )
      const stream = model.api === 'openai-codex-responses'
        ? this.providerAuth.models.stream(
            model,
            {
              systemPrompt,
              messages: piMessages,
              tools: tools.length > 0 ? tools : undefined
            },
            streamOptions
          )
        : this.providerAuth.models.streamSimple(
            model,
            {
              systemPrompt,
              messages: piMessages,
              tools: tools.length > 0 ? tools : undefined
            },
            streamOptions as { reasoning: ThinkingLevel; signal?: AbortSignal }
          )

      const streamStartedAt = Date.now()
      response = await consumeAssistantStream(
        stream,
        {
          onThinking: onThinkingEvent,
          onText: onTextEvent
        },
        {
          inactivityTimeoutMs: streamInactivityTimeoutMs,
          signal: requestSignal,
          onTimeout: () => stallAbort.abort()
        }
      )
      streamDurationMs += Date.now() - streamStartedAt
      accumulatedUsage = accumulateProviderUsage(accumulatedUsage, response.usage)
      outputTokens += response.usage.output

      // Provider APIs can encode a retryable server failure as an AssistantMessage rather
      // than rejecting the stream. Throw before checkpointing so a retry resumes from the
      // last valid user/tool result instead of sending an error assistant back as history.
      assertAssistantResponseSucceeded(response)

      // Checkpoint assistant first so a safety stop never discards partial work.
      piMessages.push(response)
      options.onNativeMessages?.(structuredClone(piMessages))

      if (response.stopReason === 'aborted' || options.signal?.aborted) {
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
        if (options.signal?.aborted) {
          aborted = true
          break
        }

        const result = await this.executeToolCall(
          toolCall,
          mcpTools,
          enabledSkills,
          projectPath,
          mode,
          toolEvents,
          onToolEvent,
          options.signal,
          options.threadId,
          discovery
        )

        piMessages.push(result)

        // A steer received while this tool was running must take effect at this boundary,
        // rather than waiting for every tool in the model's batch to execute.
        const steerText = options.drainSteer?.()?.trim()
        if (steerText) {
          result.content = appendSteerToToolResultContent(
            result.content as Array<{ type: string; text?: string }>,
            steerText
          ) as ToolResultMessage['content']

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

      if (aborted) break

    }

    // totalTokensUsed reports aggregate processed usage for the turn.
    const totalTokensUsed = accumulatedUsage.processedTokens

    if (!response) {
      if (aborted) {
        return {
          text: '',
          usage: emptyUsage(),
          modelName: model.name,
          totalResponseTimeMs: Date.now() - responseStartedAt,
          totalTokensUsed,
          tokensPerSecond: calculateTokensPerSecond(outputTokens, streamDurationMs),
          contextInputs,
          toolEvents,
          aborted: true,
          nativeMessages: piMessages
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
      usage: response.usage,
      modelName: model.name,
      totalResponseTimeMs: Date.now() - responseStartedAt,
      totalTokensUsed,
      tokensPerSecond: calculateTokensPerSecond(outputTokens, streamDurationMs),
      contextInputs,
      toolEvents,
      aborted: aborted || response.stopReason === 'aborted',
      nativeMessages: piMessages
    }

  }



  async generateTitle(userRequest: string, firstResponse?: string): Promise<string> {
    const configuredProviders = this.providerAuth.getConfiguredLlmProviders()
    const { llmProvider, model: selectedModelId } = resolveTitleModel(
      this.settingsStore.get(),
      configuredProviders
    )
    if (!llmProvider || !selectedModelId) {
      throw new Error('Connect a provider with a title model before generating a chat title.')
    }

    const { baseId, effort } = parseThinkingSuffixFromModelId(selectedModelId)
    const model = this.providerAuth.models.getModel(llmProvider, baseId)
    if (!model) throw new Error(`Unknown title model "${selectedModelId}" for provider "${llmProvider}"`)
    if (!(await this.providerAuth.models.getAuth(model))) {
      throw new Error(`Title provider "${llmProvider}" is not configured.`)
    }

    const prompt = [
      'Write a concise title for this chat (maximum 7 words).',
      'Return only the title: no quotes, markdown, or ending punctuation.',
      '',
      `User request: ${userRequest.slice(0, 4000)}`,
      ...(firstResponse?.trim() ? [`First response: ${firstResponse.slice(0, 6000)}`] : [])
    ].join('\n')
    const titleContext = {
      systemPrompt: 'You name chat threads clearly and specifically.',
      messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }]
    }
    const reasoning = (effort ?? 'off') as ThinkingLevel
    const stream = model.api === 'openai-codex-responses'
      ? this.providerAuth.models.stream(
          model,
          titleContext,
          getReasoningStreamOptions(model.api, reasoning)
        )
      : this.providerAuth.models.streamSimple(
          model,
          titleContext,
          getReasoningStreamOptions(model.api, reasoning) as { reasoning: ThinkingLevel }
        )
    // Bounded like main turns: a dead title connection must fail fast (the caller
    // falls back to a heuristic) instead of leaking a pending promise forever.
    const response = await consumeAssistantStream(
      stream,
      {},
      { inactivityTimeoutMs: DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS }
    )
    return extractAssistantText(response)
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?:;]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
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
      this.providerAuth.models.getModel(llmProvider, catalogModelId) ??
      this.providerAuth.models.getModel(llmProvider, modelId)

    if (!model) {

      return { limit: 128_000, modelName: null }

    }



    return { limit: model.contextWindow, modelName: model.name }

  }



  getSystemPromptForMode(mode: ChatMode = 'agent'): string {
    const { llmProvider } = this.resolveProviderModel(mode)
    return buildOrchestratorSystemPrompt({
      mode,
      providerId: llmProvider,
      projectPath: this.getProjectPath?.()
    })
  }

  async getContextInputs(
    mode: ChatMode = 'agent',
    userContent = '',
    options: Pick<LlmChatOptions, 'llmProvider' | 'model'> = {}
  ): Promise<LlmContextInputs> {
    const normalizedMode = normalizeChatMode(mode)
    const { llmProvider } = this.resolveProviderModel(normalizedMode, options)
    const projectPath = this.getProjectPath?.()
    return (await this.prepareRequestContext(
      normalizedMode,
      userContent,
      projectPath,
      llmProvider,
      false
    )).contextInputs
  }

  /** Validate an optional Mousse subagent model override before allocating its worktree. */
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
      this.providerAuth.models.getModel(llmProvider, baseId) ??
      this.providerAuth.models.getModel(llmProvider, modelId)
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
    discovery?: LlmChatOptions['subagentDiscovery']
  ) {
    const descriptor = typeof mode === 'string' ? modeRegistry.getModeSync(mode, { projectPath }) : undefined
    const isReadOnlyMode = descriptor ? (descriptor.permission?.['edit'] === 'deny' || descriptor.permission?.['bash'] === 'deny') : mode === 'plan'
    const isBuildMode = descriptor ? descriptor.id === 'build' : mode === 'build'
    const [{ enabledSkills, loadedSkills }, mcpTools] = await Promise.all([
      this.prepareSkillsContext(projectPath, mode, userContent),
      isBuildMode ? Promise.resolve([] as McpToolDescriptor[]) : this.getMcpTools(projectPath),
      llmProvider === CURSOR_PROVIDER_ID && projectPath
        ? setCursorSessionProjectScope(projectPath)
        : Promise.resolve()
    ]).then(([skillsContext, tools]) => [skillsContext, tools] as const)

    const mcpToolDefs = mcpTools.map(toPiTool)
    const unfilteredInternalTools = isReadOnlyMode ? [] : this.getInternalSkillTools(enabledSkills, mode)
    const internalTools = unfilteredInternalTools.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    const piToolSet = projectPath ? piToolSetForMode(mode, projectPath) : null
    const unfilteredPiToolDefs =
      projectPath && piToolSet
        ? await this.piCodingTools.getToolDefinitions(projectPath, piToolSet)
        : []
    const unfilteredGitToolDefs =
      isBuildMode && projectPath ? this.buildTools.getGitToolDefinitions() : []
    const piCodingToolDefs = unfilteredPiToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    const buildGitToolDefs = unfilteredGitToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    const isAgentMode = descriptor ? descriptor.id === 'agent' : mode === 'agent'
    // Plan tools are available in Plan mode and in Agent mode alike — the
    // Agent-mode model decides whether presenting a plan, asking, editing,
    // or delegating fits the turn. Subagents and Build/Skill modes stay
    // plan-free so workers implement instead of re-planning.
    const unfilteredPlanToolDefs = !discovery
      ? isReadOnlyMode || (!subagent && isAgentMode)
        ? this.planTools.getToolDefinitions()
        : []
      : []
    const planToolDefs = unfilteredPlanToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    // Task tools for the main orchestrator in every chat mode (not subagents).
    const unfilteredTaskToolDefs =
      !subagent && this.taskTools ? this.taskTools.getToolDefinitions() : []
    const taskToolDefs = unfilteredTaskToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    // Agent-created quick actions: main orchestrator only — approval needs a user.
    const unfilteredQuickActionToolDefs =
      !subagent ? this.quickActionTools.getToolDefinitions() : []
    const quickActionToolDefs = unfilteredQuickActionToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    // Dev GUI self-inspection tools: main orchestrator only, dev sessions only,
    // gated by Settings → Tools like every other Mousse tool.
    const unfilteredDevGuiToolDefs =
      !subagent && isDevGuiToolsEnabled() ? this.devGuiTools.getToolDefinitions() : []
    const devGuiToolDefs = unfilteredDevGuiToolDefs.filter((tool) =>
      this.isMousseToolEnabled(tool.name)
    )
    const otherToolDefs: Tool[] = [
      ...internalTools,
      ...piCodingToolDefs,
      ...buildGitToolDefs,
      ...planToolDefs,
      ...taskToolDefs,
      ...quickActionToolDefs,
      ...devGuiToolDefs
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
      subagentDiscovery: Boolean(discovery)
    })
    const mcpToolsText = serializeToolDefinitions(mcpToolDefs)
    const otherToolsText = serializeToolDefinitions(otherToolDefs)
    const contextInputs: LlmContextInputs = {
      systemPromptText: systemPrompt,
      mcpToolsText,
      otherToolsText,
      signature: `${systemPrompt}\u0000${mcpToolsText}\u0000${otherToolsText}`
    }

    return { enabledSkills, loadedSkills, mcpTools, tools, systemPrompt, contextInputs }
  }



  private async prepareSkillsContext(
    projectPath: string | undefined,
    mode: ChatMode,
    userContent: string
  ): Promise<{
    enabledSkills: SkillDescriptor[]
    loadedSkills: Array<{ name: string; content: string }>
  }> {
    if (!this.skillsRegistry) {
      return { enabledSkills: [], loadedSkills: [] }
    }

    const settings = this.settingsStore.get().integrations.skills
    if (!settings.enabled || !settings.enableForMainAgent) {
      return { enabledSkills: [], loadedSkills: [] }
    }

    const snapshot = await this.skillsRegistry.discover({ projectPath })
    const enabledSkills = this.filterEnabledSkills(snapshot, mode, settings)
    const modeSkills = await this.loadSkillForMode(mode, projectPath, snapshot)
    const explicitSkills = await this.loadExplicitSkills(userContent, enabledSkills, projectPath, snapshot)
    const loadedSkills = [
      ...modeSkills,
      ...explicitSkills.filter(
        (skill) => !modeSkills.some((loaded) => loaded.name === skill.name)
      )
    ]

    return { enabledSkills, loadedSkills }
  }

  private filterEnabledSkills(
    snapshot: SkillsRegistrySnapshot,
    mode: ChatMode | undefined,
    settings: { enabledSkills: string[] }
  ): SkillDescriptor[] {
    const selected = new Set(settings.enabledSkills)
    const skillId = getSkillIdFromMode(normalizeChatMode(mode))
    return snapshot.skills.filter((skill) => {
      if (skill.isActive === false) return false
      if (skillId) return skill.id === skillId
      if (selected.size === 0) return false
      return selected.has(skill.id) || selected.has(skill.name)
    })
  }

  private async getMcpTools(projectPath?: string): Promise<McpToolDescriptor[]> {

    if (!this.mcpManager) return []
    // Context usage and the live request must observe the same schemas. Surface discovery
    // failures instead of silently presenting stale/under-counted context numbers.
    return this.mcpManager.getEnabledTools(projectPath)

  }

  private isMousseToolEnabled(toolName: string): boolean {
    const tools = this.settingsStore.get().integrations.tools
    if (!tools || tools.enabled === false) {
      // Missing settings (pre-migration configs) default to all enabled.
      if (!tools) return true
      return false
    }
    const enabled = tools.enabledTools
    if (!Array.isArray(enabled)) return true
    // Empty explicit list means nothing selected; default list means all.
    if (enabled.length === 0) return false
    const canonical = MOUSSE_TOOL_ALIASES[toolName] ?? toolName
    if (enabled.includes(toolName) || enabled.includes(canonical)) return true
    return false
  }



  private async loadSkillForMode(
    mode: ChatMode,
    projectPath?: string,
    snapshot?: SkillsRegistrySnapshot
  ): Promise<Array<{ name: string; content: string }>> {
    const skillId = getSkillIdFromMode(mode)
    if (!skillId || !this.skillsRegistry) return []

    const result = await this.skillsRegistry.readSkill(skillId, { projectPath }, snapshot)
    return [{ name: result.skill.name, content: truncateForModel(result.content) }]
  }

  private async loadExplicitSkills(
    userContent: string,
    availableSkills: SkillDescriptor[],
    projectPath?: string,
    snapshot?: SkillsRegistrySnapshot
  ): Promise<Array<{ name: string; content: string }>> {

    if (!this.skillsRegistry) return []

    const requestedNames = Array.from(userContent.matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)/g)).map(

      (match) => match[1].toLowerCase()

    )

    if (requestedNames.length === 0) return []



    const loaded: Array<{ name: string; content: string }> = []

    for (const name of requestedNames) {

      const skill = availableSkills.find((candidate) => normalizeSkillName(candidate.name) === name)

      if (!skill) continue

      const result = await this.skillsRegistry.readSkill(skill.id, { projectPath }, snapshot)

      loaded.push({ name: result.skill.name, content: truncateForModel(result.content) })

    }

    return loaded

  }



  private getInternalSkillTools(availableSkills: SkillDescriptor[], mode: ChatMode): Tool[] {

    if (!this.skillsRegistry || availableSkills.length === 0 || mode === 'build') return []

    return [

      {

        name: 'list_skills',

        description: 'List available Mousse Agent Skills with descriptions and scopes.',

        parameters: Type.Object({})

      },

      {

        name: 'load_skill',

        description: 'Load the full SKILL.md instructions for one available Skill by name or id.',

        parameters: Type.Object({

          skill: Type.String({ description: 'Skill name or id to load.' })

        })

      }

    ]

  }



  private async executeToolCall(

    toolCall: ToolCall,

    mcpTools: McpToolDescriptor[],

    availableSkills: SkillDescriptor[],

    projectPath: string | undefined,

    mode: ChatMode,

    toolEvents: LlmToolEvent[],

    onToolEvent?: LlmToolEventHandler,

    signal?: AbortSignal,

    threadId?: string,

    discovery?: LlmChatOptions['subagentDiscovery']

  ): Promise<ToolResultMessage> {

    try {

      if (toolCall.name === 'declare_files' && discovery) {
        const rawFiles = Array.isArray(toolCall.arguments.files) ? toolCall.arguments.files : []
        const files = [...new Set(rawFiles.map(String).map((file) => file.trim()).filter(Boolean))]
        if (files.length === 0) return toolResult(toolCall, 'At least one file is required.', true)
        const rationale = typeof toolCall.arguments.rationale === 'string'
          ? toolCall.arguments.rationale.trim()
          : undefined
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

      if (toolCall.name === 'list_skills') {

        if (!this.isMousseToolEnabled('list_skills')) {
          return toolResult(toolCall, 'Tool "list_skills" is disabled in Settings → Tools.', true)
        }
        return toolResult(toolCall, JSON.stringify(availableSkills.map(toSkillSummary), null, 2))

      }



      if (toolCall.name === 'load_skill') {

        if (!this.isMousseToolEnabled('load_skill')) {
          return toolResult(toolCall, 'Tool "load_skill" is disabled in Settings → Tools.', true)
        }
        const requested = String(toolCall.arguments.skill ?? '')

        const skill = availableSkills.find(

          (candidate) =>

            candidate.id === requested ||

            candidate.name === requested ||

            normalizeSkillName(candidate.name) === normalizeSkillName(requested)

        )

        if (!skill) return toolResult(toolCall, `Skill not found: ${requested}`, true)

        if (skill['disable-model-invocation']) {

          return toolResult(toolCall, `Skill ${skill.name} can only be loaded by explicit user invocation.`, true)

        }

        const result = await this.skillsRegistry!.readSkill(skill.id, { projectPath })

        const skillEvent: LlmToolEvent = {

          kind: 'skill_loaded',

          title: `Loaded skill ${result.skill.name}`,

          summary: 'Loaded Skill instructions through the orchestrator tool loop.',

          details: [`Skill: ${result.skill.name}`, `Characters: ${result.content.length}`]

        }

        toolEvents.push(skillEvent)

        onToolEvent?.({ ...skillEvent, phase: 'complete', callId: toolCall.id })

        return toolResult(toolCall, truncateForModel(result.content))

      }



      if (this.planTools.isPlanTool(toolCall.name)) {

        if (!this.isMousseToolEnabled(toolCall.name)) {
          return toolResult(toolCall, `Tool "${toolCall.name}" is disabled in Settings → Tools.`, true)
        }
        const callEvent: LlmToolEvent = {

          kind: 'build_tool_call',

          title: `Plan tool ${toolCall.name}`,

          summary: 'The assistant called a plan tool.',

          details: [`Tool: ${toolCall.name}`],

          response: JSON.stringify(toolCall.arguments, null, 2)

        }

        toolEvents.push(callEvent)

        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })



        const result = await this.planTools.execute(

          toolCall.name,

          toolCall.arguments as Record<string, unknown>,

          threadId

        )

        const resultEvent: LlmToolEvent = {

          kind: 'build_tool_result',

          title: `Plan tool ${toolCall.name}`,

          summary: result.isError ? 'The plan tool returned an error.' : 'The plan tool returned successfully.',

          details: [`Tool: ${toolCall.name}`],

          response: truncateForDisplay(result.text)

        }

        toolEvents.push(resultEvent)

        onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })

        return toolResult(toolCall, result.text, result.isError)

      }

      if (this.taskTools?.isTaskTool(toolCall.name)) {
        if (!this.isMousseToolEnabled(toolCall.name)) {
          return toolResult(toolCall, `Tool "${toolCall.name}" is disabled in Settings → Tools.`, true)
        }
        const callEvent: LlmToolEvent = {
          kind: 'build_tool_call',
          title: `Task tool ${toolCall.name}`,
          summary: 'The orchestrator updated the thread task queue.',
          details: [`Tool: ${toolCall.name}`],
          response: JSON.stringify(toolCall.arguments, null, 2)
        }
        toolEvents.push(callEvent)
        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })

        const result = await this.taskTools.execute(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>
        )

        const resultEvent: LlmToolEvent = {
          kind: 'build_tool_result',
          title: `Task tool ${toolCall.name}`,
          summary: result.isError ? 'The task tool returned an error.' : 'The task tool returned successfully.',
          details: [`Tool: ${toolCall.name}`],
          response: truncateForDisplay(result.text)
        }
        toolEvents.push(resultEvent)

        onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })
        return toolResult(toolCall, result.text, result.isError)
      }



      if (this.quickActionTools.isQuickActionTool(toolCall.name)) {
        if (!this.isMousseToolEnabled(toolCall.name)) {
          return toolResult(toolCall, `Tool "${toolCall.name}" is disabled in Settings → Tools.`, true)
        }
        const callEvent: LlmToolEvent = {
          kind: 'build_tool_call',
          title: `Quick action ${toolCall.name}`,
          summary: 'The orchestrator is creating a chat header quick action.',
          details: [`Tool: ${toolCall.name}`],
          response: JSON.stringify(toolCall.arguments, null, 2)
        }
        toolEvents.push(callEvent)
        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })

        const result = await this.quickActionTools.execute(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          threadId
        )

        const resultEvent: LlmToolEvent = {
          kind: 'build_tool_result',
          title: `Quick action ${toolCall.name}`,
          summary: result.isError ? 'The quick-action tool returned an error.' : 'The quick-action tool returned successfully.',
          details: [`Tool: ${toolCall.name}`],
          response: truncateForDisplay(result.text)
        }
        toolEvents.push(resultEvent)
        onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })
        return toolResult(toolCall, result.text, result.isError)
      }


      if (this.devGuiTools.isDevGuiTool(toolCall.name)) {
        if (!isDevGuiToolsEnabled()) {
          return toolResult(
            toolCall,
            'Dev GUI tools are only available in development (`npm run dev`).',
            true
          )
        }
        const callEvent: LlmToolEvent = {
          kind: 'build_tool_call',
          title: `Dev GUI ${toolCall.name}`,
          summary: 'The orchestrator is inspecting the dev Electron window.',
          details: [`Tool: ${toolCall.name}`],
          response: JSON.stringify(toolCall.arguments, null, 2)
        }
        toolEvents.push(callEvent)
        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })

        const result = await this.devGuiTools.execute(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>
        )

        const resultEvent: LlmToolEvent = {
          kind: 'build_tool_result',
          title: `Dev GUI ${toolCall.name}`,
          summary: result.isError
            ? 'The dev GUI tool returned an error.'
            : 'The dev GUI tool returned successfully.',
          details: [`Tool: ${toolCall.name}`],
          response: truncateForDisplay(result.text)
        }
        toolEvents.push(resultEvent)
        onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })

        // Screenshot carries a vision image block; all other tools are text-only.
        return {
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            { type: 'text', text: result.text },
            ...(result.image
              ? [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType } as const]
              : [])
          ],
          isError: result.isError,
          timestamp: Date.now()
        }
      }

      if (this.piCodingTools.isPiTool(toolCall.name) || this.buildTools.isGitTool(toolCall.name) || this.buildTools.isBuildTool(toolCall.name)) {
        const normalizedMode = normalizeChatMode(mode)
        if (typeof normalizedMode === 'string') {
          const descriptor = modeRegistry.getModeSync(normalizedMode, { projectPath })
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

        if (!this.isMousseToolEnabled(toolCall.name)) {
          return toolResult(toolCall, `Tool "${toolCall.name}" is disabled in Settings → Tools → Mousse tools.`, true)
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

        onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })

        return toolResult(toolCall, result.text, result.isError)

      }



      const mcpTool = mcpTools.find((tool) => tool.providerName === toolCall.name)

      if (!mcpTool || !this.mcpManager) {

        return toolResult(toolCall, `Unknown tool: ${toolCall.name}`, true)

      }



      const callEvent: LlmToolEvent = {

        kind: 'mcp_tool_call',

        title: `Called ${mcpTool.serverName}.${mcpTool.toolName}`,

        summary: 'The orchestrator called an MCP tool.',

        details: [`Server: ${mcpTool.serverName}`, `Tool: ${mcpTool.toolName}`],

        response: JSON.stringify(toolCall.arguments, null, 2)

      }

      toolEvents.push(callEvent)

      onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })



      const result = await this.mcpManager.callTool(toolCall.name, toolCall.arguments, projectPath)

      const resultEvent: LlmToolEvent = {

        kind: 'mcp_tool_result',

        title: `Called ${mcpTool.serverName}.${mcpTool.toolName}`,

        summary: result.isError ? 'The MCP tool returned an error.' : 'The MCP tool returned successfully.',

        details: [`Server: ${mcpTool.serverName}`, `Tool: ${mcpTool.toolName}`],

        response: truncateForDisplay(result.text)

      }

      toolEvents.push(resultEvent)

      onToolEvent?.({ ...resultEvent, phase: 'complete', callId: toolCall.id })

      return toolResult(toolCall, result.text, result.isError)

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

function toPiTool(tool: McpToolDescriptor): Tool {

  return {

    name: tool.providerName,

    description: tool.description || `Call ${tool.toolName} on MCP server ${tool.serverName}.`,

    parameters: toTypeboxSchema(tool.inputSchema)

  }

}



function toTypeboxSchema(schema: Record<string, unknown> | undefined): TSchema {

  if (schema && schema.type === 'object') {

    return schema as unknown as TSchema

  }

  return Type.Object({}, { additionalProperties: true })

}



function toolResult(toolCall: ToolCall, text: string, isError = false): ToolResultMessage {

  return {

    role: 'toolResult',

    toolCallId: toolCall.id,

    toolName: toolCall.name,

    content: [{ type: 'text', text }],

    isError,

    timestamp: Date.now()

  }

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



function toSkillSummary(skill: SkillDescriptor): Record<string, unknown> {

  return {

    id: skill.id,

    name: skill.name,

    description: skill.description,

    scope: skill.scope,

    source: skill.source,

    paths: skill.paths,

    modelInvocationDisabled: skill['disable-model-invocation'] === true

  }

}



function normalizeSkillName(value: string): string {

  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')

}



function truncateForModel(value: string): string {

  return value.length > 16_000 ? `${value.slice(0, 16_000)}\n...[truncated]` : value

}



function truncateForDisplay(value: string): string {

  return value.length > 1_200 ? `${value.slice(0, 1_200)}\n...[truncated]` : value

}



export function parseActions(response: string): OrchestratorAction[] {
  const actions: OrchestratorAction[] = []

  // Orchestration is executable only in an explicitly marked fence. Generic JSON
  // is frequently used for discussion/examples and must never have side effects.
  // Extract by brace-balanced JSON so nested markdown fences inside task strings
  // (for example ```ts) cannot truncate the payload.
  for (const block of extractMousseActionBlocks(response)) {
    try {
      const parsed = JSON.parse(block.json)

      if (Array.isArray(parsed.actions)) {
        for (const a of parsed.actions) {
          if (isValidAction(a)) actions.push(a)
        }
      } else if (isValidAction(parsed)) {
        actions.push(parsed)
      }
    } catch {
      /* skip invalid JSON */
    }
  }

  return actions
}

export function stripActionBlocks(response: string): string {
  const blocks = extractMousseActionBlocks(response)
  if (blocks.length === 0) return response.trim()

  let result = ''
  let cursor = 0
  for (const block of blocks) {
    result += response.slice(cursor, block.start)
    try {
      const parsed = JSON.parse(block.json)
      if (!hasActionPayload(parsed)) {
        result += response.slice(block.start, block.end)
      }
    } catch {
      result += response.slice(block.start, block.end)
    }
    cursor = block.end
  }
  result += response.slice(cursor)

  return result.trim()
}

/**
 * Locate ```mousse-actions fences and extract their JSON payloads with a
 * string-aware brace balancer. Closing ``` is optional for extraction; nested
 * ``` markers inside JSON string values must not terminate the payload.
 */
function extractMousseActionBlocks(
  response: string
): Array<{ start: number; end: number; json: string }> {
  const blocks: Array<{ start: number; end: number; json: string }> = []
  const openTag = '```mousse-actions'
  let searchFrom = 0

  while (searchFrom < response.length) {
    const fenceStart = response.indexOf(openTag, searchFrom)
    if (fenceStart === -1) break

    const afterTag = fenceStart + openTag.length
    // Require a whitespace/newline boundary so ```mousse-actions-extra is ignored.
    if (afterTag < response.length && !/\s/.test(response[afterTag]!)) {
      searchFrom = afterTag
      continue
    }

    let i = afterTag
    while (i < response.length && /\s/.test(response[i]!)) i++

    const jsonStartChar = response[i]
    if (jsonStartChar !== '{' && jsonStartChar !== '[') {
      searchFrom = afterTag
      continue
    }

    const extracted = extractBalancedJson(response, i)
    if (!extracted) {
      searchFrom = afterTag
      continue
    }

    let end = extracted.end
    // Prefer consuming a trailing closing fence when present.
    let j = end
    while (j < response.length && /[ \t\r\n]/.test(response[j]!)) j++
    if (response.startsWith('```', j)) {
      end = j + 3
    }

    blocks.push({ start: fenceStart, end, json: extracted.json })
    searchFrom = end
  }

  return blocks
}

function extractBalancedJson(
  source: string,
  start: number
): { json: string; end: number } | null {
  const open = source[start]
  if (open !== '{' && open !== '[') return null

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < source.length; i++) {
    const ch = source[i]!

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }

    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '['
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return null
      }
      stack.pop()
      if (stack.length === 0) {
        return { json: source.slice(start, i + 1), end: i + 1 }
      }
    }
  }

  return null
}

export function filterActionsForChatMode(

  actions: OrchestratorAction[],

  mode: ChatMode

): OrchestratorAction[] {
  if (typeof mode === 'string') {
    const desc = modeRegistry.getModeSync(mode, {})
    if (desc) {
      const allowed = desc.permission?.['task'] !== 'deny'
      if (allowed) return actions
      return actions.filter((a) => a.type !== 'spawn_agents' && a.type !== 'complete_task')
    }
  }
  return filterActionsForMode(actions, mode)

}



export function rejectOrchestrationAction(action: OrchestratorAction, mode: ChatMode): boolean {
  if (typeof mode === 'string') {
    const desc = modeRegistry.getModeSync(mode, {})
    if (desc) {
      const allowed = desc.permission?.['task'] !== 'deny'
      if (allowed) return false
      return action.type === 'spawn_agents' || action.type === 'complete_task'
    }
  }
  if (allowsOrchestrationActions(mode)) return false

  return action.type === 'spawn_agents' || action.type === 'complete_task'

}



function hasActionPayload(value: unknown): boolean {

  if (isValidAction(value)) return true

  if (!value || typeof value !== 'object') return false



  const obj = value as Record<string, unknown>

  return Array.isArray(obj.actions) && obj.actions.some((action) => isValidAction(action))

}



function isValidAction(a: unknown): a is OrchestratorAction {

  if (!a || typeof a !== 'object') return false

  const obj = a as Record<string, unknown>

  if (obj.type === 'spawn_agents' && Array.isArray(obj.agents)) return true

  if (
    obj.type === 'complete_task' &&
    Array.isArray(obj.agentIds) &&
    obj.agentIds.length > 0 &&
    obj.agentIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) return true

  if (obj.type === 'message' && typeof obj.content === 'string') return true

  return false

}


