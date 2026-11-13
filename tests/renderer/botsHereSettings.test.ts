// @vitest-environment jsdom
/**
 * Settings → Agents → What bots may do here: four switches, on by default, each saved as the service reads them (once
 * for the installation). After a settings file that could not be read, every switch is off and one line says why until
 * the owner sets them again. How the stored value is read is in tests/bots/botsHereSetting.test.ts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { searchSettings, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { asSettingsPartial } from '../../src/mms/protocol/validators'
import { BOTS_UNREADABLE_LINE, type SettingsOptions } from '../../src/shared/settings'

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

  it('shows four switches under its own group, all on for an install that never set them', () => {
    show()
    const group = toggle('Run commands').closest('section.settings-group')!
    expect(group.querySelector('h3')?.textContent?.trim()).toBe('What bots may do here')
    const switches = [...group.querySelectorAll('[role="switch"]')].map((node) => [node.getAttribute('aria-label'), node.getAttribute('aria-checked')])
    expect(switches).toEqual([['Run commands', 'true'], ['Use files on this computer', 'true'], ['Use the browser', 'true'], ['Use your threads', 'true']])
    expect(saved()).toEqual({ shell: true, files: true, browser: true, threads: true })
  })

  it('saves each switch on its own, and another section\'s save leaves them alone', () => {
    show()
    act(() => toggle('Run commands').click())
    expect(toggle('Run commands').getAttribute('aria-checked')).toBe('false')
    expect(saved()).toEqual({ shell: false, files: true, browser: true, threads: true })
    act(() => toggle('Use the browser').click())
    expect(saved()).toEqual({ shell: false, files: true, browser: false, threads: true })
    act(() => toggle('Use your threads').click())
    expect(saved()).toEqual({ shell: false, files: true, browser: false, threads: false })
    store.set({ runs: { ...store.get().runs, resumeAfterUsageLimit: true } })
    expect(saved()).toEqual({ shell: false, files: true, browser: false, threads: false })
    act(() => toggle('Run commands').click())
    expect(saved()).toEqual({ shell: true, files: true, browser: false, threads: false })
  })

  it('after a settings file that could not be read: every switch off and one line saying so, gone once the owner sets one', () => {
    writeFileSync(join(home, 'mousse.conf'), '{"bots":{"here":{"shell":tr')
    store = new SettingsStore(MousseConfigStore.load(home))
    show()
    const group = toggle('Run commands').closest('section.settings-group')!
    expect(group.querySelector('[role="status"]')?.textContent).toBe(BOTS_UNREADABLE_LINE)
    expect([...group.querySelectorAll('[role="switch"]')].map((node) => node.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'false'])
    act(() => toggle('Use the browser').click())
    expect(saved()).toEqual({ shell: false, files: false, browser: true, threads: false })
    expect(toggle('Run commands').closest('section.settings-group')!.querySelector('[role="status"]')).toBeNull()
  })

  it('says on the Run commands switch that commands can read files even with Use files off', () => {
    show()
    const label = host.querySelector('label[for="agents-bots-shell"] [title]')
    expect(label?.getAttribute('title')).toMatch(/^Commands can read files on this computer even with Use files off/)
  })

  it('says on the Use your threads switch that a thread a bot starts can run commands with the other switches off', () => {
    show()
    const label = host.querySelector('label[for="agents-bots-threads"] [title]')
    expect(label?.getAttribute('title')).toMatch(/full access, so it can run commands and change files even with Run commands and Use files off/)
  })

  it('is found by search, on the Agents page', () => {
    const pages: SettingsSearchPage[] = [{ id: 'agents', label: 'Agents', keywords: [] }]
    expect(searchSettings('what bots may do', pages)[0]).toEqual({ title: 'What bots may do here', section: 'agents', anchor: 'agents-bots-here' })
    expect(searchSettings('bot browser', pages)[0]).toMatchObject({ anchor: 'agents-bots-browser' })
    expect(searchSettings('use your threads', pages)[0]).toMatchObject({ anchor: 'agents-bots-threads' })
  })
})
