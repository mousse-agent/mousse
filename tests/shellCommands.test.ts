import { describe, expect, it } from 'vitest'
import {
  bindingFor,
  formatBinding,
  normalizeShortcuts,
  resolveCommand,
  type CommandContext,
  type CommandId,
  type KeyInput
} from '../src/shared/commands'
import { shortcutTitle } from '../src/renderer/commands/commandRegistry'
import { resetPatch, shortcutGroups } from '../src/renderer/commands/shortcutEditing'
import { renamedThreadName } from '../src/renderer/components/ThreadRenameDialog'

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  platform: 'win32',
  inTextInput: false,
  inTerminal: false,
  overlay: null,
  threadOpen: true,
  runActive: false,
  mainAreaOpen: false,
  projectsMode: true,
  ...over
})

const key = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

const resolve = (input: KeyInput, ctx: CommandContext = context()): CommandId | null => resolveCommand(input, {}, ctx, () => true)

describe('shell commands', () => {
  it('toggles the sidebar with Ctrl+B (Cmd+B on macOS), also from the composer', () => {
    expect(resolve(key('b', 'KeyB', { ctrlKey: true }))).toBe('sidebar.toggle')
    expect(resolve(key('b', 'KeyB', { ctrlKey: true }), context({ inTextInput: true }))).toBe('sidebar.toggle')
    expect(resolve(key('b', 'KeyB', { metaKey: true }), context({ platform: 'darwin' }))).toBe('sidebar.toggle')
    // macOS text fields keep Ctrl+B (cursor back); a terminal keeps it (tmux, readline).
    expect(resolve(key('b', 'KeyB', { ctrlKey: true }), context({ platform: 'darwin' }))).toBeNull()
    expect(resolve(key('b', 'KeyB', { ctrlKey: true }), context({ inTerminal: true }))).toBeNull()
  })

  it('toggles the panel with Ctrl+Shift+B and opens settings with Ctrl+,', () => {
    expect(resolve(key('B', 'KeyB', { ctrlKey: true, shiftKey: true }))).toBe('mainArea.toggle')
    expect(resolve(key(',', 'Comma', { ctrlKey: true }))).toBe('settings.open')
    expect(resolve(key(',', 'Comma', { metaKey: true }), context({ platform: 'darwin' }))).toBe('settings.open')
    expect(formatBinding(bindingFor('settings.open', {}, 'darwin')!, 'darwin')).toBe('⌘,')
    expect(formatBinding(bindingFor('settings.open', {}, 'win32')!, 'win32')).toBe('Ctrl+,')
  })

  it('stands down for an open dialog', () => {
    expect(resolve(key('b', 'KeyB', { ctrlKey: true }), context({ overlay: 'modal' }))).toBeNull()
    expect(resolve(key(',', 'Comma', { ctrlKey: true }), context({ overlay: 'palette' }))).toBeNull()
  })
})

describe('commands that ship without a key', () => {
  const unbound: CommandId[] = ['project.open', 'automations.open', 'usage.open', 'thread.archive', 'thread.rename', 'thread.pin']

  it('have no binding until one is recorded', () => {
    for (const id of unbound) expect(bindingFor(id, {}, 'win32')).toBeNull()
    expect(bindingFor('project.open', { 'project.open': 'CommandOrControl+Shift+P' }, 'win32')).toBe('CommandOrControl+Shift+P')
  })

  it('drop an unbind, and reset to no override', () => {
    expect(normalizeShortcuts({ 'project.open': null }, 'win32')).toEqual({})
    expect(normalizeShortcuts({ 'project.open': 'Ctrl+Shift+P' }, 'win32')).toEqual({ 'project.open': 'Ctrl+Shift+P' })
    const overrides = { 'project.open': 'Ctrl+Shift+P' }
    expect(normalizeShortcuts({ ...overrides, ...resetPatch('project.open', overrides, 'win32') }, 'win32')).toEqual({})
  })

  it('are listed in the Shortcuts section as unbound, not as custom', () => {
    const rows = shortcutGroups('', {}, 'win32').flatMap((group) => group.rows)
    const row = rows.find((candidate) => candidate.command.id === 'project.open')
    expect(row).toMatchObject({ binding: null, label: '', custom: false })
    const recorded = shortcutGroups('', { 'project.open': 'Ctrl+Shift+P' }, 'win32').flatMap((group) => group.rows)
    expect(recorded.find((candidate) => candidate.command.id === 'project.open')?.custom).toBe(true)
  })
})

describe('shortcut tooltips', () => {
  it('names the key after the label, or shows the label alone', () => {
    expect(shortcutTitle('Hide sidebar', 'CommandOrControl+B', 'win32')).toBe('Hide sidebar · Ctrl+B')
    expect(shortcutTitle('Hide sidebar', 'CommandOrControl+B', 'darwin')).toBe('Hide sidebar · ⌘B')
    expect(shortcutTitle('Add project', null, 'win32')).toBe('Add project')
  })
})

describe('rename thread dialog', () => {
  it('saves a trimmed new name and nothing for a blank or unchanged one', () => {
    expect(renamedThreadName('  Fix tests  ', 'Old')).toBe('Fix tests')
    expect(renamedThreadName('   ', 'Old')).toBeNull()
    expect(renamedThreadName('Old ', 'Old')).toBeNull()
  })
})
