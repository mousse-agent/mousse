import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ShortcutsSettings, rowNotes, sectionScope } from '../../src/renderer/components/settings/ShortcutsSettings'
import { shortcutGroups } from '../../src/renderer/commands/shortcutEditing'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { getDefaultSettings, type MousseSettings } from '../../src/shared/settings'
import type { ShortcutOverrides } from '../../src/shared/commands'

const globals = globalThis as { window?: unknown }
const originalWindow = globals.window

beforeEach(() => {
  globals.window = { mousse: { platform: 'win32' } }
  useAppStore.setState({ appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' } })
})

afterEach(() => {
  globals.window = originalWindow
})

const render = (shortcuts: ShortcutOverrides): string => {
  const settings: MousseSettings = { ...getDefaultSettings(), shortcuts }
  return renderToStaticMarkup(createElement(ShortcutsSettings, { settings, onUpdate: async () => undefined }))
}

it('lists every group with the default shortcuts and no reset buttons', () => {
  const markup = render({})
  for (const heading of ['Thread', 'View', 'Go', 'Surfaces', 'Model picker', 'Workflow editor', 'Editor']) expect(markup).toContain(heading)
  expect(markup).toContain('Ctrl+Shift+Backspace')
  expect(markup).toContain('Ctrl+Tab')
  expect(markup).not.toContain('Custom')
  expect(markup).not.toContain('to its default shortcut')
  // Reset all has nothing to reset yet.
  expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Reset all<\/button>/)
})

it('shows a custom shortcut with a badge and a reset, and a shortcut another command shadows', () => {
  const markup = render({ 'thread.new': 'CommandOrControl+K', 'threads.search': null })
  expect(markup).toContain('Custom')
  expect(markup).toContain('Reset New thread to its default shortcut')
  expect(markup).toContain('Reset Search threads to its default shortcut')
  expect(markup).toContain('Not set')
  expect(markup).toContain('Not active while Command palette uses this shortcut')
  expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset all<\/button>/)
})

const count = (markup: string, text: string): number => markup.split(text).length - 1

it('says where a scoped section works once, under its heading, and that the editors own their fixed keys', () => {
  const markup = render({})
  for (const note of ['Works while the model picker is open', 'Works while the Open menu is showing', 'Works in the workflow editor']) {
    expect(count(markup, note)).toBe(1)
    expect(markup).toContain(`<p class="settings-group-desc">${note}</p>`)
  }
  // Undo, Redo, Save file and Commit message: commit.
  expect(count(markup, 'Set by the editor')).toBe(4)
})

it('names rows briefly under their section and keeps the editor name out', () => {
  const markup = render({})
  expect(markup).toContain('>Save file<')
  expect(markup).toContain('>Undo<')
  expect(markup).toContain('>Redo<')
  expect(markup).not.toContain('Monaco')
  expect(markup).not.toContain('Workflow editor: undo')
})

it('edits a shortcut with an icon button named after its command, and none on fixed keys', () => {
  const markup = render({})
  expect(markup).toMatch(/<button[^>]*title="Change shortcut"[^>]*aria-label="Change New thread shortcut"[^>]*>\s*<svg/)
  expect(markup).toContain('aria-label="Change Pick model 1 shortcut"')
  expect(markup).not.toContain('>Change<')
  expect(markup).not.toContain('Change Save file shortcut')
  expect(markup).not.toContain('Change Undo shortcut')
})

it('keeps a row note when its scope differs from its section', () => {
  const rows = shortcutGroups('', {}, 'win32').flatMap((group) => group.rows)
  const global = rows.find((row) => row.command.id === 'thread.new')!
  const picker = rows.find((row) => row.command.id === 'model.pick1')!
  expect(sectionScope([picker])).toBe('model-picker')
  expect(sectionScope([global])).toBeNull()
  expect(sectionScope([picker, global])).toBeNull()
  expect(rowNotes(picker, 'model-picker')).toEqual([])
  expect(rowNotes(picker, null)).toEqual(['Works while the model picker is open'])
  expect(rowNotes(global, null)).toEqual([])
})

it('spaces shortcut rows on the compact step of the shared scale', () => {
  expect(render({})).toContain('class="settings-group shortcuts-group"')
})
