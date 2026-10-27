/**
 * The command table and the pure helpers behind keyboard shortcuts. No React, DOM or Electron, so the
 * renderer dispatcher, the settings recorder and the main-process menu all read one definition.
 *
 * Bindings are strings in Electron accelerator syntax: `CommandOrControl+Shift+K`, `Ctrl+Tab`, `B`.
 * `CommandOrControl` is Ctrl on Windows and Linux and Cmd on macOS. Two bindings are compared only
 * after both are resolved for a platform (`resolveBinding`).
 */

export type CommandId =
  | 'palette.open'
  | 'thread.new'
  | 'thread.next'
  | 'thread.previous'
  | 'threads.search'
  | 'chat.findInThread'
  | 'run.stop'
  | 'sideCard.toggle'
  | 'terminal.open'
  | 'composer.focus'
  | 'surface.browser'
  | 'surface.terminal'
  | 'surface.files'
  | 'surface.git'
  | 'model.pick1'
  | 'model.pick2'
  | 'model.pick3'
  | 'model.pick4'
  | 'model.pick5'
  | 'workflow.save'
  | 'workflow.duplicate'
  | 'workflow.delete'
  | 'workflow.undo'
  | 'workflow.redo'
  | 'editor.save'
  | 'git.commit'

/** Where a command is meant to run. A scoped command only exists while its surface is mounted. */
export type CommandScope = 'global' | 'surface-picker' | 'model-picker' | 'workflow-editor'

/** The kind of overlay that is topmost. While one is open it owns the keyboard. */
export type OverlayScope = 'modal' | 'palette' | 'thread-search' | 'model-picker'

export type CommandCategory = 'Thread' | 'View' | 'Go' | 'Surfaces' | 'Model picker' | 'Workflow editor' | 'Editor'

/** Per-profile overrides: a binding string replaces the default, `null` unbinds. */
export type ShortcutOverrides = Partial<Record<CommandId, string | null>>

export interface CommandContext {
  platform: string
  inTextInput: boolean
  inTerminal: boolean
  overlay: OverlayScope | null
  threadOpen: boolean
  runActive: boolean
  mainAreaOpen: boolean
  projectsMode: boolean
}

export interface CommandDefinition {
  id: CommandId
  title: string
  category: CommandCategory
  /** Extra words the palette matches besides the title. */
  searchTerms?: string[]
  defaultBinding: string | { mac: string; other: string }
  scope: CommandScope
  /** Whether the command may run while a text field has focus. */
  textInput: 'allow' | 'deny'
  /** Whether the command may run while a terminal has focus. */
  terminal: 'allow' | 'deny'
  /** Whether the command may run from a key typed inside the browser surface. */
  guest: 'allow' | 'deny'
  when?: (ctx: CommandContext) => boolean
  /** Declared for display only: the owner handles the key itself and it cannot be rebound. */
  fixed?: boolean
}

const MOD = 'CommandOrControl'
const mainAreaInProjects = (ctx: CommandContext): boolean => ctx.mainAreaOpen && ctx.projectsMode
const threadIsOpen = (ctx: CommandContext): boolean => ctx.threadOpen

function surfaceCommand(id: CommandId, title: string, letter: string): CommandDefinition {
  return {
    id,
    title,
    category: 'Surfaces',
    defaultBinding: letter,
    scope: 'surface-picker',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny',
    when: mainAreaInProjects
  }
}

function modelCommand(id: CommandId, n: number): CommandDefinition {
  return {
    id,
    title: `Pick model ${n}`,
    category: 'Model picker',
    defaultBinding: `${MOD}+${n}`,
    scope: 'model-picker',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'deny'
  }
}

/** Table order breaks ties: the first of two equal candidates wins. */
export const COMMANDS: readonly CommandDefinition[] = [
  {
    id: 'palette.open',
    title: 'Command palette',
    category: 'Go',
    searchTerms: ['commands', 'search', 'go to'],
    defaultBinding: `${MOD}+K`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    id: 'thread.new',
    title: 'New thread',
    category: 'Thread',
    searchTerms: ['chat', 'create', 'start'],
    defaultBinding: `${MOD}+N`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    id: 'thread.next',
    title: 'Next thread',
    category: 'Thread',
    searchTerms: ['chat', 'switch'],
    defaultBinding: 'Ctrl+Tab',
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    id: 'thread.previous',
    title: 'Previous thread',
    category: 'Thread',
    searchTerms: ['chat', 'switch'],
    defaultBinding: 'Ctrl+Shift+Tab',
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    id: 'threads.search',
    title: 'Search threads',
    category: 'Thread',
    searchTerms: ['find', 'chat', 'messages'],
    defaultBinding: `${MOD}+Shift+O`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    // The transcript's own find bar. A text field may be focused (the composer); a terminal or the
    // browser surface keeps the key, and the handler also leaves Monaco its own find widget.
    id: 'chat.findInThread',
    title: 'Find in thread',
    category: 'Thread',
    searchTerms: ['search', 'text', 'messages', 'transcript'],
    defaultBinding: `${MOD}+F`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'deny',
    when: threadIsOpen
  },
  {
    id: 'run.stop',
    title: 'Stop run',
    category: 'Thread',
    searchTerms: ['interrupt', 'cancel', 'abort', 'halt'],
    defaultBinding: `${MOD}+Shift+Backspace`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'allow',
    guest: 'allow',
    when: (ctx) => ctx.runActive
  },
  {
    id: 'sideCard.toggle',
    title: 'Toggle side card',
    category: 'View',
    searchTerms: ['panel', 'sidebar', 'details'],
    defaultBinding: `${MOD}+Shift+D`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow',
    when: threadIsOpen
  },
  {
    id: 'terminal.open',
    title: 'Open terminal',
    category: 'View',
    searchTerms: ['shell', 'console'],
    defaultBinding: `${MOD}+J`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'allow'
  },
  {
    id: 'composer.focus',
    title: 'Focus composer',
    category: 'Go',
    searchTerms: ['input', 'message', 'type'],
    defaultBinding: `${MOD}+Shift+M`,
    scope: 'global',
    textInput: 'allow',
    terminal: 'allow',
    guest: 'allow',
    when: threadIsOpen
  },
  surfaceCommand('surface.browser', 'Open Browser', 'B'),
  surfaceCommand('surface.terminal', 'Open Terminal', 'T'),
  surfaceCommand('surface.files', 'Open Files', 'F'),
  surfaceCommand('surface.git', 'Open Diff', 'D'),
  modelCommand('model.pick1', 1),
  modelCommand('model.pick2', 2),
  modelCommand('model.pick3', 3),
  modelCommand('model.pick4', 4),
  modelCommand('model.pick5', 5),
  {
    id: 'workflow.save',
    title: 'Save workflow',
    category: 'Workflow editor',
    defaultBinding: `${MOD}+S`,
    scope: 'workflow-editor',
    textInput: 'allow',
    terminal: 'deny',
    guest: 'deny'
  },
  {
    id: 'workflow.duplicate',
    title: 'Duplicate workflow node',
    category: 'Workflow editor',
    defaultBinding: `${MOD}+D`,
    scope: 'workflow-editor',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny'
  },
  {
    id: 'workflow.delete',
    title: 'Delete workflow node',
    category: 'Workflow editor',
    defaultBinding: 'Delete',
    scope: 'workflow-editor',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny'
  },
  {
    id: 'workflow.undo',
    title: 'Workflow editor: undo',
    category: 'Workflow editor',
    defaultBinding: `${MOD}+Z`,
    scope: 'workflow-editor',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny',
    fixed: true
  },
  {
    id: 'workflow.redo',
    title: 'Workflow editor: redo',
    category: 'Workflow editor',
    defaultBinding: { mac: 'Cmd+Shift+Z', other: 'Ctrl+Y' },
    scope: 'workflow-editor',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny',
    fixed: true
  },
  {
    // The editors and the commit box handle these keys themselves; they have no scope of their own.
    id: 'editor.save',
    title: 'Save file (Monaco)',
    category: 'Editor',
    defaultBinding: `${MOD}+S`,
    scope: 'global',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny',
    fixed: true
  },
  {
    id: 'git.commit',
    title: 'Commit message: commit',
    category: 'Editor',
    defaultBinding: `${MOD}+Enter`,
    scope: 'global',
    textInput: 'deny',
    terminal: 'deny',
    guest: 'deny',
    fixed: true
  }
]

const COMMAND_BY_ID: ReadonlyMap<CommandId, CommandDefinition> = new Map(COMMANDS.map((command) => [command.id, command]))

export function getCommand(id: CommandId): CommandDefinition {
  return COMMAND_BY_ID.get(id)!
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && COMMAND_BY_ID.has(value as CommandId)
}

const isMac = (platform: string): boolean => platform === 'darwin'

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

export interface ParsedBinding {
  /** `CommandOrControl`. False once resolved for a platform. */
  mod: boolean
  ctrl: boolean
  cmd: boolean
  alt: boolean
  shift: boolean
  key: string
}

type ModifierName = 'mod' | 'ctrl' | 'cmd' | 'alt' | 'shift'

const MODIFIERS: ReadonlyMap<string, ModifierName> = new Map([
  ['commandorcontrol', 'mod'],
  ['cmdorctrl', 'mod'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['cmd', 'cmd'],
  ['command', 'cmd'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['shift', 'shift']
])

const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['space', 'Space'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['insert', 'Insert'],
  ['plus', 'Plus']
])

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/i

function parseKeyToken(token: string): string | null {
  const named = NAMED_KEYS.get(token.toLowerCase())
  if (named) return named
  if (FUNCTION_KEY.test(token)) return token.toUpperCase()
  const chars = [...token]
  if (chars.length !== 1) return null
  const char = chars[0]!
  if (/\p{L}/u.test(char)) {
    const upper = char.toUpperCase()
    return [...upper].length === 1 ? upper : char
  }
  if (/[\s\p{C}]/u.test(char)) return null
  return char
}

/**
 * Parses `Modifier+...+Key`. Exactly one key; `+` as a key is written `Plus`. A trailing or doubled
 * `+`, a second key, an unknown modifier such as `Super` or `Meta`, and Escape all give null.
 */
export function parseBinding(text: string): ParsedBinding | null {
  if (typeof text !== 'string') return null
  const tokens = text.split('+').map((token) => token.trim())
  if (tokens.some((token) => token === '')) return null
  const parsed = { mod: false, ctrl: false, cmd: false, alt: false, shift: false }
  let key: string | null = null
  for (const token of tokens) {
    const modifier = MODIFIERS.get(token.toLowerCase())
    if (modifier) {
      parsed[modifier] = true
      continue
    }
    if (key !== null) return null
    key = parseKeyToken(token)
    if (key === null) return null
  }
  return key === null ? null : { ...parsed, key }
}

/** The canonical string for a parsed binding. Parsing it again gives the same value back. */
export function serializeBinding(binding: ParsedBinding): string {
  const parts: string[] = []
  if (binding.mod) parts.push(MOD)
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.cmd) parts.push('Cmd')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(binding.key)
  return parts.join('+')
}

/** `CommandOrControl` becomes Ctrl on Windows and Linux and Cmd on macOS. */
export function resolveParsedBinding(binding: ParsedBinding, platform: string): ParsedBinding {
  const mac = isMac(platform)
  return {
    mod: false,
    ctrl: binding.ctrl || (binding.mod && !mac),
    cmd: binding.cmd || (binding.mod && mac),
    alt: binding.alt,
    shift: binding.shift,
    key: binding.key
  }
}

/** The platform-specific canonical form, equal for two bindings that press the same keys. Null when unparseable. */
export function resolveBinding(binding: string, platform: string): string | null {
  const parsed = parseBinding(binding)
  return parsed ? serializeBinding(resolveParsedBinding(parsed, platform)) : null
}

const MAC_KEY_LABELS: ReadonlyMap<string, string> = new Map([
  ['Tab', '⇥'],
  ['Backspace', '⌫'],
  ['Delete', '⌦'],
  ['Enter', '↩'],
  ['Up', '↑'],
  ['Down', '↓'],
  ['Left', '←'],
  ['Right', '→'],
  ['Plus', '+']
])

/** `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. Empty for an unparseable binding. */
export function formatBinding(binding: string, platform: string): string {
  const parsed = parseBinding(binding)
  if (!parsed) return ''
  const resolved = resolveParsedBinding(parsed, platform)
  if (isMac(platform)) {
    const modifiers = `${resolved.ctrl ? '⌃' : ''}${resolved.alt ? '⌥' : ''}${resolved.cmd ? '⌘' : ''}${resolved.shift ? '⇧' : ''}`
    return modifiers + (MAC_KEY_LABELS.get(resolved.key) ?? resolved.key)
  }
  const parts: string[] = []
  if (resolved.ctrl) parts.push('Ctrl')
  if (resolved.cmd) parts.push('Super')
  if (resolved.alt) parts.push('Alt')
  if (resolved.shift) parts.push('Shift')
  parts.push(resolved.key === 'Plus' ? '+' : resolved.key)
  return parts.join('+')
}

export function defaultBindingFor(id: CommandId, platform: string): string {
  const { defaultBinding } = getCommand(id)
  return typeof defaultBinding === 'string' ? defaultBinding : isMac(platform) ? defaultBinding.mac : defaultBinding.other
}

/** The binding a command has under these overrides: the override (`null` = unbound) or the default. */
export function bindingFor(id: CommandId, overrides: ShortcutOverrides, platform: string): string | null {
  const override = overrides[id]
  return override === undefined ? defaultBindingFor(id, platform) : override
}

// ---------------------------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------------------------

export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

const EVENT_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ['Tab', 'Tab'],
  ['Enter', 'Enter'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right']
])

/** US shifted punctuation and the unshifted key it sits on. Digit-row symbols are not here: their `code` decides. */
const SHIFTED_PUNCTUATION: ReadonlyMap<string, string> = new Map([
  ['~', '`'],
  ['_', '-'],
  ['+', '='],
  ['{', '['],
  ['}', ']'],
  ['|', '\\'],
  [':', ';'],
  ['"', "'"],
  ['<', ','],
  ['>', '.'],
  ['?', '/']
])

/** The physical letter or digit of a key, whatever the layout types on it. */
function physicalToken(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)
  return digit ? digit[1]! : null
}

/**
 * The binding a key press stands for, or null when it is not a shortcut candidate: a modifier alone,
 * Escape, an IME composition, a Super/Win chord outside macOS, or an AltGr character on Windows/Linux.
 *
 * Letters follow the layout (`event.key`) and fall back to the physical key when the layout does not
 * type a Latin letter. Digits fall back to the physical key too. Punctuation is `event.key` only.
 * The result uses `CommandOrControl` for Ctrl on Windows/Linux and Cmd on macOS, and keeps Ctrl literal on macOS.
 */
export function bindingFromKey(input: KeyInput, platform: string): string | null {
  if (input.isComposing) return null
  const mac = isMac(platform)
  if (!mac && input.metaKey) return null
  const key = input.key
  if (!key) return null
  const chars = [...key]
  // On Windows and Linux AltGr reports Ctrl+Alt. A character it typed is text, not a chord.
  if (!mac && input.ctrlKey && input.altKey && chars.length === 1 && !/^[A-Za-z0-9]$/.test(key)) return null

  let token: string | null
  let shift = input.shiftKey
  if (chars.length > 1) {
    token = EVENT_KEY_NAMES.get(key) ?? (FUNCTION_KEY.test(key) ? key.toUpperCase() : null)
  } else if (key === ' ') {
    token = 'Space'
  } else if (/^[A-Za-z]$/.test(key)) {
    token = key.toUpperCase()
  } else if (/^[0-9]$/.test(key)) {
    token = key
  } else {
    token = physicalToken(input.code)
    if (token === null) {
      const base = SHIFTED_PUNCTUATION.get(key)
      if (base) shift = true
      token = parseKeyToken(base ?? key)
    }
  }
  if (token === null) return null

  return serializeBinding({
    mod: mac ? input.metaKey : input.ctrlKey,
    ctrl: mac && input.ctrlKey,
    cmd: false,
    alt: input.altKey,
    shift,
    key: token
  })
}

// ---------------------------------------------------------------------------------------------
// Resolving a key press to a command
// ---------------------------------------------------------------------------------------------

/** Resolved binding -> the commands bound to it, in table order. Fixed commands are not dispatched. */
export function resolveBindings(overrides: ShortcutOverrides, platform: string): Map<string, CommandId[]> {
  const bindings = new Map<string, CommandId[]>()
  for (const command of COMMANDS) {
    if (command.fixed) continue
    const binding = bindingFor(command.id, overrides, platform)
    const resolved = binding === null ? null : resolveBinding(binding, platform)
    if (resolved === null) continue
    const ids = bindings.get(resolved)
    if (ids) ids.push(command.id)
    else bindings.set(resolved, [command.id])
  }
  return bindings
}

/**
 * Whether the context lets a command run: the overlay that owns the keyboard, text-field and terminal
 * focus, and the command's own `when`. While an overlay is open only Stop run, the overlay's own
 * commands, and (for the palette) the palette toggle are allowed.
 */
export function commandAllowedInContext(command: CommandDefinition, ctx: CommandContext): boolean {
  if (command.fixed) return false
  // The picker's own commands exist only while the picker is the topmost overlay.
  if (command.scope === 'model-picker' && ctx.overlay !== 'model-picker') return false
  if (ctx.overlay !== null) {
    const owned =
      command.id === 'run.stop' ||
      command.scope === ctx.overlay ||
      (command.id === 'palette.open' && ctx.overlay === 'palette')
    if (!owned) return false
  }
  if (ctx.inTerminal && command.terminal === 'deny') return false
  if (ctx.inTextInput && command.textInput === 'deny') return false
  return command.when ? command.when(ctx) : true
}

/**
 * The command a key press runs, or null. `registered` says whether a handler is mounted and enabled.
 * A scoped command beats a global one on the same binding, then table order decides.
 */
export function resolveCommand(
  input: KeyInput,
  overrides: ShortcutOverrides,
  ctx: CommandContext,
  registered: (id: CommandId) => boolean,
  bindings: ReadonlyMap<string, CommandId[]> = resolveBindings(overrides, ctx.platform)
): CommandId | null {
  const binding = bindingFromKey(input, ctx.platform)
  const resolved = binding === null ? null : resolveBinding(binding, ctx.platform)
  const ids = resolved === null ? undefined : bindings.get(resolved)
  if (!ids) return null
  let best: CommandDefinition | null = null
  for (const id of ids) {
    const command = getCommand(id)
    if (!registered(id) || !commandAllowedInContext(command, ctx)) continue
    if (best === null || (best.scope === 'global' && command.scope !== 'global')) best = command
  }
  return best?.id ?? null
}

// ---------------------------------------------------------------------------------------------
// Reserved chords and conflicts
// ---------------------------------------------------------------------------------------------

export interface ReservedBinding {
  /** A binding string, or a predicate over the platform-resolved binding. */
  match: string | ((resolved: ParsedBinding) => boolean)
  reason: string
  /** Hard: never bindable. Soft: allowed after a warning. */
  hard: boolean
  /** Commands that may use the chord without a warning. */
  except?: CommandId[]
}

/** `zoomShortcuts.ts` swallows every Ctrl/Cmd chord on these keys, whatever Shift or Alt add. */
const ZOOM_KEYS: ReadonlySet<string> = new Set(['=', 'Plus', '-', '0'])

export const RESERVED_BINDINGS: readonly ReservedBinding[] = [
  { match: `${MOD}+Z`, reason: 'Undo belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+Shift+Z`, reason: 'Redo belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+X`, reason: 'Cut belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+C`, reason: 'Copy belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+V`, reason: 'Paste belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+A`, reason: 'Select all belongs to text fields and the Edit menu', hard: true },
  { match: `${MOD}+W`, reason: 'Closing the window belongs to the system', hard: true },
  { match: `${MOD}+Q`, reason: 'Quitting belongs to the system', hard: true },
  { match: `${MOD}+H`, reason: 'Hiding the app belongs to the system', hard: true },
  { match: `${MOD}+Alt+H`, reason: 'Hiding other apps belongs to the system', hard: true },
  {
    match: (resolved) => (resolved.ctrl || resolved.cmd) && ZOOM_KEYS.has(resolved.key),
    reason: 'Zoom shortcuts are handled before the page sees the key',
    hard: true
  },
  { match: `${MOD}+R`, reason: 'Reloads the window in development builds', hard: false },
  { match: `${MOD}+Shift+R`, reason: 'Reloads the window in development builds', hard: false },
  { match: `${MOD}+Shift+I`, reason: 'Opens developer tools in development builds', hard: false },
  {
    match: `${MOD}+F`,
    reason: 'Reserved for Find in thread (chat.findInThread)',
    hard: false,
    except: ['chat.findInThread']
  },
  { match: `${MOD}+P`, reason: 'Reserved for Files quick open (files.quickOpen)', hard: false },
  { match: `${MOD}+Shift+F`, reason: 'Reserved for Files text search (files.textSearch)', hard: false },
  {
    match: `${MOD}+S`,
    reason: 'Saves in editors and in the browser page',
    hard: false,
    except: ['workflow.save']
  }
]

/** The reserved entries a binding hits on a platform; entries that except `id` are left out. */
export function reservedMatches(binding: string, platform: string, id?: CommandId): ReservedBinding[] {
  const parsed = parseBinding(binding)
  if (!parsed) return []
  const resolved = resolveParsedBinding(parsed, platform)
  const resolvedText = serializeBinding(resolved)
  return RESERVED_BINDINGS.filter((entry) => {
    if (id && entry.except?.includes(id)) return false
    return typeof entry.match === 'string' ? resolveBinding(entry.match, platform) === resolvedText : entry.match(resolved)
  })
}

export type Conflict =
  | {
      kind: 'command'
      /** The resolved binding they share. */
      binding: string
      /** The commands that share it with a command they can be active together with, in table order. */
      commands: CommandId[]
      /** The one that runs where they overlap. */
      winner: CommandId
      /** The others that something above beats. */
      losers: CommandId[]
    }
  | {
      kind: 'reserved'
      binding: string
      command: CommandId
      reason: string
      hard: boolean
    }

/** Scopes can be active together when they are equal or either is global. */
export const scopesOverlap = (a: CommandDefinition, b: CommandDefinition): boolean =>
  a.scope === b.scope || a.scope === 'global' || b.scope === 'global'

/** Scoped beats global; otherwise the earlier one in the table. */
export const beats = (a: CommandDefinition, b: CommandDefinition): boolean => {
  if ((a.scope === 'global') !== (b.scope === 'global')) return a.scope !== 'global'
  return COMMANDS.indexOf(a) < COMMANDS.indexOf(b)
}

/** Every clash between commands, and every use of a reserved chord, under these overrides. Fixed commands are not checked. */
export function findConflicts(overrides: ShortcutOverrides, platform: string): Conflict[] {
  const conflicts: Conflict[] = []
  const byBinding = new Map<string, CommandDefinition[]>()
  for (const command of COMMANDS) {
    if (command.fixed) continue
    const binding = bindingFor(command.id, overrides, platform)
    const resolved = binding === null ? null : resolveBinding(binding, platform)
    if (resolved === null) continue
    const sharing = byBinding.get(resolved)
    if (sharing) sharing.push(command)
    else byBinding.set(resolved, [command])
  }
  for (const [binding, commands] of byBinding) {
    const overlapping = commands.filter((command) => commands.some((other) => other !== command && scopesOverlap(command, other)))
    if (overlapping.length > 1) {
      const losers = overlapping.filter((command) =>
        overlapping.some((other) => other !== command && scopesOverlap(command, other) && beats(other, command))
      )
      const winner = overlapping.reduce((best, command) => (beats(command, best) ? command : best))
      conflicts.push({
        kind: 'command',
        binding,
        commands: overlapping.map((command) => command.id),
        winner: winner.id,
        losers: losers.map((command) => command.id)
      })
    }
    for (const command of commands) {
      for (const entry of reservedMatches(binding, platform, command.id)) {
        conflicts.push({ kind: 'reserved', binding, command: command.id, reason: entry.reason, hard: entry.hard })
      }
    }
  }
  return conflicts
}

/**
 * Cleans stored overrides: keeps only known, non-fixed commands whose value is a parseable binding or
 * `null`, drops hard-reserved chords and entries equal to the default (resolved for the platform),
 * and spells the rest canonically. A bad entry is dropped on its own.
 */
export function normalizeShortcuts(raw: unknown, platform: string): ShortcutOverrides {
  const result: ShortcutOverrides = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [id, value] of Object.entries(raw)) {
    if (!isCommandId(id) || getCommand(id).fixed) continue
    if (value === null) {
      result[id] = null
      continue
    }
    if (typeof value !== 'string') continue
    const parsed = parseBinding(value)
    if (!parsed) continue
    if (reservedMatches(value, platform, id).some((entry) => entry.hard)) continue
    if (resolveBinding(value, platform) === resolveBinding(defaultBindingFor(id, platform), platform)) continue
    result[id] = serializeBinding(parsed)
  }
  return result
}
