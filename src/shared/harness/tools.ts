/**
 * Neutral names for a runtime's own built-in tools (PR 6 §2). A bot's grant, its exact allowlist
 * and its checks name these; each driver maps a neutral name to the names its runtime uses
 * (`HarnessDriver.nativeToolNames`). A runtime tool with no neutral name (Pi's `powershell`,
 * Claude Code's `Agent`, `TodoWrite`, ...) is never granted. Mousse's app tools keep their own
 * names (`AppToolTurns`) and are not listed here. Browser-safe.
 */

export const NEUTRAL_TOOLS = ['read', 'list', 'search', 'edit', 'write', 'shell', 'web_fetch', 'web_search'] as const
export type NeutralTool = (typeof NEUTRAL_TOOLS)[number]

const NEUTRAL: ReadonlySet<string> = new Set(NEUTRAL_TOOLS)

export function isNeutralTool(name: string): name is NeutralTool {
  return NEUTRAL.has(name)
}

/**
 * The tools that only read: a call of these that a crash cut short can run again, so its ledger
 * row is written as idempotent whatever its native name. `edit`, `write` and `shell` are not.
 */
const IDEMPOTENT: ReadonlySet<NeutralTool> = new Set<NeutralTool>(['read', 'list', 'search', 'web_fetch', 'web_search'])

export function neutralToolIdempotent(tool: NeutralTool): boolean {
  return IDEMPOTENT.has(tool)
}

/** A driver's native names per neutral tool; a missing or empty entry means the runtime has no such tool. */
export type NativeToolTable = Readonly<Partial<Record<NeutralTool, readonly string[]>>>
