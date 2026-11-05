import { describe, expect, it } from 'vitest'
import {
  clampAcrylicIntensity,
  glassTokensFromIntensity,
  normalizeAppearance,
  THEME_OPTIONS,
  getDefaultSettings
} from '../src/shared/settings'

describe('appearance settings', () => {
  it('lists mousse dark with its compatible saved theme id', () => {
    const ids = THEME_OPTIONS.map((t) => t.id)
    expect(ids).toContain('blacksphere-plus')
    expect(ids).toContain('github-dark')
    expect(ids).not.toContain('dark-modern')
    expect(ids).not.toContain('one-dark')
    expect(ids).not.toContain('monokai')
    expect(ids.indexOf('blacksphere-plus')).toBe(1)
    expect(THEME_OPTIONS[1].label).toBe('Mousse Dark')
    expect(ids).not.toContain('cursor-dark')
    expect(ids).not.toContain('dark-acrylic')
    expect(ids).not.toContain('system-acrylic')
  })

  it('defaults acrylic off with a mid intensity dial', () => {
    const appearance = getDefaultSettings().appearance
    expect(appearance.theme).toBe('blacksphere-plus')
    expect(appearance.acrylic).toBe(false)
    expect(appearance.acrylicIntensity).toBe(55)
  })

  it('renders math by default and keeps an explicit choice', () => {
    expect(getDefaultSettings().appearance.renderMath).toBe(true)
    expect(normalizeAppearance({}).renderMath).toBe(true)
    expect(normalizeAppearance({ renderMath: false }).renderMath).toBe(false)
    expect(normalizeAppearance({ renderMath: 'no' as never }).renderMath).toBe(true)
  })

  it('tints threads with project colors by default and keeps an explicit choice', () => {
    expect(getDefaultSettings().appearance.threadProjectColors).toBe(true)
    expect(normalizeAppearance({}).threadProjectColors).toBe(true)
    expect(normalizeAppearance({ threadProjectColors: false }).threadProjectColors).toBe(false)
  })

  it('migrates legacy acrylic theme ids', () => {
    expect(normalizeAppearance({ theme: 'system-acrylic' as never })).toEqual({
      theme: 'system',
      accentColor: '#a785c7',
      acrylic: true,
      acrylicIntensity: 55,
      renderMath: true,
      threadProjectColors: true,
      animationSpeed: 'normal'
    })
    expect(normalizeAppearance({ theme: 'dark-acrylic' as never, accentColor: '#5b8def' })).toMatchObject({
      theme: 'dark',
      acrylic: true,
      accentColor: '#5b8def'
    })
    expect(normalizeAppearance({ theme: 'light-acrylic' as never, acrylic: false })).toMatchObject({
      theme: 'light',
      acrylic: false
    })
  })

  it('moves removed themes to the closest remaining one', () => {
    expect(normalizeAppearance({ theme: 'dark-modern' as never }).theme).toBe('dark')
    expect(normalizeAppearance({ theme: 'one-dark' as never }).theme).toBe('github-dark')
    expect(normalizeAppearance({ theme: 'monokai' as never, acrylic: false }).theme).toBe('dark')
  })

  it('clamps intensity and maps glass tokens', () => {
    expect(clampAcrylicIntensity(-10)).toBe(0)
    expect(clampAcrylicIntensity(140)).toBe(100)
    expect(clampAcrylicIntensity('nope')).toBe(55)

    const low = glassTokensFromIntensity(0)
    const high = glassTokensFromIntensity(100)
    expect(low.alphaBase).toBeGreaterThan(high.alphaBase)
    expect(high.blurPx).toBeGreaterThan(low.blurPx)
  })

  it('falls back to defaults for unknown themes', () => {
    expect(normalizeAppearance({ theme: 'not-a-theme' as never }).theme).toBe('blacksphere-plus')
  })
})
