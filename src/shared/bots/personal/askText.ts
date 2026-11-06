import type { BotBudget } from './definition'
import { isSpecialAsk, type BotAskRequest } from './escalation'

/**
 * An ask in plain words for its card and for About → Can use (Bot Phase 1 §5.4): the card reads
 * "<name> wants to <title>", then the note. Browser-safe.
 * TODO(WP3): finer wording per tool and budget; the shapes below are the contract.
 */

export interface AskText {
  /** Lower case, read after "wants to": "read files in ~/Documents/Invoices". */
  title: string
  /** One line on the limit; empty when there is nothing to add. */
  note: string
}

/** `path` with the owner's home folder written as `~`. */
export function shortPath(path: string, home?: string): string {
  if (!home) return path
  const base = home.replace(/[\\/]+$/, '')
  if (path === base) return '~'
  for (const separator of ['/', '\\'])
    if (path.startsWith(base + separator)) return `~${separator}${path.slice(base.length + 1)}`
  return path
}

/**
 * `request` in plain words. `home` shortens folders to `~/…`; `budget`, the bot's current limits,
 * turns a work-time ask into its new total.
 */
export function askText(request: BotAskRequest, options: { home?: string; budget?: BotBudget } = {}): AskText {
  if (isSpecialAsk(request)) return { title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' }
  if ('path' in request) {
    const folder = shortPath(request.path, options.home)
    return request.access === 'write'
      ? { title: `change files in ${folder}`, note: 'Only this folder.' }
      : { title: `read files in ${folder}`, note: "Only this folder. It can't change anything." }
  }
  if ('skill' in request) return { title: `use the ${request.skill} skill`, note: '' }
  if ('mcp' in request) return { title: `use the ${request.mcp.serverId} tool ${request.mcp.tool}`, note: '' }
  if ('tool' in request) return { title: `use ${request.tool}`, note: '' }
  const { key, amount } = request.budget
  if (key === 'maxActiveMs') {
    const total = amount !== undefined && options.budget ? options.budget.maxActiveMs + amount : undefined
    return total !== undefined
      ? { title: `work for up to ${Math.max(1, Math.round(total / 60_000))} minutes per run`, note: '' }
      : { title: 'work longer on each run', note: '' }
  }
  return { title: 'do more on each run', note: '' }
}
