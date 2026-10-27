import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  proposeBinding,
  resetAllPatch,
  resetPatch,
  shadowedBy,
  shortcutGroups
} from '../src/renderer/commands/shortcutEditing'
import { COMMANDS, bindingFor, type ShortcutOverrides } from '../src/shared/commands'

const WIN = 'win32'
const MAC = 'darwin'

describe('proposeBinding: saving a recorded binding', () => {
  it('saves a free chord as a one-entry patch', () => {
    expect(proposeBinding('thread.new', 'CommandOrControl+Shift+X', {}, WIN)).toEqual({
      kind: 'save',
      patch: { 'thread.new': 'CommandOrControl+Shift+X' }
    })
  })

  it('does nothing when the command already has the chord', () => {
    expect(proposeBinding('thread.new', 'CommandOrControl+N', {}, WIN)).toEqual({ kind: 'unchanged' })
    // Compared after resolving: Ctrl+N on Windows is the default Mod+N.
    expect(proposeBinding('thread.new', 'Ctrl+N', {}, WIN)).toEqual({ kind: 'unchanged' })
    expect(proposeBinding('thread.new', null, { 'thread.new': null }, WIN)).toEqual({ kind: 'unchanged' })
  })

  it('unbinds with null', () => {
    expect(proposeBinding('thread.new', null, {}, WIN)).toEqual({ kind: 'save', patch: { 'thread.new': null } })
  })

  it('refuses a chord the Edit menu, the window or zoom owns, and saves nothing', () => {
    for (const binding of ['CommandOrControl+C', 'CommandOrControl+Z', 'CommandOrControl+W', 'CommandOrControl+Q', 'CommandOrControl+Shift+0', 'CommandOrControl+Alt+=']) {
      const proposal = proposeBinding('thread.new', binding, {}, WIN)
      expect(proposal.kind, binding).toBe('refuse')
    }
    const refused = proposeBinding('terminal.open', 'CommandOrControl+V', {}, WIN)
    expect(refused).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('Paste') })
  })

  it('refuses a bare key for a command that runs while typing, but not for one that does not', () => {
    expect(proposeBinding('palette.open', 'K', {}, WIN).kind).toBe('refuse')
    expect(proposeBinding('palette.open', 'Shift+K', {}, WIN).kind).toBe('refuse')
    expect(proposeBinding('palette.open', 'Tab', {}, WIN).kind).toBe('refuse')
    // Alt, Ctrl and function keys do not type text.
    expect(proposeBinding('palette.open', 'Alt+K', {}, WIN).kind).toBe('save')
    expect(proposeBinding('palette.open', 'F6', {}, WIN).kind).toBe('save')
    // Surface letters are text-denied and stay bare keys.
    expect(proposeBinding('surface.browser', 'W', {}, WIN)).toMatchObject({ kind: 'save' })
  })

  it('refuses a chord that does not parse', () => {
    expect(proposeBinding('thread.new', 'Super+K', {}, WIN).kind).toBe('refuse')
  })
})

describe('proposeBinding: conflicts', () => {
  it('warns when another global command has the chord and names who runs', () => {
    // Mod+K is Command palette (first in the table), so it wins over New thread.
    const proposal = proposeBinding('thread.new', 'CommandOrControl+K', {}, WIN)
    expect(proposal).toMatchObject({
      kind: 'confirm',
      others: ['palette.open'],
      winner: 'palette.open',
      losers: ['thread.new'],
      reasons: [],
      keepPatch: { 'thread.new': 'CommandOrControl+K' },
      replacePatch: { 'thread.new': 'CommandOrControl+K', 'palette.open': null }
    })
  })

  it('names the new command as the winner when it comes first in the table', () => {
    const proposal = proposeBinding('palette.open', 'CommandOrControl+N', {}, WIN)
    expect(proposal).toMatchObject({ kind: 'confirm', others: ['thread.new'], winner: 'palette.open', losers: ['thread.new'] })
  })

  it('lets a scoped command beat a global one', () => {
    const proposal = proposeBinding('surface.git', 'CommandOrControl+N', {}, WIN)
    expect(proposal).toMatchObject({ kind: 'confirm', others: ['thread.new'], winner: 'surface.git', losers: ['thread.new'] })
  })

  it('does not warn for scopes that are never active together', () => {
    // The surface letters and the workflow editor cannot be open at once.
    expect(proposeBinding('workflow.delete', 'B', {}, WIN)).toEqual({ kind: 'save', patch: { 'workflow.delete': 'B' } })
  })

  it('keeps Mod+K and a bare K apart', () => {
    expect(proposeBinding('surface.browser', 'K', {}, WIN).kind).toBe('save')
  })

  it('compares on the resolved binding: Ctrl+K on Windows is the palette default', () => {
    expect(proposeBinding('thread.new', 'Ctrl+K', {}, WIN)).toMatchObject({ kind: 'confirm', others: ['palette.open'] })
    // On macOS, Ctrl+K is not Cmd+K.
    expect(proposeBinding('thread.new', 'Ctrl+K', {}, MAC).kind).toBe('save')
  })

  it('warns about a soft-reserved chord and offers only Use anyway', () => {
    const proposal = proposeBinding('thread.new', 'CommandOrControl+Shift+I', {}, WIN)
    expect(proposal).toMatchObject({
      kind: 'confirm',
      others: [],
      winner: null,
      replacePatch: null,
      keepPatch: { 'thread.new': 'CommandOrControl+Shift+I' }
    })
    expect(proposal.kind === 'confirm' && proposal.reasons[0]).toMatch(/developer tools/)
  })

  it('reports Mod+F as taken by Find in thread, which owns the reservation', () => {
    const proposal = proposeBinding('thread.new', 'CommandOrControl+F', {}, WIN)
    expect(proposal).toMatchObject({ kind: 'confirm', others: ['chat.findInThread'] })
    expect(proposal.kind === 'confirm' && proposal.reasons.join(' ')).toMatch(/Find in thread/)
  })

  it('does not warn about Mod+S for the workflow editor save, which owns it', () => {
    expect(proposeBinding('workflow.save', 'CommandOrControl+S', { 'workflow.save': null }, WIN)).toEqual({
      kind: 'save',
      patch: { 'workflow.save': 'CommandOrControl+S' }
    })
    expect(proposeBinding('thread.new', 'CommandOrControl+S', {}, WIN).kind).toBe('confirm')
  })

  it('reports a clash and a soft-reserved chord together', () => {
    const proposal = proposeBinding('terminal.open', 'CommandOrControl+S', {}, WIN)
    expect(proposal).toMatchObject({ kind: 'confirm', others: ['workflow.save'], winner: 'workflow.save', losers: ['terminal.open'] })
    expect(proposal.kind === 'confirm' && proposal.reasons).toHaveLength(1)
  })

  it('treats a freed chord as free: unbinding the other command clears the clash', () => {
    expect(proposeBinding('thread.new', 'CommandOrControl+K', { 'palette.open': null }, WIN).kind).toBe('save')
  })
})

describe('reset', () => {
  const overrides: ShortcutOverrides = {
    'thread.new': 'CommandOrControl+Shift+X',
    'thread.next': null,
    'palette.open': 'CommandOrControl+Shift+P'
  }

  it('writes the default back for one command, resolved for the platform', () => {
    expect(resetPatch('thread.new', overrides, WIN)).toEqual({ 'thread.new': 'CommandOrControl+N' })
    expect(resetPatch('thread.next', overrides, WIN)).toEqual({ 'thread.next': 'Ctrl+Tab' })
    expect(resetPatch('thread.next', overrides, MAC)).toEqual({ 'thread.next': 'Ctrl+Tab' })
  })

  it('has nothing to write for a command that is not overridden', () => {
    expect(resetPatch('terminal.open', overrides, WIN)).toEqual({})
  })

  it('resets every overridden command and leaves the rest alone', () => {
    expect(resetAllPatch(overrides, WIN)).toEqual({
      'thread.new': 'CommandOrControl+N',
      'thread.next': 'Ctrl+Tab',
      'palette.open': 'CommandOrControl+K'
    })
    expect(resetAllPatch({}, WIN)).toEqual({})
  })

  it('leaves no entries once the patch is applied', () => {
    expect(applyPatch(overrides, resetPatch('thread.new', overrides, WIN), WIN)).toEqual({
      'thread.next': null,
      'palette.open': 'CommandOrControl+Shift+P'
    })
    expect(applyPatch(overrides, resetAllPatch(overrides, WIN), WIN)).toEqual({})
  })
})

describe('applyPatch', () => {
  it('merges the entries and cleans them like the daemon does', () => {
    expect(applyPatch({ 'thread.new': 'CommandOrControl+Shift+X' }, { 'thread.next': null, 'terminal.open': 'CommandOrControl+Shift+J' }, WIN)).toEqual({
      'thread.new': 'CommandOrControl+Shift+X',
      'thread.next': null,
      'terminal.open': 'CommandOrControl+Shift+J'
    })
  })
})

describe('the list', () => {
  it('shows every command once, grouped in table order', () => {
    const groups = shortcutGroups('', {}, WIN)
    const ids = groups.flatMap((group) => group.rows.map((row) => row.command.id))
    expect(ids.sort()).toEqual(COMMANDS.map((command) => command.id).sort())
    expect(groups.map((group) => group.category)).toEqual([...new Set(COMMANDS.map((command) => command.category))])
  })

  it('formats the current binding and marks a custom one', () => {
    const rows = shortcutGroups('', { 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null }, WIN).flatMap((group) => group.rows)
    const byId = (id: string) => rows.find((row) => row.command.id === id)!
    expect(byId('thread.new')).toMatchObject({ label: 'Ctrl+Shift+X', custom: true })
    expect(byId('thread.next')).toMatchObject({ binding: null, label: '', custom: true })
    expect(byId('terminal.open')).toMatchObject({ label: 'Ctrl+J', custom: false })
    expect(shortcutGroups('', { 'thread.new': 'CommandOrControl+Shift+X' }, MAC).flatMap((group) => group.rows).find((row) => row.command.id === 'thread.new')?.label).toBe('⌘⇧X')
  })

  it('narrows by every word of the query across title, terms, category and shortcut', () => {
    const ids = (query: string) => shortcutGroups(query, {}, WIN).flatMap((group) => group.rows.map((row) => row.command.id))
    expect(ids('new thread')).toEqual(['thread.new'])
    expect(ids('interrupt')).toEqual(['run.stop'])
    expect(ids('model picker')).toEqual(['model.pick1', 'model.pick2', 'model.pick3', 'model.pick4', 'model.pick5'])
    expect(ids('ctrl+tab')).toContain('thread.next')
    expect(ids('zzz')).toEqual([])
  })

  it('says which command runs instead where two share a chord', () => {
    const overrides: ShortcutOverrides = { 'thread.new': 'CommandOrControl+K' }
    expect(shadowedBy(overrides, WIN).get('thread.new')).toBe('palette.open')
    const rows = shortcutGroups('', overrides, WIN).flatMap((group) => group.rows)
    expect(rows.find((row) => row.command.id === 'thread.new')?.shadowedBy).toBe('palette.open')
    expect(rows.find((row) => row.command.id === 'palette.open')?.shadowedBy).toBeNull()
    expect(shadowedBy({}, WIN).size).toBe(0)
  })

  it('has no clash among the defaults', () => {
    for (const platform of [WIN, MAC]) {
      expect(shadowedBy({}, platform).size).toBe(0)
      for (const command of COMMANDS) if (!command.fixed) expect(bindingFor(command.id, {}, platform)).not.toBeNull()
    }
  })
})
