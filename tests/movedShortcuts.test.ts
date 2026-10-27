import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_COMMANDS } from '../src/main/menu/menuTemplate'
import { eligibleCommands } from '../src/renderer/commands/paletteItems'
import {
  pushOverlay,
  registerCommand,
  useCommandRegistry
} from '../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../src/renderer/commands/useCommandShortcuts'
import { workflowLocalKey, type WorkflowKeyEvent } from '../src/renderer/components/workflows/editorKeys'
import { SURFACE_CHOICES } from '../src/renderer/lib/surfaces'
import { useAppStore } from '../src/renderer/stores/appStore'
import {
  COMMANDS,
  getCommand,
  normalizeShortcuts,
  resolveCommand,
  type CommandContext,
  type CommandId,
  type KeyInput,
  type ShortcutOverrides
} from '../src/shared/commands'

/**
 * The shortcuts that used to be their own `keydown` listeners (the surface letters, the model picker's
 * Ctrl/Cmd+1-5, the workflow editor's save, duplicate and delete) are registry commands now.
 */

const SURFACES: Array<[string, CommandId]> = [
  ['B', 'surface.browser'],
  ['T', 'surface.terminal'],
  ['F', 'surface.files'],
  ['D', 'surface.git'],
  ['R', 'surface.review']
]
const MODEL_SLOTS: CommandId[] = ['model.pick1', 'model.pick2', 'model.pick3', 'model.pick4', 'model.pick5']
const WORKFLOW_COMMANDS: CommandId[] = ['workflow.save', 'workflow.duplicate', 'workflow.delete']
const MOVED: CommandId[] = [...SURFACES.map(([, id]) => id), ...MODEL_SLOTS, ...WORKFLOW_COMMANDS]

function press(spec: string): KeyInput {
  const parts = spec.split('+')
  const name = parts.pop()!
  const named = ['Delete', 'Backspace', 'Enter', 'Tab']
  const letter = /^[A-Za-z]$/.test(name)
  return {
    key: named.includes(name) ? name : letter ? name.toLowerCase() : name,
    code: named.includes(name) ? name : letter ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : '',
    ctrlKey: parts.includes('Ctrl'),
    metaKey: parts.includes('Meta'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift')
  }
}

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  platform: 'win32',
  inTextInput: false,
  inTerminal: false,
  overlay: null,
  threadOpen: true,
  runActive: false,
  mainAreaOpen: true,
  projectsMode: true,
  ...over
})

const resolve = (spec: string, ctx: CommandContext = context(), overrides: ShortcutOverrides = {}) =>
  resolveCommand(press(spec), overrides, ctx, () => true)

describe('each moved shortcut keeps its old default', () => {
  it('opens a surface from its letter in the empty main area, outside text fields', () => {
    for (const [letter, id] of SURFACES) {
      expect(resolve(letter)).toBe(id)
      expect(resolve(letter, context({ platform: 'darwin' }))).toBe(id)
      expect(resolve(letter, context({ inTextInput: true }))).toBeNull()
      expect(resolve(letter, context({ mainAreaOpen: false }))).toBeNull()
      expect(resolve(letter, context({ projectsMode: false }))).toBeNull()
      // A letter with a modifier was never a surface shortcut.
      expect(resolve(`Ctrl+${letter}`)).not.toBe(id)
    }
    expect(SURFACE_CHOICES.map((choice) => choice.commandId)).toEqual(SURFACES.map(([, id]) => id))
  })

  it('picks the nth model with Ctrl+n (Cmd+n on macOS) while the picker is open', () => {
    MODEL_SLOTS.forEach((id, index) => {
      const n = index + 1
      expect(resolve(`Ctrl+${n}`, context({ overlay: 'model-picker' }))).toBe(id)
      expect(resolve(`Meta+${n}`, context({ overlay: 'model-picker', platform: 'darwin' }))).toBe(id)
      // The picker was the only place these keys did anything.
      expect(resolve(`Ctrl+${n}`)).toBeNull()
    })
    expect(resolve('Ctrl+6', context({ overlay: 'model-picker' }))).toBeNull()
    expect(resolve('Ctrl+Shift+1', context({ overlay: 'model-picker' }))).toBeNull()
  })

  it('saves, duplicates and deletes in the workflow editor', () => {
    expect(resolve('Ctrl+S')).toBe('workflow.save')
    expect(resolve('Meta+S', context({ platform: 'darwin' }))).toBe('workflow.save')
    expect(resolve('Ctrl+D')).toBe('workflow.duplicate')
    expect(resolve('Meta+D', context({ platform: 'darwin' }))).toBe('workflow.duplicate')
    expect(resolve('Delete')).toBe('workflow.delete')
    // Save still works with a field focused; duplicate and delete leave the field its own keys.
    expect(resolve('Ctrl+S', context({ inTextInput: true }))).toBe('workflow.save')
    expect(resolve('Ctrl+D', context({ inTextInput: true }))).toBeNull()
    expect(resolve('Delete', context({ inTextInput: true }))).toBeNull()
  })

  it('stands down for an open dialog', () => {
    for (const spec of ['B', 'Ctrl+S', 'Ctrl+D', 'Delete', 'Ctrl+1']) {
      expect(resolve(spec, context({ overlay: 'modal' }))).toBeNull()
    }
  })
})

describe('each moved shortcut can be rebound and is listed', () => {
  it('follows an override and drops the old chord, and an unbind', () => {
    const overrides: ShortcutOverrides = {
      'surface.browser': 'X',
      'surface.review': 'CommandOrControl+Shift+R',
      'model.pick1': 'CommandOrControl+9',
      'workflow.save': 'CommandOrControl+Shift+S',
      'workflow.delete': null
    }
    expect(resolve('X', context(), overrides)).toBe('surface.browser')
    expect(resolve('B', context(), overrides)).toBeNull()
    expect(resolve('Ctrl+Shift+S', context(), overrides)).toBe('workflow.save')
    expect(resolve('Ctrl+S', context(), overrides)).toBeNull()
    expect(resolve('Ctrl+9', context({ overlay: 'model-picker' }), overrides)).toBe('model.pick1')
    expect(resolve('Ctrl+1', context({ overlay: 'model-picker' }), overrides)).toBeNull()
    expect(resolve('Delete', context(), overrides)).toBeNull()
  })

  it('is saved as an override like any other command', () => {
    const overrides = Object.fromEntries(MOVED.map((id) => [id, null]))
    expect(normalizeShortcuts(overrides, 'win32')).toEqual(overrides)
    expect(normalizeShortcuts({ 'surface.review': 'Q' }, 'win32')).toEqual({ 'surface.review': 'Q' })
  })

  it('has a row in the Shortcuts section: a command that is not fixed, with its scope', () => {
    for (const id of MOVED) expect(getCommand(id).fixed).toBeUndefined()
    expect(SURFACES.map(([, id]) => getCommand(id).scope)).toEqual(Array(SURFACES.length).fill('surface-picker'))
    expect(MODEL_SLOTS.map((id) => getCommand(id).scope)).toEqual(Array(MODEL_SLOTS.length).fill('model-picker'))
    expect(WORKFLOW_COMMANDS.map((id) => getCommand(id).scope)).toEqual(Array(WORKFLOW_COMMANDS.length).fill('workflow-editor'))
    expect(COMMANDS.filter((command) => command.fixed).map((command) => command.id)).toEqual([
      'workflow.undo',
      'workflow.redo',
      'editor.save',
      'git.commit'
    ])
  })

  it('shows in the palette while its surface is mounted, and nowhere else', () => {
    const palette = context()
    const listed = (registered: CommandId[], ctx = palette) =>
      eligibleCommands(ctx, (id) => registered.includes(id)).map((item) => (item.kind === 'command' ? item.id : null))
    expect(listed(MOVED.filter((id) => !MODEL_SLOTS.includes(id)))).toEqual(
      MOVED.filter((id) => !MODEL_SLOTS.includes(id))
    )
    // Nothing is listed for a surface that is not mounted, or while the main area is closed.
    expect(listed([])).toEqual([])
    expect(listed(SURFACES.map(([, id]) => id), context({ mainAreaOpen: false }))).toEqual([])
    // The picker owns the keyboard while open, so its slots are never palette rows.
    expect(listed(MODEL_SLOTS)).toEqual([])
  })

  it('keeps scoped commands out of the application menu, which lists global ones', () => {
    for (const id of Object.values(MENU_COMMANDS).flat()) expect(getCommand(id).scope).toBe('global')
  })
})

describe('the registry is the only handler', () => {
  const globals = globalThis as { window?: unknown; document?: unknown }
  const original = { window: globals.window, document: globals.document }

  function stubWindow() {
    const win = new EventTarget() as EventTarget & { mousse: { platform: string } }
    win.mousse = { platform: 'win32' }
    const doc = new EventTarget() as EventTarget & { activeElement: unknown }
    doc.activeElement = { closest: () => null }
    globals.window = win
    globals.document = doc
    return win
  }

  function keydown(win: EventTarget, init: Partial<KeyInput> & { key: string }) {
    const event = Object.assign(
      new Event('keydown', { cancelable: true }),
      { code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, keyCode: 0 },
      init
    )
    win.dispatchEvent(event)
    return event
  }

  beforeEach(() => {
    useCommandRegistry.setState({ handlers: new Map(), recording: false, overlays: [] })
    useAppStore.setState({
      shortcuts: {},
      activeThreadId: 'thread-1',
      turnStates: {},
      mainAreaOpen: true,
      sidebarMode: 'projects',
      appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' }
    })
  })

  afterEach(() => {
    globals.window = original.window
    globals.document = original.document
  })

  it('runs each moved shortcut once from the one dispatcher, and consumes the key', () => {
    const win = stubWindow()
    attachCommandShortcuts(win as never)
    const browser = vi.fn()
    const pick = vi.fn()
    const save = vi.fn()
    registerCommand('surface.browser', { run: browser })
    registerCommand('model.pick2', { run: pick })
    registerCommand('workflow.save', { run: save })

    const b = keydown(win, { key: 'b', code: 'KeyB' })
    expect(browser).toHaveBeenCalledTimes(1)
    expect(b.defaultPrevented).toBe(true)

    const s = keydown(win, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(s.defaultPrevented).toBe(true)

    // The picker's slot answers only while the picker is open.
    keydown(win, { key: '2', code: 'Digit2', ctrlKey: true })
    expect(pick).not.toHaveBeenCalled()
    const pop = pushOverlay('model-picker')
    keydown(win, { key: '2', code: 'Digit2', ctrlKey: true })
    pop()
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('runs a rebound shortcut under its new chord only', () => {
    const win = stubWindow()
    attachCommandShortcuts(win as never)
    useAppStore.setState({ shortcuts: { 'surface.terminal': 'X' } })
    const terminal = vi.fn()
    registerCommand('surface.terminal', { run: terminal })

    keydown(win, { key: 't', code: 'KeyT' })
    expect(terminal).not.toHaveBeenCalled()
    keydown(win, { key: 'x', code: 'KeyX' })
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it('leaves the workflow editor with only the keys that cannot be rebound', () => {
    const event = (init: Partial<WorkflowKeyEvent> & { key: string }): WorkflowKeyEvent => ({
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      target: null,
      ...init
    })
    const state = { hasSelection: true, canvasView: true }
    // Save, duplicate and Delete belong to the registry; a second handler here would run them twice.
    expect(workflowLocalKey(event({ key: 's', ctrlKey: true }), state)).toBeNull()
    expect(workflowLocalKey(event({ key: 's', metaKey: true }), state)).toBeNull()
    expect(workflowLocalKey(event({ key: 'd', ctrlKey: true }), state)).toBeNull()
    expect(workflowLocalKey(event({ key: 'Delete' }), state)).toBeNull()
    // What stays local.
    expect(workflowLocalKey(event({ key: 'z', ctrlKey: true }), state)).toEqual({ type: 'undo' })
    expect(workflowLocalKey(event({ key: 'Z', metaKey: true, shiftKey: true }), state)).toEqual({ type: 'redo' })
    expect(workflowLocalKey(event({ key: 'y', ctrlKey: true }), state)).toEqual({ type: 'redo' })
    expect(workflowLocalKey(event({ key: 'Backspace' }), state)).toEqual({ type: 'delete' })
    expect(workflowLocalKey(event({ key: 'ArrowLeft', shiftKey: true }), state)).toEqual({ type: 'nudge', dx: -16, dy: 0 })
    expect(workflowLocalKey(event({ key: 'ArrowDown', shiftKey: true }), state)).toEqual({ type: 'nudge', dx: 0, dy: 16 })
    // Nothing selected, or the source view: no delete or nudge.
    expect(workflowLocalKey(event({ key: 'Backspace' }), { hasSelection: false, canvasView: true })).toBeNull()
    expect(workflowLocalKey(event({ key: 'Backspace' }), { hasSelection: true, canvasView: false })).toBeNull()
    expect(workflowLocalKey(event({ key: 'ArrowUp', shiftKey: true }), { hasSelection: false, canvasView: true })).toBeNull()
  })

  it('keeps undo, redo and Backspace for a focused text field', () => {
    const state = { hasSelection: true, canvasView: true }
    const field = { closest: (selector: string) => (selector.includes('textarea') ? {} : null) }
    expect(workflowLocalKey({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, target: field }, state)).toBeNull()
    expect(workflowLocalKey({ key: 'y', ctrlKey: true, metaKey: false, shiftKey: false, target: field }, state)).toBeNull()
    expect(workflowLocalKey({ key: 'Backspace', ctrlKey: false, metaKey: false, shiftKey: false, target: field }, state)).toBeNull()
    const canvas = { closest: () => null }
    expect(workflowLocalKey({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, target: canvas }, state)).toEqual({ type: 'undo' })
  })

  it('has no ad-hoc listener left for the moved keys', () => {
    const source = (path: string) => readFileSync(new URL(`../src/renderer/components/${path}`, import.meta.url), 'utf8')
    expect(source('OpenSurfaceMenu.tsx')).not.toMatch(/addEventListener\(\s*'keydown'/)
    // The picker's remaining keydown handler is for arrows and Enter.
    expect(source('ModelFamilyMenu.tsx')).not.toMatch(/event\.ctrlKey \|\| event\.metaKey/)
    const editor = source('workflows/WorkflowEditor.tsx')
    expect(editor).not.toMatch(/key\.toLowerCase\(\) === '[sd]'/)
    expect(editor).not.toContain("event.key === 'Delete'")
  })
})
