import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { proposeBinding, resetAllPatch, resetPatch } from '../src/renderer/commands/shortcutEditing'
import { defaultBindingFor } from '../src/shared/commands'
import { getDefaultSettings } from '../src/shared/settings'

describe('shortcut settings', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-shortcut-settings-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MOUSSE_HOME
    } else {
      process.env.MOUSSE_HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  const open = () => new SettingsStore(MousseConfigStore.load(tempHome))

  it('starts with no overrides', () => {
    expect(getDefaultSettings().shortcuts).toEqual({})
    expect(open().get().shortcuts).toEqual({})
  })

  it('keeps an override and an unbound command across a reload', () => {
    open().set({ shortcuts: { 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null } })

    const reloaded = open().get()
    expect(reloaded.shortcuts).toEqual({ 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null })
    expect(JSON.parse(readFileSync(join(tempHome, 'mousse.conf'), 'utf8')).settings.shortcuts).toEqual(reloaded.shortcuts)
  })

  it('adds to the overrides already saved', () => {
    const settings = open()
    settings.set({ shortcuts: { 'thread.new': 'CommandOrControl+Shift+X' } })
    settings.set({ shortcuts: { 'palette.open': 'CommandOrControl+Shift+P' } })

    expect(open().get().shortcuts).toEqual({
      'thread.new': 'CommandOrControl+Shift+X',
      'palette.open': 'CommandOrControl+Shift+P'
    })
  })

  it('removes an entry when its default binding is written back', () => {
    const settings = open()
    settings.set({ shortcuts: { 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null } })

    settings.set({ shortcuts: { 'thread.new': defaultBindingFor('thread.new', process.platform) } })
    expect(open().get().shortcuts).toEqual({ 'thread.next': null })

    // An unbound command is reset the same way.
    settings.set({ shortcuts: { 'thread.next': defaultBindingFor('thread.next', process.platform) } })
    expect(open().get().shortcuts).toEqual({})
    expect(JSON.parse(readFileSync(join(tempHome, 'mousse.conf'), 'utf8')).settings.shortcuts).toEqual({})
  })

  it('leaves the shortcuts alone when other settings change, and the reverse', () => {
    const settings = open()
    settings.set({ shortcuts: { 'thread.new': 'CommandOrControl+Shift+X' } })
    settings.set({ notifications: { threadCompletionSound: false } })

    const reloaded = open().get()
    expect(reloaded.shortcuts).toEqual({ 'thread.new': 'CommandOrControl+Shift+X' })
    expect(reloaded.notifications.threadCompletionSound).toBe(false)

    settings.set({ shortcuts: { 'thread.next': null } })
    expect(open().get().notifications.threadCompletionSound).toBe(false)
  })

  it('drops unknown commands, bad bindings and reserved chords, on write and on load', () => {
    open().set({
      shortcuts: {
        'thread.new': 'CommandOrControl+C',
        'thread.next': 'Super+K',
        'palette.open': 'CommandOrControl+Shift+=',
        'run.stop': 'CommandOrControl+Shift+X',
        'editor.save': 'CommandOrControl+Shift+Y',
        ...({ 'not.a.command': 'CommandOrControl+X' } as Record<string, string>)
      }
    })
    expect(open().get().shortcuts).toEqual({ 'run.stop': 'CommandOrControl+Shift+X' })

    // A file edited by hand, or written by another version, is cleaned when it is read.
    const confPath = join(tempHome, 'mousse.conf')
    const conf = JSON.parse(readFileSync(confPath, 'utf8'))
    conf.settings.shortcuts = { 'terminal.open': 'CommandOrControl+V', 'sideCard.toggle': 'CommandOrControl+Shift+Q', 'thread.previous': 7 }
    writeFileSync(confPath, JSON.stringify(conf), 'utf8')
    expect(open().get().shortcuts).toEqual({ 'sideCard.toggle': 'CommandOrControl+Shift+Q' })
  })

  it('keeps what the Shortcuts section saves across a restart, and what it resets', () => {
    const platform = process.platform
    const settings = open()

    // Record a binding, then a second one that clashes and is replaced.
    const recorded = proposeBinding('thread.new', 'CommandOrControl+Shift+X', settings.get().shortcuts, platform)
    if (recorded.kind !== 'save') throw new Error('expected a plain save')
    settings.set({ shortcuts: recorded.patch })
    const clash = proposeBinding('terminal.open', 'CommandOrControl+Shift+X', open().get().shortcuts, platform)
    if (clash.kind !== 'confirm' || !clash.replacePatch) throw new Error('expected a clash with a Replace choice')
    settings.set({ shortcuts: clash.replacePatch })

    expect(open().get().shortcuts).toEqual({ 'thread.new': null, 'terminal.open': 'CommandOrControl+Shift+X' })

    // Reset one: the entry is gone after the restart, the other stays.
    settings.set({ shortcuts: resetPatch('thread.new', open().get().shortcuts, platform) })
    expect(open().get().shortcuts).toEqual({ 'terminal.open': 'CommandOrControl+Shift+X' })

    // Reset all leaves no entry in the file.
    settings.set({ shortcuts: { 'run.stop': null } })
    settings.set({ shortcuts: resetAllPatch(open().get().shortcuts, platform) })
    expect(open().get().shortcuts).toEqual({})
    expect(JSON.parse(readFileSync(join(tempHome, 'mousse.conf'), 'utf8')).settings.shortcuts).toEqual({})
  })

  it('reads a config saved before shortcuts existed as having none', () => {
    open()
    const confPath = join(tempHome, 'mousse.conf')
    const conf = JSON.parse(readFileSync(confPath, 'utf8'))
    delete conf.settings.shortcuts
    writeFileSync(confPath, JSON.stringify(conf), 'utf8')

    expect(open().get().shortcuts).toEqual({})
  })
})
