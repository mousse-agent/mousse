import type { BotBudget } from './definition'
import { isSpecialAsk, type BotAskRequest } from './escalation'
import { botGrantTool } from './manifest'

/**
 * An ask in plain words for its card and for About → Can use (Bot Phase 1 §5.4): the card reads
 * "<name> wants to <title>", then the note. Browser-safe.
 */

export interface AskText {
  /** Lower case, read after "wants to": "run commands". */
  title: string
  /** One line on the limit; empty when there is nothing to add. */
  note: string
  /** What Allow gives, in full, for the card's tooltip and About's: absent when the note says it all. */
  tip?: string
}

/**
 * "Use your threads": what the card and About say. The line names what matters most, that a thread it starts runs with
 * full access; the tooltip says the rest.
 */
export const THREADS_TEXT: AskText = {
  title: 'use your threads',
  note: 'Threads it starts run with full access on this computer.',
  tip: 'It can read your threads, their queues and their Git status and diffs, here and on your other computers that let agents work there. When you ask it in its chat, or in work you gave it, it can start new threads, message, steer or stop them, change what waits in their queues, fork one and hand a fork\'s work back, and archive or unarchive them. A thread it starts runs commands and changes files without asking; a message it sends runs in that thread\'s own mode. It answers the questions and approvals of the threads it starts. In other threads it answers an approval only while you let agents answer approvals on other threads, and never a question.'
}

/**
 * "Create and turn on automations" (`automation_enable`): what the card and About say. The line names what matters most,
 * that what it turns on runs without the owner's Turn on, in their permission mode.
 */
export const AUTOMATION_ENABLE_TEXT: AskText = {
  title: 'create and turn on automations',
  note: 'They run without you pressing Turn on, within the permissions you hold.',
  tip: "It can turn on the automation drafts it wrote, or write one and turn it on at once, as if you pressed Turn on: each runs on its schedule in your permission mode, until you pause or delete it in Automations. Another bot's message never makes it do so. Without this it writes drafts you turn on yourself."
}

/** Tools by name, as a card says them after "wants to". */
const TOOL_TEXT: Record<string, AskText> = {
  read: { title: 'read files', note: 'In its files folder.' },
  list: { title: 'look through folders', note: 'In its files folder.' },
  search: { title: 'search in files', note: 'In its files folder.' },
  edit: { title: 'edit files', note: 'In its files folder.' },
  write: { title: 'create files', note: 'In its files folder.' },
  shell: { title: 'run commands', note: 'Any command, started in its files folder. Commands can reach other files on this computer.' },
  web_search: { title: 'search the web', note: 'It sees search results, not your files.' },
  web_fetch: { title: 'read web pages', note: 'It sees the pages, not your files.' },
  browser: { title: 'use the browser', note: 'Its own browser, apart from your tabs. It can open pages, click and type. Sites you sign in to there stay signed in for it.' },
  computer: {
    title: 'use the computer',
    note: 'Sees and operates apps on this computer: windows, clicks and typing.',
    tip: "It can read app windows, click, type and run steps in apps on this computer through Cua Driver, as a thread's agent can, in its work (never in the chat itself). Threads it starts get it too. Settings → Computer use can still turn it off for everyone."
  },
  threads: THREADS_TEXT,
  automation_enable: AUTOMATION_ENABLE_TEXT,
  // The bot's own tools: a bot made before one of them existed has none of it in its grant, so its first use asks.
  bot_schedule_add: { title: 'run on a schedule', note: '' },
  bot_schedule_remove: { title: 'remove its schedules', note: '' },
  bot_schedule_list: { title: 'see its schedules', note: '' },
  set_profile: { title: 'change its name or description', note: '' },
  set_depth: { title: 'change how long it thinks', note: '' },
  use_model: { title: 'switch its model', note: '' },
  permission_ask: { title: 'ask you for permissions', note: '' },
  run_report: { title: 'report on its automation runs', note: '' },
  memory_search: { title: 'search its memory', note: '' },
  memory_read: { title: 'read its memory', note: '' },
  memory_list: { title: 'list its memory', note: '' },
  memory_save: { title: 'save to its memory', note: '' },
  memory_forget: { title: 'forget things in its memory', note: '' },
  item_save: { title: 'keep its list of what you asked for', note: '' },
  item_list: { title: 'read its list of what you asked for', note: '' }
}

/** Any other tool: the card never shows a tool's name; the tooltip does. */
const otherToolText = (tool: string): AskText => ({ title: 'use another of Mousse\'s tools', note: '', tip: `Mousse's tool ${tool}.` })

/**
 * What an MCP ask's card says of what the tools can do, only as the tools' own annotations tell it (their read-only
 * hints): Mousse never judges a server itself.
 */
export function mcpChangesNote(name: string, changes: 'none' | 'some' | 'unknown' | undefined): string {
  if (changes === 'none') return `${name} says these tools only read.`
  if (changes === 'some') return `${name} says some of these tools can change things.`
  return `${name} doesn't say whether these tools change things.`
}

/**
 * A file ask an older build wrote (a `path` request): bots can no longer be given files outside their files folder, so
 * such a card stays only as history and Allow gives nothing.
 */
export const OLD_FILES_TEXT: AskText = { title: 'use files on this computer', note: 'No longer available: a bot uses only its own files folder.' }

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** "400,000 tokens". */
const tokens = (count: number) => `${Math.round(count).toLocaleString('en-US')} tokens`

function budgetText(key: string, amount: number | undefined, budget: BotBudget | undefined): AskText {
  const held = budget?.[key as keyof BotBudget]
  const total = amount !== undefined && held !== undefined ? held + amount : undefined
  switch (key) {
    // An older build's ask for work time, which has no limit now: only its answered card is still shown.
    case 'maxActiveMs':
      return { title: 'keep working', note: '' }
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
  if (isSpecialAsk(request)) return request.ask === 'export_memory' ? { title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' } : { title: 'allow this request', note: 'This request grants no tools.' }
  if ('path' in request) return OLD_FILES_TEXT
  if ('skill' in request) return { title: `use the ${request.skill} skill`, note: '' }
  // The owner's MCP tools are one ask per server: "use your GitHub tools", and "use GitHub's new tools" once it added some.
  if ('mcp' in request) {
    const name = request.mcp.name
    if (name) {
      // Not answered yet: the card says so, and its tools are filled in (with what their hints say) once they are listed.
      if (request.mcp.loading) return { title: `use your ${name} tools`, note: `${name} is still starting, so its tools aren't listed yet. Allow turns on once they are.` }
      const changes = mcpChangesNote(name, request.mcp.changes)
      if (request.mcp.changed) return { title: `use your ${name} tools again`, note: `${name} changed since you allowed it: it now runs from another address or command. ${changes}` }
      return request.mcp.added ? { title: `use ${name}'s new tools`, note: `${name} has new tools. ${changes}` } : { title: `use your ${name} tools`, note: changes }
    }
    return { title: request.mcp.tool ? `use the MCP tool ${request.mcp.tool}` : 'use the tools of an MCP server', note: '' }
  }
  if ('tool' in request) {
    // Every browser tool is one permission: "use the browser", never "the browser act tool".
    const tool = botGrantTool(request.tool)
    return TOOL_TEXT[tool] ?? otherToolText(tool)
  }
  return budgetText(request.budget.key, request.budget.amount, options.budget)
}

/**
 * The words of a notice that carries only an ask ("Plusy wants to run commands."): an ask the turn's reply had no room
 * for, or one a run posted. The chat shows such a notice as the ask alone, as on a reply, and once answered only the
 * quiet line the answer leaves (`askOnlyNotice`).
 */
export function askNoticeText(botName: string, title: string): string {
  return `${botName} wants to ${title}.`
}
