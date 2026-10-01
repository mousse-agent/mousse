import { describe, expect, it } from 'vitest'
import { linuxTransparencyOptions } from '../src/main/linuxRendering'

describe('Linux native transparency', () => {
  it('creates an alpha-capable surface for acrylic and runtime toggles', () => {
    expect(linuxTransparencyOptions('linux')).toEqual({ transparent: true })
  })

  it.each(['win32', 'darwin'] as const)('preserves native %s window options', (platform) => {
    expect(linuxTransparencyOptions(platform)).toEqual({})
  })
})
