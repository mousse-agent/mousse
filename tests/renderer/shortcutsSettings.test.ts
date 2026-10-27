import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ShortcutsSettings } from '../../src/renderer/components/settings/ShortcutsSettings'
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

it('notes where a scoped command works and that the editors own their fixed keys', () => {
  const markup = render({})
  expect(markup).toContain('Works while the model picker is open')
  expect(markup).toContain('Set by the editor')
})
