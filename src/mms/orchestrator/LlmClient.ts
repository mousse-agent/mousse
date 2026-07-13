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

import { resolveModelForMode } from '../../shared/settings'

import { parseThinkingSuffixFromModelId } from '../../shared/modelVariants'

import type { SettingsStore } from '../settings/SettingsStore'

import type { ProviderAuthService } from '../providers/ProviderAuthService'

import type { McpManager } from '../integrations/mcp/McpManager'

import type { SkillsRegistry } from '../integrations/skills/SkillsRegistry'

import type { FileService } from '../files/FileService'

import type { GitService } from '../git/GitService'

import { BuildModeTools } from './BuildModeTools'
import { PiCodingTools, piToolSetForMode } from './PiCodingTools'
import { PlanModeTools } from './PlanModeTools'
import { userQuestionService } from './UserQuestionService'
import type { DocumentOpenPayload } from '../../shared/types'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'

import { buildOrchestratorSystemPrompt } from './systemPrompt'
import { appendSteerToToolResultContent } from './steer'
import {
  CURSOR_PROVIDER_ID,
  setCursorSessionProjectScope
} from '../providers/cursorPiProvider'



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

  /**
   * When true, the model is a Mousse subagent implementing a delegated task.
   * Uses coding tools without spawn_agents orchestration instructions.
   */
  subagent?: boolean

  /** Abort in-flight stream and tool loop. */
  signal?: AbortSignal

  /**
   * Drain pending mid-turn steer text after each tool batch.
   * Injected into the last tool result with OOB markers (not a new user role).
   */
  drainSteer?: () => string | undefined

}



function extractAssistantText(message: AssistantMessage): string {

  // Aborted streams may still carry partial text plus an errorMessage.
  if (message.errorMessage && message.stopReason !== 'aborted') {

    throw new Error(message.errorMessage)

  }



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

  toolEvents: LlmToolEvent[]

  aborted?: boolean

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
}

export type LlmTextEventHandler = (event: StreamingLlmTextEvent) => void

async function consumeAssistantStream(
  stream: AssistantMessageEventStream,
  handlers: {
    onThinking?: LlmThinkingEventHandler
    onText?: LlmTextEventHandler
  } = {}
): Promise<AssistantMessage> {
  const thinkingContentRef = { current: '' }
  const textContentRef = { current: '' }
  const textStartedRef = { current: false }

  for await (const event of stream) {
    handleThinkingStreamEvent(event, handlers.onThinking, thinkingContentRef)
    handleTextStreamEvent(event, handlers.onText, textContentRef, textStartedRef)
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

function handleTextStreamEvent(
  event: AssistantMessageEvent,
  onText: LlmTextEventHandler | undefined,
  textContentRef: { current: string },
  textStartedRef: { current: boolean }
): void {
  if (!onText) return

  if (event.type === 'text_start') {
    if (!textStartedRef.current) {
      textStartedRef.current = true
      textContentRef.current = ''
      onText({ phase: 'start', content: '' })
    }
    return
  }

  if (event.type === 'text_delta') {
    if (!textStartedRef.current) {
      textStartedRef.current = true
      textContentRef.current = ''
      onText({ phase: 'start', content: '' })
    }
    textContentRef.current += event.delta
    onText({ phase: 'delta', content: textContentRef.current })
    return
  }

  if (event.type === 'text_end') {
    if (!textStartedRef.current) {
      textStartedRef.current = true
      onText({ phase: 'start', content: '' })
    }
    if ('content' in event && typeof event.content === 'string') {
      textContentRef.current = event.content
    }
    onText({ phase: 'complete', content: textContentRef.current })
  }
}

export class LlmClient {

  private buildTools: BuildModeTools

  private piCodingTools: PiCodingTools

  private planTools: PlanModeTools



  constructor(

    private settingsStore: SettingsStore,

    private providerAuth: ProviderAuthService,

    private mcpManager?: McpManager,

    private skillsRegistry?: SkillsRegistry,

    private getProjectPath?: () => string | undefined,

    fileService?: FileService,

    gitService?: GitService,

    lineEditStats?: LineEditStatsStore,

    private onOpenDocument?: (payload: DocumentOpenPayload) => void

  ) {

    this.buildTools = new BuildModeTools(fileService!, gitService!, lineEditStats)
    this.piCodingTools = new PiCodingTools(lineEditStats)

    this.planTools = new PlanModeTools(
      (questions) => userQuestionService.requestAnswers(questions),
      (payload) => this.onOpenDocument?.(payload)
    )

  }



  async chat(

    messages: LlmMessage[],

    onToolEvent?: LlmToolEventHandler,

    options: LlmChatOptions = {},

    onThinkingEvent?: LlmThinkingEventHandler,

    onTextEvent?: LlmTextEventHandler

  ): Promise<LlmChatResult> {

    const subagent = options.subagent === true
    // Subagents implement work with the full coding tool set (same as Build).
    const mode = subagent ? ('build' as const) : normalizeChatMode(options.mode)

    const { llmProvider, model: modelId } = this.resolveProviderModel(
      subagent ? normalizeChatMode(options.mode) : mode,
      options
    )



    if (!this.providerAuth.has(llmProvider)) {

      throw new Error(

        `Provider "${llmProvider}" is not connected. Add and authenticate it in Settings.`

      )

    }



    const { baseId: catalogModelId, effort: reasoningLevel } = parseThinkingSuffixFromModelId(modelId)

    const model =
      this.providerAuth.models.getModel(llmProvider, catalogModelId) ??
      this.providerAuth.models.getModel(llmProvider, modelId)

    if (!model) {

      throw new Error(`Unknown model "${modelId}" for provider "${llmProvider}"`)

    }



    const auth = await this.providerAuth.models.getAuth(model)

    if (!auth) {

      throw new Error(

        `Provider "${llmProvider}" is not configured. Re-authenticate it in Settings.`

      )

    }



    const projectPath = this.getProjectPath?.()
    const userContent = messages.at(-1)?.content ?? ''

    const [{ enabledSkills, loadedSkills }, mcpTools] = await Promise.all([
      this.prepareSkillsContext(projectPath, mode, userContent),
      mode === 'build' ? Promise.resolve([] as McpToolDescriptor[]) : this.getMcpTools(projectPath),
      llmProvider === CURSOR_PROVIDER_ID && projectPath
        ? setCursorSessionProjectScope(projectPath)
        : Promise.resolve()
    ]).then(([skillsContext, tools]) => [skillsContext, tools] as const)

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



    const internalTools = mode === 'plan' ? [] : this.getInternalSkillTools(enabledSkills, mode)

    const piToolSet = projectPath ? piToolSetForMode(mode) : null
    const piCodingToolDefs =
      projectPath && piToolSet
        ? await this.piCodingTools.getToolDefinitions(projectPath, piToolSet)
        : []

    // Keep git helpers only in build mode (Pi tools cover file/shell/search).
    const buildGitToolDefs =
      mode === 'build' && projectPath ? this.buildTools.getGitToolDefinitions() : []

    const planToolDefs = mode === 'plan' ? this.planTools.getToolDefinitions() : []

    const tools = [
      ...mcpTools.map(toPiTool),
      ...internalTools,
      ...piCodingToolDefs,
      ...buildGitToolDefs,
      ...planToolDefs
    ]

    const piMessages = toPiMessages(messages)

    const systemPrompt = buildOrchestratorSystemPrompt({

      mode: subagent ? 'build' : mode,

      providerId: llmProvider,

      skills: enabledSkills,

      loadedSkills,

      subagent

    })



    let response: AssistantMessage | null = null
    let aborted = Boolean(options.signal?.aborted)

    for (let iteration = 0; iteration < 24; iteration += 1) {
      if (options.signal?.aborted) {
        aborted = true
        break
      }

      response = await consumeAssistantStream(
        this.providerAuth.models.streamSimple(
          model,
          {
            systemPrompt,
            messages: piMessages,
            tools: tools.length > 0 ? tools : undefined
          },
          {
            reasoning: (reasoningLevel ?? 'off') as ThinkingLevel,
            signal: options.signal
          }
        ),
        {
          onThinking: onThinkingEvent,
          onText: onTextEvent
        }
      )

      if (response.stopReason === 'aborted' || options.signal?.aborted) {
        aborted = true
        break
      }

      const toolCalls = response.content.filter((block): block is ToolCall => block.type === 'toolCall')

      if (response.stopReason !== 'toolUse' || toolCalls.length === 0) break

      piMessages.push(response)

      for (const toolCall of toolCalls) {
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
          onToolEvent
        )

        piMessages.push(result)
      }

      if (aborted) break

      // Inject mid-turn steer into the last tool result (not a new user role).
      const steerText = options.drainSteer?.()?.trim()
      if (steerText) {
        for (let i = piMessages.length - 1; i >= 0; i -= 1) {
          const msg = piMessages[i]
          if (msg && msg.role === 'toolResult') {
            const toolMsg = msg as ToolResultMessage
            toolMsg.content = appendSteerToToolResultContent(
              toolMsg.content as Array<{ type: string; text?: string }>,
              steerText
            ) as ToolResultMessage['content']
            break
          }
        }
      }
    }

    if (!response) {
      if (aborted) {
        return {
          text: '',
          usage: emptyUsage(),
          toolEvents,
          aborted: true
        }
      }
      throw new Error('LLM returned no response.')
    }

    return {
      text: extractAssistantText(response),
      usage: response.usage,
      toolEvents,
      aborted: aborted || response.stopReason === 'aborted'
    }

  }



  getSelectedModelContextLimit(mode: ChatMode = 'agent'): { limit: number; modelName: string | null } {

    const { llmProvider, model: modelId } = this.resolveProviderModel(mode)

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
    return buildOrchestratorSystemPrompt({ mode, providerId: llmProvider })
  }



  private resolveProviderModel(mode: ChatMode, options: LlmChatOptions = {}): { llmProvider: string; model: string } {

    if (options.llmProvider && options.model) {

      return { llmProvider: options.llmProvider, model: options.model }

    }

    const connected = this.providerAuth.credentials.listProviderIds()

    return resolveModelForMode(this.settingsStore.get(), mode, connected)

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

    try {

      return await this.mcpManager.getEnabledTools(projectPath)

    } catch (err) {

      console.warn('[LlmClient] Failed to list MCP tools:', err)

      return []

    }

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

    onToolEvent?: LlmToolEventHandler

  ): Promise<ToolResultMessage> {

    try {

      if (toolCall.name === 'list_skills') {

        return toolResult(toolCall, JSON.stringify(availableSkills.map(toSkillSummary), null, 2))

      }



      if (toolCall.name === 'load_skill') {

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

        const callEvent: LlmToolEvent = {

          kind: 'build_tool_call',

          title: `Plan tool ${toolCall.name}`,

          summary: 'The planning assistant called a plan-mode tool.',

          details: [`Tool: ${toolCall.name}`],

          response: JSON.stringify(toolCall.arguments, null, 2)

        }

        toolEvents.push(callEvent)

        onToolEvent?.({ ...callEvent, phase: 'start', callId: toolCall.id })



        const result = await this.planTools.execute(

          toolCall.name,

          toolCall.arguments as Record<string, unknown>

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



      if (this.piCodingTools.isPiTool(toolCall.name) || this.buildTools.isGitTool(toolCall.name)) {

        if (!projectPath) {

          return toolResult(toolCall, 'No project root selected for project tools.', true)

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
              toolCall.id
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

  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g

  let match: RegExpExecArray | null



  while ((match = jsonBlockRegex.exec(response)) !== null) {

    try {

      const parsed = JSON.parse(match[1].trim())

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



  if (actions.length === 0) {

    const inline = response.match(/\{[\s\S]*"actions"[\s\S]*\}/)

    if (inline) {

      try {

        const parsed = JSON.parse(inline[0])

        if (Array.isArray(parsed.actions)) {

          for (const a of parsed.actions) {

            if (isValidAction(a)) actions.push(a)

          }

        }

      } catch {

        /* ignore */

      }

    }

  }



  return actions

}



export function stripActionBlocks(response: string): string {

  const withoutFencedActions = response

    .replace(/```(?:json)?\s*([\s\S]*?)```/g, (block, body) => {

      try {

        const parsed = JSON.parse(String(body).trim())

        return hasActionPayload(parsed) ? '' : block

      } catch {

        return block

      }

    })



  const inline = withoutFencedActions.match(/\{[\s\S]*"actions"[\s\S]*\}/)

  if (!inline) return withoutFencedActions.trim()



  try {

    const parsed = JSON.parse(inline[0])

    if (hasActionPayload(parsed)) {

      return withoutFencedActions.replace(inline[0], '').trim()

    }

  } catch {

    /* keep invalid inline JSON visible */

  }



  return withoutFencedActions.trim()

}



export function filterActionsForChatMode(

  actions: OrchestratorAction[],

  mode: ChatMode

): OrchestratorAction[] {

  return filterActionsForMode(actions, mode)

}



export function rejectOrchestrationAction(action: OrchestratorAction, mode: ChatMode): boolean {

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

  if (obj.type === 'complete_task') return true

  if (obj.type === 'message' && typeof obj.content === 'string') return true

  return false

}


