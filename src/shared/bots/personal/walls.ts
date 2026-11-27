import type { BotAuthority, BotCheck, BotCheckDenied, NormalisedCall, WallReason } from './authority'
import { neutralToolsOf, type NativeToolTable, type NeutralTool } from '../../harness/tools'
import { BROWSER_AUTOMATION_TOOLS } from '../../browser/automation'
import { BOT_SCHEDULE_ACT_TOOLS, BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from './manifest'

/** Walls in plain words, and the built-in check a runtime's gate makes (PR 6 §4). Browser-safe. */

/** What a wall tells the model and the owner, in plain words. */
export function wallMessage(wall: WallReason): string {
  switch (wall.kind) {
    case 'waiting': return 'This bot is waiting for its owner, so it cannot use tools now.'
    case 'tool': return `This bot is not allowed to use ${wall.tool}.`
    // Never an ask: a bot can't be given files outside its own folders.
    case 'path': return wall.access === 'write'
      ? `This bot is not allowed to change ${wall.path}.`
      : `This bot is not allowed to read ${wall.path}.`
    case 'network_path': return `Give ${wall.path} by its path on this computer, not as a network path to it.`
    case 'path_form': return wall.full
      ? `Give ${wall.path} as a full path, without ~ or variables: ${wall.full}`
      : wall.home
        ? `Give ${wall.path} as a full path, without ~ or variables. Your owner's home folder is ${wall.home}.`
        : `Give ${wall.path} as a full path, without ~ or variables.`
    case 'skill': return `This bot is not allowed to use the skill ${wall.skill}.`
    case 'mcp': return `This bot is not allowed to use the ${wall.serverName ?? 'MCP'} tool ${wall.tool}.`
    case 'policy_unenforceable': return `This bot cannot use ${wall.tool} on this runtime.`
    case 'revoked': return 'This bot\'s permissions were withdrawn, so it cannot use tools now.'
    case 'ended': return 'This bot\'s run has ended, so it cannot use tools now.'
    case 'escalated': return `Paused: waiting for the owner to allow: ${wall.permission}. End your turn now.`
    case 'paused': return 'Paused: earlier tool calls need checking by the owner. End your turn now.'
  }
}

/** What the model is told when a check did not allow its call: the wall, or the ask's refusal. */
export function checkMessage(denied: BotCheckDenied): string {
  return 'refused' in denied ? denied.refused.text : wallMessage(denied.wall)
}

/**
 * A runtime's built-in call (`nativeName` in `table`) under a bot's authority: allowed when any
 * neutral tool the name stands for passes `check`. A name with no neutral tool is never granted.
 * `own`: the runtime's gate found every path of the call in its own storage for this bot.
 */
export function checkBuiltinCall(bot: Pick<BotAuthority, 'check' | 'checkAny'>, table: NativeToolTable, nativeName: string, args: Record<string, unknown>, own?: boolean): BotCheck {
  const neutrals = neutralToolsOf(table, nativeName)
  if (!neutrals.length) return { ok: false, wall: { kind: 'tool', tool: nativeName } }
  const call = (tool: NeutralTool): NormalisedCall => ({ kind: 'builtin', tool, nativeName, args, ...(own ? { own: true as const } : {}) })
  if (bot.checkAny) return bot.checkAny(neutrals.map(call))
  let refused: BotCheckDenied | undefined
  for (const tool of neutrals) {
    const decided = bot.check(call(tool))
    if (decided.ok) return decided
    refused ??= decided
  }
  return refused!
}

/** The skill tools: usable when the bot holds any skill, and `skill_load` only for a granted one. */
const SKILL_TOOLS: ReadonlySet<string> = new Set(['skill_list', 'skill_load'])

/**
 * Whether a turn's "usable now" note may name the Mousse app tool `name`: any tool on a thread's
 * turn, and only the granted ones (with permission_ask, memory and skill tools) on a bot's.
 */
export function botTurnOffers(bot: Pick<BotAuthority, 'appTools'> | undefined, name: string): boolean {
  return !bot || bot.appTools.has(name)
}

/**
 * Why a bot may not run the Mousse app tool `name` with `args` (its wall in plain words), or
 * undefined when its grant holds the call. The registry checks this on every call of a bot turn.
 */
export function botAppToolRefusal(bot: Pick<BotAuthority, 'check' | 'skills' | 'escalate'> & Partial<Pick<BotAuthority, 'appTools' | 'threadsReadOnly' | 'allSkills' | 'turnRefusals'>>, name: string, args: Record<string, unknown>): string | undefined {
  // What started the turn decides some tools (a turn whose start no build names only reads): said in its own words.
  const byStart = bot.turnRefusals?.get(name)
  if (byStart) return byStart
  // Starting, messaging and stopping threads belong to a turn the owner started or asked for: a turn that holds the
  // owner's threads to read only (a chat turn no message of the owner's started) is told why, and nothing is
  // asked. A turn of a bot without the permission falls through to the check below, which asks for it.
  if (THREAD_ACT.has(name) && (bot.threadsReadOnly || (bot.appTools && !bot.appTools.has(name) && BOT_THREAD_READ_TOOLS.some((tool) => bot.appTools!.has(tool)))))
    return BOT_THREADS_NOT_OWNER_TEXT
  // Making and changing scheduled jobs likewise: such a turn lists them only.
  if (SCHEDULE_ACT.has(name) && ((bot.threadsReadOnly && bot.appTools?.has(name)) || (bot.appTools && !bot.appTools.has(name) && bot.appTools.has('schedule_list'))))
    return BOT_SCHEDULES_NOT_OWNER_TEXT
  if (SKILL_TOOLS.has(name)) {
    // The skill tools come with skills. Which skill loads is held by the turn itself: a bot turn's skills are every skill
    // unless switched off, else only its granted ones (by id), whether `skill_load` names one by id or name.
    if (!bot.skills.size && !bot.allSkills) return wallMessage({ kind: 'tool', tool: name })
    const decided = bot.check({ kind: 'app', tool: name, args })
    if (!decided.ok && ('refused' in decided || decided.wall.kind !== 'tool')) return checkMessage(decided)
    return undefined
  }
  const decided = bot.check({ kind: 'app', tool: name, args })
  if (decided.ok) return undefined
  return BROWSER_TOOL_NAMES.has(name) && !('refused' in decided) && decided.wall.kind === 'tool' ? botBrowserNotAllowed(bot) : checkMessage(decided)
}

const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BROWSER_AUTOMATION_TOOLS)
const THREAD_ACT: ReadonlySet<string> = new Set(BOT_THREAD_ACT_TOOLS)
const SCHEDULE_ACT: ReadonlySet<string> = new Set(BOT_SCHEDULE_ACT_TOOLS)

/** What such a turn is told when it tries to make, change, pause or run a scheduled job. */
export const BOT_SCHEDULES_NOT_OWNER_TEXT = "Not on this turn: it did not start with a message from your owner, and you make or change their scheduled jobs only when their own message asks for it. You may list the jobs you made now. Say what you would do, and do it once your owner replies."

/**
 * What a chat turn that no message of the owner started (another bot's message) is told when it tries
 * to start, message or stop one of the owner's threads.
 */
export const BOT_THREADS_NOT_OWNER_TEXT = "Not on this turn: it did not start with a message from your owner, and you start, message, stop or archive their threads only when their own message asks for it. You may list, search, read and wait on them now. Say what you would do, and do it once your owner replies."

/**
 * What a bot's call of a browser tool returns when its turn does not hold the browser (a bot's thread lists the browser
 * tools whatever it holds): not allowed, and where the turn can ask, to ask with permission_ask. In the chat, whose work may
 * hold the browser, permission_ask answers to hand the job to work_start.
 */
export function botBrowserNotAllowed(bot: Pick<BotAuthority, 'escalate'>): string {
  return `Not allowed: you may not use the browser on this turn.${bot.escalate ? ' If you need it, ask your owner with permission_ask (tool "browser").' : ''}`
}

/** Whether a bot's call of the Mousse app tool `name` is a browser tool its owner has not allowed. */
export function botBrowserWithheld(bot: Pick<BotAuthority, 'appTools'>, name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name) && !bot.appTools.has(name)
}
