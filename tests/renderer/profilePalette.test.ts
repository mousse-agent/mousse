import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlusStatus } from '../../src/shared/net/local'
import { MousseIdAvatar } from '../../src/renderer/components/MousseIdAvatar'
import { nextProfileColor, paletteColorFor, PROFILE_PALETTE, PROFILE_SWATCHES, profileColor } from '../../src/renderer/lib/profilePalette'
import { devicesLine, useMousseIdStore } from '../../src/renderer/stores/mousseIdStore'
import { useAppStore } from '../../src/renderer/stores/appStore'

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

describe('device count in the Mousse ID store', () => {
  const globals = globalThis as { window?: unknown }
  const original = globals.window
  afterEach(() => {
    globals.window = original
    useMousseIdStore.setState({ plus: undefined, profileId: null, loaded: false, runtimeOrigin: '' })
  })

  function stub(answers: Record<string, () => Promise<unknown>>) {
    const request = vi.fn((method: string) => (answers[method] ?? (() => Promise.reject(new Error(`unexpected ${method}`))))())
    globals.window = Object.assign(new EventTarget(), { mousse: { platformRequest: { request } } })
    return request
  }

  it('adds the count from the inventory to the signed-in status', async () => {
    const request = stub({ 'net.plus.inventory': async () => ({ ...signedIn, devices: { used: 3, limit: 5 } }) })
    useMousseIdStore.setState({ plus: signedIn, profileId: useAppStore.getState().profileId })
    await useMousseIdStore.getState().loadDevices()
    expect(request).toHaveBeenCalledWith('net.plus.inventory', {})
    expect(devicesLine(useMousseIdStore.getState().plus)).toBe('3 of 5 devices')
  })

  it('does not ask while signed out, and leaves the status alone when the service cannot answer', async () => {
    const request = stub({ 'net.plus.inventory': () => Promise.reject(new Error('unreachable')) })
    useMousseIdStore.setState({ plus: { configured: false, connected: false }, profileId: useAppStore.getState().profileId })
    await useMousseIdStore.getState().loadDevices()
    expect(request).not.toHaveBeenCalled()
    useMousseIdStore.setState({ plus: signedIn })
    await useMousseIdStore.getState().loadDevices()
    expect(request).toHaveBeenCalledTimes(1)
    expect(useMousseIdStore.getState().plus).toEqual(signedIn)
  })

  it('keeps the count across status refreshes of the same account, but not another account', async () => {
    let status: PlusStatus = signedIn
    stub({ 'net.status': async () => ({ enabled: false }), 'net.plus.status': async () => status })
    useMousseIdStore.setState({ plus: { ...signedIn, devices: { used: 2, limit: 3 } }, profileId: useAppStore.getState().profileId, runtimeOrigin: 'https://id.example' })
    await useMousseIdStore.getState().refresh()
    expect(devicesLine(useMousseIdStore.getState().plus)).toBe('2 of 3 devices')
    status = { ...signedIn, accountId: 'acct_other' }
    await useMousseIdStore.getState().refresh()
    expect(devicesLine(useMousseIdStore.getState().plus)).toBeUndefined()
  })
})
