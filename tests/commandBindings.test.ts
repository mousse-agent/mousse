import { describe, expect, it } from 'vitest'
import { interpretRecorderKey } from '../src/renderer/commands/shortcutEditing'
import {
  COMMANDS,
  bindingFromKey,
  defaultBindingFor,
  findConflicts,
  formatBinding,
  normalizeShortcuts,
  parseBinding,
  resolveBinding,
  resolveBindings,
  resolveCommand,
  serializeBinding,
  type CommandContext,
  type CommandId,
  type KeyInput,
  type ShortcutOverrides
} from '../src/shared/commands'

const key = (init: Partial<KeyInput> & { key: string }): KeyInput => ({
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init
})

/** A key press from a short spec such as `Ctrl+Shift+K` on a US layout. `Meta` is Cmd. */
function press(spec: string): KeyInput {
  const parts = spec.split('+')
  const name = parts.pop()!
  const shiftKey = parts.includes('Shift')
  const namedKeys = ['Tab', 'Backspace', 'Delete', 'Enter']
  const isLetter = /^[A-Za-z]$/.test(name)
  return {
    key: namedKeys.includes(name) ? name : isLetter ? (shiftKey ? name.toUpperCase() : name.toLowerCase()) : name,
    code: namedKeys.includes(name) ? name : isLetter ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : '',
    ctrlKey: parts.includes('Ctrl'),
    metaKey: parts.includes('Meta'),
    altKey: parts.includes('Alt'),
    shiftKey
  }
}

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  platform: 'win32',
  inTextInput: false,
  inTerminal: false,
  overlay: null,
  threadOpen: true,
  runActive: true,
  mainAreaOpen: true,
  projectsMode: true,
  ...over
})

const everythingRegistered = (): boolean => true

const resolve = (spec: string, ctx: CommandContext = context(), overrides: ShortcutOverrides = {}) =>
  resolveCommand(press(spec), overrides, ctx, everythingRegistered)

describe('parseBinding', () => {
  it('reads modifiers and one key', () => {
    expect(parseBinding('CommandOrControl+Shift+[')).toEqual({ mod: true, ctrl: false, cmd: false, alt: false, shift: true, key: '[' })
    expect(parseBinding('CommandOrControl+Plus')?.key).toBe('Plus')
    expect(parseBinding('CommandOrControl+=')?.key).toBe('=')
    expect(parseBinding('Ctrl+Tab')).toMatchObject({ ctrl: true, key: 'Tab' })
    expect(parseBinding('B')).toMatchObject({ mod: false, ctrl: false, key: 'B' })
    expect(parseBinding('cmdorctrl+shift+k')).toMatchObject({ mod: true, shift: true, key: 'K' })
  })

  it('rejects text that is not exactly modifiers plus one key', () => {
    expect(parseBinding('CommandOrControl+')).toBeNull()
    expect(parseBinding('Ctrl++')).toBeNull()
    expect(parseBinding('Ctrl++K')).toBeNull()
    expect(parseBinding('Ctrl+K+L')).toBeNull()
    expect(parseBinding('Super+K')).toBeNull()
    expect(parseBinding('Meta+K')).toBeNull()
    expect(parseBinding('Ctrl')).toBeNull()
    expect(parseBinding('Escape')).toBeNull()
    expect(parseBinding('')).toBeNull()
  })

  it('serialises to a form that parses back to the same binding', () => {
    for (const text of ['CommandOrControl+Shift+K', 'Ctrl+Alt+Tab', 'Cmd+Shift+Z', 'F5', 'CommandOrControl+Plus']) {
      expect(serializeBinding(parseBinding(text)!)).toBe(text)
    }
    expect(serializeBinding(parseBinding('shift+commandorcontrol+k')!)).toBe('CommandOrControl+Shift+K')
  })
})

describe('formatBinding and resolveBinding', () => {
  it('shows Cmd symbols on macOS and Ctrl elsewhere from one string', () => {
    expect(formatBinding('CommandOrControl+Shift+K', 'darwin')).toBe('⌘⇧K')
    expect(formatBinding('CommandOrControl+Shift+K', 'win32')).toBe('Ctrl+Shift+K')
    expect(formatBinding('CommandOrControl+Shift+K', 'linux')).toBe('Ctrl+Shift+K')
    expect(formatBinding('Ctrl+Tab', 'darwin')).toBe('⌃⇥')
    expect(formatBinding('Ctrl+Tab', 'win32')).toBe('Ctrl+Tab')
    expect(formatBinding('CommandOrControl+Shift+Backspace', 'darwin')).toBe('⌘⇧⌫')
    expect(formatBinding('Ctrl+Alt+CommandOrControl+Shift+K', 'darwin')).toBe('⌃⌥⌘⇧K')
    expect(formatBinding('CommandOrControl+Plus', 'win32')).toBe('Ctrl++')
    expect(formatBinding('B', 'darwin')).toBe('B')
    expect(formatBinding('nonsense+', 'win32')).toBe('')
  })

  it('resolves CommandOrControl per platform', () => {
    expect(resolveBinding('CommandOrControl+K', 'darwin')).toBe('Cmd+K')
    expect(resolveBinding('CommandOrControl+K', 'win32')).toBe('Ctrl+K')
    expect(resolveBinding('Ctrl+Tab', 'darwin')).toBe('Ctrl+Tab')
    expect(resolveBinding('CommandOrControl+Tab', 'win32')).toBe(resolveBinding('Ctrl+Tab', 'win32'))
    expect(resolveBinding('CommandOrControl+Tab', 'darwin')).not.toBe(resolveBinding('Ctrl+Tab', 'darwin'))
    expect(resolveBinding('Super+K', 'win32')).toBeNull()
  })

  it('picks the per-platform default where they differ', () => {
    expect(defaultBindingFor('workflow.redo', 'darwin')).toBe('Cmd+Shift+Z')
    expect(defaultBindingFor('workflow.redo', 'win32')).toBe('Ctrl+Y')
    expect(defaultBindingFor('thread.new', 'darwin')).toBe('CommandOrControl+N')
  })
})

describe('bindingFromKey layouts', () => {
  it('US: Ctrl and Shift chords', () => {
    expect(bindingFromKey(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), 'win32')).toBe('CommandOrControl+Shift+K')
    expect(bindingFromKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), 'win32')).toBe('CommandOrControl+Shift+Tab')
    expect(bindingFromKey(key({ key: 'b', code: 'KeyB' }), 'win32')).toBe('B')
    expect(bindingFromKey(key({ key: '=', code: 'Equal', ctrlKey: true }), 'win32')).toBe('CommandOrControl+=')
    expect(bindingFromKey(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), 'win32')).toBe('CommandOrControl+Shift+=')
    expect(bindingFromKey(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), 'win32')).toBe('CommandOrControl+Shift+1')
    expect(bindingFromKey(key({ key: ' ', code: 'Space', ctrlKey: true }), 'win32')).toBe('CommandOrControl+Space')
    expect(bindingFromKey(key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }), 'win32')).toBe('Alt+Up')
    expect(bindingFromKey(key({ key: 'F5', code: 'F5' }), 'win32')).toBe('F5')
    expect(bindingFromKey(key({ key: '5', code: 'Numpad5', ctrlKey: true }), 'win32')).toBe('CommandOrControl+5')
  })

  it('macOS: Cmd is CommandOrControl and Ctrl stays literal', () => {
    expect(bindingFromKey(key({ key: 'k', code: 'KeyK', metaKey: true }), 'darwin')).toBe('CommandOrControl+K')
    expect(bindingFromKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'darwin')).toBe('Ctrl+Tab')
    expect(bindingFromKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: true }), 'darwin')).toBe('CommandOrControl+Ctrl+Tab')
    // Option types a symbol; the physical key names the chord.
    expect(bindingFromKey(key({ key: '˚', code: 'KeyK', altKey: true }), 'darwin')).toBe('Alt+K')
  })

  it('records Ctrl as CommandOrControl on Windows and Linux, so Ctrl+Tab equals the default there only', () => {
    const recorded = bindingFromKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'win32')!
    expect(recorded).toBe('CommandOrControl+Tab')
    expect(resolveBinding(recorded, 'win32')).toBe(resolveBinding(defaultBindingFor('thread.next', 'win32'), 'win32'))
    expect(bindingFromKey(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'linux')).toBe('CommandOrControl+Tab')
  })

  it('ignores the Super key outside macOS', () => {
    expect(bindingFromKey(key({ key: 'k', code: 'KeyK', metaKey: true }), 'win32')).toBeNull()
    expect(bindingFromKey(key({ key: 'k', code: 'KeyK', metaKey: true }), 'linux')).toBeNull()
  })

  it('German: + on BracketRight is Shift+=, not ], and AltGr chords are not shortcuts', () => {
    const plus = bindingFromKey(key({ key: '+', code: 'BracketRight', ctrlKey: true }), 'win32')!
    expect(plus).toBe('CommandOrControl+Shift+=')
    expect(resolveBinding(plus, 'win32')).not.toBe(resolveBinding('CommandOrControl+]', 'win32'))
    // AltGr+Q types @ and reports Ctrl+Alt on Windows.
    expect(bindingFromKey(key({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), 'win32')).toBeNull()
    expect(bindingFromKey(key({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }), 'win32')).toBeNull()
    // A real Ctrl+Alt letter chord still counts.
    expect(bindingFromKey(key({ key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true }), 'win32')).toBe('CommandOrControl+Alt+Q')
    // The apostrophe-like key records the character the layout types.
    expect(bindingFromKey(key({ key: '#', code: 'Backslash', ctrlKey: true }), 'win32')).toBe('CommandOrControl+#')
  })

  it('French AZERTY: digits match by physical key, letters fall back when the layout types no A-Z', () => {
    const one = bindingFromKey(key({ key: '&', code: 'Digit1', ctrlKey: true }), 'win32')!
    expect(one).toBe('CommandOrControl+1')
    expect(resolveBinding(one, 'win32')).toBe(resolveBinding(defaultBindingFor('model.pick1', 'win32'), 'win32'))
    expect(bindingFromKey(key({ key: 'Æ', code: 'KeyQ' }), 'darwin')).toBe('Q')
  })

  it('Dvorak: letters follow the layout, not the physical key', () => {
    expect(bindingFromKey(key({ key: 'j', code: 'KeyC', ctrlKey: true }), 'win32')).toBe('CommandOrControl+J')
  })

  it('Cyrillic: letters fall back to the physical key', () => {
    expect(bindingFromKey(key({ key: 'я', code: 'KeyZ', ctrlKey: true }), 'win32')).toBe('CommandOrControl+Z')
  })

  it('gives null for modifiers alone, Escape, composition and unsupported keys', () => {
    for (const name of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Escape', 'Dead', 'Process', 'Unidentified', 'MediaPlayPause']) {
      expect(bindingFromKey(key({ key: name, code: name }), 'win32')).toBeNull()
    }
    expect(bindingFromKey(key({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }), 'win32')).toBeNull()
    expect(bindingFromKey(key({ key: '', code: '' }), 'win32')).toBeNull()
  })

  it('only gives strings that parse back', () => {
    const samples = [
      key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true, altKey: true }),
      key({ key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true }),
      key({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
      key({ key: '`', code: 'Backquote', ctrlKey: true }),
      key({ key: 'Delete', code: 'Delete' })
    ]
    for (const sample of samples) {
      const binding = bindingFromKey(sample, 'win32')
      expect(binding).not.toBeNull()
      expect(parseBinding(binding!)).not.toBeNull()
    }
  })
})

describe('resolveBindings', () => {
  it('maps resolved bindings to commands in table order and leaves out fixed commands', () => {
    const win = resolveBindings({}, 'win32')
    expect(win.get('Ctrl+K')).toEqual(['palette.open'])
    expect(win.get('Ctrl+Tab')).toEqual(['thread.next'])
    expect(win.get('B')).toEqual(['surface.browser'])
    expect(win.get('Ctrl+S')).toEqual(['workflow.save'])
    expect(win.has('Ctrl+Z')).toBe(false)
    expect(win.has('Ctrl+Enter')).toBe(false)
    expect(resolveBindings({}, 'darwin').get('Cmd+K')).toEqual(['palette.open'])
    expect(resolveBindings({}, 'darwin').get('Ctrl+Tab')).toEqual(['thread.next'])
  })

  it('applies overrides: a replacement, an unbind, and a shared chord', () => {
    const bindings = resolveBindings(
      { 'thread.new': 'CommandOrControl+Shift+X', 'palette.open': null, 'thread.next': 'CommandOrControl+J' },
      'win32'
    )
    expect(bindings.get('Ctrl+Shift+X')).toEqual(['thread.new'])
    expect(bindings.has('Ctrl+N')).toBe(false)
    expect(bindings.has('Ctrl+K')).toBe(false)
    expect(bindings.get('Ctrl+J')).toEqual(['thread.next', 'terminal.open'])
  })
})

describe('resolveCommand', () => {
  it('lets Stop run and Focus composer fire in the composer', () => {
    const inComposer = context({ inTextInput: true })
    expect(resolve('Ctrl+Shift+Backspace', inComposer)).toBe('run.stop')
    expect(resolve('Ctrl+Shift+M', inComposer)).toBe('composer.focus')
  })

  it('lets New thread fire in the composer but not a bare surface letter', () => {
    const inComposer = context({ inTextInput: true })
    expect(resolve('Ctrl+N', inComposer)).toBe('thread.new')
    expect(resolve('B', inComposer)).toBeNull()
    expect(resolve('B')).toBe('surface.browser')
    expect(resolve('B', context({ mainAreaOpen: false }))).toBeNull()
    expect(resolve('B', context({ projectsMode: false }))).toBeNull()
  })

  it('allows only Stop run and Focus composer in a terminal', () => {
    const inTerminal = context({ inTerminal: true, inTextInput: true })
    expect(resolve('Ctrl+Shift+Backspace', inTerminal)).toBe('run.stop')
    expect(resolve('Ctrl+Shift+M', inTerminal)).toBe('composer.focus')
    for (const spec of ['Ctrl+N', 'Ctrl+K', 'Ctrl+J', 'Ctrl+Tab', 'Ctrl+Shift+D']) {
      expect(resolve(spec, inTerminal)).toBeNull()
    }
  })

  it('gives the topmost overlay the keyboard', () => {
    const picker = context({ overlay: 'model-picker' })
    expect(resolve('Ctrl+1', picker)).toBe('model.pick1')
    expect(resolve('Ctrl+5', picker)).toBe('model.pick5')
    expect(resolve('Ctrl+N', picker)).toBeNull()
    expect(resolve('Ctrl+K', picker)).toBeNull()
    expect(resolve('Ctrl+Shift+Backspace', picker)).toBe('run.stop')
    // Without the picker its commands do not exist.
    expect(resolve('Ctrl+1')).toBeNull()

    const modal = context({ overlay: 'modal' })
    expect(resolve('Ctrl+Shift+Backspace', modal)).toBe('run.stop')
    expect(resolve('Ctrl+1', modal)).toBeNull()
    expect(resolve('Ctrl+K', modal)).toBeNull()
    expect(resolve('Ctrl+N', modal)).toBeNull()

    const palette = context({ overlay: 'palette' })
    expect(resolve('Ctrl+K', palette)).toBe('palette.open')
    expect(resolve('Ctrl+Shift+Backspace', palette)).toBe('run.stop')
    expect(resolve('Ctrl+N', palette)).toBeNull()

    const search = context({ overlay: 'thread-search' })
    expect(resolve('Ctrl+K', search)).toBeNull()
    expect(resolve('Ctrl+Shift+Backspace', search)).toBe('run.stop')
  })

  it('applies each command\'s own condition', () => {
    expect(resolve('Ctrl+Shift+Backspace', context({ runActive: false }))).toBeNull()
    expect(resolve('Ctrl+Shift+D', context({ threadOpen: false }))).toBeNull()
    expect(resolve('Ctrl+Shift+M', context({ threadOpen: false }))).toBeNull()
    expect(resolve('Ctrl+Shift+D')).toBe('sideCard.toggle')
  })

  it('skips commands without a handler', () => {
    const noNewThread = (id: CommandId): boolean => id !== 'thread.new'
    expect(resolveCommand(press('Ctrl+N'), {}, context(), noNewThread)).toBeNull()
    expect(resolveCommand(press('Ctrl+K'), {}, context(), noNewThread)).toBe('palette.open')
  })

  it('prefers a scoped command over a global one, then table order', () => {
    const overrides: ShortcutOverrides = { 'thread.new': 'B' }
    expect(resolve('B', context(), overrides)).toBe('surface.browser')
    // In a text field the surface letter stands down and the global command takes the key.
    expect(resolve('B', context({ inTextInput: true }), overrides)).toBe('thread.new')
    expect(resolve('Ctrl+N', context(), { 'thread.next': 'CommandOrControl+N' })).toBe('thread.new')
  })

  it('never confuses Mod+K with a bare K', () => {
    const overrides: ShortcutOverrides = { 'surface.git': 'K' }
    expect(resolve('Ctrl+K', context(), overrides)).toBe('palette.open')
    expect(resolve('K', context(), overrides)).toBe('surface.git')
    expect(findConflicts(overrides, 'win32')).toEqual([])
  })

  it('does not run fixed commands', () => {
    expect(resolve('Ctrl+Enter')).toBeNull()
    expect(resolve('Ctrl+Z')).toBeNull()
  })

  it('follows overrides and unbinding, resolved per platform', () => {
    expect(resolve('Ctrl+N', context(), { 'thread.new': null })).toBeNull()
    const moved: ShortcutOverrides = { 'thread.new': 'CommandOrControl+Shift+X' }
    expect(resolve('Ctrl+Shift+X', context(), moved)).toBe('thread.new')
    expect(resolve('Ctrl+N', context(), moved)).toBeNull()
    expect(resolveCommand(press('Meta+K'), {}, context({ platform: 'darwin' }), everythingRegistered)).toBe('palette.open')
    expect(resolveCommand(press('Ctrl+K'), {}, context({ platform: 'darwin' }), everythingRegistered)).toBeNull()
    expect(resolveCommand(press('Ctrl+Tab'), {}, context({ platform: 'darwin' }), everythingRegistered)).toBe('thread.next')
  })

  it('ignores a composing key', () => {
    expect(resolveCommand({ ...press('Ctrl+N'), isComposing: true }, {}, context(), everythingRegistered)).toBeNull()
  })
})

describe('findConflicts', () => {
  it('finds none among the defaults on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) expect(findConflicts({}, platform)).toEqual([])
  })

  it('names the winner when two global commands share a chord', () => {
    expect(findConflicts({ 'thread.next': 'CommandOrControl+N' }, 'win32')).toEqual([
      { kind: 'command', binding: 'Ctrl+N', commands: ['thread.new', 'thread.next'], winner: 'thread.new', losers: ['thread.next'] }
    ])
  })

  it('lets a scoped command beat a global one', () => {
    expect(findConflicts({ 'thread.new': 'B' }, 'win32')).toEqual([
      { kind: 'command', binding: 'B', commands: ['thread.new', 'surface.browser'], winner: 'surface.browser', losers: ['thread.new'] }
    ])
  })

  it('finds two commands of the same scope, and ignores scopes that are never active together', () => {
    expect(findConflicts({ 'surface.git': 'B' }, 'win32')).toEqual([
      { kind: 'command', binding: 'B', commands: ['surface.browser', 'surface.git'], winner: 'surface.browser', losers: ['surface.git'] }
    ])
    expect(findConflicts({ 'workflow.duplicate': 'B' }, 'win32')).toEqual([])
  })

  it('compares resolved bindings, so Ctrl is not Cmd on macOS', () => {
    expect(findConflicts({ 'thread.next': 'Ctrl+N' }, 'win32')).toHaveLength(1)
    expect(findConflicts({ 'thread.next': 'Ctrl+N' }, 'darwin')).toEqual([])
  })

  it('warns about a soft-reserved chord with its reason, and not for the command it is kept for', () => {
    const [conflict] = findConflicts({ 'thread.new': 'CommandOrControl+F' }, 'win32')
    expect(conflict).toMatchObject({ kind: 'reserved', command: 'thread.new', hard: false })
    expect(conflict!.kind === 'reserved' && conflict!.reason).toContain('chat.findInThread')
    expect(findConflicts({ 'thread.new': 'CommandOrControl+P' }, 'win32')[0]).toMatchObject({ kind: 'reserved', hard: false })
    expect(findConflicts({ 'thread.new': 'CommandOrControl+Shift+F' }, 'win32')[0]).toMatchObject({ kind: 'reserved', hard: false })
    expect(findConflicts({ 'thread.new': 'CommandOrControl+S' }, 'win32')).toEqual([
      expect.objectContaining({ kind: 'command', commands: ['thread.new', 'workflow.save'] }),
      expect.objectContaining({ kind: 'reserved', command: 'thread.new', hard: false })
    ])
    // Save workflow keeps Mod+S as its default without a warning.
    expect(findConflicts({}, 'win32').some((conflict) => conflict.kind === 'reserved')).toBe(false)
  })

  it('flags Edit, window and zoom chords as hard-reserved', () => {
    for (const chord of ['CommandOrControl+C', 'CommandOrControl+Shift+Z', 'CommandOrControl+W', 'CommandOrControl+Alt+H']) {
      expect(findConflicts({ 'thread.new': chord }, 'win32')[0]).toMatchObject({ kind: 'reserved', hard: true })
    }
    // The zoom family is a predicate over the keys zoomShortcuts.ts swallows, with any Shift or Alt.
    for (const chord of ['CommandOrControl+Shift+0', 'CommandOrControl+=', 'CommandOrControl+Plus', 'CommandOrControl+-', 'CommandOrControl+Alt+0', 'Ctrl+Shift+-']) {
      expect(findConflicts({ 'thread.new': chord }, 'darwin')[0]).toMatchObject({ kind: 'reserved', hard: true })
    }
    expect(findConflicts({ 'thread.new': 'Alt+0' }, 'win32')).toEqual([])
  })

  it('treats null as unbound', () => {
    expect(findConflicts({ 'thread.new': null, 'thread.next': 'CommandOrControl+N' }, 'win32')).toEqual([])
    expect(findConflicts({ 'thread.new': null, 'thread.next': null }, 'win32')).toEqual([])
  })
})

describe('normalizeShortcuts', () => {
  it('keeps only known, non-fixed commands with a parseable binding or null', () => {
    expect(
      normalizeShortcuts(
        {
          'thread.new': 'cmdorctrl+shift+x',
          'thread.next': null,
          'not.a.command': 'CommandOrControl+X',
          'run.stop': 'Super+K',
          'palette.open': 42,
          'terminal.open': '',
          'editor.save': 'CommandOrControl+Shift+X',
          'workflow.undo': 'CommandOrControl+Shift+X'
        },
        'win32'
      )
    ).toEqual({ 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null })
  })

  it('drops hard-reserved chords, including zoom variants, but keeps soft-reserved ones', () => {
    expect(
      normalizeShortcuts(
        {
          'thread.new': 'CommandOrControl+C',
          'thread.next': 'CommandOrControl+Shift+=',
          'palette.open': 'CommandOrControl+Alt+0',
          'terminal.open': 'CommandOrControl+F'
        },
        'win32'
      )
    ).toEqual({ 'terminal.open': 'CommandOrControl+F' })
  })

  it('drops entries equal to the default, resolved per platform', () => {
    expect(normalizeShortcuts({ 'thread.next': 'CommandOrControl+Tab', 'thread.new': 'CommandOrControl+N' }, 'win32')).toEqual({})
    // On macOS CommandOrControl+Tab is Cmd+Tab, which is not the Ctrl+Tab default.
    expect(normalizeShortcuts({ 'thread.next': 'CommandOrControl+Tab' }, 'darwin')).toEqual({ 'thread.next': 'CommandOrControl+Tab' })
    expect(normalizeShortcuts({ 'thread.next': 'Ctrl+Tab' }, 'darwin')).toEqual({})
  })

  it('is stable and tolerates input that is not a map', () => {
    const once = normalizeShortcuts({ 'thread.new': 'shift+commandorcontrol+x', 'thread.next': null }, 'linux')
    expect(normalizeShortcuts(once, 'linux')).toEqual(once)
    for (const raw of [undefined, null, 'x', 7, ['thread.new']]) expect(normalizeShortcuts(raw, 'win32')).toEqual({})
  })
})

describe('the command table', () => {
  it('has unique ids and parseable default bindings on every platform', () => {
    expect(new Set(COMMANDS.map((command) => command.id)).size).toBe(COMMANDS.length)
    for (const command of COMMANDS) {
      for (const platform of ['win32', 'darwin']) expect(parseBinding(defaultBindingFor(command.id, platform))).not.toBeNull()
    }
  })

  it('keeps the reserved ids for later features out of the table', () => {
    const ids = COMMANDS.map((command) => command.id as string)
    for (const id of ['chat.findInThread', 'files.quickOpen', 'files.textSearch']) expect(ids).not.toContain(id)
  })
})

describe('the Shortcuts recorder reading keys', () => {
  const record = (spec: string, platform = 'win32') => interpretRecorderKey(press(spec), platform)

  it('ignores a modifier pressed alone and keeps listening', () => {
    for (const name of ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']) {
      expect(interpretRecorderKey(key({ key: name, code: name, ctrlKey: name === 'Control' }), 'win32')).toEqual({ type: 'ignore' })
    }
  })

  it('cancels on Escape, with or without a modifier', () => {
    expect(interpretRecorderKey(key({ key: 'Escape', code: 'Escape' }), 'win32')).toEqual({ type: 'cancel' })
    expect(interpretRecorderKey(key({ key: 'Escape', code: 'Escape', ctrlKey: true }), 'win32')).toEqual({ type: 'cancel' })
  })

  it('unbinds on Backspace alone and records Backspace with a modifier', () => {
    expect(record('Backspace')).toEqual({ type: 'unbind' })
    expect(record('Ctrl+Shift+Backspace')).toEqual({ type: 'record', binding: 'CommandOrControl+Shift+Backspace' })
  })

  it('records Shift with a letter as Shift+letter', () => {
    expect(record('Ctrl+Shift+K')).toEqual({ type: 'record', binding: 'CommandOrControl+Shift+K' })
    expect(record('Shift+K')).toEqual({ type: 'record', binding: 'Shift+K' })
  })

  it('records the character a German layout types for the apostrophe key, and skips AltGr text', () => {
    expect(interpretRecorderKey(key({ key: '#', code: 'Backslash', ctrlKey: true }), 'win32')).toEqual({
      type: 'record',
      binding: 'CommandOrControl+#'
    })
    expect(interpretRecorderKey(key({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), 'win32')).toEqual({ type: 'ignore' })
  })

  it('emits CommandOrControl for Cmd on macOS and keeps Ctrl literal there', () => {
    expect(record('Meta+K', 'darwin')).toEqual({ type: 'record', binding: 'CommandOrControl+K' })
    expect(record('Ctrl+Tab', 'darwin')).toEqual({ type: 'record', binding: 'Ctrl+Tab' })
  })

  it('ignores a key typed during an IME composition', () => {
    expect(interpretRecorderKey(key({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }), 'win32')).toEqual({ type: 'ignore' })
  })
})
