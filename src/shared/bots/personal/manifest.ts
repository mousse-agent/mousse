import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool } from '../../browser/automation'
import { COMPUTER_TOOL_NAMES, COMPUTER_USE_REQUEST_TOOL } from '../../computerUse'
import { PROFILER_TOOL_NAMES, type ProfilerToolName } from '../../diagnostics/profiler'
import { isNeutralTool, NEUTRAL_TOOLS, type NeutralTool } from '../../harness/tools'
import { foldersOf, workspaceOf, type BotBudget, type BotManifest, type BotPermissionLine } from './definition'
import { BOT_LIST_TOOL, BOT_SEND_TOOL } from './botMessages'
import { BOT_MEMORY_TOOLS } from './memory'
import { BOT_ITEM_TOOLS } from './items'
import { BOT_CATALOGUE_TOOL, BOT_USE_TOOL } from './catalogue'
import { canonicalToolName } from '../../toolAliases'

/**
 * A bot manifest's canonical form, the subset rule of approval, and the plain words the approval
 * dialog uses (PR 6 §4). Browser-safe: the digest itself is computed in the daemon.
 */

/** The limits an owner may set on a bot's runs. Work time is not one: it has no limit (`BotBudget.maxActiveMs`). */
const BUDGET_KEYS = ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const

/**
 * The bot's own app tools (Bot Phase 1 §5.10): its schedules, its name and description, how much
 * time it takes, asking the owner, and its memory. They act only on the bot itself (in `bots.db`),
 * so they are not permissions: every bot has them, they never raise an ask, and About never lists them.
 */
export const BOT_OWN_APP_TOOLS: readonly string[] = [
  'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list', 'set_profile', 'set_depth', 'use_model', 'escalate', ...BOT_MEMORY_TOOLS, ...BOT_ITEM_TOOLS,
  // An automation run's report on its own run (the Automations inbox); only a scheduled run has one to give.
  'run_report'
]

/**
 * The bot's front-desk tools (docs/plans/bot-always-free.md): a chat turn hands longer work to a run of its own and
 * keeps one-off reminders and wakes (its own follow-ups). Like memory they are always on and never grantable, so bots made before them have them too;
 * only a chat turn gets them, so work never starts work.
 */
export const BOT_WORK_TOOLS: readonly string[] = ['work_start', 'model_list', 'work_list', 'work_stop', 'work_note', 'remind', 'reminder_list', 'reminder_cancel', 'wake', 'watch_start', 'watch_list', 'watch_stop']

/**
 * The tools a bot's work splits a job among subagents with: start one on a title and a brief (on the work's model, or one
 * from `model_list`), send it a follow-up, wait for it, read its result, stop it. Like memory they are always on and
 * never grantable: they give no power the work lacks, since each subagent is compiled from the same grant and holds less
 * (`BOT_SUBAGENT_APP_TOOLS`). Only a run's main turn gets them, never the chat, a consult or a subagent: one level.
 */
export const BOT_SUBAGENT_TOOLS: readonly string[] = ['subagent_start', 'subagent_send', 'subagent_wait', 'subagent_result', 'subagent_stop']

/**
 * The grant's Mousse app tools a bot's subagent may have, when the grant holds them: what a thread's subagent may use.
 * The web, the bot's own browser, the computer and the owner's threads (as the work holds them: reading, and acting when
 * the work may); Mousse's profiler comes without a grant (`compileBotThread`). The rest are the bot's and its work's
 * alone, as they are a thread's own agent's: its own tools (schedules, its name and depth, its model, memory, asks) and
 * the automation tools, which a thread's subagent is refused too. The built-ins, the files folder, MCP tools and skills
 * are the work's, unchanged.
 */
export const BOT_SUBAGENT_APP_TOOLS: readonly string[] = ['web_search', 'web_fetch', 'browser', 'computer', 'threads']

/**
 * What a chat turn never does itself, though the grant may hold it, with the browser (docs/bots.md, "Quick calls in the
 * chat"): running commands keeps the runtime's own sandbox and time in work, and the browser and the computer never
 * collide with work that uses them, so the chat hands them to work and stays free to talk. Work runs with the whole grant.
 * The chat calls the web, a bound service and the owner's MCP tools itself, within its budgets (`BotQuickCalls`).
 */
export const BOT_WORK_ONLY_TOOLS: readonly string[] = ['shell', 'computer']

/**
 * The runtime's own web (Claude Code's WebSearch and WebFetch): never in a chat turn, whose web is Mousse's `web_search`
 * and `web_fetch` alone, which keep to the chat's deadlines.
 */
export const BOT_CHAT_NATIVE_OFF: readonly string[] = ['web_search', 'web_fetch']

/**
 * The bot's listing of its owner's MCP servers (`mcp_servers`): each server set up for the whole profile, by name and a
 * line of Mousse's own, and whether the bot holds its tools. It shows no tool schema and calls nothing, so like memory
 * it is always on and never grantable, in both lanes: the chat needs it to ask for the right server.
 */
export const BOT_MCP_LIST_TOOL = 'mcp_servers'

/**
 * What runs now for the bot's folders (`running_list`): its background commands, and servers and commands there, with
 * their addresses. It reads and starts nothing, so it is never grantable and every bot turn has it (chat, work, consults
 * and subagents), as a thread's agent has it on every turn.
 */
export const BOT_RUNNING_TOOL = 'running_list'

/**
 * Making a picture (#1088): offered only to a bot whose owner picked a model in Runs on's Images row, in chat and in
 * work. The pick is the consent, so it is no permission: it is never in a grant, never asked for, and About never lists
 * it. It runs no command, reads no file and opens no page: Mousse calls the picked model and saves the picture in the
 * bot's files folder.
 */
export const BOT_IMAGE_TOOL = 'make_image'

/**
 * Publishing an applet (`publish_applet`): an offline HTML/CSS/JS illustration or small dashboard under the bot's
 * message, exactly as a thread's agent publishes one. It reaches nothing (no network, files, the app or other applets:
 * it runs in the same sandbox as a thread's applet) and needs no permission, so like memory it is always on and never
 * grantable. A bot's main turns get it in both lanes; never a consult.
 */
export const BOT_APPLET_TOOL = 'publish_applet'

/**
 * Asking the owner a question with answers to tap (`ask_owner`, issue #1123). It grants nothing (a "Yes" allows no
 * permission: that is `escalate`), so like memory it is always on and never grantable. Offered to a chat turn and to work
 * the owner asked for (`work_start`, a reminder's work), which waits for the answer; scheduled runs, consults and
 * subagents never get it.
 */
export const BOT_QUESTION_TOOL = 'ask_owner'

/**
 * Passing on to work an answer the owner gave in the chat to the question it waits on (`question_answer`, issue #1123).
 * A chat turn their own message started gets it with `ask_owner`; it grants nothing either.
 */
export const BOT_QUESTION_ANSWER_TOOL = 'question_answer'

/**
 * Taking back a question the bot asked and no longer needs (`question_withdraw`, issue #1446). Held with `ask_owner`,
 * wherever a turn may ask; it grants nothing either.
 */
export const BOT_QUESTION_WITHDRAW_TOOL = 'question_withdraw'

/**
 * Attaching a small card to the turn's next message (`show_card`, issue #1123): facts, a checklist, progress or a
 * gallery of pictures from the bot's files folder, drawn by the app from fixed components. It grants nothing, so it is
 * always on and never grantable. A bot's main turns get it in both lanes; never a consult or a subagent.
 */
export const BOT_CARD_TOOL = 'show_card'

/**
 * Drafting a Mousse bug report (`report_bug`): the owner sees the draft in the report dialog and files it or not, so it
 * grants nothing and is always on, like cards, on a bot's main turns; never a consult or a subagent. Settings → General's
 * Report button switch turns it off for bots and threads alike.
 */
export const BOT_REPORT_BUG_TOOL = 'report_bug'

/**
 * Messages to the owner's other bots (`bot_list`, `bot_send`, `botMessages.ts`): the message is information to the bot
 * that gets it and gives it no permission, so like memory the tools are always on and never grantable. A chat turn, work
 * and a scheduled run get them (`BOT_TURN_KINDS`); a run started by hand, a consult and a subagent never do.
 */
export const BOT_MESSAGE_TOOLS: readonly string[] = [BOT_LIST_TOOL, BOT_SEND_TOOL]

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
 * "Use the computer": see and operate apps on this computer through Cua Driver (`src/shared/computerUse.ts`), one
 * permission for both computer tools. A thread the bot started gets them only while the bot holds it.
 */
export const BOT_COMPUTER_PERMISSION = 'computer'

/** The computer tools a bot with "use the computer" gets. */
export const BOT_COMPUTER_TOOLS: readonly string[] = COMPUTER_TOOL_NAMES

/**
 * The tool a bot's work asks its owner to set up computer use on this computer with (`computer_use_request`): under "use
 * the computer" too, and only in work its owner asked for in its chat (`compileBotThread`, `BotAuthority.ownerRequested`).
 */
export const BOT_COMPUTER_REQUEST_TOOL = COMPUTER_USE_REQUEST_TOOL

/**
 * The automation tools (`automation_*`, v4): a bot builds drafts the owner turns on, and lists, changes and pauses the
 * owner's automations. Every bot has them unless its owner switched them off in About (`BOT_AUTOMATIONS_SWITCH`), so
 * nothing asks for them; a grant an older build approved may still list them by name, which adds nothing.
 */
export const BOT_AUTOMATION_APP_TOOLS: readonly string[] = ['automation_draft_save', 'automation_ask', 'automation_list', 'automation_update', 'automation_pause']

/**
 * "Use your threads": one permission, asked for once, for the owner's ordinary threads in this profile. The grant names
 * it alone; `compileBotThread` turns it into the thread tools a turn may use (`BOT_THREAD_READ_TOOLS` in every lane but a
 * consult, `BOT_THREAD_ACT_TOOLS` in a run and a chat turn the owner's message or tapped answer started). A thread the bot starts runs in
 * Full access, and a message it sends runs in that thread's own mode, so the card says so (`askText`).
 */
export const BOT_THREADS_PERMISSION = 'threads'

/**
 * What a bot with "use your threads" may do in its work as well as its chat: list, search, read and wait on threads (here
 * and on the owner's other computers that let agents work there), read their terminals, a thread's queue, its Git status
 * and diffs, and list the owner's computers.
 */
export const BOT_THREAD_READ_TOOLS: readonly string[] = ['thread_list', 'thread_search', 'thread_read', 'thread_wait', 'terminal_read', 'queue_list', 'git_status', 'git_diff', 'computer_list']

/**
 * What changes threads: start one, message one, steer or stop one's turn, archive or unarchive one, hide one it started
 * from the owner's sidebar or show it again, fork one and hand a fork's work back, change what waits in a thread's queue,
 * and answer an approval in a thread (only while the owner lets agents answer approvals). A run (work, a reminder, a wake,
 * a schedule), a chat turn the owner's message or tapped answer started, and the bot's first message get them; a turn
 * another bot's message started does not.
 */
export const BOT_THREAD_ACT_TOOLS: readonly string[] = [
  'thread_create', 'thread_send', 'thread_interrupt', 'thread_archive', 'thread_hide', 'thread_update', 'thread_steer', 'thread_fork', 'thread_merge_back',
  'queue_enqueue', 'queue_edit', 'queue_remove', 'queue_reorder', 'queue_promote_to_steer', 'approval_respond'
]

/**
 * Mousse's own profiler (Settings → Labs → Profiler): every bot has its tools on a main turn and its subagents
 * (`BOT_PROFILER_TOOLS` in work, `BOT_PROFILER_CHAT_TOOLS` in the chat; never a consult), with no ask. Each call is still
 * held to the Labs switches. `profiler` names the group: it was a permission once (`BOT_DROPPED_PERMISSIONS`).
 */
export const BOT_PROFILER_PERMISSION = 'profiler'

/**
 * The profiler tools a bot gets: every read and sample tool. Never `profiler_heap_summary`, which pauses the service: no
 * bot is offered it, asks for it or can be granted it.
 */
export const BOT_PROFILER_TOOLS: readonly ProfilerToolName[] = PROFILER_TOOL_NAMES.filter((tool) => tool !== 'profiler_heap_summary')

/** What a chat turn gets of them: all but `profiler_watch`, which samples for minutes, so the chat stays free (work watches). */
export const BOT_PROFILER_CHAT_TOOLS: readonly ProfilerToolName[] = BOT_PROFILER_TOOLS.filter((tool) => tool !== 'profiler_watch')

const PROFILER_TOOL_SET: ReadonlySet<string> = new Set(BOT_PROFILER_TOOLS)

/**
 * Mousse's look: the theme tools (`theme_read`, `theme_set`) on every main turn, chat or work (never a consult or a
 * subagent), with no ask. The bot switches themes, saves colors, CSS and a wallpaper, with the checks a thread's agent
 * has. `themes` names the group: it was a permission once.
 */
export const BOT_THEMES_PERMISSION = 'themes'

/** The theme tools every bot's main turn gets. */
export const BOT_THEME_TOOLS: readonly string[] = ['theme_read', 'theme_set']

const THEME_TOOL_SET: ReadonlySet<string> = new Set(BOT_THEME_TOOLS)

/**
 * Scheduled work in the owner's threads: the scheduled-job tools a thread's agent has (`schedule_*`), jobs that run a
 * turn in one of the owner's threads, or start a new thread in a project, at a time, with no ask. The bot sees and
 * changes only the jobs it made. Listing in every main turn; making, changing, pausing and running a job only in a turn
 * that may act on the owner's threads (`threadsActOf`). Never a consult or a subagent. `schedules` names the group: it
 * was a permission once.
 */
export const BOT_SCHEDULES_PERMISSION = 'schedules'

/** What every bot reads of its scheduled jobs in every main turn. */
export const BOT_SCHEDULE_READ_TOOLS: readonly string[] = ['schedule_list']

/** What makes, changes, pauses, runs and removes its jobs, in a turn that may act. */
export const BOT_SCHEDULE_ACT_TOOLS: readonly string[] = ['schedule_create', 'schedule_update', 'schedule_pause', 'schedule_run', 'schedule_delete']

/**
 * Secrets the owner gives: `secret_request` (the owner types a secret into a private card in the bot's chat, never into
 * the chat itself, and the bot gets only its name), `secret_run` (a command of the bot's work, from its files folder,
 * with the secret as an environment variable or a private file) and `secret_fetch`, with no ask. A command also needs
 * "run commands", so the chat, which hands commands to work, never runs one. Never a consult or a subagent. `secrets`
 * names the group: it was a permission once.
 */
export const BOT_SECRETS_PERMISSION = 'secrets'

/** The secret tools of a main turn. */
export const BOT_SECRET_TOOLS: readonly string[] = ['secret_request', 'secret_run', 'secret_fetch']

/**
 * Quick actions: `create_quick_action` (a button in the owner's Actions list that sends a message or runs a command when
 * the owner presses it), on main turns, with no ask. `quick_actions` names the group: it was a permission once.
 */
export const BOT_QUICK_ACTIONS_PERMISSION = 'quick_actions'

/** The quick-action tools of a main turn. */
export const BOT_QUICK_ACTION_TOOLS: readonly string[] = ['create_quick_action']

/**
 * The task list of the turn's own thread (`task_create`, `task_list`, `task_update`): a checklist the agent keeps for
 * itself. It acts on nothing else, so like memory it is always on and never grantable, in every turn but a consult.
 */
export const BOT_TASK_TOOLS: readonly string[] = ['task_create', 'task_list', 'task_update']

/** Every thread tool a bot can hold, all under "use your threads". */
export const BOT_THREAD_TOOLS: readonly string[] = [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS]

const THREAD_TOOL_NAMES: ReadonlySet<string> = new Set(BOT_THREAD_TOOLS)

/** Whether `name` is one of the thread tools a bot can hold under "use your threads". */
export function isBotThreadTool(name: string): boolean {
  return THREAD_TOOL_NAMES.has(name)
}

/**
 * The permissions that each stand for a group of app tools: the grant names the permission alone, and
 * `compileBotThread` turns it into the tools a turn may use. None is a tool's own name.
 */
export const BOT_GROUP_PERMISSIONS: ReadonlySet<string> = new Set([BOT_BROWSER_PERMISSION, BOT_COMPUTER_PERMISSION, BOT_THREADS_PERMISSION])

/**
 * The Mousse app tools a bot may be granted: ones that read the web, its own browser, the bot's own tools, the
 * automation tools, the computer and the owner's threads (on this computer and the others that let agents work there) as
 * one permission each. Delegation is not one: a bot's work has subagents of its own (`BOT_SUBAGENT_TOOLS`), held to the
 * grant. Consults (6c-2) are the way a bot uses its own threads. The skill tools come with skills.
 */
export const BOT_APP_TOOLS: ReadonlySet<string> = new Set([...BOT_DEFAULT_APP_TOOLS, ...BOT_AUTOMATION_APP_TOOLS, ...BOT_GROUP_PERMISSIONS])

/**
 * Group permissions every bot now has without asking: the profiler, Mousse's look, scheduled jobs, secrets and quick
 * actions. `compileBotThread` gives their tools to the turns that may have them whatever the grant says.
 */
export const BOT_DROPPED_PERMISSIONS: ReadonlySet<string> = new Set([
  BOT_PROFILER_PERMISSION, BOT_THEMES_PERMISSION, BOT_SCHEDULES_PERMISSION, BOT_SECRETS_PERMISSION, BOT_QUICK_ACTIONS_PERMISSION
])

/**
 * Names bots are no longer granted: `telling_set` (the Tells you setting, gone) and the permissions every bot now has
 * (`BOT_DROPPED_PERMISSIONS`). A grant an older build approved may still list one: it reads as well formed and gives
 * nothing beyond what every bot has, and its digest stays the same, so no bot is asked to approve again.
 */
export const BOT_RETIRED_APP_TOOLS: ReadonlySet<string> = new Set(['telling_set', ...BOT_DROPPED_PERMISSIONS])

/**
 * What every bot has by default and its owner can switch off for it in About, as the ids of those switches: all of the
 * owner's MCP servers, one server (`BOT_MCP_SERVER_SWITCH` and its installation id, so an edit of the server keeps its
 * switch), every skill, and the automation tools. A switch turned off is kept beside the grant
 * (`BotStore.keepDisabledPermission`); the grant and its digest never change.
 */
export const BOT_MCP_SWITCH = 'default:mcp'
export const BOT_MCP_SERVER_SWITCH = 'default:mcp:'
export const BOT_SKILLS_SWITCH = 'default:skills'
export const BOT_AUTOMATIONS_SWITCH = 'default:automations'

/** About's switch for "Allow everything" (`BotManifest.fullTrust`), as `bots.permissions.set` names it. */
export const BOT_FULL_TRUST_PERMISSION = 'full_trust'

/** Whether `id` is one of the switches of what every bot has by default. */
export function isBotDefaultSwitch(id: string): boolean {
  return id === BOT_MCP_SWITCH || id === BOT_SKILLS_SWITCH || id === BOT_AUTOMATIONS_SWITCH || (id.startsWith(BOT_MCP_SERVER_SWITCH) && id.length > BOT_MCP_SERVER_SWITCH.length)
}

/**
 * Every Mousse app tool a bot's turn can ever be offered (what `compileBotThread` may add to a turn): the grantable
 * tools, each group permission's tools in place of the permission, the skill tools, consult, the front desk's work and reminder
 * tools, the task list, and `make_image` with an Images row. A bot's thread lists only these, so its runtime never shows the model a tool no bot can hold.
 */
const BOT_OFFERABLE_APP_TOOLS: ReadonlySet<string> = new Set([
  'schedule_done',
  ...[...BOT_APP_TOOLS].filter((tool) => !BOT_GROUP_PERMISSIONS.has(tool)),
  ...BOT_BROWSER_TOOLS,
  ...BOT_COMPUTER_TOOLS,
  BOT_COMPUTER_REQUEST_TOOL,
  ...BOT_THEME_TOOLS,
  ...BOT_THREAD_TOOLS,
  ...BOT_PROFILER_TOOLS,
  ...BOT_SCHEDULE_READ_TOOLS,
  ...BOT_SCHEDULE_ACT_TOOLS,
  ...BOT_SECRET_TOOLS,
  ...BOT_QUICK_ACTION_TOOLS,
  ...BOT_TASK_TOOLS,
  ...BOT_WORK_TOOLS,
  'work_wait',
  ...BOT_SUBAGENT_TOOLS,
  ...BOT_MEMORY_TOOLS,
  ...BOT_ITEM_TOOLS,
  BOT_MCP_LIST_TOOL,
  BOT_RUNNING_TOOL,
  BOT_IMAGE_TOOL,
  BOT_APPLET_TOOL,
  BOT_QUESTION_TOOL,
  BOT_QUESTION_ANSWER_TOOL,
  BOT_QUESTION_WITHDRAW_TOOL,
  BOT_CARD_TOOL,
  BOT_REPORT_BUG_TOOL,
  ...BOT_MESSAGE_TOOLS,
  'skill_list', 'skill_load', 'escalate', 'consult',
  // The tool catalogue (docs/plans/bot-context.md §15): looking up a group, and calling its tools on Codex and Pi.
  BOT_CATALOGUE_TOOL, BOT_USE_TOOL
])

/** Whether a bot's turn can ever be offered the Mousse app tool `name` (`BOT_OFFERABLE_APP_TOOLS`). */
export function botMayBeOffered(name: string): boolean {
  return BOT_OFFERABLE_APP_TOOLS.has(name)
}

const OWN_APP_TOOLS: ReadonlySet<string> = new Set(BOT_OWN_APP_TOOLS)
const BROWSER_TOOLS: ReadonlySet<string> = new Set(BROWSER_AUTOMATION_TOOLS)

/** Each tool of a group other than the browser, threads, the profiler and themes, by its group's name. */
const GROUPED_TOOLS: ReadonlyMap<string, string> = new Map([
  ...[...BOT_SCHEDULE_READ_TOOLS, ...BOT_SCHEDULE_ACT_TOOLS].map((tool) => [tool, BOT_SCHEDULES_PERMISSION] as const),
  ...BOT_SECRET_TOOLS.map((tool) => [tool, BOT_SECRETS_PERMISSION] as const),
  ...BOT_QUICK_ACTION_TOOLS.map((tool) => [tool, BOT_QUICK_ACTIONS_PERMISSION] as const),
  ...[...BOT_COMPUTER_TOOLS, BOT_COMPUTER_REQUEST_TOOL].map((tool) => [tool, BOT_COMPUTER_PERMISSION] as const)
])

const TASK_TOOL_SET: ReadonlySet<string> = new Set(BOT_TASK_TOOLS)

/**
 * Whether a bot's thread lists `name` only while the turn holds it: the tools of a group (the owner's threads, the
 * computer, the profiler, themes, scheduled jobs, secrets, quick actions) and the task list. A turn holds them only
 * where `compileBotThread` gave them (never a consult; a subagent only what a thread's subagent may use).
 */
export function isBotTurnHeldTool(name: string): boolean {
  return THREAD_TOOL_NAMES.has(name) || PROFILER_TOOL_SET.has(name) || THEME_TOOL_SET.has(name) || GROUPED_TOOLS.has(name) || TASK_TOOL_SET.has(name)
}

/**
 * The permission or group an app tool falls under: every browser tool is "use the browser" (`browser`), so
 * an ask for `browser_act` is the same one ask; every thread tool is "use your threads" (`threads`); the computer tools
 * are `computer`. The groups every bot has without asking keep their names (`BOT_DROPPED_PERMISSIONS`): every profiler
 * tool a bot can hold is `profiler`, both theme tools `themes`, the scheduled-job tools `schedules`, the secret tools
 * `secrets` and `create_quick_action` is `quick_actions`. Any other tool is its own (the heap summary too, which no bot
 * holds).
 */
export function botGrantTool(name: string): string {
  // An old name asks for, and is granted as, the tool it was renamed to.
  const tool = canonicalToolName(name)
  if (BROWSER_TOOLS.has(tool)) return BOT_BROWSER_PERMISSION
  if (PROFILER_TOOL_SET.has(tool)) return BOT_PROFILER_PERMISSION
  if (THEME_TOOL_SET.has(tool)) return BOT_THEMES_PERMISSION
  const grouped = GROUPED_TOOLS.get(tool)
  if (grouped) return grouped
  return THREAD_TOOL_NAMES.has(tool) ? BOT_THREADS_PERMISSION : tool
}

/** Whether `tool` is one of the bot's own tools: not a permission, never listed in About. */
export function isOwnBotAppTool(tool: string): boolean {
  return OWN_APP_TOOLS.has(tool)
}

/**
 * A new bot's grant (Bot Phase 1 §5.3.1): the file tools, which reach only its files folder; the web and its own tools;
 * no limits. Pressing Create bot approves it.
 */
export function botStarterManifest(): BotManifest {
  return {
    tools: ['read', 'list', 'search', 'edit', 'write'],
    appTools: [...BOT_DEFAULT_APP_TOOLS],
    mcp: [],
    skills: [],
    workspace: null,
    budget: {},
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
 * manifests that grant the same things have the same canonical JSON (and digest). An old grant's work time stays as it
 * was, though nothing reads it: dropping it would change the digest its activations were made under.
 */
export function canonicalManifest(manifest: BotManifest): BotManifest {
  const budget: BotBudget = manifest.budget.maxActiveMs !== undefined ? { maxActiveMs: manifest.budget.maxActiveMs } : {}
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) budget[key] = manifest.budget[key]
  return {
    tools: sorted(manifest.tools, (tool) => tool),
    appTools: sorted(manifest.appTools, (tool) => tool),
    mcp: sorted(manifest.mcp, mcpIdentity).map((pair) => ({ serverId: pair.serverId, tool: pair.tool, ...(pair.level === 'asks_first' ? { level: pair.level } : {}) })),
    skills: sorted(manifest.skills, (skill) => skill),
    workspace: workspaceOf(foldersOf(manifest.workspace)),
    budget,
    audience: manifest.audience,
    // Only when true: a grant without it keeps the digest it was approved under.
    ...(manifest.fullTrust === true ? { fullTrust: true as const } : {})
  }
}

/**
 * What "Allow everything" (`fullTrust`) gives: every built-in tool and every Mousse app tool a bot can be granted, added
 * to `manifest`. Its MCP tools, skills and limits stay as they are: MCP and skills come to every bot unless switched off
 * (`BotEngine.withDefaults`), and a tool that asks first still asks. A manifest without it is returned as it is.
 */
export function withFullTrust(manifest: BotManifest): BotManifest {
  if (manifest.fullTrust !== true) return manifest
  return {
    ...manifest,
    tools: [...new Set<NeutralTool>([...manifest.tools, ...NEUTRAL_TOOLS])],
    appTools: [...new Set([...manifest.appTools, ...BOT_APP_TOOLS])]
  }
}

/** Why a manifest is malformed, or undefined when it is well formed. */
export function manifestProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'The permissions are missing.'
  const manifest = value as Partial<BotManifest>
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  if (!Array.isArray(manifest.tools) || !manifest.tools.every((tool) => typeof tool === 'string' && isNeutralTool(tool))) return 'A built-in tool is not one Mousse knows.'
  if (!strings(manifest.appTools)) return 'An app tool name is invalid.'
  // A grant an older build approved may name a tool by its old name (`canonicalToolName`): it is that tool.
  const refusedApp = (manifest.appTools as string[]).find((tool) => !BOT_APP_TOOLS.has(canonicalToolName(tool)) && !BOT_RETIRED_APP_TOOLS.has(tool))
  if (refusedApp !== undefined) return `A bot can't be given the Mousse tool ${refusedApp}: it would reach other threads, act in your name or ask you, outside the bot's permissions.`
  if (!strings(manifest.skills)) return 'A skill id is invalid.'
  if (!Array.isArray(manifest.mcp) || !manifest.mcp.every((pair) => pair && typeof pair === 'object' && typeof pair.serverId === 'string' && typeof pair.tool === 'string' && MCP_PART.test(pair.serverId) && MCP_PART.test(pair.tool))) return 'An MCP tool is invalid.'
  // A stored workspace grants nothing now, but one an older build wrote must still read as well formed.
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
    if (limit === undefined) continue
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return `The limit ${key} must be a positive number.`
    // Counts and times are whole numbers; only the spend is in dollars.
    if (key !== 'maxUsd' && !Number.isSafeInteger(limit)) return `The limit ${key} must be a whole number.`
  }
  if (manifest.audience !== 'owner') return 'Bots for other people are not available yet.'
  if (manifest.fullTrust !== undefined && manifest.fullTrust !== true) return 'Allow everything is on, or left out.'
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
 * granted, no MCP tool goes without asking first where the grant asks first, "Allow everything" only where the grant
 * has it, and every limit is at most the granted one (a limit the grant has and `wanted` drops is
 * wider, so it is not a subset). A stored `workspace` grants nothing, so it is never asked about.
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
  if (wanted.fullTrust === true && granted.fullTrust !== true) lines.push(FULL_TRUST_LINE)
  // What the grant gives, not what it lists: with "Allow everything", a tool it leaves out is still given.
  const given = withFullTrust(granted)
  const tools = new Set(given.tools)
  for (const tool of wanted.tools) if (!tools.has(tool)) lines.push(toolLine(tool))
  const appTools = new Set(given.appTools)
  for (const tool of wanted.appTools) if (!appTools.has(tool) && !BOT_RETIRED_APP_TOOLS.has(tool)) lines.push(appToolLine(tool))
  const mcp = new Set(granted.mcp.map(mcpIdentity))
  for (const pair of wanted.mcp) if (!mcp.has(mcpIdentity(pair))) lines.push(mcpLine(pair))
  // A tool the grant holds as asking first, wanted without asking: a looser hold is more, as a new tool is.
  const asksFirst = new Set(granted.mcp.filter((pair) => pair.level === 'asks_first').map(mcpIdentity))
  for (const pair of wanted.mcp) if (pair.level !== 'asks_first' && asksFirst.has(mcpIdentity(pair))) lines.push({ kind: 'mcp', text: `Use the MCP tool \`${pair.tool}\` without asking first` })
  const skills = new Set(granted.skills)
  for (const skill of wanted.skills) if (!skills.has(skill)) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
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
  const lines: BotPermissionLine[] = manifest.fullTrust === true ? [FULL_TRUST_LINE] : []
  for (const tool of manifest.tools) lines.push(toolLine(tool))
  for (const tool of manifest.appTools) if (!BOT_RETIRED_APP_TOOLS.has(tool)) lines.push(appToolLine(tool))
  for (const pair of manifest.mcp) lines.push(mcpLine(pair))
  for (const skill of manifest.skills) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) lines.push(budgetLine(key, manifest.budget[key]))
  return unique(lines)
}

/** Each line once. */
function unique(lines: BotPermissionLine[]): BotPermissionLine[] {
  const seen = new Set<string>()
  return lines.filter((line) => !seen.has(line.text) && Boolean(seen.add(line.text)))
}

/** "Allow everything" in the approval's words. */
const FULL_TRUST_LINE: BotPermissionLine = { kind: 'full_trust', text: 'Allow everything: every tool and permission a bot can be given, without asking' }

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

/** The file tools: they reach only the bot's files folder. */
const FILE_TOOLS: ReadonlySet<NeutralTool> = new Set<NeutralTool>(['read', 'list', 'search', 'edit', 'write'])

function toolLine(tool: NeutralTool): BotPermissionLine {
  return { kind: 'tool', text: FILE_TOOLS.has(tool) ? `${TOOL_WORDS[tool]} in its files folder` : TOOL_WORDS[tool] }
}

/** An app tool in plain words: the browser, the computer and the owner's threads by what they are, any other tool by its name. */
function appToolLine(tool: string): BotPermissionLine {
  if (tool === BOT_BROWSER_PERMISSION) return { kind: 'app_tool', text: 'Use the browser' }
  if (tool === BOT_COMPUTER_PERMISSION) return { kind: 'app_tool', text: 'Use the computer' }
  if (tool === BOT_THREADS_PERMISSION) return { kind: 'app_tool', text: 'Use your threads' }
  return { kind: 'app_tool', text: `Use the Mousse tool \`${tool}\`` }
}

function mcpLine(pair: { serverId: string; tool: string }): BotPermissionLine {
  return { kind: 'mcp', text: `Use the MCP tool \`${pair.tool}\`` }
}

function budgetLine(key: (typeof BUDGET_KEYS)[number], limit: number | undefined): BotPermissionLine {
  if (limit === undefined) return { kind: 'budget', text: `No limit on ${BUDGET_WORDS[key]}` }
  if (key === 'maxUsd') return { kind: 'budget', text: `Up to $${limit} per run` }
  return { kind: 'budget', text: `Up to ${limit} ${BUDGET_WORDS[key]} per run` }
}

const BUDGET_WORDS: Record<(typeof BUDGET_KEYS)[number], string> = {
  maxTurns: 'model requests (retries included)',
  maxToolCalls: 'tool calls',
  maxInputTokens: 'input tokens',
  maxOutputTokens: 'output tokens',
  maxUsd: 'spend'
}

/**
 * One thread's permissions: the manifest, narrowed. `narrow` only removes: a tool, MCP tool or
 * skill it names that the manifest lacks is ignored. A stored `workspace` grants nothing, so none is kept.
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
    workspace: null
  }
}

/**
 * What runs: `wanted` (a published revision) held inside `granted` (the approved grant). Only
 * what both name is kept, and each limit is the lower one. A revision that is a subset of the
 * grant is itself; a narrower one really narrows. A stored `workspace` grants nothing, so none is kept.
 */
export function intersectManifest(wanted: BotManifest, granted: BotManifest): BotManifest {
  const within = <T>(values: readonly T[], allowed: readonly T[], key: (value: T) => string): T[] => {
    const names = new Set(allowed.map(key))
    return values.filter((value) => names.has(key(value)))
  }
  const budget: BotBudget = {}
  for (const key of BUDGET_KEYS) {
    const a = wanted.budget[key]
    const b = granted.budget[key]
    const limit = a === undefined ? b : b === undefined ? a : Math.min(a, b)
    if (limit !== undefined) budget[key] = limit
  }
  return {
    tools: within(wanted.tools, granted.tools, (tool) => tool),
    appTools: within(wanted.appTools, granted.appTools, (tool) => tool),
    mcp: within(wanted.mcp, granted.mcp, mcpIdentity).map(pair => ({ ...pair, ...(granted.mcp.find(g => mcpIdentity(g) === mcpIdentity(pair))?.level === 'asks_first' ? { level: 'asks_first' as const } : {}) })),
    skills: within(wanted.skills, granted.skills, (skill) => skill),
    workspace: null,
    budget,
    audience: 'owner',
    // Only what both give: the revision asks for it and the grant holds it.
    ...(wanted.fullTrust === true && granted.fullTrust === true ? { fullTrust: true as const } : {})
  }
}
