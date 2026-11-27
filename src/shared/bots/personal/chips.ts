import type { BotChip, BotChipIcon } from './chat'
import { canonicalToolName } from '../../toolAliases'

/**
 * Activity chips (Bot Phase 1 §5.8, bot-ui C3). Mousse makes them from the calls the authority
 * allowed, never from model text: a live chip is worded as an attempt ("searching the web"), and the
 * calls of one dispatch roll up into settled chips when it ends ("searched the web · 3"). App tools,
 * whose results pass through Mousse, may give outcome chips ("every weekday · 09:00"). No chip names a model, except
 * work the owner asked to run on a model that is not the bot's usual one ("started Vacuum comparison · Opus 5.5").
 * Browser-safe.
 */

/** The tooltip of work on a model of its own: "Opus 5.5 on Claude Code, high reasoning, for this work only". */
export function workModelDetail(model: { name: string; entry: string; effort?: string }): string {
  return `${model.name}${model.entry ? ` on ${model.entry}` : ''}${model.effort ? `, ${model.effort} reasoning` : ''}, for this work only`
}

/** Where a call happened, for highlights: the bot's files folder, its scratch folder and the owner's home (`~`). */
export interface BotChipContext {
  filesFolder?: string
  scratch?: string
  home?: string
}

/** One allowed call of a dispatch, in the order it was made. */
export interface BotChipCall {
  /** Neutral built-in name (`read`, `edit` …) or app-tool name (`web_search`, `bot_schedule_add` …). */
  tool: string
  input: unknown
  /** An app tool's result, when it returned (outcome chips). */
  result?: unknown
  /**
   * The provider's own storage, as its gate decided from real paths (`NormalisedCall.own`): Claude Code reading back a
   * large tool result it saved under its home. Its plumbing, not the bot's work, so it shows and settles to no chip.
   */
  own?: true
}

/** What a call does, for its words and how it rolls up. */
type ChipKind =
  | 'search' | 'fetch' | 'service_read' | 'browse' | 'read' | 'change' | 'save' | 'draft' | 'lookback' | 'consult' | 'skill' | 'tool' | 'mcp' | 'schedules'
  | 'schedule' | 'unschedule' | 'remember' | 'forget' | 'depth' | 'profile' | 'model'
  | 'work' | 'work_stop' | 'work_note' | 'remind' | 'unremind' | 'work_look' | 'wake' | 'watch' | 'unwatch' | 'bot_send' | 'bot_look'
  | 'threads_look' | 'profiler' | 'themes_look' | 'theme' | 'thread_wait' | 'thread_start' | 'thread_send' | 'thread_stop' | 'thread_archive' | 'thread_hide' | 'picture'
  | 'thread_steer' | 'thread_fork' | 'thread_merge' | 'approval' | 'queue' | 'jobs' | 'secret' | 'secret_run' | 'quick_action'
  | 'subagent' | 'subagent_wait' | 'subagent_look' | 'computer'

interface Classified {
  kind: ChipKind
  icon: BotChipIcon
  /** The live chip's words. */
  live: string
  /** A highlight for the live chip and the roll-up: a query, a domain, a folder or file name. */
  detail?: string
}

const READ_TOOLS = new Set(['read', 'list', 'search'])
const WRITE_TOOLS = new Set(['edit', 'write'])
const LOOK_BACK_TOOLS = new Set(['memory_search', 'memory_read', 'memory_list'])
const PATH_ARGUMENTS = ['path', 'file_path', 'filePath', 'notebook_path', 'directory', 'dir'] as const

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** At most `max` characters on one line, cut with an ellipsis at a word end when one is near. */
export function shortChipText(text: string, max = 40): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space >= max - 12 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function domainOf(url: unknown): string | undefined {
  const text = str(url)
  if (!text) return undefined
  try {
    return new URL(text).hostname.replace(/^www\./, '') || undefined
  } catch {
    return undefined
  }
}

const trimSeparators = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, '') : path)

const parts = (path: string) => path.split(/[\\/]+/).filter(Boolean)
const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
/** A Windows drive (`C:\`, `C:/`) or UNC (`\\server\share`) path, where either separator works and case does not count. */
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

/**
 * An absolute path with `/` between its parts, `.` and `..` resolved, repeated and trailing separators dropped. A Windows
 * drive or UNC path takes either separator; a Unix path splits on `/` only (a `\` is part of a file name there). A
 * relative path is resolved against `cwd`, and is undefined without one.
 */
function resolvePath(path: string, cwd?: string): { path: string; windows: boolean } | undefined {
  if (!isAbsolute(path)) return cwd && isAbsolute(cwd) ? resolvePath(`${cwd}${isWindowsPath(cwd) ? '\\' : '/'}${path}`) : undefined
  const windows = isWindowsPath(path)
  const segments = (windows ? path.split(/[\\/]+/) : path.split('/')).filter(Boolean)
  // The part `..` never climbs above: `/`, a drive (`c:`) or a UNC share (`//server/share`).
  const root = !windows ? '' : path.startsWith('\\\\') ? `//${segments.splice(0, 2).join('/')}` : segments.shift()!
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '..') resolved.pop()
    else if (segment !== '.') resolved.push(segment)
  }
  return { path: `${root}/${resolved.join('/')}`, windows }
}

/** One spelling of a path, to compare two: `resolvePath`, and case ignored on a Windows drive or UNC path only. */
function comparablePath(path: string, cwd?: string): string | undefined {
  const resolved = resolvePath(path, cwd)
  return resolved && (resolved.windows ? resolved.path.toLowerCase() : resolved.path)
}

/** Whether `path` (relative ones against `cwd`) is `folder` or inside it, compared by `comparablePath`. */
function insideFolder(folder: string | undefined, path: string, cwd?: string): boolean {
  const base = folder ? comparablePath(folder) : undefined
  const target = comparablePath(path, cwd)
  if (!base || !target) return false
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** A path's last name, split as `resolvePath` splits it: a Unix file name may hold a `\`. */
function nameOf(path: string, cwd?: string): string | undefined {
  const windows = isAbsolute(path) ? isWindowsPath(path) : !!cwd && isWindowsPath(cwd)
  return (windows ? path.split(/[\\/]+/) : path.split('/')).filter((segment) => segment && segment !== '.' && segment !== '..').pop()
}

function pathOf(input: unknown): string | undefined {
  const args = record(input)
  for (const key of PATH_ARGUMENTS) if (str(args[key])) return str(args[key])
  return undefined
}

/** The folder a file tool works in, by name: "Invoices", "~" for the home folder itself. */
function folderName(tool: string, path: string, ctx: BotChipContext): string | undefined {
  const folder = tool === 'list' || tool === 'search' ? trimSeparators(path) : trimSeparators(path).replace(/[\\/][^\\/]*$/, '') || '/'
  if (ctx.home && trimSeparators(folder) === trimSeparators(ctx.home)) return '~'
  return parts(folder).pop() ?? folder
}

function classifyFile(tool: string, input: unknown, ctx: BotChipContext): Classified | null {
  const writes = WRITE_TOOLS.has(tool)
  const path = pathOf(input)
  // No path, a relative one with no working folder to resolve it against, or one in the scratch folder, where the bot
  // works (a relative path resolves against it): a draft.
  if (!path || (!isAbsolute(path) && !ctx.scratch) || insideFolder(ctx.scratch, path, ctx.scratch))
    return writes ? { kind: 'draft', icon: 'edit', live: 'working on a draft' } : { kind: 'read', icon: 'read', live: 'reading files' }
  if (insideFolder(ctx.filesFolder, path, ctx.scratch)) {
    if (!writes) return { kind: 'read', icon: 'read', live: 'reading files', detail: 'saved files' }
    const name = comparablePath(path, ctx.scratch) === comparablePath(ctx.filesFolder!) ? undefined : nameOf(path, ctx.scratch)
    return { kind: 'save', icon: 'edit', live: 'saving a file', ...(name ? { detail: name } : {}) }
  }
  // A relative one by where it resolves, so its highlight is never "..".
  const detail = folderName(tool, isAbsolute(path) ? path : resolvePath(path, ctx.scratch)?.path ?? path, ctx)
  return writes
    ? { kind: 'change', icon: 'edit', live: 'changing files', ...(detail ? { detail } : {}) }
    : { kind: 'read', icon: 'read', live: 'reading files', ...(detail ? { detail } : {}) }
}

const DEPTH_WORDS: Record<string, string> = { deep: 'taking more time', quick: 'going quicker', normal: 'back to the usual pace' }

function classify(name: string, input: unknown, ctx: BotChipContext): Classified | null {
  // A call an older activation recorded under a tool's old name reads as the tool it was renamed to.
  const tool = canonicalToolName(name)
  const args = record(input)
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) return classifyFile(tool, input, ctx)
  if (LOOK_BACK_TOOLS.has(tool)) {
    const query = tool === 'memory_search' ? str(args.query) : undefined
    return { kind: 'lookback', icon: 'memory', live: 'looking back', ...(query ? { detail: shortChipText(query, 30) } : {}) }
  }
  switch (tool) {
    case 'web_search': {
      const query = str(args.query)
      return { kind: 'search', icon: 'search', live: 'searching the web', ...(query ? { detail: shortChipText(query, 30) } : {}) }
    }
    case 'computer_tools':
      return { kind: 'computer', icon: 'web', live: 'using the computer' }
    case 'computer_use_request':
      return { kind: 'computer', icon: 'ask', live: 'asking you to set up computer use' }
    case 'computer_use': {
      const action = str(args.tool)
      return { kind: 'computer', icon: 'web', live: 'using the computer', ...(action ? { detail: shortChipText(action, 30) } : {}) }
    }
    case 'web_fetch': {
      const domain = domainOf(args.url)
      return { kind: 'fetch', icon: 'web', live: 'reading a page', ...(domain ? { detail: domain } : {}) }
    }
    case 'browser_open':
    case 'browser_tabs':
    case 'browser_observe':
    case 'browser_screenshot':
    case 'browser_find':
    case 'browser_act':
    case 'browser_wait':
    case 'browser_extract': {
      // The page it goes to, when the call names one: a browser_open, a new tab or a navigate action.
      const action = record(args.action)
      const domain = domainOf(args.url) ?? (action.type === 'navigate' ? domainOf(action.url) : undefined)
      return { kind: 'browse', icon: 'web', live: 'using the browser', ...(domain ? { detail: domain } : {}) }
    }
    case 'bot_schedule_add': return { kind: 'schedule', icon: 'schedule', live: 'setting a schedule' }
    case 'bot_schedule_remove': return { kind: 'unschedule', icon: 'schedule', live: 'removing a schedule' }
    case 'bot_schedule_list': return { kind: 'schedules', icon: 'schedule', live: 'checking its schedules' }
    case 'memory_save': return { kind: 'remember', icon: 'memory', live: 'remembering' }
    case 'memory_forget': return { kind: 'forget', icon: 'memory', live: 'forgetting' }
    case 'set_depth': {
      const words = DEPTH_WORDS[String(args.depth)]
      return words ? { kind: 'depth', icon: 'think', live: words } : null
    }
    case 'set_profile': return { kind: 'profile', icon: 'name', live: 'updating its profile' }
    // `use_model` (#673): the owner sees the change, never the model's name (About → Runs on names it).
    case 'use_model': return { kind: 'model', icon: 'think', live: 'switching models' }
    case 'consult': {
      const context = str(args.context)
      // A context thread is the bot's own knowledge of a topic: it looks into it, never "checks with" someone.
      return { kind: 'consult', icon: 'think', live: 'looking into', ...(context ? { detail: shortChipText(context, 30) } : {}) }
    }
    case 'skill':
    case 'skill_load': {
      const skill = str(args.skill)
      return { kind: 'skill', icon: 'think', live: 'using a skill', ...(skill ? { detail: shortChipText(skill, 30) } : {}) }
    }
    case 'skill_list': return { kind: 'skill', icon: 'think', live: 'looking at its skills' }
    // One of the owner's MCP tools: the server's name ("using GitHub"), never the tool or its arguments.
    case 'mcp': {
      const server = str(args.server)
      return { kind: 'mcp', icon: 'think', live: server ? 'using' : 'using a tool', ...(server ? { detail: shortChipText(server, 30) } : {}) }
    }
    case 'shell': return { kind: 'tool', icon: 'think', live: 'running a command' }
    // A picture on the Images row's model (#1088), never the model's name.
    case 'make_image': return { kind: 'picture', icon: 'think', live: 'making a picture' }
    // The chat's work and reminders (docs/plans/bot-always-free.md), worded as the bot's own doing: never a hand-off.
    case 'work_start': return { kind: 'work', icon: 'think', live: 'starting on it' }
    case 'work_stop': return { kind: 'work_stop', icon: 'think', live: 'stopping' }
    case 'work_note': return { kind: 'work_note', icon: 'think', live: 'noting it' }
    case 'work_list': return { kind: 'work_look', icon: 'think', live: 'checking on its work' }
    case 'model_list': return { kind: 'work_look', icon: 'think', live: 'looking at your models' }
    case 'remind': return { kind: 'remind', icon: 'schedule', live: 'setting a reminder' }
    case 'wake': return { kind: 'wake', icon: 'schedule', live: 'setting a wake-up' }
    // Messages to the owner's other bots: each one sent is a chip; a look at who they are is not.
    case 'bot_send': return { kind: 'bot_send', icon: 'think', live: 'telling another bot' }
    case 'bot_list': return { kind: 'bot_look', icon: 'think', live: 'looking at your other bots' }
    case 'watch_start': return { kind: 'watch', icon: 'schedule', live: 'starting a background command' }
    case 'watch_stop': return { kind: 'unwatch', icon: 'schedule', live: 'stopping a background command' }
    case 'watch_list': return { kind: 'work_look', icon: 'think', live: 'checking its background work' }
    case 'running_list': return { kind: 'work_look', icon: 'think', live: 'checking what is running' }
    case 'reminder_cancel': return { kind: 'unremind', icon: 'schedule', live: 'cancelling a reminder' }
    case 'reminder_list': return { kind: 'schedules', icon: 'schedule', live: 'checking its reminders' }
    // The owner's threads ("use your threads"): what it read rolls up into one chip; each start, message and stop is its
    // own chip, with the thread to open.
    case 'thread_list':
    case 'thread_search':
    case 'thread_read':
    case 'queue_list':
    case 'git_status':
    case 'git_diff':
    case 'computer_list': return { kind: 'threads_look', icon: 'read', live: 'reading your threads' }
    case 'terminal_read': return { kind: 'threads_look', icon: 'read', live: 'reading a terminal' }
    case 'thread_wait': return { kind: 'thread_wait', icon: 'think', live: 'waiting on a thread' }
    // Steering, forking, handing a fork back and answering an approval: each its own chip, with the thread to open.
    case 'thread_steer': return { kind: 'thread_steer', icon: 'think', live: 'steering a thread' }
    case 'thread_fork': return { kind: 'thread_fork', icon: 'think', live: 'forking a thread' }
    case 'thread_merge_back': return { kind: 'thread_merge', icon: 'think', live: 'handing a fork back' }
    // Passing on its owner's answer to its work (`answer`) has no chip of its own.
    case 'request_answer': return typeof args.answer === 'string' || typeof args.questionId === 'string' ? null : { kind: 'approval', icon: 'think', live: 'answering an approval' }
    // A thread's queue: every change rolls up into one chip.
    case 'queue_enqueue':
    case 'queue_update': return { kind: 'queue', icon: 'think', live: "changing a thread's queue" }
    // The owner's scheduled jobs ("schedule work in your threads"): the list is a look, every change one chip.
    case 'schedule_list': return { kind: 'schedules', icon: 'schedule', live: 'checking your scheduled jobs' }
    case 'schedule_create':
    case 'schedule_update':
    case 'schedule_pause':
    case 'schedule_run':
    case 'schedule_delete': return { kind: 'jobs', icon: 'schedule', live: 'changing your scheduled jobs' }
    // Secrets ("use secrets you give it"): asking shows the card; a command with one is its own chip.
    case 'secret_request': return { kind: 'secret', icon: 'ask', live: 'asking you for a secret' }
    // The vault supplies this activity only after validation and admission, like an MCP server label.
    case 'service_read': return { kind: 'service_read', icon: 'read', live: 'reading from', detail: shortChipText(str(args.service) ?? 'a service', 40) }
    case 'secret_run': return { kind: 'secret_run', icon: 'think', live: 'running a command with a secret' }
    case 'create_quick_action': return { kind: 'quick_action', icon: 'edit', live: 'adding a quick action' }
    // Mousse's profiler ("use the profiler"): every read and sample rolls up into one chip.
    case 'profiler_overview':
    case 'profiler_service_breakdown':
    case 'profiler_window_breakdown':
    case 'profiler_gpu_hints':
    case 'profiler_children':
    case 'profiler_sample_now':
    case 'profiler_watch': return { kind: 'profiler', icon: 'read', live: "checking Mousse's memory" }
    // Mousse's look ("change how Mousse looks"): reading the themes, and changing them.
    case 'theme_read': return { kind: 'themes_look', icon: 'read', live: 'looking at your themes' }
    case 'theme_set': return { kind: 'theme', icon: 'edit', live: 'changing how Mousse looks' }
    case 'thread_create': {
      const title = str(args.title)
      return { kind: 'thread_start', icon: 'think', live: 'starting a thread', ...(title ? { detail: shortChipText(title, 40) } : {}) }
    }
    case 'thread_send': return { kind: 'thread_send', icon: 'think', live: 'messaging a thread' }
    case 'thread_interrupt': return { kind: 'thread_stop', icon: 'think', live: 'stopping a thread' }
    case 'thread_archive': return { kind: 'thread_archive', icon: 'think', live: args.archived === false ? 'unarchiving a thread' : 'archiving a thread' }
    case 'thread_hide': return { kind: 'thread_hide', icon: 'think', live: args.hidden === false ? 'showing a thread' : 'hiding a thread' }
    // Its work's subagents: each one it starts or sends more work by its title; waiting on them is one chip.
    case 'subagent_start':
    case 'subagent_send': {
      const title = str(args.title) ?? str(args.subagent)
      return { kind: 'subagent', icon: 'think', live: tool === 'subagent_start' ? 'starting a subagent' : 'messaging a subagent', ...(title ? { detail: shortChipText(title, 30) } : {}) }
    }
    case 'subagent_wait': return { kind: 'subagent_wait', icon: 'think', live: 'waiting on its subagents' }
    case 'subagent_result':
    case 'subagent_stop': return { kind: 'subagent_look', icon: 'think', live: 'checking on its subagents' }
    // `permission_ask`: its card is the chip. `question_ask`: its question's bubble is.
    default: return null
  }
}

/**
 * The live chip for a call the authority just allowed, or null when the call shows none
 * (`permission_ask`: its card is the chip).
 */
export function chipForCall(tool: string, input: unknown, ctx: BotChipContext = {}): BotChip | null {
  const classified = classify(tool, input, ctx)
  if (!classified) return null
  return { icon: classified.icon, text: classified.live, ...(classified.detail ? { highlight: classified.detail } : {}), live: true }
}

/**
 * The live chip of a call that has no words of its own (a tool `classify` does not name, a card that is its own chip):
 * the bot is doing something else now, so what it did before no longer stands. Never the tool's name. It is live only:
 * such a call settles to no chip.
 */
export const WORKING_LIVE_CHIP: BotChip = { icon: 'think', text: 'working', live: true }

/** A few distinct values in one highlight: "a.com", "a.com, b.com", "a.com +2". */
function listed(values: readonly string[]): string | undefined {
  const distinct = [...new Set(values)]
  if (distinct.length <= 2) return distinct.join(', ') || undefined
  return `${distinct[0]} +${distinct.length - 1}`
}

const succeeded = (result: unknown) => {
  const value = record(result)
  return result !== undefined && value.error === undefined && value.ok !== false
}

/** An outcome chip of one app-tool call, after it returned; null when it shows none (it failed, or has not returned). */
function outcomeChip(kind: ChipKind, call: BotChipCall): BotChip | null {
  if (!succeeded(call.result)) return null
  const input = record(call.input)
  const result = record(call.result)
  switch (kind) {
    case 'schedule': {
      // Shown as an automation card on the message instead.
      if (result.card === true) return null
      const label = str(result.label)
      return label ? { icon: 'schedule', text: label } : { icon: 'schedule', text: 'set a schedule' }
    }
    case 'remember': {
      const text = str(input.text) ?? str(result.text)
      const absorbed = Array.isArray(result.absorbed) ? result.absorbed.flatMap((entry) => {
        const text = str(record(entry).text)
        return text ? [shortChipText(text)] : []
      }) : []
      return text ? {
        icon: 'memory', text: 'remembered',
        highlight: `${shortChipText(text)}${absorbed.length ? ` · put away ${absorbed.length}` : ''}`,
        ...(absorbed.length ? { title: `Put away:\n${absorbed.join('\n')}` } : {})
      } : { icon: 'memory', text: 'remembered something' }
    }
    // Never the forgotten text: the chip is stored with the message (`chips_json`), and the owner asked for it to go.
    case 'forget': return { icon: 'memory', text: 'forgot something you asked me to' }
    case 'work': {
      const title = str(input.title)
      // Work the owner asked to run on a model that is not the bot's usual one names it, with the details on hover.
      const model = record(result.model)
      const name = str(model.name)
      const highlight = [title ? shortChipText(title, 40) : undefined, name ? shortChipText(name, 24) : undefined].filter(Boolean).join(' · ')
      const effort = str(model.effort)
      return {
        icon: 'think',
        text: result.replayed
          ? (result.status === 'ended' ? 'already ended' : result.status === 'queued' ? 'already queued' : 'already on it')
          : result.status === 'queued' ? 'will start' : 'started',
        ...(highlight ? { highlight } : {}),
        ...(name ? { title: workModelDetail({ name, entry: str(model.entry) ?? '', ...(effort ? { effort } : {}) }) } : {})
      }
    }
    // The job's title, as on "started": "stopped · SSD search".
    case 'work_stop': {
      if (result.result !== 'stopped') return null
      const title = str(result.title)
      return { icon: 'think', text: 'stopped', ...(title ? { highlight: shortChipText(title, 40) } : {}) }
    }
    // An acknowledgement under the reply, which says what changes; the job it is for on hover.
    case 'work_note': {
      if (result.result !== 'noted') return null
      const title = str(result.title)
      return { icon: 'think', text: 'noted', ...(title ? { title: `For ${shortChipText(title, 60)}` } : {}) }
    }
    case 'remind': {
      const label = str(result.label)
      return { icon: 'schedule', text: 'reminder', ...(label ? { highlight: label } : {}) }
    }
    case 'unremind': return { icon: 'schedule', text: 'cancelled a reminder' }
    // A background command shows as a card on the message instead.
    case 'watch': return null
    case 'unwatch': return { icon: 'schedule', text: 'stopped a background command' }
    // A message to another of the owner's bots: "told · Alpha".
    case 'bot_send': {
      const to = str(result.to)
      return to ? { icon: 'think', text: 'told', highlight: shortChipText(to, 40) } : null
    }
    // A wake: what it waits for ("when acme/app#12 merges") or its time.
    case 'wake': {
      const label = str(result.waitsFor) ?? str(result.when)
      return { icon: 'schedule', text: 'wake-up', ...(label ? { highlight: label } : {}) }
    }
    // A thread it started, messaged, stopped, archived, unarchived, hid or showed: its title, and the thread, which the chip
    // opens (a hidden thread too).
    case 'thread_start':
    case 'thread_send':
    case 'thread_stop':
    case 'thread_archive':
    case 'thread_hide':
    case 'thread_steer':
    case 'thread_fork':
    case 'thread_merge':
    case 'approval': {
      const threadId = str(result.threadId)
      if (!threadId) return null
      const title = str(result.title)
      const text = kind === 'thread_start' ? (result.hidden === true ? 'started hidden thread' : 'started thread')
        : kind === 'thread_send' ? 'messaged' : kind === 'thread_stop' ? 'stopped'
          : kind === 'thread_steer' ? 'steered' : kind === 'thread_fork' ? 'forked into' : kind === 'thread_merge' ? 'handed fork back to'
            : kind === 'approval' ? (result.decision === 'allow' ? 'approved in' : 'answered approval in')
              : kind === 'thread_hide' ? (result.hidden === false ? 'showed in sidebar' : 'hid from sidebar')
                : result.archived === false ? 'unarchived' : 'archived'
      // The first line of what it sent there, which the chip shows on hover.
      const said = str(result.sent)
      return { icon: 'think', text, ...(title ? { highlight: shortChipText(title, 40) } : {}), thread: threadId, ...(said ? { said: shortChipText(said, 160) } : {}) }
    }
    case 'model': {
      const rows = result.for === 'talk' ? 'for talking' : result.for === 'work' ? 'for work' : result.for === 'all' ? 'from now on' : 'for this chat'
      return { icon: 'think', text: 'switched models', highlight: rows }
    }
    case 'profile': {
      const name = str(input.name)
      if (name) return { icon: 'name', text: 'renamed itself', highlight: shortChipText(name) }
      return str(input.description) ? { icon: 'name', text: 'updated its description' } : null
    }
    default:
      return null
  }
}

/** The settled chip of a group of calls of one kind. */
function groupChip(kind: ChipKind, icon: BotChipIcon, calls: readonly Classified[], all: readonly BotChipCall[], ctx: BotChipContext): BotChip | null {
  const n = calls.length
  const details = calls.flatMap((call) => (call.detail ? [call.detail] : []))
  const chip = (text: string, highlight?: string): BotChip => ({ icon, text, ...(highlight ? { highlight } : {}) })
  switch (kind) {
    case 'search': return chip('searched the web', n === 1 ? details[0] : String(n))
    case 'fetch': return chip(n === 1 ? 'read a page' : `read ${n} pages`, listed(details))
    case 'browse': return chip('used the browser', listed(details))
    case 'computer': return chip('used the computer')
    case 'read': return chip('read files', listed(details))
    case 'change': return chip('changed files', listed(details))
    case 'save': {
      // A file written, then edited, is one file saved, however its path was spelled (`insideFolder`'s comparison), and
      // named as it was first written. A call with no path saved no file it can name, and is not counted.
      const names = new Map<string, string | undefined>()
      all.forEach((call, index) => {
        const path = pathOf(call.input)
        const spelled = path ? comparablePath(path, ctx.scratch) : undefined
        if (spelled && !names.has(spelled)) names.set(spelled, calls[index]?.detail)
      })
      const files = names.size
      return chip(files <= 1 ? 'saved a file' : `saved ${files} files`, listed([...names.values()].flatMap((name) => (name ? [name] : []))))
    }
    case 'draft': return chip('worked on a draft')
    case 'lookback': return chip('looked back', n === 1 ? details[0] : String(n))
    case 'consult': return chip('looked into', listed(details))
    case 'skill': return chip(details.length ? 'used a skill' : 'looked at its skills', listed(details))
    case 'tool': return chip(details.length ? 'used a tool' : 'ran a command', listed(details))
    case 'service_read': return chip('read from', listed(details))
    case 'mcp': return details.length ? chip('used', listed(details)) : chip('used a tool')
    case 'threads_look': return chip('read your threads')
    case 'profiler': return chip("checked Mousse's memory and CPU")
    case 'themes_look': return chip('looked at your themes')
    case 'theme': return chip('changed how Mousse looks')
    case 'queue': return chip("changed a thread's queue")
    case 'jobs': return chip('changed your scheduled jobs')
    case 'secret': return chip('asked you for a secret')
    case 'secret_run': return chip('ran a command with a secret')
    case 'quick_action': return chip(n === 1 ? 'added a quick action' : `added ${n} quick actions`)
    case 'thread_wait': return chip(n === 1 ? 'waited on a thread' : `waited on threads · ${n}`)
    case 'subagent': {
      const titles = [...new Set(details)]
      return chip(titles.length > 1 ? `used ${titles.length} subagents` : 'used a subagent', listed(titles))
    }
    // Only the pictures made: a refused or failed call shows none.
    case 'picture': {
      const made = all.filter((call) => succeeded(call.result)).length
      return made ? chip(made === 1 ? 'made a picture' : `made ${made} pictures`) : null
    }
    case 'unschedule': {
      const done = all.filter((call) => succeeded(call.result)).length
      return done ? chip(done === 1 ? 'removed a schedule' : `removed ${done} schedules`) : null
    }
    case 'depth': return chip(calls[n - 1]!.live)
    default: return null
  }
}

/** Kinds whose every successful call is its own chip. */
const OUTCOME_KINDS: ReadonlySet<ChipKind> = new Set(['schedule', 'remember', 'forget', 'work', 'work_stop', 'work_note', 'remind', 'unremind', 'wake', 'watch', 'unwatch', 'bot_send', 'model', 'thread_start', 'thread_send', 'thread_stop', 'thread_archive', 'thread_hide'])
/** Kinds that settle to one chip for the last call only. */
const LAST_KINDS: ReadonlySet<ChipKind> = new Set(['profile'])
/** Kinds that settle to nothing: a look at its own schedules is not worth a chip. */
const QUIET_KINDS: ReadonlySet<ChipKind> = new Set(['schedules', 'work_look', 'bot_look', 'subagent_wait', 'subagent_look'])

/**
 * The settled chips of one dispatch: grouped by kind, with counts and a short highlight (a domain,
 * a folder name, a schedule label), in first-seen order. Saves, forgets and new schedules are one
 * chip each, worded by their outcome; a call that failed shows none of those.
 */
/**
 * The chip of a thread a bot started, messaged or stopped ("use your threads"), as soon as the call returned: the chat
 * shows it at once, before the turn ends and its message carries every chip. Null for any other call.
 */
export function actedChip(tool: string, input: unknown, result: unknown): BotChip | null {
  const kind = tool === 'thread_create' ? 'thread_start' : tool === 'thread_send' ? 'thread_send' : tool === 'thread_interrupt' ? 'thread_stop'
    : tool === 'thread_archive' ? 'thread_archive' : tool === 'thread_hide' ? 'thread_hide' : undefined
  return kind ? outcomeChip(kind, { tool, input, result }) : null
}

export function rollUpChips(calls: readonly BotChipCall[], ctx: BotChipContext = {}): BotChip[] {
  const order: Array<{ key: string; chip?: BotChip }> = []
  const groups = new Map<string, { kind: ChipKind; icon: BotChipIcon; classified: Classified[]; calls: BotChipCall[] }>()
  for (const call of calls) {
    if (call.own) continue
    const classified = classify(call.tool, call.input, ctx)
    if (!classified || QUIET_KINDS.has(classified.kind)) continue
    if (OUTCOME_KINDS.has(classified.kind)) {
      const chip = outcomeChip(classified.kind, call)
      if (chip) order.push({ key: `outcome:${order.length}`, chip })
      continue
    }
    if (LAST_KINDS.has(classified.kind)) {
      const chip = outcomeChip(classified.kind, call)
      if (!chip) continue
      const at = order.findIndex((entry) => entry.key === classified.kind)
      if (at >= 0) order.splice(at, 1)
      order.push({ key: classified.kind, chip })
      continue
    }
    const group = groups.get(classified.kind)
    if (group) {
      group.classified.push(classified)
      group.calls.push(call)
    } else {
      groups.set(classified.kind, { kind: classified.kind, icon: classified.icon, classified: [classified], calls: [call] })
      order.push({ key: classified.kind })
    }
  }
  return order.flatMap((entry) => {
    if (entry.chip) return [entry.chip]
    const group = groups.get(entry.key)
    const chip = group ? groupChip(group.kind, group.icon, group.classified, group.calls, ctx) : null
    return chip ? [chip] : []
  })
}
