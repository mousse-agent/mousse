/**
 * User themes in settings (#1142): saved and read back across a restart, the built-in theme follows the user theme's
 * base, choosing a built-in theme (Settings or the CLI) turns the user theme off, and a theme exports and imports as
 * one file.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { normalizeAppearance, type MousseSettingsUpdate } from '../src/shared/settings'
import { appearanceSurfaceBase } from '../src/shared/themeSurfaces'
import { parseUserThemeFile, userThemeFile, type UserTheme } from '../src/shared/themes/userThemes'

const OCEAN: UserTheme = {
  id: 'user-ocean',
  name: 'Ocean',
  base: 'light',
  accent: '#1166aa',
  colors: { '--surface-base': '#e8f4fb', '--text-primary': 'rgb(10 20 30)' },
  css: '[data-mousse="sidebar"] { font-family: monospace }'
}

describe('user themes in settings', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-user-themes-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = originalHome
    rmSync(tempHome, { recursive: true, force: true })
  })

  const open = () => new SettingsStore(MousseConfigStore.load(tempHome))
  const appearance = (fields: Record<string, unknown>) => ({ appearance: fields }) as MousseSettingsUpdate

  it('keeps a user theme and its CSS across a restart, with the built-in theme set to its base', () => {
    open().set(appearance({ theme: 'blacksphere-plus', userThemes: [OCEAN], userTheme: 'user-ocean' }))
    const reloaded = open().get().appearance
    expect(reloaded.userTheme).toBe('user-ocean')
    expect(reloaded.theme).toBe('light')
    expect(reloaded.userThemes).toEqual([OCEAN])
  })

  it('turns the user theme off when a built-in theme is chosen without naming one, as the CLI does', () => {
    const store = open()
    store.set(appearance({ userThemes: [OCEAN], userTheme: 'user-ocean' }))
    const after = store.set(appearance({ theme: 'dark' })).appearance
    expect(after.userTheme).toBe('')
    expect(after.theme).toBe('dark')
    // The theme itself stays saved, ready to pick again.
    expect(after.userThemes.map((theme) => theme.id)).toEqual(['user-ocean'])
    expect(open().get().appearance.userTheme).toBe('')
  })

  it('switching to a user theme by id alone takes its base', () => {
    const store = open()
    store.set(appearance({ theme: 'github-dark', userThemes: [OCEAN] }))
    expect(store.set(appearance({ userTheme: 'user-ocean' })).appearance.theme).toBe('light')
  })
})

describe('normalizeAppearance with user themes', () => {
  it('drops an unknown active id, invalid themes, duplicates and colors that are not plain colors', () => {
    const normalized = normalizeAppearance({
      theme: 'dark',
      userTheme: 'user-missing',
      userThemes: [
        OCEAN,
        { ...OCEAN, name: 'Duplicate' },
        { id: 'not-a-user-id', name: 'Bad id', base: 'dark' },
        { id: 'user-x', name: '', base: 'dark' },
        { id: 'user-y', name: 'Y', base: 'system', colors: { '--a': 'url(https://evil.example/x)', '--b': '#fff', 'color': 'red', '--c': 'var(--d)' } }
      ] as unknown as UserTheme[]
    })
    expect(normalized.userTheme).toBe('')
    expect(normalized.theme).toBe('dark')
    expect(normalized.userThemes.map((theme) => theme.id)).toEqual(['user-ocean', 'user-y'])
    const y = normalized.userThemes[1]!
    // A base that is not a built-in theme of its own (system) falls back to dark.
    expect(y.base).toBe('dark')
    expect(y.colors).toEqual({ '--b': '#fff' })
  })

  it('gives the native window the user theme\'s own background', () => {
    const normalized = normalizeAppearance({ theme: 'dark', userThemes: [OCEAN], userTheme: 'user-ocean' })
    expect(appearanceSurfaceBase(normalized)).toBe('#e8f4fb')
  })
})

describe('theme files', () => {
  it('exports a theme and imports it back as a new theme with its own id', () => {
    const file = JSON.stringify(userThemeFile(OCEAN))
    const read = parseUserThemeFile(file, ['user-ocean'])
    if ('error' in read) throw new Error(read.error)
    expect(read.theme.id).toBe('user-ocean-2')
    expect({ ...read.theme, id: OCEAN.id }).toEqual(OCEAN)
  })

  it.each([
    ['not JSON', 'nope', /not a Mousse theme/],
    ['another kind of file', JSON.stringify({ kind: 'mousse-agent', version: 1, name: 'x', base: 'dark' }), /not a Mousse theme/],
    ['a newer format', JSON.stringify({ kind: 'mousse-theme', version: 2, name: 'x', base: 'dark' }), /newer Mousse/],
    ['no name', JSON.stringify({ kind: 'mousse-theme', version: 1, name: '  ', base: 'dark' }), /no name/],
    ['CSS that is too long', JSON.stringify({ kind: 'mousse-theme', version: 1, name: 'x', base: 'dark', css: 'a{}'.repeat(30_000) }), /too long/]
  ])('refuses %s', (_name, text, message) => {
    const read = parseUserThemeFile(text, [])
    expect('error' in read && read.error).toMatch(message)
  })
})
