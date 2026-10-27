import {
  COMMANDS,
  beats,
  bindingFor,
  bindingFromKey,
  defaultBindingFor,
  findConflicts,
  formatBinding,
  getCommand,
  normalizeShortcuts,
  parseBinding,
  reservedMatches,
  resolveBinding,
  scopesOverlap,
  type CommandCategory,
  type CommandDefinition,
  type CommandId,
  type KeyInput,
  type ShortcutOverrides
} from '../../shared/commands'

/**
 * The rules behind the Shortcuts settings section, without React: what a key press means to the
 * recorder, what saving a recorded binding would do, and how a reset is written. Every change is a
 * `patch`: the entries to send to `settings.set`, which the daemon merges into the saved overrides
 * and cleans with `normalizeShortcuts` (so a binding equal to its default is dropped).
 */

// ---------------------------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------------------------

export type RecorderAction =
  /** A modifier alone, a composing key or anything that is not a chord: keep listening. */
  | { type: 'ignore' }
  | { type: 'cancel' }
  /** Backspace alone clears the binding. */
  | { type: 'unbind' }
  | { type: 'record'; binding: string }

/** What a key press means while a row is recording. The binding comes from the same normaliser the dispatcher matches with. */
export function interpretRecorderKey(input: KeyInput, platform: string): RecorderAction {
  if (input.isComposing) return { type: 'ignore' }
  if (input.key === 'Escape') return { type: 'cancel' }
  const modified = input.ctrlKey || input.metaKey || input.altKey || input.shiftKey
  if (input.key === 'Backspace' && !modified) return { type: 'unbind' }
  const binding = bindingFromKey(input, platform)
  return binding === null ? { type: 'ignore' } : { type: 'record', binding }
}

// ---------------------------------------------------------------------------------------------
// Saving a recorded binding
// ---------------------------------------------------------------------------------------------

export type BindingProposal =
  /** The command already has this binding. */
  | { kind: 'unchanged' }
  /** Nothing to warn about: send the patch. */
  | { kind: 'save'; patch: ShortcutOverrides }
  /** Never allowed; nothing is saved. */
  | { kind: 'refuse'; reason: string }
  /**
   * Allowed after a choice. `others` are the commands that already use the chord and can be active
   * together with this one; `winner` is the one that runs where they overlap and `losers` the ones
   * that do not. `reasons` are soft-reserved chord notes. `keepPatch` saves the binding as it is
   * (Keep both, Use anyway); `replacePatch` also unbinds `others` and is null when there are none.
   */
  | {
      kind: 'confirm'
      binding: string
      others: CommandId[]
      winner: CommandId | null
      losers: CommandId[]
      reasons: string[]
      keepPatch: ShortcutOverrides
      replacePatch: ShortcutOverrides | null
    }

const isFunctionKey = (key: string): boolean => /^F\d+$/.test(key)

/** A command that may run while a text field has focus must not be a bare key: it would fire while typing. */
function bareKeyProblem(id: CommandId, binding: string): string | null {
  if (getCommand(id).textInput !== 'allow') return null
  const parsed = parseBinding(binding)
  if (!parsed || parsed.mod || parsed.ctrl || parsed.cmd || parsed.alt || isFunctionKey(parsed.key)) return null
  return 'It needs Ctrl, Cmd or Alt, otherwise it would also run while you type'
}

/** The command that runs where two overlapping commands share a chord: a scoped one beats a global one, then table order. */
function winnerOf(a: CommandDefinition, b: CommandDefinition): CommandDefinition {
  return beats(b, a) ? b : a
}

/**
 * What saving `binding` (null clears it) for `id` would do under the current overrides: refuse a
 * chord that can never be used, ask when the chord clashes with another command or is soft-reserved,
 * otherwise save.
 */
export function proposeBinding(id: CommandId, binding: string | null, overrides: ShortcutOverrides, platform: string): BindingProposal {
  const current = bindingFor(id, overrides, platform)
  if (binding === null) return current === null ? { kind: 'unchanged' } : { kind: 'save', patch: { [id]: null } }

  const resolved = resolveBinding(binding, platform)
  if (resolved === null) return { kind: 'refuse', reason: 'That is not a valid shortcut' }
  if (current !== null && resolveBinding(current, platform) === resolved) return { kind: 'unchanged' }

  const bare = bareKeyProblem(id, binding)
  if (bare) return { kind: 'refuse', reason: bare }
  const hard = reservedMatches(binding, platform, id).find((entry) => entry.hard)
  if (hard) return { kind: 'refuse', reason: hard.reason }

  const own = getCommand(id)
  const keepPatch: ShortcutOverrides = { [id]: binding }
  const others = new Set<CommandId>()
  for (const conflict of findConflicts({ ...overrides, ...keepPatch }, platform)) {
    if (conflict.kind !== 'command' || conflict.binding !== resolved || !conflict.commands.includes(id)) continue
    for (const other of conflict.commands) if (other !== id && scopesOverlap(own, getCommand(other))) others.add(other)
  }
  const reasons = reservedMatches(binding, platform, id).map((entry) => entry.reason)
  if (others.size === 0 && reasons.length === 0) return { kind: 'save', patch: keepPatch }

  let winner = own
  for (const other of others) winner = winnerOf(winner, getCommand(other))
  const sharing = [id, ...others]
  return {
    kind: 'confirm',
    binding,
    others: [...others],
    winner: others.size ? winner.id : null,
    losers: others.size ? sharing.filter((candidate) => candidate !== winner.id) : [],
    reasons,
    keepPatch,
    replacePatch: others.size ? { ...keepPatch, ...Object.fromEntries([...others].map((other) => [other, null])) } : null
  }
}

// ---------------------------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------------------------

/**
 * The patch that puts a command back on its default. The default is written rather than the key
 * removed, because a merge cannot delete a key; the daemon drops entries equal to the default.
 */
export function resetPatch(id: CommandId, overrides: ShortcutOverrides, platform: string): ShortcutOverrides {
  return overrides[id] === undefined ? {} : { [id]: defaultBindingFor(id, platform) }
}

/** The patch that puts every overridden command back on its default. */
export function resetAllPatch(overrides: ShortcutOverrides, platform: string): ShortcutOverrides {
  const patch: ShortcutOverrides = {}
  for (const id of Object.keys(overrides) as CommandId[]) Object.assign(patch, resetPatch(id, overrides, platform))
  return patch
}

/** The overrides a daemon holds after a patch: the same merge and clean-up it does, for showing the result at once. */
export function applyPatch(overrides: ShortcutOverrides, patch: ShortcutOverrides, platform: string): ShortcutOverrides {
  return normalizeShortcuts({ ...overrides, ...patch }, platform)
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

/** For each command another one shadows, the command that runs instead where both are active. */
export function shadowedBy(overrides: ShortcutOverrides, platform: string): Map<CommandId, CommandId> {
  const shadowed = new Map<CommandId, CommandId>()
  for (const conflict of findConflicts(overrides, platform)) {
    if (conflict.kind !== 'command') continue
    for (const loser of conflict.losers) {
      const lost = getCommand(loser)
      const by = conflict.commands.map(getCommand).find((other) => other.id !== loser && scopesOverlap(lost, other) && beats(other, lost))
      if (by && !shadowed.has(loser)) shadowed.set(loser, by.id)
    }
  }
  return shadowed
}

export interface ShortcutRow {
  command: CommandDefinition
  /** The binding in use, or null when unbound. */
  binding: string | null
  /** The binding as shown (`Ctrl+Shift+K`, `⌘⇧K`); empty when unbound. */
  label: string
  /** Set by the user and different from the default. */
  custom: boolean
  /** The command that runs instead where this one shares its chord. */
  shadowedBy: CommandId | null
}

export interface ShortcutGroup {
  category: CommandCategory
  rows: ShortcutRow[]
}

/** Every command in table order, grouped by category, narrowed to the ones that match every word of `query`. */
export function shortcutGroups(query: string, overrides: ShortcutOverrides, platform: string): ShortcutGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shadows = shadowedBy(overrides, platform)
  const groups = new Map<CommandCategory, ShortcutRow[]>()
  for (const command of COMMANDS) {
    const binding = bindingFor(command.id, overrides, platform)
    const label = binding === null ? '' : formatBinding(binding, platform)
    const haystack = [command.title, command.category, ...(command.searchTerms ?? []), label].join(' ').toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue
    const custom =
      !command.fixed &&
      overrides[command.id] !== undefined &&
      (binding === null || resolveBinding(binding, platform) !== resolveBinding(defaultBindingFor(command.id, platform), platform))
    const row: ShortcutRow = { command, binding, label, custom, shadowedBy: shadows.get(command.id) ?? null }
    const rows = groups.get(command.category)
    if (rows) rows.push(row)
    else groups.set(command.category, [row])
  }
  return [...groups].map(([category, rows]) => ({ category, rows }))
}
