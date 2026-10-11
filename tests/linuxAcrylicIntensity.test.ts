import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../src/shared/settings'
import { applyAcrylicIntensity, persistLinuxAcrylicIntensity } from '../src/renderer/lib/acrylicIntensity'

describe('Linux acrylic intensity', () => {
  it('saves the dial without reverting current theme, accent, or acrylic preference', async () => {
    const current = getDefaultSettings()
    current.appearance = { theme: 'light', accentColor: '#123456', acrylic: false, acrylicIntensity: 55 }
    const set = vi.fn(async ({ appearance }) => ({ ...current, appearance }))
    const result = await persistLinuxAcrylicIntensity(90, { get: async () => current, set })
    expect(result.appearance).toEqual({ ...current.appearance, acrylicIntensity: 90 })
    expect(set).toHaveBeenCalledOnce()
  })

  it('updates preview alpha immediately while keeping element/text opacity independent', () => {
    const properties = new Map<string, string>()
    const root = { style: { setProperty: (key: string, value: string) => properties.set(key, value) } } as unknown as HTMLElement
    applyAcrylicIntensity(0, root)
    const solid = Number(properties.get('--glass-alpha-base'))
    applyAcrylicIntensity(100, root)
    expect(Number(properties.get('--glass-alpha-base'))).toBeLessThan(solid)
    expect(properties.get('--acrylic-intensity')).toBe('100')
    expect(properties.has('opacity')).toBe(false)
  })
})
