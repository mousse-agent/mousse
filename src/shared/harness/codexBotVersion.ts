/**
 * What a bot's chat says when its turn does not run because the Codex that would run it is not a version Mousse has
 * checked for bots (`codexBotVersionRefusal`): older or newer alike. The run fails with this text as its error, and the
 * bot's chat shows it as it is.
 */
export const CODEX_BOT_VERSION_TEXT = 'This version of Codex hasn\'t been checked for bots yet, so my work can\'t run on it.'
/** The same when Codex didn't say which version it is. */
export const CODEX_BOT_VERSION_UNKNOWN_TEXT = 'Mousse couldn\'t tell which version of Codex this is, so my work can\'t run on it.'

/**
 * What a bot's chat says when the owner's own Codex config switches on a feature that adds a tool Mousse can't switch off
 * for one thread (`CODEX_BOT_FEATURES_REFUSED`): the turn does not run while it is on.
 */
export function codexBotSettingText(features: readonly string[]): string {
  return `Codex's own setting ${features.map((name) => `"${name}"`).join(', ')} is on, and my work can't run with it. Switch it off in Codex's config.toml to let me work here.`
}

/**
 * What a bot's chat says when its turn does not run because the owner's own Codex config can't be read: neither the MCP
 * servers to switch off nor the features a thread can't switch off (`CODEX_BOT_FEATURES_REFUSED`) can be checked.
 */
export const CODEX_BOT_SETUP_UNREADABLE_TEXT = 'Mousse couldn\'t read Codex\'s own settings, so my work can\'t run on it now.'

/**
 * What a bot's chat says when it may run commands and its turn does not run because Codex can't keep commands out of
 * Mousse's own data on this computer (Windows: its sandbox there reads every file).
 */
export const CODEX_BOT_COMMANDS_UNHELD_TEXT = 'Codex on Windows can\'t keep my commands out of Mousse\'s own data, so my work can\'t run on it while I may run commands.'

/** Whether a bot's run failed with one of these texts, which its chat shows as they are. */
export function isCodexBotRefusal(reason: string): boolean {
  return reason === CODEX_BOT_VERSION_TEXT || reason === CODEX_BOT_VERSION_UNKNOWN_TEXT || reason === CODEX_BOT_SETUP_UNREADABLE_TEXT ||
    reason === CODEX_BOT_COMMANDS_UNHELD_TEXT || /^Codex's own setting ".+" is on, and my work can't run with it\./.test(reason)
}

/** What Runs on says, once, when a row is picked on such an entry: before any work is sent. */
export const CODEX_BOT_RUNS_ON_TEXT = 'Bots\' work won\'t run on this version of Codex: it hasn\'t been checked for bots yet.'

/** What Runs on says for a Codex entry on Windows, where a bot that may run commands doesn't run (`CODEX_BOT_COMMANDS_UNHELD_TEXT`). */
export const CODEX_BOT_WINDOWS_RUNS_ON_TEXT = 'Bots that may run commands won\'t run on Codex on Windows: it can\'t keep commands out of Mousse\'s own data.'

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
 * versions in its tooltip; else, on Windows (`platform`), the line that a bot that may run commands doesn't run there.
 * Undefined otherwise. A version not known yet gets no version line: the turn itself decides then.
 */
export function codexBotRunsOnNote(version: string | undefined, checked: readonly string[], platform?: string): { text: string; title: string } | undefined {
  if (version !== undefined && !checked.includes(version))
    return { text: CODEX_BOT_RUNS_ON_TEXT, title: `Codex ${version} is installed here. Checked for bots: ${checked.join(', ')}.` }
  if (platform === 'win32')
    return { text: CODEX_BOT_WINDOWS_RUNS_ON_TEXT, title: 'Codex\'s sandbox on Windows reads every file. Bots without "run commands" run here as usual.' }
  return undefined
}
