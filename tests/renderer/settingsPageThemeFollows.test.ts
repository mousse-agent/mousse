// @vitest-environment jsdom
/**
 * An agent can change the theme while Settings is open (#1142). The open page follows: it shows the agent's theme,
 * and a theme saved on the page starts from the saved list, so it never drops the agent's. The real Settings page,
 * over a real settings store standing in for the service.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { asSettingsPartial } from '../../src/mms/protocol/validators'
import { THEME_OPTIONS, type MousseSettings, type MousseSettingsUpdate, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = { themes: THEME_OPTIONS, accentColors: [], llmProviders: [], agentTypes: [] }

/** A bridge method nobody in this test cares about: callable, awaitable, and an unsubscribe when one is expected. */
function anything(): unknown {
  const done = Promise.resolve(undefined)
  const fn = (): unknown => anything()
  return new Proxy(fn, {
    get: (_target, key) => {
      if (key === 'then') return done.then.bind(done)
      if (key === 'catch') return done.catch.bind(done)
      if (key === 'finally') return done.finally.bind(done)
      return anything()
    },
    apply: () => anything()
  })
}

describe('an open Settings page and a theme an agent changes', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  /** The service's settings store, which every window, the CLI and the agents' theme tools write through. */
  let service: SettingsStore
  let changed: Array<(settings: MousseSettings) => void>

  /** A write made somewhere else (an agent's theme_set), told to the open page as the service tells every window. */
  const elsewhere = (partial: MousseSettingsUpdate) => act(async () => {
    const next = service.set(partial)
    for (const listener of changed) listener(next)
  })
  const cards = () => [...host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Color theme"] [role="radio"]')]
  const checked = () => cards().filter((card) => card.getAttribute('aria-checked') === 'true').map((card) => card.textContent)

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-theme-page-'))
    service = new SettingsStore(MousseConfigStore.load(home))
    changed = []
    const settings = {
      get: async () => service.get(),
      getOptions: async () => OPTIONS,
      set: async (partial: unknown) => {
        const next = service.set(asSettingsPartial(partial) as never)
        for (const listener of changed) listener(next)
        return next
      },
      onChanged: (listener: (settings: MousseSettings) => void) => {
        changed.push(listener)
        return () => { changed = changed.filter((other) => other !== listener) }
      }
    }
    ;(window as unknown as { mousse: unknown }).mousse = new Proxy({ settings, platform: 'linux' }, {
      get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : anything())
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({ settingsOpen: true })
    const { SettingsPage } = await import('../../src/renderer/components/SettingsPage')
    await act(async () => root.render(createElement(SettingsPage)))
    await act(async () => { window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: 'appearance' })) })
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  it('shows the agent\'s theme at once, and a save on the page keeps it', async () => {
    await elsewhere({ appearance: { userThemes: [{ id: 'user-terminal', name: 'Terminal', base: 'dark', accent: '', colors: {}, css: '' }], userTheme: 'user-terminal' } } as MousseSettingsUpdate)
    expect(checked()).toEqual(['Terminal'])

    // The person makes a theme of their own on the same page: the agent's stays.
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'New')!.click() })
    expect(service.get().appearance.userThemes.map((theme) => theme.name)).toEqual(['Terminal', 'My theme 2'])

    await elsewhere({ appearance: { theme: 'light' } } as MousseSettingsUpdate)
    expect(checked()).toEqual(['Light'])
  })

  it('pauses the theme on every Settings page but Appearance, where themes are edited', async () => {
    const page = () => host.querySelector('[data-mousse="settings"]:not([hidden])')!
    expect(page().hasAttribute('data-mousse-decision')).toBe(false)
    await act(async () => { window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: 'agents' })) })
    expect(page().hasAttribute('data-mousse-decision')).toBe(true)
  })
})
