import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform,
  Project
} from '../../shared/types'
import type { LlmProviderOption } from '../../shared/settings'
import { applyEffortToModelId, formatEffortLabel } from '../../shared/modelVariants'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { ChannelAuth } from './ChannelAuth'
import { ChannelSessionManager } from './ChannelSessionManager'
import { ChannelStore } from './ChannelStore'
import { chunkMessage } from './chunkMessage'
import { isSilenceNarration } from './delivery'
import { dispatchSlashCommand, parseSlashCommand } from './slash'
import type { SlashAgentInfo } from './slash'
import { detectThreadRuntime, type ThreadTurnControls } from './threadRuntime'
import type {
  ChannelAdapter,
  ChannelMenu,
  ChannelMenuOption,
  InboundChannelMessage,
  OutboundChannelMessage
} from './types'
import { buildSessionKey } from './types'

export interface ChannelTurnRunner {
  runChannelTurn(
    threadId: string,
    content: string,
    opts?: {
      modelOverride?: { llmProvider: string; model: string }
      signal?: AbortSignal
      drainSteer?: () => string | undefined
    }
  ): Promise<{ text: string; silent: boolean; error?: string; aborted?: boolean }>
  abortChannelTurn?: (threadId: string) => boolean
  steerChannelTurn?: (threadId: string, text: string) => boolean
  isChannelTurnActive?: (threadId: string) => boolean
  /** Optional future MMS thread-runtime surface (feature-detected). */
  enqueueThreadMessage?: ThreadTurnControls['enqueue']
  listThreadQueue?: ThreadTurnControls['listQueue']
  isThreadTurnActive?: (threadId: string) => boolean
  abortThreadTurn?: (threadId: string) => boolean
  steerThreadTurn?: (threadId: string, text: string) => boolean
  threadRuntime?: import('./threadRuntime').MmsThreadRuntime
}

export interface ChannelRouterDeps {
  settingsStore: SettingsStore
  threadStore: ThreadDataStore
  listModels: () => LlmProviderOption[]
  listAgents?: () => SlashAgentInfo[]
}

interface InteractiveMenuDefinition {
  title: string
  placeholder: string
  options: Array<{ label: string; value: string; description?: string }>
  onSelect: (value: string) => MenuResolution | Promise<MenuResolution>
}

interface MenuResolution {
  text?: string
  next?: InteractiveMenuDefinition
}

interface InteractiveMenuState extends InteractiveMenuDefinition {
  id: string
  sessionKey: string
  userId: string
  page: number
  expiresAt: number
}

const CHANNEL_MENU_PAGE_SIZE = 25
const CHANNEL_MENU_TTL_MS = 10 * 60 * 1000

export class ChannelRouter extends EventEmitter {
  /**
   * Per-session (or MMS per-thread) FIFO turn chains.
   * Different sessions/threads must not serialize behind one global lock.
   */
  private sessionQueues = new Map<string, Promise<void>>()
  private recentActivity: ChannelActivityEvent[] = []
  private sessionGenerations = new Map<string, number>()
  /** Per-session mid-run control (abort + steer) for the active channel turn. */
  private activeSessionTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[]; threadId: string }
  >()
  private readonly threadControls: ThreadTurnControls
  private interactiveMenus = new Map<string, InteractiveMenuState>()

  constructor(
    private store: ChannelStore,
    private sessionManager: ChannelSessionManager,
    private auth: ChannelAuth,
    private runner: ChannelTurnRunner,
    private getAdapter: (platform: ChannelPlatform) => ChannelAdapter | undefined,
    private getConfig: () => ChannelConfig,
    private deps: ChannelRouterDeps
  ) {
    super()
    this.threadControls = detectThreadRuntime(runner)
  }

  bumpGeneration(sessionKey: string): number {
    const next = (this.sessionGenerations.get(sessionKey) ?? 0) + 1
    this.sessionGenerations.set(sessionKey, next)
    return next
  }

  getGeneration(sessionKey: string): number {
    return this.sessionGenerations.get(sessionKey) ?? 0
  }

  private abortSessionTurn(sessionKey: string, threadId: string): boolean {
    this.bumpGeneration(sessionKey)
    const local = this.activeSessionTurns.get(sessionKey)
    let aborted = false
    if (local && !local.abort.signal.aborted) {
      local.pendingSteer = []
      local.abort.abort()
      aborted = true
    }
    if (this.threadControls.abort(threadId)) {
      aborted = true
    }
    return aborted
  }

  private steerSessionTurn(sessionKey: string, threadId: string, text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    const local = this.activeSessionTurns.get(sessionKey)
    if (local && !local.abort.signal.aborted) {
      local.pendingSteer.push(trimmed)
      return true
    }
    return this.threadControls.steer(threadId, trimmed)
  }

  private isSessionTurnActive(sessionKey: string, threadId: string): boolean {
    const local = this.activeSessionTurns.get(sessionKey)
    if (local && !local.abort.signal.aborted) return true
    return this.threadControls.isActive(threadId)
  }

  async handleInbound(message: InboundChannelMessage): Promise<void> {
    if (message.isBot) return
    const text = message.text.trim()
    if (!text && !message.menuSelection) return

    const config = this.getConfig()
    if (!this.auth.isAuthorized(config, message)) {
      await this.handleUnauthorized(config, message)
      return
    }

    this.recordActivity(
      'inbound',
      message.platform,
      message,
      message.menuSelection ? `[menu: ${message.menuSelection.value}]` : text
    )

    const session = this.sessionManager.resolveThread(message)
    const sessionKey = session.sessionKey

    if (message.menuSelection) {
      await this.handleMenuSelection(message, sessionKey)
      return
    }

    const parsed = parseSlashCommand(text)
    if (parsed) {
      const result = await dispatchSlashCommand({
        message,
        session,
        args: parsed.args,
        parsed,
        sessionManager: this.sessionManager,
        store: this.store,
        settings: this.deps.settingsStore,
        threadStore: this.deps.threadStore,
        listModels: this.deps.listModels,
        listAgents: this.deps.listAgents,
        bumpGeneration: (key) => this.bumpGeneration(key),
        getGeneration: (key) => this.getGeneration(key),
        abortTurn: () => this.abortSessionTurn(sessionKey, session.mousseThreadId),
        steerTurn: (steerText) => this.steerSessionTurn(sessionKey, session.mousseThreadId, steerText),
        isTurnActive: () => this.isSessionTurnActive(sessionKey, session.mousseThreadId)
      })
      if (result.handled) {
        if (result.menu) {
          await this.openCommandMenu(message, result.menu)
        } else if (result.reply) {
          await this.deliverReply(message, result.reply)
        }
        return
      }
    }

    // Same-session/thread FIFO stacking only. Unrelated sessions run concurrently;
    // MMS per-thread execution control serializes same-thread work when available.
    const queueKey = session.mousseThreadId
      ? `thread:${session.mousseThreadId}`
      : `session:${sessionKey}`

    if (this.threadControls.hasMmsQueue && this.threadControls.enqueue) {
      // Prefer MMS-owned queue so we never double-persist a local stack.
      if (this.threadControls.isActive(session.mousseThreadId)) {
        await this.threadControls.enqueue(session.mousseThreadId, text)
        return
      }
    }

    const previous = this.sessionQueues.get(queueKey) ?? Promise.resolve()
    const next = previous
      .then(() => this.processTurn(message, session.mousseThreadId, text, sessionKey))
      .catch((err) => {
        console.error('[channels] turn failed:', err)
      })
    this.sessionQueues.set(queueKey, next)
    await next
  }

  private async handleUnauthorized(
    config: ChannelConfig,
    message: InboundChannelMessage
  ): Promise<void> {
    if (message.chatType !== 'dm') return

    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    if (config.unauthorizedDmBehavior === 'ignore') {
      return
    }

    const request = this.auth.createPairingRequest(message)
    if (!request) {
      await adapter.send({
        platform: message.platform,
        chatId: message.chatId,
        threadId: message.threadId,
        text: 'Too many pairing requests. Try again later.'
      })
      return
    }

    await adapter.send({
      platform: message.platform,
      chatId: message.chatId,
      threadId: message.threadId,
      text:
        `Unauthorized. Ask the Mousse owner to approve pairing code:\n` +
        `\`${request.code}\`\n` +
        `(expires ${new Date(request.expiresAt).toLocaleString()})`
    })
    this.emit('pairing-updated')
  }

  private async processTurn(
    message: InboundChannelMessage,
    threadId: string,
    text: string,
    sessionKey: string
  ): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    const genAtStart = this.getGeneration(sessionKey)
    const liveSession = this.sessionManager.getSession(sessionKey)
    const modelOverride = liveSession?.modelOverride
    // Prefer latest bound thread (e.g. after /new raced); fall back to captured
    const effectiveThreadId = liveSession?.mousseThreadId ?? threadId

    if (adapter.sendTyping) {
      void adapter.sendTyping(message.chatId, message.threadId)
    }

    if (this.getGeneration(sessionKey) !== genAtStart) {
      return
    }

    const turn = {
      abort: new AbortController(),
      pendingSteer: [] as string[],
      threadId: effectiveThreadId
    }
    this.activeSessionTurns.set(sessionKey, turn)

    try {
      const result = await this.runner.runChannelTurn(effectiveThreadId, text, {
        modelOverride,
        signal: turn.abort.signal,
        drainSteer: () => {
          if (turn.pendingSteer.length === 0) return undefined
          const steer = turn.pendingSteer.join('\n')
          turn.pendingSteer = []
          return steer
        }
      })

      if (this.getGeneration(sessionKey) !== genAtStart || result.aborted) {
        return
      }

      if (result.error) {
        await this.deliverReply(message, `Error: ${result.error}`)
        return
      }
      if (result.silent) return

      const config = this.getConfig()
      if (config.filterSilenceNarration && isSilenceNarration(result.text)) {
        return
      }

      await this.deliverReply(message, result.text)
    } finally {
      this.activeSessionTurns.delete(sessionKey)
    }
  }

  private async openCommandMenu(
    message: InboundChannelMessage,
    kind: 'models' | 'threads'
  ): Promise<void> {
    const definition =
      kind === 'models' ? this.buildProviderMenu(message) : this.buildThreadMenu(message)
    if (typeof definition === 'string') {
      await this.deliverReply(message, definition)
      return
    }
    await this.deliverMenu(message, this.registerMenu(message, definition))
  }

  private buildThreadMenu(message: InboundChannelMessage): InteractiveMenuDefinition | string {
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const session = this.sessionManager.getSession(sessionKey)
    const projects = this.deps.threadStore.listProjects()
    const standaloneThreads = this.deps.threadStore.listThreads()
    if (projects.length === 0 && standaloneThreads.length === 0) {
      return 'No threads or projects are available.'
    }

    return {
      title: 'Select a thread or browse projects',
      placeholder: 'Choose Projects or a thread',
      options: [
        ...(projects.length
          ? [
              {
                label: 'Projects ›',
                description: `${projects.length} project${projects.length === 1 ? '' : 's'}`,
                value: '__projects__'
              }
            ]
          : []),
        ...standaloneThreads.map((thread) => ({
          label: `${thread.id === session?.mousseThreadId ? '✓ ' : ''}${thread.name?.trim() || '(unnamed)'}`,
          description: thread.id.slice(0, 8),
          value: thread.id
        }))
      ],
      onSelect: (value) => {
        if (value === '__projects__') {
          const projectMenu = this.buildProjectMenu(message)
          return typeof projectMenu === 'string' ? { text: projectMenu } : { next: projectMenu }
        }
        return { text: this.selectThread(sessionKey, value) }
      }
    }
  }

  private buildProjectMenu(message: InboundChannelMessage): InteractiveMenuDefinition | string {
    const projects = this.deps.threadStore.listProjects()
    if (projects.length === 0) return 'No projects are available.'
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const currentThreadId = this.sessionManager.getSession(sessionKey)?.mousseThreadId
    const currentProjectId = currentThreadId
      ? this.deps.threadStore.getThread(currentThreadId)?.projectId
      : undefined

    return {
      title: 'Select a project',
      placeholder: 'Choose a project',
      options: projects.map((project) => {
        const threadCount = this.deps.threadStore.listThreads(project.id).length
        return {
          label: `${project.id === currentProjectId ? '✓ ' : ''}${project.name}`,
          description: `${threadCount} thread${threadCount === 1 ? '' : 's'}`,
          value: project.id
        }
      }),
      onSelect: (projectId) => {
        const project = this.deps.threadStore
          .listProjects()
          .find((entry) => entry.id === projectId)
        if (!project) return { text: 'That project no longer exists. Run /threads again.' }
        const threadMenu = this.buildProjectThreadMenu(message, project)
        return typeof threadMenu === 'string' ? { text: threadMenu } : { next: threadMenu }
      }
    }
  }

  private buildProjectThreadMenu(
    message: InboundChannelMessage,
    project: Project
  ): InteractiveMenuDefinition | string {
    const threads = this.deps.threadStore.listThreads(project.id)
    if (threads.length === 0) {
      return `No threads are available in ${project.name}.`
    }
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const currentThreadId = this.sessionManager.getSession(sessionKey)?.mousseThreadId

    return {
      title: `Select a thread in ${project.name}`,
      placeholder: 'Choose a project thread',
      options: threads.map((thread) => ({
        label: `${thread.id === currentThreadId ? '✓ ' : ''}${thread.name?.trim() || '(unnamed)'}`,
        description: thread.id.slice(0, 8),
        value: thread.id
      })),
      onSelect: (threadId) => ({ text: this.selectThread(sessionKey, threadId) })
    }
  }

  private selectThread(sessionKey: string, threadId: string): string {
    const thread = this.deps.threadStore.getThread(threadId)
    if (!thread) return 'That thread no longer exists. Run /threads again.'
    const bound = this.sessionManager.bindThread(sessionKey, thread.id)
    if (!bound) return `Could not bind thread \`${thread.id.slice(0, 8)}\`.`
    return `Selected thread ${thread.id.slice(0, 8)} — ${thread.name?.trim() || '(unnamed)'}\n(Session binding updated; history preserved.)`
  }

  private buildProviderMenu(message: InboundChannelMessage): InteractiveMenuDefinition | string {
    const providers = this.deps.listModels()
    if (providers.length === 0) {
      return 'No models are configured. Connect a provider in Settings, then run /models again.'
    }
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const session = this.sessionManager.getSession(sessionKey)
    const current = session?.modelOverride ?? this.deps.settingsStore.get().provider

    return {
      title: 'Select a model provider',
      placeholder: 'Choose a provider',
      options: providers.map((provider) => ({
        label: `${provider.id === current.llmProvider ? '✓ ' : ''}${provider.label}`,
        description: `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
        value: provider.id
      })),
      onSelect: (providerId) => {
        const provider = this.deps.listModels().find((entry) => entry.id === providerId)
        if (!provider) return { text: 'That provider is no longer available. Run /models again.' }
        return { next: this.buildModelMenu(message, provider) }
      }
    }
  }

  private buildModelMenu(
    message: InboundChannelMessage,
    provider: LlmProviderOption
  ): InteractiveMenuDefinition {
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    const current =
      this.sessionManager.getSession(sessionKey)?.modelOverride ??
      this.deps.settingsStore.get().provider

    return {
      title: `Select a model from ${provider.label}`,
      placeholder: 'Choose a model',
      options: provider.models.map((model) => ({
        label: `${provider.id === current.llmProvider && model.id === current.model ? '✓ ' : ''}${model.label}`,
        description: model.id,
        value: model.id
      })),
      onSelect: (modelId) => {
        const liveProvider = this.deps.listModels().find((entry) => entry.id === provider.id)
        const model = liveProvider?.models.find((entry) => entry.id === modelId)
        if (!model) return { text: 'That model is no longer available. Run /models again.' }
        if (model.efforts?.length) {
          return {
            next: this.buildEffortMenu(
              message,
              liveProvider!,
              model.id,
              model.label,
              model.efforts
            )
          }
        }
        return { text: this.selectSessionModel(sessionKey, provider.id, model.id) }
      }
    }
  }

  private buildEffortMenu(
    message: InboundChannelMessage,
    provider: LlmProviderOption,
    modelId: string,
    modelLabel: string,
    efforts: string[]
  ): InteractiveMenuDefinition {
    const sessionKey = buildSessionKey(message.platform, message.chatId, message.threadId)
    return {
      title: `Select reasoning effort for ${modelLabel}`,
      placeholder: 'Choose reasoning effort',
      options: efforts.map((effort) => ({
        label: formatEffortLabel(effort),
        value: effort
      })),
      onSelect: (effort) => {
        if (!efforts.includes(effort)) {
          return { text: 'That reasoning effort is no longer available. Run /models again.' }
        }
        const selectedModel = applyEffortToModelId(modelId, effort)
        return { text: this.selectSessionModel(sessionKey, provider.id, selectedModel, effort) }
      }
    }
  }

  private selectSessionModel(
    sessionKey: string,
    llmProvider: string,
    model: string,
    effort?: string
  ): string {
    const updated = this.sessionManager.setModelOverride(sessionKey, { llmProvider, model })
    if (!updated) return 'Could not update this channel session.'
    return `Session model set to ${llmProvider}/${model}${effort ? ` (reasoning effort: ${effort})` : ''}`
  }

  private registerMenu(
    message: InboundChannelMessage,
    definition: InteractiveMenuDefinition
  ): InteractiveMenuState {
    const now = Date.now()
    for (const [id, menu] of this.interactiveMenus) {
      if (menu.expiresAt <= now) this.interactiveMenus.delete(id)
    }
    const id = uuidv4().replace(/-/g, '').slice(0, 12)
    const state: InteractiveMenuState = {
      ...definition,
      id,
      sessionKey: buildSessionKey(message.platform, message.chatId, message.threadId),
      userId: message.userId,
      page: 0,
      expiresAt: now + CHANNEL_MENU_TTL_MS
    }
    this.interactiveMenus.set(id, state)
    return state
  }

  private async handleMenuSelection(
    message: InboundChannelMessage,
    sessionKey: string
  ): Promise<void> {
    const selection = message.menuSelection!
    const state = this.interactiveMenus.get(selection.menuId)
    if (!state || state.expiresAt <= Date.now()) {
      if (state) this.interactiveMenus.delete(state.id)
      await this.deliverReply(message, 'This menu expired. Run the command again.')
      return
    }
    if (state.sessionKey !== sessionKey || state.userId !== message.userId) {
      await this.deliverReply(message, 'This menu belongs to a different session or user.')
      return
    }

    const pageCount = Math.max(1, Math.ceil(state.options.length / CHANNEL_MENU_PAGE_SIZE))
    if (selection.value === 'prev' || selection.value === 'next') {
      const delta = selection.value === 'prev' ? -1 : 1
      state.page = Math.max(0, Math.min(pageCount - 1, state.page + delta))
      state.expiresAt = Date.now() + CHANNEL_MENU_TTL_MS
      await this.deliverMenu(message, state)
      return
    }

    const index = Number(selection.value)
    const option = Number.isInteger(index) ? state.options[index] : undefined
    if (!option) {
      await this.deliverReply(message, 'That menu option is invalid. Run the command again.')
      return
    }

    this.interactiveMenus.delete(state.id)
    const resolution = await state.onSelect(option.value)
    if (resolution.next) {
      await this.deliverMenu(message, this.registerMenu(message, resolution.next))
    } else if (resolution.text) {
      await this.deliverReply(message, resolution.text)
    }
  }

  private async deliverMenu(
    message: InboundChannelMessage,
    state: InteractiveMenuState
  ): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return
    const pageCount = Math.max(1, Math.ceil(state.options.length / CHANNEL_MENU_PAGE_SIZE))
    state.page = Math.min(state.page, pageCount - 1)
    const start = state.page * CHANNEL_MENU_PAGE_SIZE
    const options: ChannelMenuOption[] = state.options
      .slice(start, start + CHANNEL_MENU_PAGE_SIZE)
      .map((option, offset) => ({
        label: option.label.slice(0, 100),
        value: String(start + offset),
        ...(option.description ? { description: option.description.slice(0, 100) } : {})
      }))
    const menu: ChannelMenu = {
      id: state.id,
      placeholder: state.placeholder.slice(0, 150),
      options,
      page: state.page,
      pageCount
    }
    const text = `${state.title}${pageCount > 1 ? ` (page ${state.page + 1}/${pageCount})` : ''}`
    const result = await adapter.send({
      platform: message.platform,
      chatId: message.chatId,
      threadId: message.threadId,
      text,
      replyToMessageId: message.messageId,
      menu
    })
    if (!result.success) {
      console.error('[channels] outbound menu failed:', result.error)
      return
    }
    this.recordActivity('outbound', message.platform, message, text)
  }

  private async deliverReply(message: InboundChannelMessage, text: string): Promise<void> {
    const adapter = this.getAdapter(message.platform)
    if (!adapter) return

    const chunks = chunkMessage(text)
    for (const chunk of chunks) {
      const outbound: OutboundChannelMessage = {
        platform: message.platform,
        chatId: message.chatId,
        threadId: message.threadId,
        text: chunk,
        replyToMessageId: message.messageId
      }
      const result = await adapter.send(outbound)
      if (!result.success) {
        console.error('[channels] outbound failed:', result.error)
        break
      }
      this.recordActivity('outbound', message.platform, message, chunk)
    }
  }

  async sendTest(
    platform: ChannelPlatform,
    chatId: string,
    text: string,
    threadId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const adapter = this.getAdapter(platform)
    if (!adapter) {
      return { success: false, error: `No adapter for ${platform}` }
    }
    const result = await adapter.send({ platform, chatId, threadId, text })
    return { success: result.success, error: result.error }
  }

  getRecentActivity(limit = 50): ChannelActivityEvent[] {
    return this.recentActivity.slice(-limit)
  }

  private recordActivity(
    direction: ChannelActivityEvent['direction'],
    platform: ChannelPlatform,
    message: InboundChannelMessage,
    text: string
  ): void {
    const event: ChannelActivityEvent = {
      id: uuidv4(),
      direction,
      platform,
      sessionKey: buildSessionKey(message.platform, message.chatId, message.threadId),
      text: text.slice(0, 500),
      timestamp: new Date().toISOString()
    }
    this.recentActivity.push(event)
    if (this.recentActivity.length > 200) {
      this.recentActivity = this.recentActivity.slice(-200)
    }
    this.emit('activity', event)
  }
}
