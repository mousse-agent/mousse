import { describe, expect, it } from 'vitest'
import { accentGrayTint, tintGray } from '../../src/renderer/lib/grayTint'

describe("Mousse Dark's accent-tinted grays", () => {
  it('leans each gray at most two units toward the accent', () => {
    const purple = accentGrayTint('#a785c7')!
    expect(tintGray('#111111', purple)).toBe('#121113')
    expect(tintGray('#000000', purple)).toBe('#010002')
    expect(tintGray('18, 18, 18', purple)).toBe('19, 18, 20')
    const blue = accentGrayTint('#3b82f6')!
    expect(tintGray('#111111', blue)).toBe('#111213')
  })

  it('follows the accent and leaves colours, light grays and gray accents alone', () => {
    const red = accentGrayTint('#e5484d')!
    expect(tintGray('#1a1a1a', red)).toBe('#1c1a1a')
    expect(tintGray('#e6e6e6', red)).toBe('#e6e6e6')
    expect(tintGray('#efb080', red)).toBe('#efb080')
    expect(tintGray('#00000000', red)).toBe('#00000000')
    expect(accentGrayTint('#808080')).toBeNull()
  })
})
