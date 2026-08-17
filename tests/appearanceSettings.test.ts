import { describe, expect, it } from 'vitest'
import {
  clampAcrylicIntensity,
  glassTokensFromIntensity,
  normalizeAppearance,
  THEME_OPTIONS,
  getDefaultSettings
} from '../src/shared/settings'

describe('appearance settings', () => {
  it('lists VS Code–style themes including Blacksphere+', () => {
    const ids = THEME_OPTIONS.map((t) => t.id)
    expect(ids).toContain('blacksphere-plus')
    expect(ids).toContain('github-dark')
    expect(ids).toContain('dark-modern')
    expect(ids).toContain('one-dark')
    expect(ids.indexOf('blacksphere-plus')).toBe(1)
    expect(ids).not.toContain('cursor-dark')
    expect(ids).not.toContain('dark-acrylic')
    expect(ids).not.toContain('system-acrylic')
  })

  it('defaults acrylic on with a mid intensity dial', () => {
    const appearance = getDefaultSettings().appearance
    expect(appearance.theme).toBe('system')
    expect(appearance.acrylic).toBe(true)
    expect(appearance.acrylicIntensity).toBe(55)
  })

  it('migrates legacy acrylic theme ids', () => {
    expect(normalizeAppearance({ theme: 'system-acrylic' as never })).toEqual({
      theme: 'system',
      accentColor: '#a785c7',
      acrylic: true,
      acrylicIntensity: 55
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
    expect(normalizeAppearance({ theme: 'not-a-theme' as never }).theme).toBe('system')
  })
})
