// @vitest-environment jsdom
/**
 * Settings → Appearance with user themes (#1142), over a real settings store: New makes a theme and opens its editor,
 * Save keeps the CSS across a reload, a built-in card or the View menu's "Turn off custom theme" switches back, and a
 * theme file imports. (How the CSS looks and that it loads nothing is the real-window test, theme-css-electron.)
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from '../../src/renderer/components/settings/AppearanceSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { MousseSettingsUpdate, SettingsOptions } from '../../src/shared/settings'
import { userThemeFile } from '../../src/shared/themes/userThemes'
import { DIM_KEY_PEEK_MS } from '../../src/renderer/components/settings/WallpaperRows'
import { WALLPAPER_SAVE_DELAY_MS } from '../../src/renderer/components/settings/UserThemeEditor'
import { resetWallpapersForTests, showWallpaperLayerForTests, wallpaperLayerNow } from '../../src/renderer/lib/wallpaper'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = {
  themes: [{ id: 'dark', label: 'Dark', scheme: 'dark' }, { id: 'light', label: 'Light', scheme: 'light' }],
  accentColors: [{ id: 'lilac', label: 'Lilac', value: '#a78bfa' }],
  llmProviders: [],
  agentTypes: []
} as SettingsOptions

let root: Root
let host: HTMLElement
let home: string
let store: SettingsStore

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin' }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  home = mkdtempSync(join(tmpdir(), 'mousse-user-theme-editor-'))
  store = new SettingsStore(MousseConfigStore.load(home))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  rmSync(home, { recursive: true, force: true })
})

const show = () => {
  const draw = () => act(() => root.render(createElement(AppearanceSettings, {
    settings: store.get(),
    options: OPTIONS,
    onUpdate: async (partial) => { store.set(partial); draw() },
    restartRequired: false,
    onRestart: () => {},
    onPreviewAcrylicIntensity: () => {},
    onCommitAcrylicIntensity: () => {}
  })))
  draw()
}
const cards = () => [...host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Color theme"] [role="radio"]')]
const checked = () => cards().filter((card) => card.getAttribute('aria-checked') === 'true').map((card) => card.textContent)
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === name || entry.getAttribute('aria-label') === name)!
const typeInto = (element: HTMLTextAreaElement | HTMLInputElement, text: string) => act(() => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
  element.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('user themes in Settings → Appearance', () => {
  it('New makes a theme from the current base, and Save keeps its name and CSS across a reload', () => {
    store.set({ appearance: { theme: 'light' } } as MousseSettingsUpdate)
    show()
    act(() => button('New').click())
    expect(store.get().appearance).toMatchObject({ userTheme: 'user-my-theme', theme: 'light' })
    expect(checked()).toEqual(['My theme'])

    typeInto(host.querySelector<HTMLInputElement>('#user-theme-name')!, 'Paper')
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, '[data-mousse="sidebar"] { font-family: monospace }')
    // Not saved until Save.
    expect(store.get().appearance.userThemes[0]!.css).toBe('')
    act(() => button('Save').click())

    const reloaded = new SettingsStore(MousseConfigStore.load(home)).get().appearance
    expect(reloaded.userThemes).toEqual([expect.objectContaining({ id: 'user-my-theme', name: 'Paper', base: 'light', css: '[data-mousse="sidebar"] { font-family: monospace }' })])
    expect(checked()).toEqual(['Paper'])
  })

  it('says when Custom CSS is over 50,000 characters and will not save it', () => {
    show()
    act(() => button('New').click())
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, 'a'.repeat(50_001))
    expect(host.querySelector('[data-settings-anchor="appearance-custom-css"] [role="alert"]')?.textContent).toMatch(/50,001 characters; the limit is 50,000/)
    expect(button('Save').disabled).toBe(true)
    act(() => button('Save').click())
    expect(store.get().appearance.userThemes[0]!.css).toBe('')
    // Back under the limit, it saves.
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, 'a'.repeat(50_000))
    expect(host.querySelector('[data-settings-anchor="appearance-custom-css"] [role="alert"]')).toBeNull()
    act(() => button('Save').click())
    expect(store.get().appearance.userThemes[0]!.css).toHaveLength(50_000)
  })

  it('Discard drops the draft, and a built-in card turns the user theme off but keeps it', () => {
    show()
    act(() => button('New').click())
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, 'a { color: red }')
    act(() => button('Discard').click())
    expect(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!.value).toBe('')

    act(() => cards().find((card) => card.textContent === 'Dark')!.click())
    expect(store.get().appearance).toMatchObject({ theme: 'dark', userTheme: '' })
    expect(store.get().appearance.userThemes).toHaveLength(1)
    expect(host.querySelector('#user-theme-css')).toBeNull()
    expect(checked()).toEqual(['Dark'])
  })

  it('an accent swatch changes the user theme\'s own accent while it has one, and the profile\'s otherwise', () => {
    const accents = () => [...host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Accent color"] [role="radio"]')]
    store.set({ appearance: { accentColor: '#123456', userThemes: [{ id: 'user-x', name: 'X', base: 'dark', accent: '#3ddc84', colors: {}, css: '' }], userTheme: 'user-x' } } as MousseSettingsUpdate)
    show()
    // The theme's green is not one of the swatches: none shows as chosen.
    expect(accents().filter((swatch) => swatch.getAttribute('aria-checked') === 'true')).toEqual([])
    act(() => accents().find((swatch) => swatch.getAttribute('aria-label') === 'Lilac')!.click())
    expect(store.get().appearance.userThemes[0]!.accent).toBe('#a78bfa')
    expect(store.get().appearance.accentColor).toBe('#123456')

    store.set({ appearance: { accentColor: '#a78bfa', userThemes: [{ id: 'user-x', name: 'X', base: 'dark', accent: '', colors: {}, css: '' }], userTheme: 'user-x' } } as MousseSettingsUpdate)
    show()
    expect(accents().find((swatch) => swatch.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label')).toBe('Lilac')
  })

  it('Delete removes the theme and goes back to its base', () => {
    show()
    act(() => button('New').click())
    act(() => button('Delete theme').click())
    expect(store.get().appearance).toMatchObject({ userThemes: [], userTheme: '' })
  })

  it('imports a theme file and switches to it; a file that is not a theme says so', async () => {
    show()
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    const pick = async (file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((done) => setTimeout(done, 0)) })
    }
    await pick(new File(['{"kind":"other"}'], 'x.json'))
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not a Mousse theme/)
    expect(store.get().appearance.userThemes).toEqual([])

    const file = userThemeFile({ id: 'user-ocean', name: 'Ocean', base: 'light', accent: '#1166aa', colors: { '--surface-base': '#e8f4fb' }, css: 'a { color: blue }' })
    await pick(new File([JSON.stringify(file)], 'ocean.mousse-theme.json'))
    expect(store.get().appearance).toMatchObject({ userTheme: 'user-ocean', theme: 'light' })
    expect(store.get().appearance.userThemes[0]).toMatchObject({ name: 'Ocean', css: 'a { color: blue }' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('turning a theme off while its editor is open', () => {
  it('leaves the theme off after a preview, rather than putting the editor\'s last theme back', async () => {
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin', settings: { get: async () => store.get() } }
    store.set({ appearance: { userThemes: [{ id: 'user-x', name: 'X', base: 'dark', accent: '', colors: {}, css: '' }], userTheme: 'user-x' } } as MousseSettingsUpdate)
    show()
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, 'body { display: none }')
    await act(async () => { await new Promise((done) => setTimeout(done, 200)) })
    expect(document.documentElement.dataset.userTheme).toBe('user-x')

    // View → Turn off custom theme, from another window or the menu: the page redraws without the editor.
    store.set({ appearance: { userTheme: '' } } as MousseSettingsUpdate)
    show()
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    expect(host.querySelector('#user-theme-css')).toBeNull()
    expect(document.documentElement.dataset.userTheme).toBeUndefined()
  })
})

describe('View → Turn off custom theme', () => {
  it('turns the user theme off through settings, from the menu', async () => {
    const set = vi.fn(async (partial: MousseSettingsUpdate) => store.set(partial))
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin', settings: { set } }
    const { useAppCommands } = await import('../../src/renderer/commands/useAppCommands')
    const { runCommand } = await import('../../src/renderer/commands/commandRegistry')
    store.set({ appearance: { userThemes: [{ id: 'user-x', name: 'X', base: 'dark', accent: '', colors: {}, css: 'body { display: none }' }], userTheme: 'user-x' } } as MousseSettingsUpdate)
    const Commands = () => { useAppCommands(); return null }
    act(() => root.render(createElement(Commands)))
    await act(async () => { await runCommand('theme.builtIn', 'menu') })
    expect(set).toHaveBeenCalledWith({ appearance: { userTheme: '' } })
    expect(store.get().appearance.userTheme).toBe('')
  })
})

describe('wallpaper dim', () => {
  const peeking = () => document.documentElement.hasAttribute('data-settings-peek')
  const slider = () => host.querySelector<HTMLInputElement>('#wallpaper-dim')!
  /** A theme in use with a wallpaper at 10% dim, whose image needs 50% for readable text. */
  const showWithWallpaper = () => {
    store.set({ appearance: { userThemes: [{ id: 'user-w', name: 'W', base: 'dark', accent: '', colors: {}, css: '', wallpaper: { id: 'a'.repeat(64), type: 'image/webp', width: 10, height: 10, fit: 'cover', position: 'center', dim: 10 } }], userTheme: 'user-w' } } as MousseSettingsUpdate)
    show()
    act(() => showWallpaperLayerForTests({ url: 'blob:w', fit: 'cover', position: 'center', base: 'rgb(16 20 24)', opacity: 1, dim: 0.1, floor: 0.5, scrim: 0.5 }))
  }

  afterEach(() => {
    vi.useRealTimers()
    resetWallpapersForTests()
    document.documentElement.removeAttribute('data-settings-peek')
  })

  it('dragging changes the chat wallpaper at once with Settings aside, never below the readability floor, and saves it without Save', () => {
    vi.useFakeTimers()
    showWithWallpaper()
    typeInto(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!, 'a { color: red }')
    // Below the floor the dim changes nothing, so the slider starts at the floor and says so.
    expect(slider().value).toBe('50')
    expect(host.querySelector('.wallpaper-dim-row')?.textContent).toContain('At least 50%')

    act(() => slider().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(peeking()).toBe(true)
    typeInto(slider(), '70')
    // Drawn now, not after the theme preview's pause.
    expect(wallpaperLayerNow()).toMatchObject({ dim: 0.7, scrim: 0.7 })
    typeInto(slider(), '20')
    expect(slider().value).toBe('50')
    expect(wallpaperLayerNow()).toMatchObject({ dim: 0.5, scrim: 0.5 })
    typeInto(slider(), '60')
    act(() => window.dispatchEvent(new MouseEvent('pointerup')))
    expect(peeking()).toBe(false)

    act(() => { vi.advanceTimersByTime(WALLPAPER_SAVE_DELAY_MS) })
    // The dim is saved on its own; the CSS edit stays a draft.
    expect(store.get().appearance.userThemes[0]).toMatchObject({ css: '', wallpaper: { dim: 60 } })
    expect(host.querySelector<HTMLTextAreaElement>('#user-theme-css')!.value).toBe('a { color: red }')
    expect(slider().value).toBe('60')
    expect(button('Save').disabled).toBe(false)
  })

  it('leaving Settings right after a move still saves the dim', () => {
    vi.useFakeTimers()
    showWithWallpaper()
    typeInto(slider(), '70')
    act(() => root.render(createElement('div')))
    expect(store.get().appearance.userThemes[0]!.wallpaper?.dim).toBe(70)
  })

  it('an arrow key moves Settings aside for a moment', () => {
    vi.useFakeTimers()
    showWithWallpaper()
    act(() => slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(peeking()).toBe(true)
    act(() => { vi.advanceTimersByTime(DIM_KEY_PEEK_MS) })
    expect(peeking()).toBe(false)
    // Other keys leave Settings in place.
    act(() => slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(peeking()).toBe(false)
  })
})
