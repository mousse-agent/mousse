import type { BotBudget } from './definition'
import { isSpecialAsk, type BotAskRequest } from './escalation'
import { botGrantTool } from './manifest'

/**
 * An ask in plain words for its card and for About → Can use (Bot Phase 1 §5.4): the card reads
 * "<name> wants to <title>", then the note. Browser-safe.
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

/** Tools by name, as a card says them after "wants to". */
const TOOL_TEXT: Record<string, AskText> = {
  read: { title: 'read files', note: 'Only in folders you allow. It can\'t change anything.' },
  list: { title: 'look through folders', note: 'Only in folders you allow.' },
  search: { title: 'search in files', note: 'Only in folders you allow.' },
  edit: { title: 'edit files', note: 'Only in folders you allow for changes.' },
  write: { title: 'create files', note: 'Only in folders you allow for changes.' },
  shell: { title: 'run commands', note: 'Any command, started in its files folder. Commands can reach files outside the folders you allow.' },
  web_search: { title: 'search the web', note: 'It sees search results, not your files.' },
  web_fetch: { title: 'read web pages', note: 'It sees the pages, not your files.' },
  browser: { title: 'use the browser', note: 'Its own browser, apart from your tabs. It can open pages, click and type. Sites you sign in to there stay signed in for it.' }
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** "400,000 tokens". */
const tokens = (count: number) => `${Math.round(count).toLocaleString('en-US')} tokens`

function budgetText(key: string, amount: number | undefined, budget: BotBudget | undefined): AskText {
  const held = budget?.[key as keyof BotBudget]
  const total = amount !== undefined && held !== undefined ? held + amount : undefined
  switch (key) {
    case 'maxActiveMs':
      return total !== undefined ? { title: `work for up to ${plural(minutes(total), 'minute')} per run`, note: '' } : { title: 'work longer on each run', note: '' }
    case 'maxTurns':
      return total !== undefined ? { title: `take up to ${plural(Math.round(total), 'step')} per run`, note: '' } : { title: 'take more steps on each run', note: '' }
    case 'maxToolCalls':
      return total !== undefined ? { title: `use tools up to ${plural(Math.round(total), 'time')} per run`, note: '' } : { title: 'use its tools more on each run', note: '' }
    case 'maxInputTokens':
      return total !== undefined ? { title: `read up to ${tokens(total)} per run`, note: '' } : { title: 'read and write more on each run', note: '' }
    case 'maxOutputTokens':
      return total !== undefined ? { title: `write up to ${tokens(total)} per run`, note: '' } : { title: 'read and write more on each run', note: '' }
    case 'maxUsd':
      return total !== undefined ? { title: `spend up to $${Number(total.toFixed(2))} per run`, note: '' } : { title: 'spend more on each run', note: '' }
    default:
      return { title: 'do more on each run', note: '' }
  }
}

/**
 * `request` in plain words. `home` shortens folders to `~/…`; `budget`, the bot's current limits,
 * turns a limit ask into its new total.
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
  if ('mcp' in request) return { title: `use ${request.mcp.tool} from ${request.mcp.serverId}`, note: '' }
  if ('tool' in request) {
    // Every browser tool is one permission: "use the browser", never "the browser act tool".
    const tool = botGrantTool(request.tool)
    return TOOL_TEXT[tool] ?? { title: `use the ${tool.replace(/_/g, ' ')} tool`, note: '' }
  }
  return budgetText(request.budget.key, request.budget.amount, options.budget)
}
