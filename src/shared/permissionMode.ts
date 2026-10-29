import type { HarnessCaps } from './harness/types'
import type { ChatMessage } from './types'

/**
 * How much an agent may do in a thread without asking: `ask` (commands and edits ask), `accept_edits`
 * (edits go ahead, commands ask), `auto` (edits go ahead, and the agent's own auto mode decides which
 * commands are safe to run and asks about the rest) or `full` (nothing asks). Every provider enforces
 * it with its own controls; one that cannot is refused at turn admission rather than run unenforced.
 *
 * Only an agent with an auto mode of its own (`HarnessCaps.autoPermissionMode`) runs in `auto`. On any
 * other agent a thread set to Auto runs exactly as Auto-accept edits would (`effectivePermissionMode`),
 * and Mousse's own checks treat `auto` as `accept_edits` (`permissionModeAllows`): only the agent's own
 * auto mode ever lets a command through without asking.
 */
export type PermissionMode = 'ask' | 'accept_edits' | 'auto' | 'full'

/** Strictest first: a lower index is a stricter mode. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'accept_edits', 'auto', 'full']

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'accept_edits'

/** What an action does to the user's machine, as far as a permission mode cares. */
export type PermissionAction = 'command' | 'edit' | 'tool'

export function isPermissionMode(raw: unknown): raw is PermissionMode {
  return typeof raw === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw)
}

/**
 * A missing or unknown value (a corrupted record, a mode a later version adds) reads as the
 * strictest mode: when Mousse cannot tell what was chosen, it asks. A thread that never chose a
 * mode follows the profile default before this is called.
 */
export function normalizePermissionMode(raw: unknown): PermissionMode {
  return isPermissionMode(raw) ? raw : 'ask'
}

/** True when `a` asks about more than `b`. */
export function isStricter(a: PermissionMode, b: PermissionMode): boolean {
  return PERMISSION_MODES.indexOf(a) < PERMISSION_MODES.indexOf(b)
}

/** The strictest of the modes; the default when there are none. */
export function narrowPermissionMode(...modes: Array<PermissionMode | undefined>): PermissionMode {
  let strictest: PermissionMode | undefined
  for (const mode of modes) {
    if (mode === undefined) continue
    if (strictest === undefined || isStricter(mode, strictest)) strictest = mode
  }
  return strictest ?? DEFAULT_PERMISSION_MODE
}

/**
 * Whether `action` may go ahead without asking in `mode`, as far as Mousse itself decides. Auto lets no
 * more through here than Auto-accept edits: what Auto adds is the agent's own auto mode deciding, which
 * only that agent's driver hands over to (Claude Code's `auto` permission mode).
 */
export function permissionModeAllows(mode: PermissionMode, action: PermissionAction): boolean {
  if (mode === 'full') return true
  if (mode === 'accept_edits' || mode === 'auto') return action === 'edit'
  return false
}

export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'ask': return 'Ask before acting'
    case 'accept_edits': return 'Auto-accept edits'
    case 'auto': return 'Auto'
    case 'full': return 'Full access'
  }
}

/** Limits a runtime reports for the next turn on top of its tool control. */
export interface PermissionLimits {
  /** Claude Code: the user's settings forbid `bypassPermissions`. */
  bypassDisabled?: boolean
  /**
   * Modes the runtime cannot enforce, each with the reason shown when a thread resolves to a stricter one
   * (Claude Code: `auto` while its settings turn auto mode off).
   */
  unavailable?: Partial<Record<PermissionMode, string>>
  /** Full access also turns the agent's own sandbox off (Codex), which the permission menu says. */
  sandboxOffInFull?: boolean
}

/**
 * The modes an instance can enforce, strictest first. `exact` and `approval_only` instances can
 * enforce Ask, Auto-accept edits and Full access, and Auto when the agent has an auto mode of its own
 * (`autoPermissionMode`); one that approves tools itself (`uncontrolled`) can only run in Full access.
 */
export function supportedPermissionModes(caps: Partial<Pick<HarnessCaps, 'toolControl' | 'autoPermissionMode'>>, limits: PermissionLimits = {}): PermissionMode[] {
  // Caps from before the key existed read as uncontrolled: Mousse never assumes control it cannot show.
  if ((caps.toolControl ?? 'uncontrolled') === 'uncontrolled') return ['full']
  return PERMISSION_MODES.filter((mode) =>
    !(mode === 'full' && limits.bypassDisabled) &&
    // Caps from before the key existed, and every agent without an auto mode, have no Auto.
    !(mode === 'auto' && caps.autoPermissionMode !== true) &&
    !limits.unavailable?.[mode])
}

export type EffectivePermissionMode =
  | { mode: PermissionMode; reason?: string; refused?: undefined }
  | { refused: true; reason: string; mode?: undefined }

/**
 * The mode a turn runs in: the requested one when supported, else the nearest stricter supported
 * mode with the reason, else refused (an `ask` or `accept_edits` thread on an agent that approves
 * tools itself has no stricter mode to fall back to). Auto on an agent that cannot run it resolves
 * exactly as Auto-accept edits does there: the same mode or the same refusal, never anything wider.
 */
export function effectivePermissionMode(
  requested: PermissionMode,
  supported: readonly PermissionMode[],
  context: { agent?: string; limits?: PermissionLimits } = {}
): EffectivePermissionMode {
  if (supported.includes(requested)) return { mode: requested }
  const agent = context.agent ?? 'This provider'
  if (requested === 'auto') {
    const reason = context.limits?.unavailable?.auto ?? `${agent} has no auto mode`
    const asEdits = effectivePermissionMode('accept_edits', supported, context)
    if (asEdits.refused) return asEdits
    return { mode: asEdits.mode, reason: asEdits.reason ? `${reason}. ${asEdits.reason}` : reason }
  }
  const stricter = PERMISSION_MODES.filter((mode) => isStricter(mode, requested) && supported.includes(mode))
  const nearest = stricter[stricter.length - 1]
  if (nearest) {
    const limits = context.limits
    const reason = limits?.unavailable?.[requested]
      ?? (requested === 'full' && limits?.bypassDisabled ? 'Claude Code settings disallow bypassing permissions' : `${agent} cannot enforce ${describePermissionMode(requested)}`)
    return { mode: nearest, reason }
  }
  return { refused: true, reason: `${agent} approves tools itself; set this thread to Full access or pick another agent.` }
}

/** The slice of a thread the lineage ceiling reads. */
export interface PermissionLineageThread {
  id: string
  permissionMode?: PermissionMode
  lineage?: { parentThreadId: string }
}

/**
 * The narrowest mode on a subagent's lineage above it (each ancestor's own mode, else the profile
 * default); `full` for a thread nobody delegated. The daemon computes the same at every turn
 * (`OrchestratorService.permissionCeilingFor`); the composer uses this to grey out what a subagent
 * may not be set to.
 */
export function permissionCeilingOf(
  thread: PermissionLineageThread | undefined,
  threads: readonly PermissionLineageThread[],
  defaultMode: PermissionMode
): PermissionMode {
  let ceiling: PermissionMode = 'full'
  const seen = new Set<string>()
  let parentId = thread?.lineage?.parentThreadId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = threads.find((entry) => entry.id === parentId)
    if (!parent) break
    ceiling = narrowPermissionMode(ceiling, parent.permissionMode ?? defaultMode)
    parentId = parent.lineage?.parentThreadId
  }
  return ceiling
}

/**
 * Silent model-context notice for a mid-thread permission change. Persisted as a hidden user
 * message (never rendered), like the chat-mode notice.
 */
export function buildPermissionModeChangeNotice(from: PermissionMode, to: PermissionMode): string {
  return (
    `[System: Permission mode changed from ${describePermissionMode(from)} to ${describePermissionMode(to)}. ` +
    `${permissionModeSummary(to)} ` +
    `The current user message follows.]`
  )
}

function permissionModeSummary(mode: PermissionMode): string {
  switch (mode) {
    case 'ask': return 'Commands and file edits now ask the user before they run.'
    case 'accept_edits': return 'File edits now go ahead without asking; commands ask the user before they run.'
    case 'auto': return 'File edits now go ahead without asking; your own auto mode decides which commands are safe to run without asking and asks the user about the rest.'
    case 'full': return 'Commands and file edits now run without asking.'
  }
}

/**
 * The permission mode of the latest user turn, or undefined for a thread without one. Visible user
 * messages without a stored mode predate permission modes and read as the default. Hidden internal
 * wakes carry no mode and are skipped.
 */
export function getLastUserPermissionMode(messages: Pick<ChatMessage, 'role' | 'hidden' | 'permissionMode'>[]): PermissionMode | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (message.permissionMode !== undefined) return normalizePermissionMode(message.permissionMode)
    if (!message.hidden) return DEFAULT_PERMISSION_MODE
  }
  return undefined
}
