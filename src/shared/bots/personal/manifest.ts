import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool } from '../../browser/automation'
import { isNeutralTool, type NeutralTool } from '../../harness/tools'
import { DEFAULT_BOT_ACTIVE_MS, foldersOf, workspaceOf, type BotBudget, type BotManifest, type BotPermissionLine } from './definition'
import { BOT_MEMORY_TOOLS } from './memory'

/**
 * A bot manifest's canonical form, the subset rule of approval, and the plain words the approval
 * dialog uses (PR 6 §4). Browser-safe: the digest itself is computed in the daemon.
 */

const BUDGET_KEYS = ['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const

/** The longest work time one activation may be given: a day. */
export const MAX_BOT_ACTIVE_MS = 24 * 60 * 60_000

/**
 * The bot's own app tools (Bot Phase 1 §5.10): its schedules, its name and description, how much
 * time it takes, asking the owner, and its memory. They act only on the bot itself (in `bots.db`),
 * so they are not permissions: every bot has them, they never raise an ask, and About never lists them.
 */
export const BOT_OWN_APP_TOOLS: readonly string[] = [
  'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list', 'set_profile', 'set_depth', 'use_model', 'escalate', ...BOT_MEMORY_TOOLS,
  // An automation run's report on its own run (the Automations inbox); only a scheduled run has one to give.
  'run_report'
]

/**
 * The bot's front-desk tools (docs/plans/bot-always-free.md): a chat turn hands longer work to a run of its own and
 * keeps one-off reminders. Like memory they are always on and never grantable, so bots made before them have them too;
 * only a chat turn gets them, so work never starts work.
 */
export const BOT_WORK_TOOLS: readonly string[] = ['work_start', 'work_models', 'work_list', 'work_stop', 'work_note', 'remind', 'reminder_list', 'reminder_cancel']

/**
 * The tools a bot's work splits a job among subagents with: start one on a title and a brief (on the work's model, or one
 * from `work_models`), send it a follow-up, wait for it, read its result, stop it. Like memory they are always on and
 * never grantable: they give no power the work lacks, since each subagent is compiled from the same grant and holds less
 * (`BOT_SUBAGENT_APP_TOOLS`). Only a run's main turn gets them, never the chat, a consult or a subagent: one level.
 */
export const BOT_SUBAGENT_TOOLS: readonly string[] = ['subagent_start', 'subagent_send', 'subagent_wait', 'subagent_result', 'subagent_stop']

/**
 * The grant's Mousse app tools a bot's subagent may have, when the grant holds them: the web and the bot's own browser.
 * The rest are the bot's and its work's alone: its own tools (schedules, its name and depth, its model, memory, asks),
 * the automation tools, and the owner's threads. The built-ins, the files folder, file access, MCP tools and skills are
 * the work's, unchanged.
 */
export const BOT_SUBAGENT_APP_TOOLS: readonly string[] = ['web_search', 'web_fetch', 'browser']

/** Subagents one piece of a bot's work runs at once: a bot's own run slots. */
export const MAX_BOT_SUBAGENTS_AT_ONCE = 3

/** Subagents one piece of a bot's work may start in all, across its turns: the threads a bot may have at work at once. */
export const MAX_BOT_SUBAGENTS_PER_WORK = 10

/**
 * What a chat turn never does itself, though the grant may hold it: it can take long (the web, the browser, running
 * commands), so the chat hands it to work and stays free to talk. Work runs with the whole grant.
 */
export const BOT_WORK_ONLY_TOOLS: readonly string[] = ['shell', 'web_search', 'web_fetch']

/**
 * The bot's listing of its owner's MCP servers (`mcp_servers`): each server set up for the whole profile, by name and a
 * line of Mousse's own, and whether the bot holds its tools. It shows no tool schema and calls nothing, so like memory
 * it is always on and never grantable, in both lanes: the chat needs it to ask for the right server.
 */
export const BOT_MCP_LIST_TOOL = 'mcp_servers'

/** Every new bot's app tools: the web, and its own tools. */
export const BOT_DEFAULT_APP_TOOLS: readonly string[] = ['web_search', 'web_fetch', ...BOT_OWN_APP_TOOLS]

/**
 * "Use the browser": one permission for every browser tool, asked for once and remembered. The
 * grant names it alone; `compileBotThread` turns it into the browser tools, which drive the bot's
 * own browser (`src/mms/bots/browser/`), never the owner's tabs or another thread's.
 */
export const BOT_BROWSER_PERMISSION = 'browser'

/**
 * The browser tools a bot with the browser gets. `browser_request_human` is not one: a bot asks its
 * owner in its reply, and the owner takes over from the bot's browser view.
 */
export const BOT_BROWSER_TOOLS: readonly BrowserAutomationTool[] = BROWSER_AUTOMATION_TOOLS.filter((tool) => tool !== 'browser_request_human')

/**
 * The automation tools (`automation_*`, v4): a bot granted them builds drafts the owner turns on, and lists, changes
 * and pauses the owner's automations. They are permissions: the first use asks the owner.
 */
export const BOT_AUTOMATION_APP_TOOLS: readonly string[] = ['automation_draft_save', 'automation_ask', 'automation_list', 'automation_update', 'automation_pause']

/**
 * "Use your threads": one permission, asked for once, for the owner's ordinary threads in this profile. The grant names
 * it alone; `compileBotThread` turns it into the thread tools a turn may use (`BOT_THREAD_READ_TOOLS` in every lane but a
 * consult, `BOT_THREAD_ACT_TOOLS` only in a chat turn the owner's own message started). A thread the bot starts runs in
 * Full access, and a message it sends runs in that thread's own mode, so the card says so (`askText`).
 */
export const BOT_THREADS_PERMISSION = 'threads'

/** What a bot with "use your threads" may do in its work as well as its chat: list, search, read and wait on threads. */
export const BOT_THREAD_READ_TOOLS: readonly string[] = ['thread_list', 'thread_search', 'thread_read', 'thread_wait']

/**
 * What changes threads: start one, message one, stop one's turn. Only a chat turn the owner's own message started gets
 * them, so nothing a bot read in its work, a reminder or a schedule starts or steers a thread.
 */
export const BOT_THREAD_ACT_TOOLS: readonly string[] = ['thread_create', 'thread_send', 'thread_interrupt']

/** Every thread tool a bot can hold, all under "use your threads". */
export const BOT_THREAD_TOOLS: readonly string[] = [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS]

const THREAD_TOOL_NAMES: ReadonlySet<string> = new Set(BOT_THREAD_TOOLS)

/** Whether `name` is one of the thread tools a bot can hold under "use your threads". */
export function isBotThreadTool(name: string): boolean {
  return THREAD_TOOL_NAMES.has(name)
}

/**
 * The Mousse app tools a bot may be granted: ones that read the web, its own browser, the bot's
 * own tools, the automation tools, and the owner's threads as one permission. Every other app tool starts, wakes,
 * writes or reads other threads (delegation, forks, queues, merge-backs), acts in the owner's name, or asks a person,
 * so it would run work outside the grant. Consults (6c-2) are the way a bot uses its own threads. The skill tools come
 * with granted skills.
 */
export const BOT_APP_TOOLS: ReadonlySet<string> = new Set([...BOT_DEFAULT_APP_TOOLS, BOT_BROWSER_PERMISSION, ...BOT_AUTOMATION_APP_TOOLS, BOT_THREADS_PERMISSION])

/**
 * Every Mousse app tool a bot's turn can ever be offered (what `compileBotThread` may add to a turn): the grantable
 * tools, the browser's tools in place of "browser", the skill tools, consult, and the front desk's work and reminder
 * tools. A bot's thread lists only these, so its runtime never shows the model a tool no bot can hold.
 */
const BOT_OFFERABLE_APP_TOOLS: ReadonlySet<string> = new Set([
  ...[...BOT_APP_TOOLS].filter((tool) => tool !== BOT_BROWSER_PERMISSION && tool !== BOT_THREADS_PERMISSION),
  ...BOT_BROWSER_TOOLS,
  ...BOT_THREAD_TOOLS,
  ...BOT_WORK_TOOLS,
  ...BOT_SUBAGENT_TOOLS,
  ...BOT_MEMORY_TOOLS,
  BOT_MCP_LIST_TOOL,
  'list_skills', 'load_skill', 'escalate', 'consult'
])

/** Whether a bot's turn can ever be offered the Mousse app tool `name` (`BOT_OFFERABLE_APP_TOOLS`). */
export function botMayBeOffered(name: string): boolean {
  return BOT_OFFERABLE_APP_TOOLS.has(name)
}

const OWN_APP_TOOLS: ReadonlySet<string> = new Set(BOT_OWN_APP_TOOLS)
const BROWSER_TOOLS: ReadonlySet<string> = new Set(BROWSER_AUTOMATION_TOOLS)

/**
 * The permission an app tool falls under: every browser tool is "use the browser" (`browser`), so
 * an ask for `browser_act` is the same one ask; every thread tool is "use your threads" (`threads`); any other tool is
 * its own.
 */
export function botGrantTool(tool: string): string {
  if (BROWSER_TOOLS.has(tool)) return BOT_BROWSER_PERMISSION
  return THREAD_TOOL_NAMES.has(tool) ? BOT_THREADS_PERMISSION : tool
}

/** Whether `tool` is one of the bot's own tools: not a permission, never listed in About. */
export function isOwnBotAppTool(tool: string): boolean {
  return OWN_APP_TOOLS.has(tool)
}

/**
 * A new bot's grant (Bot Phase 1 §5.3.1): the file tools, which reach only its files folder until
 * the owner lets it use files on this computer; the web and its own tools; no file access; an hour
 * per activation. Pressing Create bot approves it.
 */
export function botStarterManifest(): BotManifest {
  return {
    tools: ['read', 'list', 'search', 'edit', 'write'],
    appTools: [...BOT_DEFAULT_APP_TOOLS],
    mcp: [],
    skills: [],
    workspace: null,
    budget: { maxActiveMs: DEFAULT_BOT_ACTIVE_MS },
    audience: 'owner'
  }
}

/** One MCP server id or tool name: no separator a qualified name or an identity key could hide. */
const MCP_PART = /^[A-Za-z0-9](?:[A-Za-z0-9.-]|_(?!_)){0,127}$/

/** Whether `part` can be a granted MCP server id or tool name (`BotManifest.mcp`). */
export function mcpGrantable(part: string): boolean {
  return MCP_PART.test(part)
}

/** The identity of a granted MCP tool: injective in its server and tool. */
export function mcpIdentity(pair: { serverId: string; tool: string }): string {
  return JSON.stringify([pair.serverId, pair.tool])
}

const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] => {
  const seen = new Map<string, T>()
  for (const value of values) seen.set(key(value), value)
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value)
}

/**
 * The manifest with every list deduplicated and sorted and every absent limit dropped, so two
 * manifests that grant the same things have the same canonical JSON (and digest).
 */
export function canonicalManifest(manifest: BotManifest): BotManifest {
  const budget: BotBudget = { maxActiveMs: manifest.budget.maxActiveMs }
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) budget[key] = manifest.budget[key]
  return {
    tools: sorted(manifest.tools, (tool) => tool),
    appTools: sorted(manifest.appTools, (tool) => tool),
    mcp: sorted(manifest.mcp, mcpIdentity).map((pair) => ({ serverId: pair.serverId, tool: pair.tool })),
    skills: sorted(manifest.skills, (skill) => skill),
    workspace: workspaceOf(foldersOf(manifest.workspace)),
    budget,
    audience: manifest.audience
  }
}

/** Why a manifest is malformed, or undefined when it is well formed. */
export function manifestProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'The permissions are missing.'
  const manifest = value as Partial<BotManifest>
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  if (!Array.isArray(manifest.tools) || !manifest.tools.every((tool) => typeof tool === 'string' && isNeutralTool(tool))) return 'A built-in tool is not one Mousse knows.'
  if (!strings(manifest.appTools)) return 'An app tool name is invalid.'
  const refusedApp = (manifest.appTools as string[]).find((tool) => !BOT_APP_TOOLS.has(tool))
  if (refusedApp !== undefined) return `A bot can't be given the Mousse tool ${refusedApp}: it would reach other threads, act in your name or ask you, outside the bot's permissions.`
  if (!strings(manifest.skills)) return 'A skill id is invalid.'
  if (!Array.isArray(manifest.mcp) || !manifest.mcp.every((pair) => pair && typeof pair === 'object' && typeof pair.serverId === 'string' && typeof pair.tool === 'string' && MCP_PART.test(pair.serverId) && MCP_PART.test(pair.tool))) return 'An MCP tool is invalid.'
  if (manifest.workspace !== null) {
    const workspace = manifest.workspace
    if (!workspace || typeof workspace !== 'object' || !strings(workspace.roots) || workspace.roots.length === 0) return 'The bot needs at least one folder, or no file access.'
    if (workspace.access !== 'read' && workspace.access !== 'write') return 'Folder access must be read or write.'
    if (workspace.roots.some((root) => !isAbsolutePath(root))) return 'Folders must be absolute paths.'
    if (workspace.rootAccess !== undefined) {
      if (!workspace.rootAccess || typeof workspace.rootAccess !== 'object' || Array.isArray(workspace.rootAccess)) return 'Folder access is invalid.'
      for (const [root, access] of Object.entries(workspace.rootAccess))
        if (!workspace.roots.includes(root) || (access !== 'read' && access !== 'write')) return 'Folder access is invalid.'
    }
  }
  const budget = manifest.budget
  if (!budget || typeof budget !== 'object') return 'The limits are missing.'
  for (const key of BUDGET_KEYS) {
    const limit = budget[key]
    if (limit === undefined && key !== 'maxActiveMs') continue
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return `The limit ${key} must be a positive number.`
    // Counts and times are whole numbers; only the spend is in dollars.
    if (key !== 'maxUsd' && !Number.isSafeInteger(limit)) return `The limit ${key} must be a whole number.`
  }
  if ((budget.maxActiveMs as number) > MAX_BOT_ACTIVE_MS) return 'A bot can work at most 24 hours per run.'
  if (manifest.audience !== 'owner') return 'Bots for other people are not available yet.'
  return undefined
}

/**
 * A full folder path that names exactly the folder shown: absolute on the daemon's platform (on
 * Windows `/x` is relative to the current drive, so it is not), with no `.` or `..` part that
 * would make the folder granted differ from the one shown.
 */
export function isAbsolutePath(path: string, platform: string = currentPlatform()): boolean {
  const windows = platform === 'win32'
  const absolute = windows ? /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path) : path.startsWith('/')
  if (!absolute) return false
  return !path.split(windows ? /[\\/]/ : /\//).some((part) => part === '.' || part === '..')
}

function currentPlatform(): string {
  const scope = globalThis as { process?: { platform?: string }; navigator?: { platform?: string } }
  if (typeof scope.process?.platform === 'string') return scope.process.platform
  return /win/i.test(scope.navigator?.platform ?? '') ? 'win32' : 'linux'
}

/**
 * Whether `wanted` asks for nothing beyond `granted`: every tool, app tool, MCP tool and skill is
 * granted, file access only when it is granted, and every limit is at most the granted one (a
 * limit the grant has and `wanted` drops is wider, so it is not a subset).
 */
export function manifestSubset(wanted: BotManifest, granted: BotManifest): boolean {
  return addedPermissions(wanted, granted).length === 0
}

/**
 * What `wanted` adds to `granted`, in plain words: the lines the approval dialog lists when a
 * revision asks for more than the active grant. Everything when nothing is granted yet.
 */
export function addedPermissions(wanted: BotManifest, granted: BotManifest | null): BotPermissionLine[] {
  if (!granted) return describeManifest(wanted)
  const lines: BotPermissionLine[] = []
  const tools = new Set(granted.tools)
  for (const tool of wanted.tools) if (!tools.has(tool)) lines.push(toolLine(tool, wanted.workspace))
  const appTools = new Set(granted.appTools)
  for (const tool of wanted.appTools) if (!appTools.has(tool)) lines.push(appToolLine(tool))
  const mcp = new Set(granted.mcp.map(mcpIdentity))
  for (const pair of wanted.mcp) if (!mcp.has(mcpIdentity(pair))) lines.push(mcpLine(pair))
  const skills = new Set(granted.skills)
  for (const skill of wanted.skills) if (!skills.has(skill)) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
  if (wanted.workspace && !granted.workspace) lines.push(FILES_LINE)
  for (const key of BUDGET_KEYS) {
    const limit = wanted.budget[key]
    const held = granted.budget[key]
    if (held === undefined) continue
    if (limit === undefined || limit > held) lines.push(budgetLine(key, limit))
  }
  return unique(lines)
}

/** Every permission of a manifest, in plain words. */
export function describeManifest(manifest: BotManifest): BotPermissionLine[] {
  const lines: BotPermissionLine[] = []
  if (manifest.workspace) lines.push(FILES_LINE)
  for (const tool of manifest.tools) lines.push(toolLine(tool, manifest.workspace))
  for (const tool of manifest.appTools) lines.push(appToolLine(tool))
  for (const pair of manifest.mcp) lines.push(mcpLine(pair))
  for (const skill of manifest.skills) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) lines.push(budgetLine(key, manifest.budget[key]))
  return unique(lines)
}

/** Each line once: a folder's access and a tool on it can say the same thing. */
function unique(lines: BotPermissionLine[]): BotPermissionLine[] {
  const seen = new Set<string>()
  return lines.filter((line) => !seen.has(line.text) && Boolean(seen.add(line.text)))
}

const TOOL_WORDS: Record<NeutralTool, string> = {
  read: 'Read files',
  list: 'List folders',
  search: 'Search files',
  edit: 'Edit files',
  write: 'Create and overwrite files',
  shell: 'Run commands',
  web_fetch: 'Fetch web pages',
  web_search: 'Search the web'
}

/** The file tools: in the bot's files folder, or anywhere once it may use files on this computer. */
const FILE_TOOLS: ReadonlySet<NeutralTool> = new Set<NeutralTool>(['read', 'list', 'search', 'edit', 'write'])

/**
 * File access (bot-architecture.md §3.7): one permission, every folder on this computer, read and
 * write. A workspace of any shape grants it, so a grant an older build wrote for some folders
 * holds it too.
 */
const FILES_LINE: BotPermissionLine = { kind: 'workspace', text: 'Use files on this computer' }

function toolLine(tool: NeutralTool, workspace: BotManifest['workspace']): BotPermissionLine {
  if (!FILE_TOOLS.has(tool)) return { kind: 'tool', text: TOOL_WORDS[tool] }
  return { kind: 'tool', text: workspace ? TOOL_WORDS[tool] : `${TOOL_WORDS[tool]} in its files folder` }
}

/** An app tool in plain words: the browser and the owner's threads by what they are, any other tool by its name. */
function appToolLine(tool: string): BotPermissionLine {
  if (tool === BOT_BROWSER_PERMISSION) return { kind: 'app_tool', text: 'Use the browser' }
  if (tool === BOT_THREADS_PERMISSION) return { kind: 'app_tool', text: 'Use your threads' }
  return { kind: 'app_tool', text: `Use the Mousse tool \`${tool}\`` }
}

function mcpLine(pair: { serverId: string; tool: string }): BotPermissionLine {
  return { kind: 'mcp', text: `Use the MCP tool \`${pair.tool}\`` }
}

function budgetLine(key: (typeof BUDGET_KEYS)[number], limit: number | undefined): BotPermissionLine {
  if (limit === undefined) return { kind: 'budget', text: `No limit on ${BUDGET_WORDS[key]}` }
  if (key === 'maxActiveMs') {
    const minutes = Math.round(limit / 60_000)
    return { kind: 'budget', text: minutes >= 1 ? `Up to ${minutes} minute${minutes === 1 ? '' : 's'} of work per run` : `Up to ${Math.round(limit / 1000)} seconds of work per run` }
  }
  if (key === 'maxUsd') return { kind: 'budget', text: `Up to $${limit} per run` }
  return { kind: 'budget', text: `Up to ${limit} ${BUDGET_WORDS[key]} per run` }
}

const BUDGET_WORDS: Record<(typeof BUDGET_KEYS)[number], string> = {
  maxActiveMs: 'work time',
  maxTurns: 'model requests (retries included)',
  maxToolCalls: 'tool calls',
  maxInputTokens: 'input tokens',
  maxOutputTokens: 'output tokens',
  maxUsd: 'spend'
}

/**
 * One thread's permissions: the manifest, narrowed. `narrow` only removes: a tool, MCP tool or
 * skill it names that the manifest lacks is ignored. File access is one permission: a narrowing
 * to no workspace removes it, and any other keeps it as the manifest has it.
 */
export function narrowManifest(manifest: BotManifest, narrow: Partial<Pick<BotManifest, 'tools' | 'mcp' | 'skills' | 'workspace'>> | undefined): BotManifest {
  if (!narrow) return manifest
  const keep = <T>(values: readonly T[], allowed: readonly T[] | undefined, key: (value: T) => string): T[] => {
    if (!allowed) return [...values]
    const names = new Set(allowed.map(key))
    return values.filter((value) => names.has(key(value)))
  }
  return {
    ...manifest,
    tools: keep(manifest.tools, narrow.tools, (tool) => tool),
    mcp: keep(manifest.mcp, narrow.mcp, mcpIdentity),
    skills: keep(manifest.skills, narrow.skills, (skill) => skill),
    workspace: narrow.workspace === null ? null : manifest.workspace
  }
}

/**
 * What runs: `wanted` (a published revision) held inside `granted` (the approved grant). Only
 * what both name is kept (file access when both have it), and each limit is the lower one. A
 * revision that is a subset of the grant is itself; a narrower one really narrows.
 */
export function intersectManifest(wanted: BotManifest, granted: BotManifest): BotManifest {
  const within = <T>(values: readonly T[], allowed: readonly T[], key: (value: T) => string): T[] => {
    const names = new Set(allowed.map(key))
    return values.filter((value) => names.has(key(value)))
  }
  const workspace = wanted.workspace && granted.workspace ? granted.workspace : null
  const budget: BotBudget = { maxActiveMs: Math.min(wanted.budget.maxActiveMs, granted.budget.maxActiveMs) }
  for (const key of BUDGET_KEYS) {
    const a = wanted.budget[key]
    const b = granted.budget[key]
    const limit = a === undefined ? b : b === undefined ? a : Math.min(a, b)
    if (limit !== undefined) budget[key] = limit
  }
  return {
    tools: within(wanted.tools, granted.tools, (tool) => tool),
    appTools: within(wanted.appTools, granted.appTools, (tool) => tool),
    mcp: within(wanted.mcp, granted.mcp, mcpIdentity),
    skills: within(wanted.skills, granted.skills, (skill) => skill),
    workspace,
    budget,
    audience: 'owner'
  }
}
