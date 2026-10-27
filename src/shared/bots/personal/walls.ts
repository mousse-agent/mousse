import type { BotAuthority, WallReason } from './authority'
import { neutralToolsOf, type NativeToolTable } from '../../harness/tools'

/** Walls in plain words, and the built-in check a runtime's gate makes (PR 6 §4). Browser-safe. */

/** What a wall tells the model and the owner, in plain words. */
export function wallMessage(wall: WallReason): string {
  switch (wall.kind) {
    case 'waiting': return 'This bot is waiting for its owner, so it cannot use tools now.'
    case 'tool': return `This bot is not allowed to use ${wall.tool}.`
    case 'path': return wall.access === 'write'
      ? `This bot is not allowed to change ${wall.path}.`
      : `This bot is not allowed to read ${wall.path}.`
    case 'skill': return `This bot is not allowed to use the skill ${wall.skill}.`
    case 'mcp': return `This bot is not allowed to use the ${wall.server} tool ${wall.tool}.`
    case 'policy_unenforceable': return `This bot cannot use ${wall.tool} on this runtime.`
    case 'revoked': return 'This bot\'s permissions were withdrawn, so it cannot use tools now.'
    case 'ended': return 'This bot\'s run has ended, so it cannot use tools now.'
    case 'escalated': return `Paused: waiting for the owner to allow: ${wall.permission}. End your turn now.`
    case 'paused': return 'Paused: earlier tool calls need checking by the owner. End your turn now.'
  }
}

/**
 * A runtime's built-in call (`nativeName` in `table`) under a bot's authority: allowed when any
 * neutral tool the name stands for passes `check`. A name with no neutral tool is never granted.
 */
export function checkBuiltinCall(bot: Pick<BotAuthority, 'check'>, table: NativeToolTable, nativeName: string, args: Record<string, unknown>): { ok: true } | { ok: false; wall: WallReason } {
  const neutrals = neutralToolsOf(table, nativeName)
  if (!neutrals.length) return { ok: false, wall: { kind: 'tool', tool: nativeName } }
  let refused: { ok: false; wall: WallReason } | undefined
  for (const tool of neutrals) {
    const decided = bot.check({ kind: 'builtin', tool, nativeName, args })
    if (decided.ok) return decided
    refused ??= decided
  }
  return refused!
}

/** The skill tools: usable when the bot holds any skill, and `load_skill` only for a granted one. */
const SKILL_TOOLS: ReadonlySet<string> = new Set(['list_skills', 'load_skill'])

/**
 * Why a bot may not run the Mousse app tool `name` with `args` (its wall in plain words), or
 * undefined when its grant holds the call. The registry checks this on every call of a bot turn.
 */
export function botAppToolRefusal(bot: Pick<BotAuthority, 'check' | 'skills'>, name: string, args: Record<string, unknown>): string | undefined {
  if (SKILL_TOOLS.has(name)) {
    // The skill tools come with granted skills. Which skill loads is held by the turn itself: a
    // bot turn's skills are only its granted ones (by id), whether `load_skill` names one by id or name.
    if (!bot.skills.size) return wallMessage({ kind: 'tool', tool: name })
    const decided = bot.check({ kind: 'app', tool: name, args })
    if (!decided.ok && decided.wall.kind !== 'tool') return wallMessage(decided.wall)
    return undefined
  }
  const decided = bot.check({ kind: 'app', tool: name, args })
  return decided.ok ? undefined : wallMessage(decided.wall)
}
