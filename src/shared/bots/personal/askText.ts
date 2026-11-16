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
  tip: 'It can read your threads, their queues and their Git status and diffs, here and on your other computers that let agents work there. When you ask it in its chat, or in work you gave it, it can start new threads, message, steer or stop them, change what waits in their queues, fork one and hand a fork\'s work back, and archive or unarchive them. A thread it starts runs commands and changes files without asking; a message it sends runs in that thread\'s own mode. It answers an approval only while you let agents answer approvals on other threads, and never a question.'
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
  threads: THREADS_TEXT,
  profiler: {
    title: 'use the profiler',
    note: "Mousse's memory and CPU numbers, while Labs lets agents read the profiler.",
    tip: "It can read Mousse's profiler: memory and CPU of each process, the service's counts and caches, windows and the GPU, and take samples. Numbers only, never your chats or files; threads it can't see count only in totals. Never a heap snapshot. Settings → Labs → Profiler can still turn it off."
  },
  themes: {
    title: 'change how Mousse looks',
    note: 'Themes, colors, CSS and a wallpaper picture from this computer, without asking each time.',
    tip: "It can read your themes, switch between them, and save a theme with colors, an accent, CSS and a wallpaper, as a thread's agent can in Full access. Theme CSS can restyle or cover anything in Mousse's window; CSS that loads anything from outside Mousse is dropped. A wallpaper is a PNG, JPEG or WebP it names on this computer, never on a network share; Mousse keeps its own copy. Settings → Appearance switches the theme back."
  },
  schedules: {
    title: 'schedule work in your threads',
    note: 'Scheduled jobs that run in your threads with full access, without asking each time.',
    tip: "It can make scheduled jobs, as a thread's agent can: a turn in one of your threads, or a new thread in a project, later or on a cadence. It sees, changes, pauses, runs and removes only the jobs it made. Its jobs run in Full access (or no wider than the device you wrote from). The profile's limits on agent jobs hold, and Automations shows each job; only you resume or extend one."
  },
  secrets: {
    title: 'use secrets you give it',
    note: 'You type each one into a private card in its chat; it gets only the name.',
    tip: 'It can ask you for a secret (an API key, a token) with a private card in its chat, where you type it or pick a saved one. It never sees the value: it uses the secret by name in commands its work runs from its files folder (with "run commands"), each command\'s output masked. Those commands run in a sandbox with only its folders and no network, which needs Linux with bubblewrap; on other computers it can only ask. Settings → Secrets lists and removes them.'
  },
  quick_actions: {
    title: 'add quick actions',
    note: 'Buttons in your Actions list, without asking for each.',
    tip: 'It can add a quick action: a button in your Actions list that sends a message or runs a shell command when you press it. Nothing runs until you press it.'
  }
}

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

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** "45 minutes", "2 hours", "90 minutes": whole hours read as hours. */
const duration = (ms: number) => {
  const count = minutes(ms)
  return count >= 60 && count % 60 === 0 ? plural(count / 60, 'hour') : plural(count, 'minute')
}
/** "400,000 tokens". */
const tokens = (count: number) => `${Math.round(count).toLocaleString('en-US')} tokens`

function budgetText(key: string, amount: number | undefined, budget: BotBudget | undefined): AskText {
  const held = budget?.[key as keyof BotBudget]
  const total = amount !== undefined && held !== undefined ? held + amount : undefined
  switch (key) {
    case 'maxActiveMs':
      return total !== undefined ? { title: `work for up to ${duration(total)} per run`, note: '' } : { title: 'work longer on each run', note: '' }
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
    return TOOL_TEXT[tool] ?? { title: `use the ${tool.replace(/_/g, ' ')} tool`, note: '' }
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
