// @vitest-environment jsdom
/**
 * Settings → Agents → What bots may do here: three switches, on by default, each saved in this profile's own settings as
 * the service reads them. A switch never written is on; one that can't be read is off.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { searchSettings, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { asSettingsPartial } from '../../src/mms/protocol/validators'
import { normalizeBotSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

describe('What bots may do here', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let store: SettingsStore

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-bots-here-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  /** Settings > Agents wired to a real settings store, the way Settings wires it to the service. */
  const show = () => {
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options: OPTIONS,
      projects: [],
      updateSettings: async (partial) => {
        // The service checks a window's update before it saves it.
        store.set(asSettingsPartial(partial) as never)
        draw()
      }
    })))
    draw()
  }
  const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
  const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().bots.here

  it('shows three switches under its own group, all on for an install that never set them', () => {
    show()
    const group = toggle('Run commands').closest('section.settings-group')!
    expect(group.querySelector('h3')?.textContent?.trim()).toBe('What bots may do here')
    const switches = [...group.querySelectorAll('[role="switch"]')].map((node) => [node.getAttribute('aria-label'), node.getAttribute('aria-checked')])
    expect(switches).toEqual([['Run commands', 'true'], ['Use files on this computer', 'true'], ['Use the browser', 'true']])
    expect(saved()).toEqual({ shell: true, files: true, browser: true })
  })

  it('saves each switch on its own in this profile\'s settings, and another section\'s save leaves them alone', () => {
    show()
    act(() => toggle('Run commands').click())
    expect(toggle('Run commands').getAttribute('aria-checked')).toBe('false')
    expect(saved()).toEqual({ shell: false, files: true, browser: true })
    act(() => toggle('Use the browser').click())
    expect(saved()).toEqual({ shell: false, files: true, browser: false })
    store.set({ runs: { ...store.get().runs, resumeAfterUsageLimit: true } })
    expect(saved()).toEqual({ shell: false, files: true, browser: false })
    act(() => toggle('Run commands').click())
    expect(saved()).toEqual({ shell: true, files: true, browser: false })
  })

  it('reads a switch never written as on, and one that is not exactly on as off', () => {
    expect(normalizeBotSettings(undefined).here).toEqual({ shell: true, files: true, browser: true })
    expect(normalizeBotSettings({ here: { files: false } }).here).toEqual({ shell: true, files: false, browser: true })
    for (const value of ['yes', 1, null, 'true']) expect(normalizeBotSettings({ here: { shell: value } }).here.shell, String(value)).toBe(false)
  })

  it('is found by search, on the Agents page', () => {
    const pages: SettingsSearchPage[] = [{ id: 'agents', label: 'Agents', keywords: [] }]
    expect(searchSettings('what bots may do', pages)[0]).toEqual({ title: 'What bots may do here', section: 'agents', anchor: 'agents-bots-here' })
    expect(searchSettings('bot browser', pages)[0]).toMatchObject({ anchor: 'agents-bots-browser' })
  })
})
