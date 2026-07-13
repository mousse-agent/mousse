import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import {
  type Agent,
  type ChatImageAttachment,
  type ChatMode,
  type ChatMessage,
  type CliType,
  type ContextUsageSnapshot,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput
} from '../../shared/types'
import { allowsOrchestrationActions, normalizeChatMode } from '../../shared/chatMode'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { PtyManager } from '../terminals/PtyManager'
import { HeadlessAgentRunner } from '../terminals/HeadlessAgentRunner'
import { MacroEngine } from '../macros/MacroEngine'
import { LlmClient, parseActions, stripActionBlocks, type LlmMessage, type StreamingLlmThinkingEvent, type StreamingLlmToolEvent, filterActionsForChatMode, rejectOrchestrationAction } from './LlmClient'
import { computeContextUsage } from './contextUsage'
import { getToolCallDisplay } from '../../shared/toolCallDisplay'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
import type { McpManager } from '../integrations/mcp/McpManager'
import type { SkillsRegistry } from '../integrations/skills/SkillsRegistry'
import type { AgentConfigManager } from '../integrations/agents/AgentConfigManager'
import type { FileService } from '../files/FileService'
import type { GitService } from '../git/GitService'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { applyProjectWorkingDirectory } from '../data/projectWorkingDirectory'
import { MousseAgentService } from '../agents/MousseAgentService'

interface NormalizedOrchestratorSendRequest {
  content: string
  mode: ChatMode
  images?: ChatImageAttachment[]
}

interface NormalizedContextUsageRequest {
  draftInput: string
  mode: ChatMode
}

function normalizeSendRequest(request: OrchestratorSendInput): NormalizedOrchestratorSendRequest {
  if (typeof request === 'string') {
    return { content: request, mode: normalizeChatMode(), images: undefined }
  }

  return {
    content: request.content,
    mode: normalizeChatMode(request.mode),
    images: request.images?.filter((img) => img.data && img.mimeType)
  }
}

function normalizeContextUsageRequest(
  request: OrchestratorContextUsageInput
): NormalizedContextUsageRequest {
  if (typeof request === 'string') {
    return { draftInput: request, mode: normalizeChatMode() }
  }

  return {
    draftInput: request.draftInput ?? '',
    mode: normalizeChatMode(request.mode)
  }
}

export class OrchestratorService extends EventEmitter {
  private llm: LlmClient
  private messages: ChatMessage[] = []
  private history: LlmMessage[] = []
  private persistFn?: () => void
  private lastMeasuredInput: number | null = null
  private lastMeasuredCacheRead: number | null = null
  private measuredAtHistoryLength = 0
  private activeToolCallMessageIds = new Map<string, string>()
  private activeThinkingMessageId: string | null = null
  private activeAssistantMessageId: string | null = null
  private assistantStreamBase = ''
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private mousseAgents: MousseAgentService
  /** In-flight GUI/CLI turn control (abort + mid-turn steer). */
  private activeTurn: {
    abort: AbortController
    pendingSteer: string[]
  } | null = null
  /** In-flight channel turns keyed by mousse thread id. */
  private channelTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[] }
  >()

  constructor(
    private agents: AgentRegistry,
    private tasks: TaskQueue,
    private worktrees: WorktreeManager,
    private ptyManager: PtyManager,
    private headlessRunner: HeadlessAgentRunner,
    private macros: MacroEngine,
    settingsStore: SettingsStore,
    providerAuth: ProviderAuthService,
    private mcpManager?: McpManager,
    private skillsRegistry?: SkillsRegistry,
    private agentConfigManager?: AgentConfigManager,
    fileService?: FileService,
    gitService?: GitService,
    lineEditStats?: LineEditStatsStore,
    private projectManager?: ProjectManager
  ) {
    super()
    this.llm = new LlmClient(
      settingsStore,
      providerAuth,
      mcpManager,
      skillsRegistry,
      () => this.worktrees.getRepoRoot(),
      fileService,
      gitService,
      lineEditStats,
      (payload) => this.emit('document-opened', payload)
    )

    this.mousseAgents = new MousseAgentService(this.llm, {
      spawnAgents: (specs) => this.spawnAgents(specs as Array<{ cliType: CliType; task: string }>),
      completeAgent: (agentId, merge, summary) => this.completeMousseAgent(agentId, merge, summary)
    })

    this.mousseAgents.on('message', ({ agentId, message }) => {
      this.emit('mousse-agent-message', { agentId, message })
    })
    this.mousseAgents.on('message-updated', ({ agentId, message }) => {
      this.emit('mousse-agent-message-updated', { agentId, message })
    })
    this.mousseAgents.on('messages-sync', ({ agentId, messages }) => {
      this.emit('mousse-agent-messages-sync', { agentId, messages })
    })
    this.mousseAgents.on('complete', ({ agentId, summary }) => {
      this.emit('mousse-agent-complete', { agentId, summary })
    })

    this.headlessRunner.on('exit', ({ agentId, exitCode }) => {
      const agent = this.agents.get(agentId)
      if (!agent || agent.executionMode !== 'headless') return
      if (agent.status === 'merging' || agent.status === 'completed' || agent.status === 'failed') {
        return
      }
      if (exitCode !== 0 && exitCode !== null) {
        this.agents.updateStatus(agentId, 'failed')
        const task = this.tasks.findByAgentId(agentId)
        if (task) this.tasks.updateStatus(task.id, 'failed')
      }
    })
  }

  setPersistCallback(fn: () => void): void {
    this.persistFn = fn
  }

  private persist(immediate = false): void {
    if (immediate) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer)
        this.persistTimer = null
      }
      this.persistFn?.()
      return
    }

    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistFn?.()
    }, 500)
  }

  loadMessages(messages: ChatMessage[]): void {
    this.messages = [...messages]
    this.history = this.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    this.lastMeasuredInput = null
    this.lastMeasuredCacheRead = null
    this.measuredAtHistoryLength = 0
  }

  getMessages(): ChatMessage[] {
    return [...this.messages]
  }

  getContextUsage(input: OrchestratorContextUsageInput = ''): ContextUsageSnapshot {
    const request = normalizeContextUsageRequest(input)
    const { limit, modelName } = this.llm.getSelectedModelContextLimit(request.mode)
    return computeContextUsage({
      history: this.history,
      draftInput: request.draftInput,
      contextLimit: limit,
      modelName,
      lastMeasuredInput: this.lastMeasuredInput,
      lastMeasuredCacheRead: this.lastMeasuredCacheRead,
      measuredAtHistoryLength: this.measuredAtHistoryLength,
      systemPromptText: this.llm.getSystemPromptForMode(request.mode)
    })
  }

  private addSystemMessage(content: string): void {
    this.messages.push({
      id: uuidv4(),
      role: 'system',
      content,
      timestamp: new Date().toISOString()
    })
    this.persist()
  }

  private addPlanCardMessage(originalRequest: string, planMarkdown: string): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      kind: 'plan_card',
      content: planMarkdown,
      planCard: { originalRequest, planMarkdown },
      timestamp: new Date().toISOString()
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist()
    return msg
  }

  private addMessage(
    role: 'user' | 'assistant',
    content: string,
    images?: ChatImageAttachment[]
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist(true)
    return msg
  }

  private addToolCallMessage(action: OrchestratorAction): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind: 'tool_call',
      content: '',
      timestamp: new Date().toISOString(),
      toolCall: getToolCallDisplay(action)
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist()
    return msg
  }

  private addToolTimelineMessage(
    kind: NonNullable<ChatMessage['kind']>,
    toolCall: NonNullable<ChatMessage['toolCall']>
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist()
    return msg
  }

  private updateToolTimelineMessage(
    messageId: string,
    toolCall: NonNullable<ChatMessage['toolCall']>,
    immediate = false
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      toolCall
    }
    this.messages[index] = updated
    this.emit('message-updated', updated)
    this.persist(immediate)
  }

  private updateThinkingMessage(
    messageId: string,
    content: string,
    status: NonNullable<ChatMessage['thinking']>['status']
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      thinking: { content, status }
    }
    this.messages[index] = updated
    this.emit('message-updated', updated)
    this.persist(status === 'complete')
  }

  private addStreamingAssistantMessage(): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist()
    return msg
  }

  private updateStreamingAssistantMessage(messageId: string, content: string, streaming: boolean): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      content,
      streaming
    }
    this.messages[index] = updated
    this.emit('message-updated', updated)
    this.persist(!streaming)
  }

  private removeMessage(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return
    this.messages.splice(index, 1)
    this.emit('messages-sync', this.getMessages())
    this.persist(true)
  }

  private handleStreamingTextEvent(event: import('./LlmClient').StreamingLlmTextEvent): void {
    if (event.phase === 'start') {
      if (!this.activeAssistantMessageId) {
        const msg = this.addStreamingAssistantMessage()
        this.activeAssistantMessageId = msg.id
        this.assistantStreamBase = ''
      }
      return
    }

    if (!this.activeAssistantMessageId) return

    if (event.phase === 'delta') {
      this.updateStreamingAssistantMessage(
        this.activeAssistantMessageId,
        this.assistantStreamBase + event.content,
        true
      )
      return
    }

    if (event.phase === 'complete') {
      const combined = this.assistantStreamBase + event.content
      this.assistantStreamBase = combined
      this.updateStreamingAssistantMessage(this.activeAssistantMessageId, combined, true)
    }
  }

  private handleStreamingThinkingEvent(event: StreamingLlmThinkingEvent): void {
    if (event.phase === 'start') {
      const msg = this.addThinkingMessage('', 'processing')
      this.activeThinkingMessageId = msg.id
      return
    }

    if (!this.activeThinkingMessageId) return

    if (event.phase === 'delta') {
      this.updateThinkingMessage(this.activeThinkingMessageId, event.content, 'processing')
      return
    }

    if (event.phase === 'complete') {
      this.updateThinkingMessage(this.activeThinkingMessageId, event.content, 'complete')
      this.activeThinkingMessageId = null
    }
  }

  private addThinkingMessage(
    content: string,
    status: NonNullable<ChatMessage['thinking']>['status']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind: 'thinking',
      content: '',
      timestamp: new Date().toISOString(),
      thinking: { content, status }
    }
    this.messages.push(msg)
    this.emit('message', msg)
    this.persist()
    return msg
  }

  private handleStreamingToolEvent(event: StreamingLlmToolEvent): void {
    const timelineKind =
      event.kind === 'build_tool_call'
        ? 'mcp_tool_call'
        : event.kind === 'build_tool_result'
          ? 'mcp_tool_result'
          : event.kind

    if (event.phase === 'start' && event.callId) {
      const msg = this.addToolTimelineMessage(timelineKind, {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: 'processing'
      })
      this.activeToolCallMessageIds.set(event.callId, msg.id)
      return
    }

    if (event.phase === 'complete' && event.callId) {
      const messageId = this.activeToolCallMessageIds.get(event.callId)
      if (messageId) {
        this.updateToolTimelineMessage(messageId, {
          title: event.title,
          summary: event.summary,
          details: event.details,
          response: event.response,
          status: 'complete'
        }, true)
        this.activeToolCallMessageIds.delete(event.callId)
        return
      }
    }

    this.addToolTimelineMessage(timelineKind, {
      title: event.title,
      summary: event.summary,
      details: event.details,
      response: event.response,
      status: 'complete'
    })
  }

  isTurnActive(): boolean {
    return this.activeTurn !== null && !this.activeTurn.abort.signal.aborted
  }

  /**
   * Abort the active GUI/CLI orchestrator turn.
   * Returns true if a turn was running and abort was signaled.
   */
  abortActiveTurn(): boolean {
    if (!this.activeTurn || this.activeTurn.abort.signal.aborted) {
      return false
    }
    this.activeTurn.pendingSteer = []
    this.activeTurn.abort.abort()
    this.emit('turn-aborted')
    return true
  }

  /**
   * Inject mid-turn guidance into the active GUI/CLI turn (applied after next tool batch).
   */
  steerActiveTurn(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed || !this.activeTurn || this.activeTurn.abort.signal.aborted) {
      return false
    }
    this.activeTurn.pendingSteer.push(trimmed)
    this.addSystemMessage(`[steer] ${trimmed}`)
    this.emit('turn-steered', { text: trimmed })
    return true
  }

  /**
   * Abort an in-flight channel turn for a Mousse thread (Telegram/Discord).
   */
  abortChannelTurn(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    if (!turn || turn.abort.signal.aborted) return false
    turn.pendingSteer = []
    turn.abort.abort()
    return true
  }

  /**
   * Steer an in-flight channel turn for a Mousse thread.
   */
  steerChannelTurn(threadId: string, text: string): boolean {
    const trimmed = text.trim()
    const turn = this.channelTurns.get(threadId)
    if (!trimmed || !turn || turn.abort.signal.aborted) return false
    turn.pendingSteer.push(trimmed)
    return true
  }

  isChannelTurnActive(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    return Boolean(turn && !turn.abort.signal.aborted)
  }

  async send(input: OrchestratorSendInput): Promise<OrchestratorResponse> {
    if (this.activeTurn) {
      throw new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
    }

    const request = normalizeSendRequest(input)
    const userContent = request.content
    const mode = request.mode
    const images = request.images
    this.addMessage('user', userContent, images)
    this.history.push({
      role: 'user',
      content: userContent,
      images: images?.map((img) => ({
        mimeType: img.mimeType,
        data: img.data,
        name: img.name
      }))
    })
    this.activeToolCallMessageIds.clear()
    this.activeThinkingMessageId = null
    this.activeAssistantMessageId = null
    this.assistantStreamBase = ''

    const turn = {
      abort: new AbortController(),
      pendingSteer: [] as string[]
    }
    this.activeTurn = turn

    let assistantText: string
    let aborted = false
    try {
      const result = await this.llm.chat(
        this.history,
        (event) => {
          this.handleStreamingToolEvent(event)
        },
        {
          mode,
          signal: turn.abort.signal,
          drainSteer: () => {
            if (turn.pendingSteer.length === 0) return undefined
            const text = turn.pendingSteer.join('\n')
            turn.pendingSteer = []
            return text
          }
        },
        (event) => {
          this.handleStreamingThinkingEvent(event)
        },
        (event) => {
          this.handleStreamingTextEvent(event)
        }
      )
      assistantText = result.text
      aborted = Boolean(result.aborted)
      this.lastMeasuredInput = result.usage.input
      this.lastMeasuredCacheRead = result.usage.cacheRead
      this.measuredAtHistoryLength = this.history.length
    } catch (err) {
      const isAbort =
        turn.abort.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) {
        aborted = true
        assistantText = ''
      } else {
        const errMsg = err instanceof Error ? err.message : String(err)
        assistantText = `LLM error: ${errMsg}`
      }
    } finally {
      this.activeTurn = null
    }

    if (this.activeThinkingMessageId) {
      const thinkingMessage = this.messages.find((message) => message.id === this.activeThinkingMessageId)
      if (thinkingMessage?.thinking?.status === 'processing') {
        this.updateThinkingMessage(
          this.activeThinkingMessageId,
          thinkingMessage.thinking.content,
          'complete'
        )
      }
      this.activeThinkingMessageId = null
    }

    if (aborted) {
      const partial =
        stripActionBlocks(assistantText).trim() ||
        '(Stopped)'
      this.history.push({ role: 'assistant', content: partial })
      if (this.activeAssistantMessageId) {
        this.updateStreamingAssistantMessage(this.activeAssistantMessageId, partial, false)
        this.activeAssistantMessageId = null
      } else {
        this.addMessage('assistant', partial)
      }
      this.addSystemMessage('Turn stopped.')
      const response: OrchestratorResponse = { message: partial, actions: [] }
      this.persist(true)
      this.emit('response', response)
      return response
    }

    if (mode === 'plan') {
      const planMarkdown = stripActionBlocks(assistantText) || assistantText.trim() || 'No plan generated.'
      this.history.push({ role: 'assistant', content: planMarkdown })
      if (this.activeAssistantMessageId) {
        const streamingId = this.activeAssistantMessageId
        this.activeAssistantMessageId = null
        this.removeMessage(streamingId)
      }
      const planMsg = this.addPlanCardMessage(userContent, planMarkdown)
      const response: OrchestratorResponse = {
        message: planMsg.content,
        actions: []
      }
      this.persist(true)
      this.emit('response', response)
      return response
    }

    const parsedActions = parseActions(assistantText)
    const actions = filterActionsForChatMode(parsedActions, mode)
    const displayText = stripActionBlocks(assistantText)
    this.history.push({ role: 'assistant', content: assistantText })

    if (this.activeAssistantMessageId) {
      this.updateStreamingAssistantMessage(
        this.activeAssistantMessageId,
        displayText || 'Done.',
        false
      )
      this.activeAssistantMessageId = null
    } else {
      this.addMessage('assistant', displayText || 'Done.')
    }

    for (const action of actions) {
      if (rejectOrchestrationAction(action, mode)) {
        this.addSystemMessage(
          `[build] Blocked orchestration action "${action.type}" — Build mode cannot spawn agents or complete tasks.`
        )
        continue
      }
      this.addToolCallMessage(action)
      await this.executeAction(action)
    }

    if (!allowsOrchestrationActions(mode) && parsedActions.length > actions.length) {
      this.addSystemMessage('[build] Ignored orchestration actions emitted by the model.')
    }

    const response: OrchestratorResponse = {
      message: displayText || 'Done.',
      actions
    }
    this.persist(true)
    this.emit('response', response)
    return response
  }

  private async executeAction(action: OrchestratorAction): Promise<string[]> {
    switch (action.type) {
      case 'spawn_agents':
        return this.spawnAgents(action.agents)
      case 'complete_task':
        return this.completeTask(action.merge !== false)
      case 'message':
        return [action.content]
      default:
        return []
    }
  }

  async spawnAgents(
    specs: Array<{ cliType: CliType; task: string }>
  ): Promise<string[]> {
    const logs: string[] = []
    // Dedupe identical (cliType, task) pairs within a single spawn request.
    const seen = new Set<string>()
    const uniqueSpecs = specs.filter((spec) => {
      const key = `${spec.cliType}::${spec.task.trim()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    for (const spec of uniqueSpecs) {
      if (!this.macros.listProviders().includes(spec.cliType)) {
        logs.push(`[agent] Skipped ${spec.cliType}: disabled or unavailable`)
        continue
      }

      const task = this.tasks.create(spec.task)
      this.tasks.updateStatus(task.id, 'in_progress')

      const agentId = uuidv4()
      let worktreePath = ''
      let branch = ''

      try {
        const wt = await this.worktrees.createWorktree(agentId)
        worktreePath = wt.path
        branch = wt.branch
        logs.push(`[worktree] Created ${worktreePath} on branch ${branch}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logs.push(`[worktree] Failed: ${msg}`)
        this.tasks.updateStatus(task.id, 'failed')
        continue
      }

      const prep = this.agentConfigManager
        ? await this.agentConfigManager.prepare(agentId, spec.cliType, worktreePath, this.worktrees.getRepoRoot())
        : undefined
      prep?.logs.forEach((line) => logs.push(line))
      prep?.warnings.forEach((line) => logs.push(`[integrations] ${line}`))

      if (spec.cliType === 'mousse') {
        const agent = this.agents.create({
          cliType: 'mousse',
          worktreePath,
          branch,
          executionMode: 'gui',
          status: 'running',
          task: spec.task
        })

        this.tasks.linkAgent(task.id, agent.id)
        this.tasks.updateStatus(task.id, 'in_progress')
        this.mousseAgents.start(agent.id, spec.task, worktreePath)
        this.emit('agent-spawned', agent)
        this.emit('agent-activated', { agentId: agent.id })
        logs.push(`[agent] Spawned Mousse GUI agent ${agent.id.slice(0, 8)}`)
        continue
      }

      const useHeadless = this.macros.isHeadlessEnabled(spec.cliType)

      if (useHeadless) {
        const shellCommand = this.macros.getHeadlessShellCommand(spec.cliType, spec.task)
        const processId = this.headlessRunner.spawn(agentId, worktreePath, shellCommand, {
          env: prep?.env
        })

        const agent = this.agents.create({
          cliType: spec.cliType,
          worktreePath,
          branch,
          executionMode: 'headless',
          processId,
          status: 'running',
          task: spec.task
        })

        this.tasks.linkAgent(task.id, agent.id)
        this.tasks.updateStatus(task.id, 'in_progress')
        this.emit('agent-spawned', agent)
        logs.push(`[agent] Spawned headless ${spec.cliType} agent ${agent.id.slice(0, 8)}`)
        continue
      }

      const cliCommand = this.macros.getCliCommand(spec.cliType)
      const ptyId = this.ptyManager.create(agentId, worktreePath, cliCommand, { env: prep?.env })

      const agent = this.agents.create({
        cliType: spec.cliType,
        worktreePath,
        branch,
        executionMode: 'interactive',
        ptyId,
        status: 'starting',
        task: spec.task
      })

      this.tasks.linkAgent(task.id, agent.id)
      this.tasks.updateStatus(task.id, 'in_progress')

      this.emit('agent-spawned', agent)

      setTimeout(async () => {
        this.agents.updateStatus(agent.id, 'running')

        this.ptyManager.focusWindow()
        this.emit('terminal-activated', { ptyId: agent.ptyId! })
        this.emit('agent-activated', { agentId: agent.id })

        if (!this.ptyManager.has(agent.ptyId!)) {
          logs.push(`[terminal] Cannot prompt ${agent.id.slice(0, 8)}: terminal is not available`)
          this.agents.updateStatus(agent.id, 'failed')
          this.tasks.updateStatus(task.id, 'failed')
          return
        }

        const macroResult = await this.macros.runPtyMacro(spec.cliType, {
          prompt: spec.task,
          windowTitle: spec.cliType
        }, (data) => this.ptyManager.write(agent.ptyId!, data))
        macroResult.log.forEach((l) => logs.push(l))
      }, 2000)

      logs.push(`[agent] Spawned ${spec.cliType} agent ${agent.id.slice(0, 8)}`)
    }

    return logs
  }

  private async completeTask(merge: boolean): Promise<string[]> {
    const logs: string[] = []
    const agentList = this.agents.list().filter(
      (a) => a.status !== 'completed' && a.status !== 'failed'
    )

    if (agentList.length === 0) {
      logs.push('[complete] No active agents to complete')
      return logs
    }

    for (const agent of agentList) {
      logs.push(...(await this.finalizeAgent(agent, merge)))
    }

    this.emit('task-completed')
    return logs
  }

  async stopAgent(agentId: string, merge = false): Promise<string[]> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return [`[agent] Not found: ${agentId}`]
    }
    if (agent.status === 'completed' || agent.status === 'failed') {
      return [`[agent] Already ${agent.status}: ${agentId.slice(0, 8)}`]
    }
    const logs = await this.finalizeAgent(agent, merge)
    this.emit('task-completed')
    return logs
  }

  private async finalizeAgent(agent: Agent, merge: boolean): Promise<string[]> {
    const logs: string[] = []
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    if (this.agentConfigManager) {
      logs.push(...(await this.agentConfigManager.cleanup(agent.id)))
    }

    if (merge) {
      const result = await this.worktrees.mergeAndRemove({
        path: agent.worktreePath,
        branch: agent.branch
      })
      if (result.success) {
        logs.push(`[merge] Merged ${agent.branch}`)
        this.agents.updateStatus(agent.id, 'completed')
        task && this.tasks.updateStatus(task.id, 'completed')
      } else {
        logs.push(`[merge] Failed for ${agent.branch}: ${result.error}`)
        this.agents.updateStatus(agent.id, 'failed')
        task && this.tasks.updateStatus(task.id, 'failed')
      }
    } else {
      this.agents.updateStatus(agent.id, 'completed')
      task && this.tasks.updateStatus(task.id, 'completed')
    }

    if (agent.executionMode === 'headless' && agent.processId) {
      this.headlessRunner.kill(agent.processId)
      logs.push(`[headless] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.executionMode === 'gui') {
      this.mousseAgents.remove(agent.id)
      logs.push(`[mousse] Closed GUI agent ${agent.id.slice(0, 8)}`)
    } else if (agent.ptyId) {
      this.ptyManager.kill(agent.ptyId)
      logs.push(`[terminal] Closed agent ${agent.id.slice(0, 8)}`)
    }
    return logs
  }

  getMousseAgentMessages(agentId: string): ChatMessage[] {
    return this.mousseAgents.getMessages(agentId)
  }

  sendMousseAgentMessage(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[]
  ): void {
    void this.mousseAgents.send(agentId, content, images)
  }

  private async completeMousseAgent(
    agentId: string,
    merge: boolean,
    summary: string
  ): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return

    this.agents.updateStatus(agentId, 'merging')
    const task = this.tasks.findByAgentId(agentId)

    if (this.agentConfigManager) {
      await this.agentConfigManager.cleanup(agentId)
    }

    if (merge) {
      const result = await this.worktrees.mergeAndRemove({
        path: agent.worktreePath,
        branch: agent.branch
      })
      if (result.success) {
        this.agents.updateStatus(agentId, 'completed')
        task && this.tasks.updateStatus(task.id, 'completed')
      } else {
        this.agents.updateStatus(agentId, 'failed')
        task && this.tasks.updateStatus(task.id, 'failed')
      }
    } else {
      this.agents.updateStatus(agentId, 'completed')
      task && this.tasks.updateStatus(task.id, 'completed')
    }

    this.mousseAgents.remove(agentId)
    this.addSystemMessage(`[Mousse agent ${agentId.slice(0, 8)}] ${summary}`)
  }

  getActiveAgents(): Agent[] {
    return this.agents.list().filter((a) => a.status === 'running' || a.status === 'starting')
  }

  async runIsolatedScheduledJob(
    prompt: string
  ): Promise<{ text: string; silent: boolean; error?: string }> {
    try {
      const result = await this.llm.chat([{ role: 'user', content: prompt }], () => {}, {
        mode: 'agent'
      })
      const text = stripActionBlocks(result.text) || result.text.trim() || 'Done.'
      const silent = text.trim() === '[SILENT]' || text.trimStart().startsWith('[SILENT]')
      return { text, silent }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', silent: false, error: message }
    }
  }

  async runChannelTurn(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: { llmProvider: string; model: string }
      signal?: AbortSignal
      drainSteer?: () => string | undefined
    }
  ): Promise<{ text: string; silent: boolean; error?: string; aborted?: boolean }> {
    const previousRoot = this.worktrees.getRepoRoot()
    const projectPath = this.projectManager
      ? resolveThreadProjectPath(this.projectManager, threadStore, threadId)
      : undefined
    if (projectPath) {
      applyProjectWorkingDirectory(projectPath)
      this.worktrees.setRepoRoot(projectPath)
    }

    const ownedTurn = !opts?.signal
    const turn = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [] as string[] }
      : null
    if (turn) {
      this.channelTurns.set(threadId, turn)
    }

    try {
      const data = threadStore.loadThreadData(threadId)
      const history = data.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content,
        timestamp: new Date().toISOString()
      }
      history.push({ role: 'user', content })

      // Persist the user message immediately so /stop mid-turn keeps history.
      threadStore.saveThreadData(threadId, {
        messages: [...data.messages, userMsg],
        agents: data.agents,
        tasks: data.tasks
      })

      const signal = opts?.signal ?? turn!.abort.signal
      const drainSteer =
        opts?.drainSteer ??
        (() => {
          if (!turn || turn.pendingSteer.length === 0) return undefined
          const text = turn.pendingSteer.join('\n')
          turn.pendingSteer = []
          return text
        })

      const result = await this.llm.chat(history, () => {}, {
        mode: 'agent',
        llmProvider: opts?.modelOverride?.llmProvider,
        model: opts?.modelOverride?.model,
        signal,
        drainSteer
      })

      const latest = threadStore.loadThreadData(threadId)

      if (result.aborted || signal.aborted) {
        const stoppedMsg: ChatMessage = {
          id: uuidv4(),
          role: 'system',
          content: 'Turn stopped.',
          timestamp: new Date().toISOString()
        }
        threadStore.saveThreadData(threadId, {
          messages: [...latest.messages, stoppedMsg],
          agents: latest.agents,
          tasks: latest.tasks
        })
        return { text: '', silent: true, aborted: true }
      }

      const rawText = result.text
      const displayText = stripActionBlocks(rawText) || rawText.trim() || 'Done.'
      const silent =
        displayText.trim() === '[SILENT]' || displayText.trimStart().startsWith('[SILENT]')

      const assistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: displayText,
        timestamp: new Date().toISOString()
      }

      const parsedActions = parseActions(rawText)
      const systemNotes: ChatMessage[] = []
      if (parsedActions.length > 0) {
        systemNotes.push({
          id: uuidv4(),
          role: 'system',
          content:
            `[channels] Model emitted ${parsedActions.length} orchestration action(s) — ` +
            'not executed from remote channel. Open this thread in Mousse to run agents.',
          timestamp: new Date().toISOString()
        })
      }

      threadStore.saveThreadData(threadId, {
        messages: [...latest.messages, assistantMsg, ...systemNotes],
        agents: latest.agents,
        tasks: latest.tasks
      })

      return { text: displayText, silent }
    } catch (err) {
      const isAbort =
        (opts?.signal?.aborted ?? turn?.abort.signal.aborted) ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) {
        try {
          const latest = threadStore.loadThreadData(threadId)
          const stoppedMsg: ChatMessage = {
            id: uuidv4(),
            role: 'system',
            content: 'Turn stopped.',
            timestamp: new Date().toISOString()
          }
          threadStore.saveThreadData(threadId, {
            messages: [...latest.messages, stoppedMsg],
            agents: latest.agents,
            tasks: latest.tasks
          })
        } catch {
          // best-effort
        }
        return { text: '', silent: true, aborted: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', silent: false, error: message }
    } finally {
      if (turn) {
        this.channelTurns.delete(threadId)
      }
      if (projectPath) {
        applyProjectWorkingDirectory(previousRoot)
        this.worktrees.setRepoRoot(previousRoot)
      }
    }
  }
}
