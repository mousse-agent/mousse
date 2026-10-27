import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PlusStatus } from '../../src/shared/net/local'
import { MousseIdAvatar } from '../../src/renderer/components/MousseIdAvatar'
import { nextProfileColor, paletteColorFor, PROFILE_PALETTE, PROFILE_SWATCHES, profileColor } from '../../src/renderer/lib/profilePalette'
import { devicesLine } from '../../src/renderer/stores/mousseIdStore'

const signedIn: PlusStatus = { configured: true, connected: true, accountId: 'acct_ada', email: 'ada@example.com' }

describe('profile palette', () => {
  it('is eight distinct named colours', () => {
    expect(PROFILE_PALETTE).toHaveLength(8)
    expect(new Set(PROFILE_PALETTE).size).toBe(8)
    expect(new Set(PROFILE_SWATCHES.map((swatch) => swatch.name)).size).toBe(8)
    for (const color of PROFILE_PALETTE) expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('gives a string the same palette colour every time', () => {
    for (const seed of ['ada@example.com', 'acct_ada', '', 'Studio']) {
      expect(PROFILE_PALETTE).toContain(paletteColorFor(seed))
      expect(paletteColorFor(seed)).toBe(paletteColorFor(seed))
    }
    const used = new Set(Array.from({ length: 40 }, (_, index) => paletteColorFor(`person${index}@example.com`)))
    expect(used.size).toBeGreaterThan(4)
  })

  it('colours the account avatar from the palette and leaves the signed-out avatar empty', () => {
    const html = renderToStaticMarkup(createElement(MousseIdAvatar, { plus: signedIn, large: true }))
    expect(html).toContain(`background:${paletteColorFor('ada@example.com')}`)
    expect(html).toContain('profile-avatar-large')
    expect(html).toContain('>A<')
    const empty = renderToStaticMarkup(createElement(MousseIdAvatar, { plus: { configured: false, connected: false } }))
    expect(empty).toContain('mousse-id-avatar-empty')
    expect(empty).not.toContain('background:')
  })

  it('uses a profile colour as stored and falls back to the gradient without one', () => {
    expect(profileColor({ color: '#604880' })).toBe('#604880')
    expect(profileColor({})).toBeUndefined()
    expect(profileColor({ color: '' })).toBeUndefined()
  })

  it('suggests the first colour no profile uses, ignoring case', () => {
    expect(nextProfileColor([])).toBe('#4d6088')
    expect(nextProfileColor([{ color: '#4D6088' }, { color: undefined }, { color: '#604880' }])).toBe('#2f7a6a')
    const all = PROFILE_PALETTE.map((color) => ({ color }))
    expect(PROFILE_PALETTE).toContain(nextProfileColor(all))
  })
})

describe('devices line', () => {
  it('reads "N of M devices" once Mousse ID has reported the count', () => {
    expect(devicesLine({ ...signedIn, devices: { used: 3, limit: 5 } })).toBe('3 of 5 devices')
    expect(devicesLine({ ...signedIn, devices: { used: 0, limit: 3 } })).toBe('0 of 3 devices')
    expect(devicesLine({ ...signedIn, devices: { used: 1, limit: 1 } })).toBe('1 of 1 device')
  })

  it('says nothing before the count is known or when signed out', () => {
    expect(devicesLine(signedIn)).toBeUndefined()
    expect(devicesLine(undefined)).toBeUndefined()
    expect(devicesLine({ configured: true, connected: false, devices: { used: 3, limit: 5 } })).toBeUndefined()
  })
})
