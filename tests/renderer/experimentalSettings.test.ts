// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { getDefaultSettings, normalizeExperimentalSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

describe('the experimental settings', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-experimental-settings-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  /** Settings > Agents wired to a real settings store, the way Settings wires it to the daemon. */
  const show = () => {
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options: OPTIONS,
      projects: [],
      updateSettings: async (partial) => {
        store.set(partial)
        draw()
      }
    })))
    draw()
  }
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Give each subagent its own worktree"]')!
  const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().experimental

  it('give subagents their own worktree only when turned on, and only an explicit true does it', () => {
    expect(getDefaultSettings().experimental).toEqual({ subagentWorktrees: false })
    expect(store.get().experimental).toEqual({ subagentWorktrees: false })
    for (const value of ['yes', 1, null, undefined]) expect(normalizeExperimentalSettings({ subagentWorktrees: value as never }).subagentWorktrees).toBe(false)
    expect(normalizeExperimentalSettings({ subagentWorktrees: true })).toEqual({ subagentWorktrees: true })
  })

  it('show the row under Agents > Experimental, off by default, and save a change in mousse.conf', () => {
    show()
    const group = Array.from(host.querySelectorAll('h2, h3, [role="heading"]')).find((heading) => heading.textContent?.trim() === 'Experimental')
    expect(group).toBeDefined()
    expect(host.textContent).toContain('Give each subagent its own worktree')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    act(() => toggle().click())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(saved()).toEqual({ subagentWorktrees: true })
    // Another section's change leaves it alone.
    store.set({ runs: { ...store.get().runs, resumeAfterUsageLimit: true } })
    expect(saved()).toEqual({ subagentWorktrees: true })
    act(() => toggle().click())
    expect(saved()).toEqual({ subagentWorktrees: false })
  })
})
