import type { ChannelSession } from '../../../shared/types'
import type { LlmProviderOption } from '../../../shared/settings'
import { formatThreadList, resolveThreadSelection } from '../../../shared/threadSelection'
import type { SettingsStore } from '../../settings/SettingsStore'
import type { ThreadDataStore } from '../../data/ThreadDataStore'
import type { ChannelSessionManager } from '../ChannelSessionManager'
import type { ChannelStore } from '../ChannelStore'
import type { InboundChannelMessage } from '../types'
import { channelHelpText, resolveChannelCommand } from './registry'
import type { ParsedSlashCommand } from './parse'

export interface SlashHandlerResult {
  handled: boolean
  reply?: string
}

export interface SlashAgentInfo {
  id: string
  name?: string
  status?: string
  task?: string
}

export interface SlashContext {
  message: InboundChannelMessage
  session: ChannelSession
  args: string
  parsed: ParsedSlashCommand
  sessionManager: ChannelSessionManager
  store: ChannelStore
  settings: SettingsStore
  threadStore: ThreadDataStore
  listModels: () => LlmProviderOption[]
  /**
   * Provider-native subscription usage text, shared with the desktop usage view.
   * It is optional because providers authenticated by API key do not expose
   * subscription quotas.
   */
  getSubscriptionUsage?: (providerId: string) => Promise<string | undefined> | string | undefined
  listAgents?: () => SlashAgentInfo[]
  bumpGeneration: (sessionKey: string) => number
  getGeneration: (sessionKey: string) => number
  abortTurn?: () => boolean
  steerTurn?: (text: string) => boolean
  isTurnActive?: () => boolean
}

export async function dispatchSlashCommand(ctx: SlashContext): Promise<SlashHandlerResult> {
  const cmd = resolveChannelCommand(ctx.parsed.canonical)
  if (!cmd) {
    return {
      handled: true,
      reply: `Unknown command \`/${ctx.parsed.name}\`. Try /help.`
    }
  }

  switch (cmd.name) {
    case 'help':
      return { handled: true, reply: handleHelp() }
    case 'start':
      return { handled: true, reply: handleStart() }
    case 'new':
      return { handled: true, reply: handleNew(ctx) }
    case 'status':
      return { handled: true, reply: handleStatus(ctx) }
    case 'usage':
      return { handled: true, reply: await handleUsage(ctx) }
    case 'threads':
      return { handled: true, reply: handleThreads(ctx) }
    case 'model':
    case 'models':
      return { handled: true, reply: handleModel(ctx) }
    case 'stop':
      return { handled: true, reply: handleStop(ctx) }
    case 'steer':
      return { handled: true, reply: handleSteer(ctx) }
    case 'whoami':
      return { handled: true, reply: handleWhoami(ctx) }
    case 'title':
      return { handled: true, reply: handleTitle(ctx) }
    case 'sethome':
      return { handled: true, reply: handleSetHome(ctx) }
    case 'agents':
      return { handled: true, reply: handleAgents(ctx) }
    default:
      return {
        handled: true,
        reply: `Unknown command \`/${ctx.parsed.name}\`. Try /help.`
      }
  }
}

function handleHelp(): string {
  return channelHelpText()
}

function handleStart(): string {
  return 'Mousse is ready. Send a message or try /help for commands.'
}

function handleNew(ctx: SlashContext): string {
  ctx.bumpGeneration(ctx.session.sessionKey)
  const title = ctx.args.trim() || undefined
  const session = ctx.sessionManager.resetSession(ctx.message, title)
  const shortId = session.mousseThreadId.slice(0, 8)
  if (title) {
    return `New session started: ${title} (${shortId})`
  }
  return `New session started. (${shortId})`
}

function handleStatus(ctx: SlashContext): string {
  const session =
    ctx.sessionManager.getSession(ctx.session.sessionKey) ?? ctx.session
  const thread = ctx.threadStore.getThread(session.mousseThreadId)
  const data = safeLoadThreadData(ctx.threadStore, session.mousseThreadId)
  const msgCount = data?.messages.length ?? 0
  const { llmProvider, model } = resolveCurrentModel(ctx, session)

  const lines = [
    `sessionKey: ${session.sessionKey}`,
    `platform: ${session.platform}`,
    `chat: ${session.chatName ?? session.chatId}`,
    `thread: ${session.mousseThreadId}${thread?.name ? ` (${thread.name})` : ''}`,
    `model: ${llmProvider ? `${llmProvider}/${model}` : model || '(not set)'}`,
    `messages: ${msgCount}`
  ]
  if (session.modelOverride) {
    lines.push(
      `model override: ${session.modelOverride.llmProvider}/${session.modelOverride.model}`
    )
  }
  return lines.join('\n')
}

async function handleUsage(ctx: SlashContext): Promise<string> {
  const session =
    ctx.sessionManager.getSession(ctx.session.sessionKey) ?? ctx.session
  const { llmProvider } = resolveCurrentModel(ctx, session)

  try {
    const usage = await ctx.getSubscriptionUsage?.(llmProvider)
    if (usage) return usage
  } catch {
    // A usage endpoint is informational; its failure must not fail the channel turn.
  }

  return `Subscription usage is not available for ${llmProvider || 'the current provider'}.`
}

function handleThreads(ctx: SlashContext): string {
  const session =
    ctx.sessionManager.getSession(ctx.session.sessionKey) ?? ctx.session
  const threads = ctx.threadStore.listThreads().map((t) => ({
    id: t.id,
    name: t.name
  }))
  const query = ctx.args.trim()
  if (!query) {
    return formatThreadList(threads, session.mousseThreadId)
  }

  const result = resolveThreadSelection(threads, query)
  if (!result.ok) {
    return result.error
  }

  const bound = ctx.sessionManager.bindThread(session.sessionKey, result.thread.id)
  if (!bound) {
    return `Could not bind thread \`${result.thread.id.slice(0, 8)}\`.`
  }
  const name = result.thread.name?.trim() || '(unnamed)'
  return `Selected thread ${result.thread.id.slice(0, 8)} — ${name}\n(Session binding updated; history preserved.)`
}

function handleModel(ctx: SlashContext): string {
  const raw = ctx.args.trim()
  if (!raw) {
    return formatModelList(ctx)
  }

  const tokens = raw.split(/\s+/)
  let global = false
  let sessionMode = false
  const nameParts: string[] = []
  for (const token of tokens) {
    if (token === '--global') {
      global = true
      continue
    }
    if (token === '--session') {
      sessionMode = true
      continue
    }
    nameParts.push(token)
  }

  const modelName = nameParts.join(' ').trim()
  if (!modelName) {
    return formatModelList(ctx)
  }

  const match = findModel(ctx.listModels(), modelName, ctx)
  if (!match) {
    return `Model not found: \`${modelName}\`. Use /model to list available models.`
  }

  if (global && !sessionMode) {
    ctx.settings.set({
      provider: { llmProvider: match.llmProvider, model: match.model }
    })
    ctx.sessionManager.setModelOverride(ctx.session.sessionKey, undefined)
    return `Global model set to ${match.llmProvider}/${match.model}`
  }

  // Default for channels: session-scoped override
  ctx.sessionManager.setModelOverride(ctx.session.sessionKey, {
    llmProvider: match.llmProvider,
    model: match.model
  })
  return `Session model set to ${match.llmProvider}/${match.model}`
}

function handleStop(ctx: SlashContext): string {
  const active = ctx.isTurnActive?.() ?? false
  const aborted = ctx.abortTurn?.() ?? false
  if (!aborted && !active) {
    // Still bump generation so any queued turn for this session is dropped.
    ctx.bumpGeneration(ctx.session.sessionKey)
    return 'Nothing to stop — no in-flight reply for this session.'
  }
  return 'Stop requested. The in-flight reply will be discarded.'
}

function handleSteer(ctx: SlashContext): string {
  const text = ctx.args.trim()
  if (!text) {
    return 'Usage: `/steer <prompt>` — inject mid-turn guidance after the next tool call.'
  }
  // Never fall back to a normal message — steer targets the active turn only.
  if (!ctx.isTurnActive?.()) {
    return 'No active turn to steer. Send a message first, then `/steer <prompt>` while it runs.'
  }
  const ok = ctx.steerTurn?.(text) ?? false
  if (!ok) {
    return 'Could not steer — the turn may have just finished. Try again while a reply is in flight.'
  }
  return `Steered: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`
}

function handleWhoami(ctx: SlashContext): string {
  const { message } = ctx
  return [
    `userId: ${message.userId}`,
    `userName: ${message.userName ?? '(none)'}`,
    `platform: ${message.platform}`,
    `chatType: ${message.chatType}`
  ].join('\n')
}

function handleTitle(ctx: SlashContext): string {
  const title = ctx.args.trim()
  const session =
    ctx.sessionManager.getSession(ctx.session.sessionKey) ?? ctx.session
  const thread = ctx.threadStore.getThread(session.mousseThreadId)

  if (!title) {
    return `Current title: ${thread?.name ?? '(unnamed)'}`
  }

  try {
    ctx.threadStore.updateThreadMeta(session.mousseThreadId, { name: title })
    return `Title set to: ${title}`
  } catch {
    return `Could not set title (thread ${session.mousseThreadId} not found).`
  }
}

function handleSetHome(ctx: SlashContext): string {
  const { message, store } = ctx
  const config = store.getConfig()
  const platformConfig = config.platforms[message.platform]
  store.updateConfig({
    platforms: {
      ...config.platforms,
      [message.platform]: {
        ...platformConfig,
        homeChatId: message.chatId
      }
    }
  })
  return `Home channel for ${message.platform} set to chat \`${message.chatId}\`.`
}

function handleAgents(ctx: SlashContext): string {
  if (!ctx.listAgents) {
    return 'Agent registry is not available in this context.'
  }
  const agents = ctx.listAgents()
  if (agents.length === 0) {
    return 'No active agents.'
  }
  return agents
    .map((agent) => {
      const name = agent.name ?? agent.id.slice(0, 8)
      const status = agent.status ?? 'unknown'
      const task = agent.task ? ` — ${agent.task.slice(0, 80)}` : ''
      return `• ${name} [${status}]${task}`
    })
    .join('\n')
}

function resolveCurrentModel(
  ctx: SlashContext,
  session: ChannelSession
): { llmProvider: string; model: string } {
  if (session.modelOverride) {
    return session.modelOverride
  }
  const provider = ctx.settings.get().provider
  return {
    llmProvider: provider.llmProvider,
    model: provider.model
  }
}

function formatModelList(ctx: SlashContext): string {
  const session =
    ctx.sessionManager.getSession(ctx.session.sessionKey) ?? ctx.session
  const current = resolveCurrentModel(ctx, session)
  const lines: string[] = [
    `Current model: ${current.llmProvider ? `${current.llmProvider}/${current.model}` : current.model || '(not set)'}`,
    session.modelOverride ? '(session override active)' : '(from global settings)',
    '',
    'Available models:'
  ]

  const providers = ctx.listModels()
  if (providers.length === 0) {
    lines.push('(none configured — connect a provider in Settings)')
    return lines.join('\n')
  }

  const maxModels = 30
  let shown = 0
  let total = 0
  for (const provider of providers) {
    total += provider.models.length
  }

  outer: for (const provider of providers) {
    lines.push(`${provider.label} (${provider.id}):`)
    for (const model of provider.models) {
      if (shown >= maxModels) break outer
      const marker =
        model.id === current.model && provider.id === current.llmProvider
          ? ' *'
          : ''
      lines.push(`  ${model.id}${marker}`)
      shown++
    }
  }

  if (total > shown) {
    lines.push(`… and ${total - shown} more`)
  }
  lines.push('')
  lines.push('Usage: /model <name> [--session|--global]')
  return lines.join('\n')
}

function findModel(
  providers: LlmProviderOption[],
  query: string,
  ctx: SlashContext
): { llmProvider: string; model: string } | undefined {
  const q = query.trim()
  if (!q) return undefined

  const currentProvider =
    ctx.sessionManager.getSession(ctx.session.sessionKey)?.modelOverride
      ?.llmProvider ?? ctx.settings.get().provider.llmProvider

  type Hit = { llmProvider: string; model: string; score: number }
  const hits: Hit[] = []

  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id === q) {
        hits.push({ llmProvider: provider.id, model: model.id, score: 0 })
      } else if (model.id.toLowerCase() === q.toLowerCase()) {
        hits.push({ llmProvider: provider.id, model: model.id, score: 1 })
      } else if (model.label.toLowerCase() === q.toLowerCase()) {
        hits.push({ llmProvider: provider.id, model: model.id, score: 2 })
      }
    }
  }

  if (hits.length === 0) return undefined

  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.llmProvider === currentProvider && b.llmProvider !== currentProvider) return -1
    if (b.llmProvider === currentProvider && a.llmProvider !== currentProvider) return 1
    return 0
  })

  return { llmProvider: hits[0]!.llmProvider, model: hits[0]!.model }
}

function safeLoadThreadData(
  threadStore: ThreadDataStore,
  threadId: string
): { messages: unknown[] } | undefined {
  try {
    return threadStore.loadThreadData(threadId)
  } catch {
    return undefined
  }
}
