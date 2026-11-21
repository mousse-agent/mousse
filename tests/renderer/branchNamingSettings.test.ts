// @vitest-environment jsdom
/**
 * Settings → Storage → Branches: the person picks how worktree branches are named, and the prefix they type is what the
 * daemon keeps. The real Settings page, over a real settings store and the protocol's settings check.
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
import { THEME_OPTIONS, type MousseSettings, type SettingsOptions } from '../../src/shared/settings'

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

describe('Settings → Storage → Branches', () => {
  let root: Root
  let host: HTMLElement
  let home: string
  let service: SettingsStore

  const row = (title: string) => [...host.querySelectorAll<HTMLElement>('.settings-item')].find((item) => item.querySelector('.settings-item-title')?.textContent === title)
  const choose = async (label: string, option: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(option))!.click())
  }
  const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-branch-settings-'))
    service = new SettingsStore(MousseConfigStore.load(home))
    const settings = {
      get: async () => service.get(),
      getOptions: async () => OPTIONS,
      set: async (partial: unknown) => service.set(asSettingsPartial(partial) as never),
      onChanged: (_listener: (settings: MousseSettings) => void) => () => undefined
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
    await act(async () => { window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: 'storage' })) })
    await vi.waitFor(() => expect(row('Worktree branch naming')).toBeTruthy())
  }, 60_000)

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  it('starts on the static mousse/ prefix; a typed prefix is saved cleaned, and an empty one means none', async () => {
    expect(service.get().branches).toMatchObject({ mode: 'static', prefix: 'mousse' })
    const prefix = row('Branch prefix')!.querySelector('input')!
    expect(prefix.value).toBe('mousse')
    await type(prefix, 'team alex/')
    expect(service.get().branches.prefix).toBe('team-alex')
    expect(prefix.value).toBe('team-alex')
    expect(row('Worktree branch naming')!.textContent).toContain('team-alex/fix-login-button')
    await type(prefix, '')
    expect(service.get().branches.prefix).toBe('')
  })

  it('semantic mode hides the prefix; custom mode asks for instructions, which are saved', async () => {
    await choose('Worktree branch naming', 'Semantic prefix')
    expect(service.get().branches.mode).toBe('semantic')
    expect(row('Branch prefix')).toBeUndefined()
    expect(row('Naming instructions')).toBeUndefined()
    await choose('Worktree branch naming', 'Custom instructions')
    expect(service.get().branches.mode).toBe('custom')
    await type(row('Naming instructions')!.querySelector('textarea')!, 'Start with the ticket number.')
    expect(service.get().branches.instructions).toBe('Start with the ticket number.')
  })
})
