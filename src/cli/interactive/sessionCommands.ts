/**
 * Shared interactive session command helpers used by the CLI TUI and tests.
 * Mirrors Telegram/Discord slash semantics for /threads, /models, /model, /steer, /stop.
 */

import { formatThreadList, resolveThreadSelection } from '../../shared/threadSelection'
import type { LlmProviderOption } from '../../shared/settings'

export interface SessionThread {
  id: string
  name?: string
}

export interface SessionModel {
  llmProvider: string
  model: string
}

export interface InteractiveSessionState {
  threadId: string | null
  modelOverride?: SessionModel
}

export interface InteractiveCommandContext {
  state: InteractiveSessionState
  listThreads: () => SessionThread[]
  listModels: () => LlmProviderOption[]
  getGlobalModel: () => SessionModel
  setGlobalModel: (model: SessionModel) => void
  isTurnActive: () => boolean
  abortTurn: () => boolean
  steerTurn: (text: string) => boolean
  bindThread: (threadId: string) => void
  setModelOverride: (override: SessionModel | undefined) => void
}

export interface InteractiveCommandResult {
  handled: boolean
  /** Text to show in the transcript. */
  reply?: string
  /** When true, exit the interactive session. */
  exit?: boolean
}

export function handleInteractiveSlash(
  raw: string,
  ctx: InteractiveCommandContext
): InteractiveCommandResult {
  const text = raw.trim()
  if (!text.startsWith('/')) {
    return { handled: false }
  }

  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return { handled: false }

  let name = match[1]!.toLowerCase()
  if (name.includes('@')) name = name.split('@')[0]!
  const args = (match[2] ?? '').trim()

  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return { handled: true, reply: 'Goodbye.', exit: true }
    case 'help':
      return {
        handled: true,
        reply: [
          'Interactive commands:',
          '  /threads [id|index|name]  List or select a thread',
          '  /thread …                 Alias of /threads',
          '  /models [name]            List or switch models',
          '  /model [name]             Same as /models',
          '  /steer <prompt>           Mid-turn guidance (active turn only)',
          '  /stop                     Abort the in-flight turn',
          '  /help                     This help',
          '  /exit                     Leave interactive mode',
          '',
          'Ordinary messages while a turn is busy stack FIFO and run next.'
        ].join('\n')
      }
    case 'stop': {
      const stopped = ctx.abortTurn()
      return {
        handled: true,
        reply: stopped
          ? 'Stop requested. The in-flight reply will be discarded.'
          : 'Nothing to stop — no in-flight turn.'
      }
    }
    case 'steer': {
      if (!args) {
        return {
          handled: true,
          reply: 'Usage: `/steer <prompt>` — inject mid-turn guidance after the next tool call.'
        }
      }
      // Prefer local in-process steer; when a peer holds the lease, persist a one-time intent.
      const ok = ctx.steerTurn(args)
      return {
        handled: true,
        reply: ok
          ? `Steered: ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`
          : ctx.isTurnActive()
            ? 'Could not steer — the turn may have just finished.'
            : 'No active turn to steer. Send a message first, then `/steer <prompt>` while it runs (or while a peer MMS process owns the turn).'
      }
    }
    case 'thread':
    case 'threads': {
      const threads = ctx.listThreads()
      if (!args) {
        return {
          handled: true,
          reply: formatThreadList(threads, ctx.state.threadId)
        }
      }
      const result = resolveThreadSelection(threads, args)
      if (!result.ok) {
        return { handled: true, reply: result.error }
      }
      ctx.bindThread(result.thread.id)
      const label = result.thread.name?.trim() || '(unnamed)'
      return {
        handled: true,
        reply: `Selected thread ${result.thread.id.slice(0, 8)} — ${label}\n(History preserved.)`
      }
    }
    case 'model':
    case 'models':
      return { handled: true, reply: handleModelCommand(args, ctx) }
    default:
      return {
        handled: true,
        reply: `Unknown command \`/${name}\`. Try /help.`
      }
  }
}

function handleModelCommand(raw: string, ctx: InteractiveCommandContext): string {
  if (!raw.trim()) {
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
    if (token === '--session' || token === '--thread') {
      sessionMode = true
      continue
    }
    nameParts.push(token)
  }

  const modelName = nameParts.join(' ').trim()
  if (!modelName) return formatModelList(ctx)

  const match = findModel(ctx.listModels(), modelName, ctx)
  if (!match) {
    return `Model not found: \`${modelName}\`. Use /models to list available models.`
  }

  if (global && !sessionMode) {
    ctx.setGlobalModel(match)
    ctx.setModelOverride(undefined)
    return `Global model set to ${match.llmProvider}/${match.model}`
  }

  ctx.setModelOverride(match)
  return `Session model set to ${match.llmProvider}/${match.model}`
}

function formatModelList(ctx: InteractiveCommandContext): string {
  const current = ctx.state.modelOverride ?? ctx.getGlobalModel()
  const lines: string[] = [
    `Current model: ${current.llmProvider ? `${current.llmProvider}/${current.model}` : current.model || '(not set)'}`,
    ctx.state.modelOverride ? '(session/thread override active)' : '(from global settings)',
    '',
    'Available models:'
  ]

  const providers = ctx.listModels()
  if (providers.length === 0) {
    lines.push('(none configured — run: mousse-cli config providers)')
    return lines.join('\n')
  }

  const maxModels = 30
  let shown = 0
  let total = 0
  for (const provider of providers) total += provider.models.length

  outer: for (const provider of providers) {
    lines.push(`${provider.label} (${provider.id}):`)
    for (const model of provider.models) {
      if (shown >= maxModels) break outer
      const marker =
        model.id === current.model && provider.id === current.llmProvider ? ' *' : ''
      lines.push(`  ${model.id}${marker}`)
      shown++
    }
  }

  if (total > shown) lines.push(`… and ${total - shown} more`)
  lines.push('')
  lines.push('Usage: /models <name> [--session|--thread|--global]')
  return lines.join('\n')
}

function findModel(
  providers: LlmProviderOption[],
  query: string,
  ctx: InteractiveCommandContext
): SessionModel | undefined {
  const q = query.trim()
  if (!q) return undefined
  const currentProvider =
    ctx.state.modelOverride?.llmProvider ?? ctx.getGlobalModel().llmProvider

  type Hit = SessionModel & { score: number }
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
