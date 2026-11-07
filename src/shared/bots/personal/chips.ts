import type { BotChip, BotChipIcon } from './chat'

/**
 * Activity chips (Bot Phase 1 §5.8, bot-ui C3). Mousse makes them from the calls the authority
 * allowed, never from model text: a live chip is worded as an attempt ("searching the web"), and the
 * calls of one dispatch roll up into settled chips when it ends ("searched the web · 3"). App tools,
 * whose results pass through Mousse, may give outcome chips ("every weekday · 09:00"). No chip ever
 * names a model. Browser-safe.
 */

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
}

/** What a call does, for its words and how it rolls up. */
type ChipKind =
  | 'search' | 'fetch' | 'read' | 'change' | 'save' | 'draft' | 'lookback' | 'consult' | 'skill' | 'tool' | 'schedules'
  | 'schedule' | 'unschedule' | 'remember' | 'forget' | 'depth' | 'profile'

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

function insideFolder(folder: string | undefined, path: string): boolean {
  if (!folder) return false
  const base = trimSeparators(folder)
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

const parts = (path: string) => path.split(/[\\/]+/).filter(Boolean)
const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

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

function classifyFile(tool: string, input: unknown, ctx: BotChipContext): Classified {
  const writes = WRITE_TOOLS.has(tool)
  const path = pathOf(input)
  // No path or a relative one: the working folder, which is the scratch folder.
  if (!path || !isAbsolute(path) || insideFolder(ctx.scratch, path))
    return writes ? { kind: 'draft', icon: 'edit', live: 'working on a draft' } : { kind: 'read', icon: 'read', live: 'reading files' }
  if (insideFolder(ctx.filesFolder, path)) {
    if (writes) return { kind: 'save', icon: 'edit', live: 'saving a file', ...(parts(path).length > parts(ctx.filesFolder!).length ? { detail: parts(path).pop() } : {}) }
    return { kind: 'read', icon: 'read', live: 'reading files', detail: 'saved files' }
  }
  const detail = folderName(tool, path, ctx)
  return writes
    ? { kind: 'change', icon: 'edit', live: 'changing files', ...(detail ? { detail } : {}) }
    : { kind: 'read', icon: 'read', live: 'reading files', ...(detail ? { detail } : {}) }
}

const DEPTH_WORDS: Record<string, string> = { deep: 'taking more time', quick: 'going quicker', normal: 'back to the usual pace' }

function classify(tool: string, input: unknown, ctx: BotChipContext): Classified | null {
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
    case 'web_fetch': {
      const domain = domainOf(args.url)
      return { kind: 'fetch', icon: 'web', live: 'reading a page', ...(domain ? { detail: domain } : {}) }
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
    case 'consult': {
      const context = str(args.context)
      return { kind: 'consult', icon: 'think', live: 'checking with', ...(context ? { detail: shortChipText(context, 30) } : {}) }
    }
    case 'skill':
    case 'load_skill': {
      const skill = str(args.skill)
      return { kind: 'skill', icon: 'think', live: 'using a skill', ...(skill ? { detail: shortChipText(skill, 30) } : {}) }
    }
    case 'list_skills': return { kind: 'skill', icon: 'think', live: 'looking at its skills' }
    case 'mcp': {
      const server = str(args.server)
      return { kind: 'tool', icon: 'think', live: 'using a tool', ...(server ? { detail: shortChipText(server, 30) } : {}) }
    }
    case 'shell': return { kind: 'tool', icon: 'think', live: 'running a command' }
    // `escalate`: its card is the chip. `use_model`: the model is never shown.
    default: return null
  }
}

/**
 * The live chip for a call the authority just allowed, or null when the call shows none
 * (`escalate`: its card is the chip; `use_model`: the model is never shown).
 */
export function chipForCall(tool: string, input: unknown, ctx: BotChipContext = {}): BotChip | null {
  const classified = classify(tool, input, ctx)
  if (!classified) return null
  return { icon: classified.icon, text: classified.live, ...(classified.detail ? { highlight: classified.detail } : {}), live: true }
}

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
      const label = str(result.label)
      return label ? { icon: 'schedule', text: label } : { icon: 'schedule', text: 'set a schedule' }
    }
    case 'remember': {
      const text = str(input.text) ?? str(result.text)
      return text ? { icon: 'memory', text: 'remembered', highlight: shortChipText(text) } : { icon: 'memory', text: 'remembered something' }
    }
    // Never the forgotten text: the chip is stored with the message (`chips_json`), and the owner asked for it to go.
    case 'forget': return { icon: 'memory', text: 'forgot something you asked me to' }
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
function groupChip(kind: ChipKind, icon: BotChipIcon, calls: readonly Classified[], all: readonly BotChipCall[]): BotChip | null {
  const n = calls.length
  const details = calls.flatMap((call) => (call.detail ? [call.detail] : []))
  const chip = (text: string, highlight?: string): BotChip => ({ icon, text, ...(highlight ? { highlight } : {}) })
  switch (kind) {
    case 'search': return chip('searched the web', n === 1 ? details[0] : String(n))
    case 'fetch': return chip(n === 1 ? 'read a page' : `read ${n} pages`, listed(details))
    case 'read': return chip('read files', listed(details))
    case 'change': return chip('changed files', listed(details))
    case 'save': return chip(n === 1 ? 'saved a file' : `saved ${n} files`, listed(details))
    case 'draft': return chip('worked on a draft')
    case 'lookback': return chip('looked back', n === 1 ? details[0] : String(n))
    case 'consult': return chip('checked with', listed(details))
    case 'skill': return chip(details.length ? 'used a skill' : 'looked at its skills', listed(details))
    case 'tool': return chip(details.length ? 'used a tool' : 'ran a command', listed(details))
    case 'unschedule': {
      const done = all.filter((call) => succeeded(call.result)).length
      return done ? chip(done === 1 ? 'removed a schedule' : `removed ${done} schedules`) : null
    }
    case 'depth': return chip(calls[n - 1]!.live)
    default: return null
  }
}

/** Kinds whose every successful call is its own chip. */
const OUTCOME_KINDS: ReadonlySet<ChipKind> = new Set(['schedule', 'remember', 'forget'])
/** Kinds that settle to one chip for the last call only. */
const LAST_KINDS: ReadonlySet<ChipKind> = new Set(['profile'])
/** Kinds that settle to nothing: a look at its own schedules is not worth a chip. */
const QUIET_KINDS: ReadonlySet<ChipKind> = new Set(['schedules'])

/**
 * The settled chips of one dispatch: grouped by kind, with counts and a short highlight (a domain,
 * a folder name, a schedule label), in first-seen order. Saves, forgets and new schedules are one
 * chip each, worded by their outcome; a call that failed shows none of those.
 */
export function rollUpChips(calls: readonly BotChipCall[], ctx: BotChipContext = {}): BotChip[] {
  const order: Array<{ key: string; chip?: BotChip }> = []
  const groups = new Map<string, { kind: ChipKind; icon: BotChipIcon; classified: Classified[]; calls: BotChipCall[] }>()
  for (const call of calls) {
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
    const chip = group ? groupChip(group.kind, group.icon, group.classified, group.calls) : null
    return chip ? [chip] : []
  })
}
