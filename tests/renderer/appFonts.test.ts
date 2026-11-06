// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYSTEM_FONT_STACKS, type LoadedGoogleFont } from '../../src/shared/fontSettings'

type AppFonts = typeof import('../../src/renderer/lib/appFonts')

const added: { family: string; weight?: string }[] = []

class FakeFontFace {
  constructor(public family: string, private data: Uint8Array, public descriptors: FontFaceDescriptors) {}
  async load(): Promise<this> {
    if (new TextDecoder().decode(this.data) === 'broken') throw new Error('decode failed')
    return this
  }
}

const fakeFontSet = { add: (face: FakeFontFace) => added.push({ family: face.family, weight: face.descriptors.weight }) }

function font(...payloads: string[]): LoadedGoogleFont {
  return { family: 'Inter', faces: payloads.map((text, index) => ({ weight: 400 + index * 100, style: 'normal', data: new TextEncoder().encode(text) })) }
}

async function freshModule(loadGoogle?: (...args: unknown[]) => Promise<LoadedGoogleFont | null>): Promise<AppFonts> {
  vi.resetModules()
  ;(window as unknown as { mousse?: unknown }).mousse = loadGoogle ? { fonts: { loadGoogle } } : undefined
  return import('../../src/renderer/lib/appFonts')
}

beforeEach(() => {
  added.length = 0
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', { value: fakeFontSet, configurable: true })
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('app fonts', () => {
  it('sets one variable per role and clears it for the default', async () => {
    const fonts = await freshModule()
    const root = document.documentElement.style
    fonts.applyFontSettings({ interfaceFont: { source: 'installed', family: 'Avenir Next' }, codeFont: { source: 'system' } })
    expect(root.getPropertyValue('--font-sans')).toBe(`"Avenir Next", ${SYSTEM_FONT_STACKS.interface}`)
    expect(root.getPropertyValue('--font-mono')).toBe(SYSTEM_FONT_STACKS.code)
    expect(fonts.codeFontStack()).toBe(SYSTEM_FONT_STACKS.code)

    fonts.applyFontSettings({ interfaceFont: { source: 'default' }, codeFont: { source: 'default' } })
    expect(root.getPropertyValue('--font-sans')).toBe('')
    expect(root.getPropertyValue('--font-mono')).toBe('')
    expect(fonts.codeFontStack()).toContain('Geist Mono')
  })

  it('loads a chosen Google font from the cache only, and tells listeners when it is ready', async () => {
    const loadGoogle = vi.fn(async () => font('ok'))
    const fonts = await freshModule(loadGoogle)
    const listener = vi.fn()
    fonts.subscribeAppFonts(listener)
    fonts.applyFontSettings({ interfaceFont: { source: 'google', family: 'Inter' } })
    await vi.waitFor(() => expect(fonts.isGoogleFontLoaded('Inter')).toBe(true))
    expect(loadGoogle).toHaveBeenCalledWith('Inter', 'interface', false)
    expect(added).toEqual([{ family: 'Inter', weight: '400' }])
    expect(listener).toHaveBeenCalled()
  })

  it('falls back to the system font when the font is not cached or fails', async () => {
    const fonts = await freshModule(async () => null)
    await expect(fonts.loadGoogleFont('Inter', 'interface', false)).resolves.toBe(false)
    expect(fonts.isGoogleFontLoaded('Inter')).toBe(false)

    const failing = await freshModule(async () => { throw new Error('offline') })
    await expect(failing.loadGoogleFont('Inter', 'interface', false)).resolves.toBe(false)
    // A download the user asked for reports its failure, and a later attempt tries again.
    await expect(failing.loadGoogleFont('Inter', 'interface', true)).rejects.toThrow('offline')

    const noBridge = await freshModule()
    await expect(noBridge.loadGoogleFont('Inter', 'interface', true)).resolves.toBe(false)
  })

  it('skips faces that fail to decode and keeps the rest', async () => {
    const fonts = await freshModule()
    await expect(fonts.registerFontFaces(font('broken', 'ok'), fakeFontSet as unknown as FontFaceSet)).resolves.toBe(true)
    expect(added).toEqual([{ family: 'Inter', weight: '500' }])
    await expect(fonts.registerFontFaces(font('broken'), fakeFontSet as unknown as FontFaceSet)).resolves.toBe(false)
  })

  it('lists installed families once each, sorted, without hidden or unsafe names', async () => {
    const { uniqueFamilies } = await import('../../src/renderer/lib/localFonts')
    expect(uniqueFamilies(['Menlo', 'Avenir Next', 'menlo', '.SF NS', 'Bad"Name', 'Menlo', 'avenir', 'Wingdings 2', 'Apple Color Emoji', 'Symbol'])).toEqual(['avenir', 'Avenir Next', 'Menlo'])
  })
})
