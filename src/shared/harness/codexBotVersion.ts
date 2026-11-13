/**
 * What a bot's chat says when its turn does not run because the Codex that would run it is not a version whose tools
 * Mousse has accounted for (`codexBotVersionRefusal`). The run fails with this text as its error, and the bot's chat
 * shows it as it is.
 */
export const CODEX_BOT_VERSION_NEWER_TEXT = 'This version of Codex is newer than Mousse knows, so my work can\'t run on it yet.'
/** The same for a Codex older than every version checked, or one whose version could not be read. */
export const CODEX_BOT_VERSION_UNKNOWN_TEXT = 'Mousse doesn\'t know this version of Codex, so my work can\'t run on it.'

/** The texts a bot's chat shows as they are when its run fails with one of them. */
export const CODEX_BOT_VERSION_TEXTS: ReadonlySet<string> = new Set([CODEX_BOT_VERSION_NEWER_TEXT, CODEX_BOT_VERSION_UNKNOWN_TEXT])

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
  if (version === undefined) return CODEX_BOT_VERSION_UNKNOWN_TEXT
  return checked.every((known) => compareVersions(version, known) > 0) ? CODEX_BOT_VERSION_NEWER_TEXT : CODEX_BOT_VERSION_UNKNOWN_TEXT
}

/** `a` against `b` by their numeric `major.minor.patch`; a pre-release suffix is ignored. */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[-+]/)[0]!.split('.').map((part) => Number(part))
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
