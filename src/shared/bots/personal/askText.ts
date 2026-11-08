import type { BotBudget } from './definition'
import { isSpecialAsk, type BotAskRequest } from './escalation'

/**
 * An ask in plain words for its card and for About → Can use (Bot Phase 1 §5.4): the card reads
 * "<name> wants to <title>", then the note. Browser-safe.
 */

export interface AskText {
  /** Lower case, read after "wants to": "use files on this computer". */
  title: string
  /** One line on the limit; empty when there is nothing to add. */
  note: string
}

/** Tools by name, as a card says them after "wants to". */
const TOOL_TEXT: Record<string, AskText> = {
  read: { title: 'read files', note: 'In its files folder, or anywhere once it may use files on this computer.' },
  list: { title: 'look through folders', note: 'In its files folder, or anywhere once it may use files on this computer.' },
  search: { title: 'search in files', note: 'In its files folder, or anywhere once it may use files on this computer.' },
  edit: { title: 'edit files', note: 'In its files folder, or anywhere once it may use files on this computer.' },
  write: { title: 'create files', note: 'In its files folder, or anywhere once it may use files on this computer.' },
  shell: { title: 'run commands', note: 'Any command, started in its files folder. Commands can reach other files on this computer.' },
  web_search: { title: 'search the web', note: 'It sees search results, not your files.' },
  web_fetch: { title: 'read web pages', note: 'It sees the pages, not your files.' }
}

/** The one file permission (`filesAsk`), read and write, everywhere but Mousse's own data. */
export const FILES_TEXT: AskText = { title: 'use files on this computer', note: 'Read and change any file or folder, except Mousse\'s own data.' }

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

/** `request` in plain words. `budget`, the bot's current limits, turns a limit ask into its new total. */
export function askText(request: BotAskRequest, options: { budget?: BotBudget } = {}): AskText {
  if (isSpecialAsk(request)) return { title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' }
  // File access is one permission, whatever folder an ask names (`filesAsk`).
  if ('path' in request) return FILES_TEXT
  if ('skill' in request) return { title: `use the ${request.skill} skill`, note: '' }
  if ('mcp' in request) return { title: `use ${request.mcp.tool} from ${request.mcp.serverId}`, note: '' }
  if ('tool' in request) return TOOL_TEXT[request.tool] ?? { title: `use the ${request.tool.replace(/_/g, ' ')} tool`, note: '' }
  return budgetText(request.budget.key, request.budget.amount, options.budget)
}
