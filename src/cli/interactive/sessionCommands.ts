/**
 * Shared interactive session command helpers used by the CLI TUI and tests.
 * Mirrors Telegram/Discord slash semantics for /threads, /models, /model, /steer, /stop.
 */

import { findListedModel, modelChoiceOf, modelLabel } from '../../shared/modelChoice'
import { formatThreadList, resolveThreadSelection } from '../../shared/threadSelection'
import { listingKey, listingServes, selectionFromListing } from '../../shared/providerInstances'
import type { LlmProviderOption } from '../../shared/settings'
import type { ContextUsageSnapshot } from '../../shared/types'

export interface SessionThread {
  id: string
  name?: string
}

export interface SessionModel {
  /** The provider instance (two Claude instances share `llmProvider`); absent on older selections. */
  instanceId?: string
  llmProvider: string
  /** The model as its agent lists it; the reasoning level is `effort`. */
  model: string
  effort?: string
  /** The model's name, as the daemon stored it with the selection. */
  name?: string
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
  getContextUsage: () => ContextUsageSnapshot | null
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
          '  /model <instance>/<name>  A model of one instance (claude:work/sonnet)',
          '  /usage                    Show context usage for this thread',
          '  /steer <prompt>           Mid-turn guidance (active turn only)',
          '  /stop                     Abort the in-flight turn',
          '  /help                     This help',
          '  /exit                     Leave interactive mode',
          '',
          'Ordinary messages while a turn is busy stack FIFO and run next.'
        ].join('\n')
      }
    case 'usage':
      return { handled: true, reply: formatContextUsage(ctx.getContextUsage()) }
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
      // The daemon resolves profile workflows/skills and reports true misses.
      return { handled: false }
  }
}

function formatContextUsage(usage: ContextUsageSnapshot | null): string {
  if (!usage) return 'Context usage is unavailable for the current thread.'

  const total = formatTotalTokens(usage.used)
  const limit = formatTokenCount(usage.limit)
  const lines = ['Context Usage']
  if (usage.modelName) lines.push(usage.modelName)
  lines.push(`${usage.percent}% Full`)
  lines.push(`${usage.source === 'measured' ? '' : '~'}${total} / ${limit} Tokens`)
  if (usage.source === 'legacy-estimated') {
    lines.push('Legacy estimate: older tool calls, results, and reasoning were not recoverable.')
  }
  for (const category of usage.categories) {
    lines.push(`${category.label}: ${formatTokenCount(category.tokens)}`)
  }
  return lines.join('\n')
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  return String(tokens)
}

function formatTotalTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)
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

  const providers = ctx.listModels()
  const found = findModel(providers, modelName, ctx)
  if (!found) {
    return `Model not found: \`${modelName}\`. Use /models to list available models.`
  }
  if ('choices' in found) {
    return [`More than one provider lists \`${modelName}\`. Name the instance:`, ...found.choices.map((choice) => `  /model ${choice}`)].join('\n')
  }
  const match = found.match
  // Two instances of one provider (two Claude accounts) read apart by their instance.
  const shared = match.instanceId && providers.filter((provider) => provider.id === match.llmProvider).length > 1
  const name = `${match.llmProvider}/${match.model}${shared ? ` (${match.instanceId})` : ''}`

  if (global && !sessionMode) {
    ctx.setGlobalModel(match)
    ctx.setModelOverride(undefined)
    return `Global model set to ${name}`
  }

  ctx.setModelOverride(match)
  return `Session model set to ${name}`
}

function formatModelList(ctx: InteractiveCommandContext): string {
  const current = ctx.state.modelOverride ?? ctx.getGlobalModel()
  const lines: string[] = [
    `Current model: ${current.model ? currentModelLine(current, ctx.listModels()) : '(not set)'}`,
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
  const listedBy = new Map<string, number>()
  for (const provider of providers) {
    total += provider.models.length
    for (const model of provider.models) listedBy.set(model.id, (listedBy.get(model.id) ?? 0) + 1)
  }

  outer: for (const provider of providers) {
    lines.push(`${provider.label} (${listingKey(provider)}):`)
    for (const model of provider.models) {
      if (shown >= maxModels) break outer
      const marker =
        listingServes(provider, current) && findListedModel(provider.models, current.model)?.id === model.id ? ' *' : ''
      // A model more than one instance lists is picked by its qualified name.
      const qualified = (listedBy.get(model.id) ?? 0) > 1 ? `  (/model ${qualifiedName(provider, model.id)})` : ''
      lines.push(`  ${model.id}${marker}${qualified}`)
      shown++
    }
  }

  if (total > shown) lines.push(`… and ${total - shown} more`)
  lines.push('')
  lines.push('Usage: /models <name> [--session|--thread|--global]; /models <instance>/<name> picks one instance')
  return lines.join('\n')
}

/** The current model by name, then the id `/models` takes: "Claude Opus 5.5 · High (claude/opus)". */
function currentModelLine(current: SessionModel, providers: LlmProviderOption[]): string {
  const listing = providers.find((provider) => listingServes(provider, current))
  const listed = listing && findListedModel(listing.models, current.model)
  const name = modelLabel(modelChoiceOf({ ...current, provider: current.llmProvider }, listed?.label))
  return `${name} (${listing ? listingKey(listing) : current.instanceId ?? current.llmProvider}/${current.model})`
}

/** `<instance>/<model>`: how a model of one instance is named when another lists it too. */
function qualifiedName(provider: LlmProviderOption, model: string): string {
  return `${listingKey(provider)}/${model}`
}

/**
 * The selection `query` names. `<instance>/<model>` (or `<instance> <model>`) looks in that
 * instance only. A bare model goes to the one listing that has it, else to the current instance's;
 * when other instances list it too, the caller is asked to name one (`choices`).
 */
function findModel(
  providers: LlmProviderOption[],
  query: string,
  ctx: InteractiveCommandContext
): { match: SessionModel } | { choices: string[] } | undefined {
  const q = query.trim()
  if (!q) return undefined
  const current = ctx.state.modelOverride ?? ctx.getGlobalModel()

  // Each hit keeps the instance that lists it; only the best kind of match counts.
  type Hit = { provider: LlmProviderOption; model: string; score: number }
  const hitsIn = (listings: LlmProviderOption[], name: string): Hit[] => {
    const hits: Hit[] = []
    for (const provider of listings) {
      for (const model of provider.models) {
        if (model.id === name) {
          hits.push({ provider, model: model.id, score: 0 })
        } else if (model.id.toLowerCase() === name.toLowerCase()) {
          hits.push({ provider, model: model.id, score: 1 })
        } else if (model.label.toLowerCase() === name.toLowerCase()) {
          hits.push({ provider, model: model.id, score: 2 })
        }
      }
    }
    const best = Math.min(...hits.map((hit) => hit.score))
    return hits.filter((hit) => hit.score === best)
  }

  // Qualified by an instance: the longest instance key followed by `/` or a space.
  const qualified = providers
    .map((provider) => ({ provider, key: listingKey(provider) }))
    .filter(({ key }) => q.length > key.length + 1 && q.slice(0, key.length).toLowerCase() === key.toLowerCase() && /[/\s]/.test(q[key.length]!))
    .sort((a, b) => b.key.length - a.key.length)[0]
  if (qualified) {
    const [hit] = hitsIn([qualified.provider], q.slice(qualified.key.length + 1).trim())
    if (hit) return { match: selectionFromListing(hit.provider, hit.model) }
  }

  const hits = hitsIn(providers, q)
  if (hits.length === 0) return undefined
  const chosen = hits.length === 1 ? hits[0] : hits.find((hit) => listingServes(hit.provider, current))
  if (chosen) return { match: selectionFromListing(chosen.provider, chosen.model) }
  return { choices: hits.map((hit) => qualifiedName(hit.provider, hit.model)) }
}
