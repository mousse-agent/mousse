// @vitest-environment jsdom
/**
 * What bots may do here is one setting for the whole installation, changed from any window, profile or the CLI. A
 * Settings page that is already open follows a change made elsewhere, and its switches send only the switch the owner
 * changed, so a page whose copy is older never turns back a switch changed elsewhere. The real Settings page, over a
 * real settings store standing in for the service; what the service does with the write is in
 * tests/bots/botsHereSetting.test.ts.
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
import type { MousseSettings, SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

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

describe('an open Settings page and What bots may do here', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  /** The service's settings store, which every window and the CLI write through. */
  let service: SettingsStore
  let changed: Array<(settings: MousseSettings) => void>
  const sent: unknown[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bots-here-page-'))
    service = new SettingsStore(MousseConfigStore.load(home))
    changed = []
    sent.length = 0
    const settings = {
      get: async () => service.get(),
      getOptions: async () => OPTIONS,
      set: async (partial: unknown) => {
        sent.push(partial)
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
    await act(async () => { window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: 'agents' })) })
    await vi.waitFor(() => expect(toggle('Run commands')).not.toBeNull())
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)
  const checked = (label: string) => toggle(label)!.getAttribute('aria-checked')

  it('follows a switch changed in another window, and a switch it changes sends only that one', async () => {
    expect(checked('Run commands')).toBe('true')
    // Another window, another profile or the CLI switches commands off: the service tells every open window.
    const elsewhere = service.set({ bots: { here: { shell: false } } } as never)
    await act(async () => { for (const listener of changed) listener(elsewhere) })
    expect(checked('Run commands')).toBe('false')

    // The owner switches the browser off here: only that switch is sent, and commands stay off.
    await act(async () => toggle('Use the browser')!.click())
    expect(sent.at(-1)).toEqual({ bots: { here: { browser: false } } })
    expect(service.get().bots.here).toEqual({ shell: false, files: true, browser: false })
    expect([checked('Run commands'), checked('Use files on this computer'), checked('Use the browser')]).toEqual(['false', 'true', 'false'])
  })

  it('a page that missed the change still never turns a switch back: what it sends is only its own switch', async () => {
    // Commands go off elsewhere and this page is not told (an older service, a dropped event).
    service.set({ bots: { here: { shell: false } } } as never)
    expect(checked('Run commands')).toBe('true')
    await act(async () => toggle('Use the browser')!.click())
    expect(sent.at(-1)).toEqual({ bots: { here: { browser: false } } })
    expect(service.get().bots.here).toEqual({ shell: false, files: true, browser: false })
  })
})
