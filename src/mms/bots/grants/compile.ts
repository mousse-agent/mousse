import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { BotManifest, BotThreadSpec } from '../../../shared/bots/personal/definition'
import { BOT_APP_TOOLS, BOT_RETIRED_APP_TOOLS, BOT_APPLET_TOOL, BOT_CARD_TOOL, BOT_REPORT_BUG_TOOL, BOT_GROUP_PERMISSIONS, BOT_MESSAGE_TOOLS, BOT_QUESTION_ANSWER_TOOL, BOT_QUESTION_TOOL, BOT_QUESTION_WITHDRAW_TOOL, BOT_BROWSER_PERMISSION, BOT_COMPUTER_PERMISSION, BOT_COMPUTER_REQUEST_TOOL, BOT_COMPUTER_TOOLS, BOT_IMAGE_TOOL, BOT_BROWSER_TOOLS, BOT_MCP_LIST_TOOL, BOT_RUNNING_TOOL, BOT_PROFILER_CHAT_TOOLS, BOT_PROFILER_TOOLS, BOT_QUICK_ACTION_TOOLS, BOT_SCHEDULE_ACT_TOOLS, BOT_SCHEDULE_READ_TOOLS, BOT_SECRET_TOOLS, BOT_TASK_TOOLS, BOT_THEME_TOOLS, BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS, BOT_THREADS_PERMISSION, BOT_CHAT_NATIVE_OFF, BOT_WORK_ONLY_TOOLS, BOT_WORK_TOOLS, canonicalManifest, intersectManifest, narrowManifest, BOT_SUBAGENT_APP_TOOLS, BOT_SUBAGENT_TOOLS } from '../../../shared/bots/personal/manifest'
import { BOT_CATALOGUE_TOOL, BOT_USE_TOOL } from '../../../shared/bots/personal/catalogue'
import { BOT_MEMORY_TOOLS } from '../../../shared/bots/personal/memory'
import { BOT_ITEM_TOOLS } from '../../../shared/bots/personal/items'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { BindPolicy, HarnessCaps, HarnessError } from '../../../shared/harness/types'
import { stableStringify } from '../../run/json'
import { canonicalToolName } from '../../../shared/toolAliases'

/**
 * A bot thread's grant, compiled for one dispatch (PR 6 §4). Pure: the caller supplies the native
 * tool names (`Harness.nativeToolNames`), what is left of the activation's allowance and the
 * scratch folder. The output is the binding's policy and the authority's own permissions; the
 * policy names the authority only by kind and digest.
 */

/** SHA-256 (hex) of a manifest's canonical JSON. A grant is approved by this digest. */
export function botManifestDigest(manifest: BotManifest): string {
  return createHash('sha256').update(stableStringify(canonicalManifest(manifest))).digest('hex')
}

/**
 * A bot's files folder (Bot Phase 1 §5.10): `<profileHome>/bots/files/<botId>/`, for the documents
 * and deliverables it makes. Created with the bot; no prompt reads it back, and memory lives in
 * `bots.db`, not here.
 */
export function botFilesFolder(profileHome: string, botId: string): string {
  return join(profileHome, 'bots', 'files', botId)
}

/** The permissions one thread of an activation holds: the grant, narrowed by the thread. */
export interface BotPermissions {
  tools: NeutralTool[]
  appTools: string[]
  mcp: Array<`${string}::${string}`>
  skills: string[]
  /** Every skill the owner has (skills are on by default; About can switch them off): `skills` lists none of them. */
  allSkills?: true
  /**
   * The bot's own folders: its scratch folder and its files folder (`files`), both writable, and nothing else. A bot
   * has no folder beyond them ("use files on this computer" was removed), so `roots` and `writeRoots` are empty, and a
   * stored grant's `workspace` adds none. Null for a bot made before files folders.
   */
  workspace: { roots: string[]; access: 'read' | 'write'; writeRoots?: string[]; scratch: string; files?: string } | null
  /** "Use the browser": `appTools` holds the browser tools, on the bot's own browser. */
  browser?: true
  /** "Use your threads": `appTools` holds the thread tools of this turn, to read (`read`) or also to start, message and stop (`all`). */
  threads?: 'read' | 'all'
  /** The profiler: `appTools` holds the profiler tools of this turn. */
  profiler?: true
  /** Mousse's look: `appTools` holds the theme tools of this turn. */
  themes?: true
  /** The owner's scheduled jobs: `appTools` holds the scheduled-job tools of this turn (`read`: the list only). */
  schedules?: 'read' | 'all'
  /** Secrets the owner gives: `appTools` holds the secret tools of this turn. */
  secrets?: true
  /** Quick actions: `appTools` holds `create_quick_action`. */
  quickActions?: true
  /**
   * How this turn reaches the tool catalogue (docs/plans/bot-context.md §15): `search`, Claude Code's own tool search,
   * which loads any listed tool; `use_tool`, Codex and Pi, whose thread lists only the core set and calls the rest
   * through `use_tool`. Absent: no catalogue (a consult, a subagent).
   */
  catalogue?: 'search' | 'use_tool'
}

export interface CompileInput {
  /** The active grant (what the owner approved). */
  grant: BotManifest
  /**
   * The published revision's own permissions, when the dispatch runs one: what runs is the
   * revision held inside the grant, so a narrower revision really narrows. Absent: the grant.
   */
  revision?: BotManifest
  /** The grant's digest (`botManifestDigest`). */
  digest: string
  thread: Pick<BotThreadSpec, 'narrow'>
  scratch: string
  profileHome: string
  /** The runtime's names for the thread's built-ins; a refusal is passed through. */
  nativeNames(tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }
  /** What is left of the activation's counts and spend, and the dispatch's active-time deadline. */
  remaining: { maxTurns?: number; maxToolCalls?: number; maxInputTokens?: number; maxOutputTokens?: number; maxUsd?: number; deadlineMs: number }
  /**
   * The bot's files folder (`botFilesFolder`): an implicit writable root, like scratch, allowed
   * although it sits inside the profile home. Absent: none (bots made before Bot Phase 1's files folder).
   */
  filesFolder?: string
  /**
   * Every skill the owner has, beside the ones the grant names: skills are on by default, unless the owner switched them
   * off for the bot in About (`BOT_SKILLS_SWITCH`).
   */
  allSkills?: boolean
  /**
   * The bot tools the thread gets beside its grant (6c-2): `escalate` on every bot thread, and
   * `consult` on the activation thread of a bot with context threads. `memory`: the five
   * `memory_*` tools (Bot Phase 1 §5.10) and the listing of the owner's MCP servers (`mcp_servers`), always on and
   * never grantable, so a bot whose stored grant predates them has them too. `frontDesk`: a chat turn
   * (docs/plans/bot-always-free.md): it gets the work and reminder tools (`BOT_WORK_TOOLS`), and not commands, the
   * computer or the browser (`BOT_WORK_ONLY_TOOLS`), which its work runs with instead. The grant and its digest stay the
   * same: only what this turn is offered narrows.
   */
  botTools?: {
    escalate: boolean
    consult: boolean
    memory?: boolean
    /** Only the main turn of a scheduled run ends its own schedule. Never grantable. */
    scheduled?: boolean
    frontDesk?: boolean
    /** The turn may start an unsandboxed background command: any chat turn, and a run's main turn with `timers`. */
    watcherStart?: boolean
    /**
     * What "use your threads" gives this turn, when the grant holds it: `read` (list, search, read, wait: work, a
     * reminder's work, a schedule, a chat turn the owner's message did not start), or `all`, which adds starting,
     * messaging and stopping, only for a chat turn the owner's own message started. Absent: nothing (a consult).
     */
    threads?: 'read' | 'all'
    /**
     * A main turn, chat or work, or a subagent: the profiler tools, whatever the grant says (in the chat all but
     * `profiler_watch`, which samples for minutes). Each call is held to Settings → Labs. Absent: none (a consult).
     */
    profiler?: boolean
    /** A main turn, chat or work: the theme tools, whatever the grant says. Absent: none (a consult; a subagent never has them). */
    themes?: boolean
    /**
     * A main turn, chat or work: the owner's scheduled jobs, secrets and quick actions, whatever the grant says:
     * `schedule_list`, and the tools that make and change jobs in a turn whose `threads` is `all` (one that may act on
     * the owner's threads); `secret_request`, and `secret_run` where it also holds "run commands" (never the chat);
     * `create_quick_action`. Absent: none (a consult; a subagent never has them).
     */
    owner?: boolean
    /**
     * The task list of the turn's own thread (`BOT_TASK_TOOLS`): always on, on main turns and subagents. Absent: none (a
     * consult).
     */
    tasks?: boolean
    /** `make_image` (#1088): the owner picked a model in Runs on's Images row. Chat and work alike; never a consult or a subagent. */
    images?: boolean
    /** `publish_applet` (`BOT_APPLET_TOOL`): a main turn, chat or work, publishes applets; they need no permission. Never a consult. */
    applets?: boolean
    /**
     * A run's main turn: it may split its job among subagents (`BOT_SUBAGENT_TOOLS`), and lists the models they may run on
     * (`model_list`). Never the chat, a consult or a subagent.
     */
    subagents?: boolean
    /** Work (including a reminder's work) and a scheduled run may park on time or events (`BOT_TURN_KINDS`). */
    workWaiting?: boolean
    /**
     * A run's main turn sets reminders (`remind`) and, with `watcherStart`, starts background commands (`watch_start`),
     * detached: the run never waits for them. The chat has them as its front desk.
     */
    timers?: boolean
    /**
     * A main turn's tool catalogue (`BotPermissions.catalogue`): `tool_catalogue` on every runtime, and `use_tool` where
     * the runtime has no tool search of its own (Codex, Pi). Never a consult or a subagent.
     */
    catalogue?: 'search' | 'use_tool'
    /**
     * This turn is one of a run's subagents: it holds what its work holds of the built-ins, files, MCP tools and skills,
     * and of the app tools what a thread's subagent may use (`subagentManifest`): the web, the browser, and, as `threads`,
     * `profiler` and `tasks` here say, the owner's threads, the profiler and its task list. Every other bot tool is left
     * out whatever the rest of `botTools` says: no asks, memory, schedules, reminders, pictures, work, secrets or subagents
     * of its own.
     */
    subagent?: true
    /**
     * `ask_owner` (`BOT_QUESTION_TOOL`) and `question_withdraw`: questions with answers to tap; they grant nothing. Every chat turn, work and a
     * scheduled run (`BOT_TURN_KINDS`); a front desk (a chat turn) also gets `question_answer`, to pass on to work an
     * answer given in the chat.
     */
    questions?: boolean
    /** `show_card` (`BOT_CARD_TOOL`): small fixed cards on the turn's next message; they grant nothing. Main turns only. */
    cards?: boolean
    /**
     * `bot_list` and `bot_send` (`BOT_MESSAGE_TOOLS`): messages to the owner's other bots; they grant nothing. Every chat
     * turn, work and a scheduled run (`BOT_TURN_KINDS`).
     */
    bots?: boolean
  }
}

export type CompileResult =
  | { ok: true; policy: BindPolicy; permissions: BotPermissions }
  | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }

const unenforceable = (reason: string, missing: Array<keyof HarnessCaps> = ['toolControl']): CompileResult => ({
  ok: false,
  error: { code: 'policy_unenforceable', message: `This bot's permissions cannot be enforced here. ${reason}`, missing, reason }
})

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** The real paths of the system temporary folders, deduplicated. */
export function systemTempDirs(): string[] {
  const candidates = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])]
  return [...new Set(candidates.map(real))]
}

export function compileBotThread(input: CompileInput): CompileResult {
  const narrowed = narrowManifest(input.revision ? intersectManifest(input.revision, input.grant) : input.grant, input.thread.narrow)
  // A tool bots no longer have, still listed by a grant an older build approved, gives nothing. One it names by an old
  // name gives the tool it was renamed to; the stored grant and its digest stay as approved.
  const held = { ...narrowed, appTools: narrowed.appTools.filter((tool) => !BOT_RETIRED_APP_TOOLS.has(tool)).map(canonicalToolName) }
  // A subagent is the work, never more: what the work holds, less what is the bot's alone, and none of the bot's tools
  // but what a thread's subagent may use (the owner's threads, the profiler, its task list).
  const subagent = input.botTools?.subagent === true
  const own = subagent ? undefined : input.botTools
  const shared = subagent ? { threads: input.botTools?.threads, profiler: input.botTools?.profiler, tasks: input.botTools?.tasks } : own
  const manifest = subagent ? subagentManifest(held) : own?.frontDesk ? frontDeskManifest(held) : held
  // Checked again here, so a grant stored before a tool was refused can never widen later.
  const refusedApp = manifest.appTools.find((tool) => !BOT_APP_TOOLS.has(tool))
  if (refusedApp !== undefined) return unenforceable(`The Mousse tool ${refusedApp} would reach other threads, act in your name or ask you.`)
  // The owner's MCP tools (every server set up now unless switched off for the bot, `BotEngine.effectiveManifest`, and any
  // an older grant names per tool) reach every runtime through Mousse, which checks each
  // call against these pairs before the server sees it: the MCP relay on Claude Code and Codex, the user MCP proxy on
  // Pi. Each turn is offered only the granted tools of servers set up now (`BotMcp.offered`); a chat turn through its
  // catalogue.
  // `shell` ("run commands") is one permission, granted as a whole: each runtime runs its commands
  // from the bot's files folder, in its own sandbox where it has one (bot-architecture.md §3.5).
  const scratch = real(input.scratch)
  const files = input.filesFolder !== undefined ? real(input.filesFolder) : undefined
  if (files !== undefined) {
    // Only Mousse's own place for it: a files folder anywhere else would be a root nobody approved.
    const home = real(join(input.profileHome, 'bots', 'files'))
    if (files === home || !inside(home, files)) return unenforceable("The bot's files folder is not where Mousse keeps bots' files.")
    if (inside(files, scratch) || inside(scratch, files)) return unenforceable("The bot's files folder overlaps its private scratch folder.")
  }
  // Only the bot's own folders: a stored grant's `workspace` ("use files on this computer", removed) opens no folder.
  const native = input.nativeNames(manifest.tools)
  if (!native.ok) return native
  const { deadlineMs, ...counts } = input.remaining
  const budget: NonNullable<BindPolicy['budget']> = { maxWallMs: deadlineMs }
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (counts[key] !== undefined) budget[key] = counts[key]
  // Granted skills come with the skill tools that list and load them; the browser is its tools, and the owner's threads
  // are the thread tools this turn may use (none unless the caller says which), as the profiler is its tools on a main turn.
  const browser = manifest.appTools.includes(BOT_BROWSER_PERMISSION)
  const computer = manifest.appTools.includes(BOT_COMPUTER_PERMISSION)
  const threads = manifest.appTools.includes(BOT_THREADS_PERMISSION) ? shared?.threads : undefined
  // The profiler, Mousse's look, the owner's scheduled jobs, secrets and quick actions need no grant (a name an older
  // build's grant still lists gives nothing more): a main turn's, chat or work, and the profiler a subagent's too; never a
  // consult's.
  const profiler = shared?.profiler === true
  const themes = own?.themes === true
  const schedules = own?.owner === true ? (own.threads === 'all' ? 'all' as const : 'read' as const) : undefined
  const secrets = own?.owner === true
  const quickActions = own?.owner === true
  // Every skill, unless the owner switched skills off for the bot; a thread narrowed to some skills has just those.
  const narrowSkills = input.thread.narrow?.skills
  const allSkills = input.allSkills === true && !narrowSkills
  const skills = [...new Set([...manifest.skills, ...(input.allSkills === true && narrowSkills ? narrowSkills : [])])].sort()
  const appTools = [...new Set([
    ...manifest.appTools.filter((tool) => !BOT_GROUP_PERMISSIONS.has(tool)),
    ...(themes ? BOT_THEME_TOOLS : []),
    ...(profiler ? (own?.frontDesk ? BOT_PROFILER_CHAT_TOOLS : BOT_PROFILER_TOOLS) : []),
    ...(browser ? BOT_BROWSER_TOOLS : []),
    ...(computer ? BOT_COMPUTER_TOOLS : []),
    // Asking the owner to set computer use up on this computer: only a main turn the owner's own work runs (never a
    // subagent or a consult, which have no `own`; the front desk holds no computer at all).
    ...(computer && own?.owner === true ? [BOT_COMPUTER_REQUEST_TOOL] : []),
    ...(threads ? BOT_THREAD_READ_TOOLS : []),
    ...(threads === 'all' ? BOT_THREAD_ACT_TOOLS : []),
    ...(schedules ? BOT_SCHEDULE_READ_TOOLS : []),
    ...(schedules === 'all' ? BOT_SCHEDULE_ACT_TOOLS : []),
    // A secret's command is a command: only where the turn runs commands (work with "run commands"; never the chat). A
    // bound service's read is a quick call: the chat makes it too, within its budgets.
    ...(secrets ? BOT_SECRET_TOOLS.filter((tool) => tool !== 'secret_run' || manifest.tools.includes('shell')) : []),
    ...(quickActions ? BOT_QUICK_ACTION_TOOLS : []),
    ...(shared?.tasks ? BOT_TASK_TOOLS : []),
    ...(skills.length || allSkills ? ['skill_list', 'skill_load'] : []),
    ...(own?.escalate ? ['escalate'] : []),
    ...(own?.consult ? ['consult'] : []),
    ...(own?.workWaiting ? ['work_wait'] : []),
    ...(own?.scheduled ? ['schedule_done'] : []),
    // Always on, like memory: the listing of the owner's MCP servers, so the bot can ask for the right one.
    ...(own?.memory ? [...BOT_MEMORY_TOOLS, ...BOT_ITEM_TOOLS, BOT_MCP_LIST_TOOL] : []),
    // What runs in its folders, on every turn (chat, work, consults and subagents alike), so it reuses a running server
    // instead of starting another: it only reads.
    BOT_RUNNING_TOOL,
    ...(own?.frontDesk ? BOT_WORK_TOOLS.filter((tool) => tool !== 'watch_start' || own.watcherStart === true) : []),
    ...(!own?.frontDesk && own?.timers ? ['remind', ...(own.watcherStart ? ['watch_start'] : [])] : []),
    ...(own?.images ? [BOT_IMAGE_TOOL] : []),
    ...(own?.applets ? [BOT_APPLET_TOOL] : []),
    ...(own?.questions ? [BOT_QUESTION_TOOL, BOT_QUESTION_WITHDRAW_TOOL, ...(own.frontDesk ? [BOT_QUESTION_ANSWER_TOOL] : [])] : []),
    ...(own?.cards ? [BOT_CARD_TOOL, BOT_REPORT_BUG_TOOL] : []),
    ...(own?.bots ? BOT_MESSAGE_TOOLS : []),
    // A run's main turn splits its job among subagents, on models from the same list the chat picks work's from.
    ...(own?.subagents && !own.frontDesk ? [...BOT_SUBAGENT_TOOLS, 'model_list'] : []),
    // The catalogue's own tools: they reach nothing themselves, and every tool called through them is held to this list.
    ...(own?.catalogue ? [BOT_CATALOGUE_TOOL, ...(own.catalogue === 'use_tool' ? [BOT_USE_TOOL] : [])] : [])
  ])].sort()
  const mcp = [...new Set(manifest.mcp.map((pair) => `${pair.serverId}::${pair.tool}` as const))].sort()
  return {
    ok: true,
    policy: {
      // Built-ins by their runtime names, app tools by theirs, user MCP tools server-qualified.
      tools: { allow: [...new Set([...native.names, ...appTools, ...manifest.mcp.map((pair) => `mcp__${pair.serverId}__${pair.tool}`)])].sort() },
      approvals: 'grants',
      approve: 'host',
      budget,
      authority: { kind: 'bot', digest: input.digest }
    },
    permissions: {
      tools: [...new Set(manifest.tools)].sort(),
      appTools,
      mcp,
      skills,
      ...(allSkills ? { allSkills: true as const } : {}),
      ...(browser ? { browser: true as const } : {}),
      ...(threads ? { threads } : {}),
      ...(profiler ? { profiler: true as const } : {}),
      ...(themes ? { themes: true as const } : {}),
      ...(schedules ? { schedules } : {}),
      ...(secrets ? { secrets: true as const } : {}),
      ...(quickActions ? { quickActions: true as const } : {}),
      ...(own?.catalogue ? { catalogue: own.catalogue } : {}),
      workspace: files !== undefined ? { roots: [], access: 'read', writeRoots: [], scratch, files } : null
    }
  }
}

const SUBAGENT_APP: ReadonlySet<string> = new Set(BOT_SUBAGENT_APP_TOOLS)

/**
 * What a run's subagent holds of what its work holds: the built-ins, the owner's MCP tools and skills as
 * they are, and of the Mousse app tools only the web and the browser (`BOT_SUBAGENT_APP_TOOLS`, an allowlist, so an app
 * tool a later build makes grantable never reaches a subagent by itself). The limits stay the work's: its subagents
 * draw on the same counts, spend and time.
 */
export function subagentManifest(manifest: BotManifest): BotManifest {
  return { ...manifest, appTools: manifest.appTools.filter((tool) => SUBAGENT_APP.has(tool)) }
}

const WORK_ONLY: ReadonlySet<string> = new Set(BOT_WORK_ONLY_TOOLS)
const NATIVE_OFF: ReadonlySet<string> = new Set([...BOT_WORK_ONLY_TOOLS, ...BOT_CHAT_NATIVE_OFF])

/**
 * What a chat turn is offered of a grant: everything but commands, the computer and the browser, which its work does
 * (`BOT_WORK_ONLY_TOOLS`). Its web is Mousse's own web tools, never the runtime's (`BOT_CHAT_NATIVE_OFF`), and it keeps
 * the owner's MCP tools, which it reaches through its catalogue. Its quick calls keep to its budgets (`BotQuickCalls`).
 */
export function frontDeskManifest(manifest: BotManifest): BotManifest {
  return {
    ...manifest,
    tools: manifest.tools.filter((tool) => !NATIVE_OFF.has(tool)),
    // A grant may hold the web as a built-in only: in the chat that is Mousse's web tool of the same name.
    appTools: [...new Set([
      ...manifest.appTools.filter((tool) => !WORK_ONLY.has(tool) && tool !== BOT_BROWSER_PERMISSION),
      ...BOT_CHAT_NATIVE_OFF.filter((tool) => (manifest.tools as readonly string[]).includes(tool))
    ])]
  }
}
