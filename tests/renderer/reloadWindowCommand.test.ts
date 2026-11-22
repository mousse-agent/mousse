// @vitest-environment jsdom
/**
 * "Reload window" in the command palette: typing "reload" lists it, choosing it reloads the window through the
 * reload service (which saves autosaved edits first), and a reload refused for unsaved edits says so.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reloads = vi.hoisted(() => ({ count: 0, outcome: 'reloaded' as 'reloaded' | 'unsaved' }))
vi.mock('../../src/renderer/services/reloadWindow', () => ({
  reloadWindow: async () => { reloads.count += 1; return reloads.outcome }
}))
const toasts = vi.hoisted(() => [] as Array<{ message: string }>)
vi.mock('../../src/renderer/components/ui/Toast', async (actual) => ({
  ...(await actual<object>()),
  showToast: (input: { message: string }) => { toasts.push(input); return toasts.length }
}))

import { useAppCommands } from '../../src/renderer/commands/useAppCommands'
import { currentContext, isCommandRegistered, useCommandRegistry } from '../../src/renderer/commands/commandRegistry'
import { chooseCommandPaletteItem } from '../../src/renderer/commands/paletteActions'
import { buildPaletteGroups, eligibleCommands } from '../../src/renderer/commands/paletteItems'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function Commands() {
  useAppCommands()
  return null
}

beforeEach(() => {
  reloads.count = 0
  reloads.outcome = 'reloaded'
  toasts.length = 0
  useCommandRegistry.setState({ handlers: new Map(), recording: false, overlays: [] })
  useAppStore.setState({ paletteOpen: true, settingsOpen: false, shortcuts: {}, appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(Commands)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The first command row the palette shows for `query`. */
function firstCommandRow(query: string) {
  const commands = eligibleCommands(currentContext('palette'), (id) => isCommandRegistered(id, 'palette'))
  const groups = buildPaletteGroups({ query, commands, threads: [], projects: [] })
  return groups.find((group) => group.label === 'Commands')?.items[0]
}

const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)) })

describe('Reload window from the palette', () => {
  it('is found by "reload" and reloads the window when chosen', async () => {
    const row = firstCommandRow('reload')
    expect(row).toMatchObject({ kind: 'command', id: 'window.reload', title: 'Reload window' })
    act(() => chooseCommandPaletteItem(row!))
    await settle()
    expect(reloads.count).toBe(1)
    expect(toasts).toEqual([])
  })

  it('says to save or close files when unsaved edits stop the reload', async () => {
    reloads.outcome = 'unsaved'
    act(() => chooseCommandPaletteItem(firstCommandRow('reload')!))
    await settle()
    expect(reloads.count).toBe(1)
    expect(toasts.map((toast) => toast.message)).toEqual(['Save or close unsaved files first'])
  })
})
