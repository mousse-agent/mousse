/**
 * What a bot's chat says when its turn does not run because the Codex that would run it is not a version Mousse has
 * checked for bots (`codexBotVersionRefusal`): older or newer alike. The run fails with this text as its error, and the
 * bot's chat shows it as it is.
 */
export const CODEX_BOT_VERSION_TEXT = 'This version of Codex hasn\'t been checked for bots yet, so my work can\'t run on it.'
/** The same when Codex didn't say which version it is. */
export const CODEX_BOT_VERSION_UNKNOWN_TEXT = 'Mousse couldn\'t tell which version of Codex this is, so my work can\'t run on it.'

/** The texts a bot's chat shows as they are when its run fails with one of them. */
export const CODEX_BOT_VERSION_TEXTS: ReadonlySet<string> = new Set([CODEX_BOT_VERSION_TEXT, CODEX_BOT_VERSION_UNKNOWN_TEXT])

/** What Runs on says, once, when a row is picked on such an entry: before any work is sent. */
export const CODEX_BOT_RUNS_ON_TEXT = 'Bots\' work won\'t run on this version of Codex: it hasn\'t been checked for bots yet.'

/**
 * The version in the user agent Codex's app-server reports at `initialize` (`<originator>/<version> (<system>) …`).
 * Undefined when there is none.
 */
export function codexVersionOf(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string') return undefined
  return /^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(userAgent.trim())?.[1]
}

/**
 * Why a bot's turn does not run on a Codex of `version`, or undefined when `version` is one of `checked`: the versions
 * whose tools were read from the real binary and accounted for. Fails closed: an unread version never runs a bot.
 */
export function codexBotVersionRefusal(version: string | undefined, checked: readonly string[]): string | undefined {
  if (version !== undefined && checked.includes(version)) return undefined
  return version === undefined ? CODEX_BOT_VERSION_UNKNOWN_TEXT : CODEX_BOT_VERSION_TEXT
}

/**
 * Runs on's line for a Codex entry whose installed `version` (as its check read it) is not one of `checked`, with the
 * versions in its tooltip. Undefined when it is checked, or not known yet: the turn itself decides then.
 */
export function codexBotRunsOnNote(version: string | undefined, checked: readonly string[]): { text: string; title: string } | undefined {
  if (version === undefined || checked.includes(version)) return undefined
  return { text: CODEX_BOT_RUNS_ON_TEXT, title: `Codex ${version} is installed here. Checked for bots: ${checked.join(', ')}.` }
}
