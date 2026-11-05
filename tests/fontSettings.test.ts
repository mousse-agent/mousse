import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_STACKS,
  findGoogleFont,
  fontCacheSlug,
  fontChoiceLabel,
  fontStack,
  googleFontCssUrl,
  googleFontsForRole,
  isSafeFontFamily,
  normalizeFontChoice,
  parseGoogleFontCss,
  pickFontWeights,
  searchFontNames,
  SYSTEM_FONT_STACKS
} from '../src/shared/fontSettings'
import { getDefaultSettings, normalizeAppearance } from '../src/shared/settings'

describe('font settings', () => {
  it('defaults to the fonts Mousse ships, matching the stylesheet stacks', () => {
    const appearance = getDefaultSettings().appearance
    expect(appearance.interfaceFont).toEqual({ source: 'default' })
    expect(appearance.codeFont).toEqual({ source: 'default' })
    expect(normalizeAppearance({}).interfaceFont).toEqual({ source: 'default' })
    expect(fontStack('interface', { source: 'default' })).toBe(DEFAULT_FONT_STACKS.interface)
    expect(DEFAULT_FONT_STACKS.interface.startsWith("'Geist'")).toBe(true)
    expect(DEFAULT_FONT_STACKS.code.startsWith("'Geist Mono'")).toBe(true)
  })

  it('keeps valid choices and resets unreadable ones to the default', () => {
    expect(normalizeAppearance({ codeFont: { source: 'google', family: 'JetBrains Mono' } }).codeFont)
      .toEqual({ source: 'google', family: 'JetBrains Mono' })
    expect(normalizeFontChoice({ source: 'installed', family: '  Menlo ' })).toEqual({ source: 'installed', family: 'Menlo' })
    expect(normalizeFontChoice({ source: 'system', family: 'ignored' })).toEqual({ source: 'system' })
    for (const raw of [
      null,
      'Inter',
      [],
      { source: 'google' },
      { source: 'google', family: '' },
      { source: 'installed', family: 'Evil"; } body { color: red' },
      { source: 'installed', family: 'a'.repeat(101) },
      { source: 'remote', family: 'Inter' }
    ]) {
      expect(normalizeFontChoice(raw)).toEqual({ source: 'default' })
    }
  })

  it('accepts family names in any script and refuses CSS or URL syntax', () => {
    expect(isSafeFontFamily('Hiragino Kaku Gothic ProN')).toBe(true)
    expect(isSafeFontFamily('ヒラギノ角ゴシック')).toBe(true)
    expect(isSafeFontFamily('M PLUS 1p')).toBe(true)
    for (const bad of ["Bad'Name", 'Bad"Name', 'a;b', 'a{b}', 'a\\b', 'a<b', 'a/b', ' padded', '']) {
      expect(isSafeFontFamily(bad)).toBe(false)
    }
  })

  it('puts a chosen family first and falls back to the system font', () => {
    expect(fontStack('interface', { source: 'google', family: 'Inter' })).toBe(`"Inter", ${SYSTEM_FONT_STACKS.interface}`)
    expect(fontStack('code', { source: 'installed', family: 'Menlo' })).toBe(`"Menlo", ${SYSTEM_FONT_STACKS.code}`)
    expect(fontStack('code', { source: 'system' })).toBe(SYSTEM_FONT_STACKS.code)
    expect(fontChoiceLabel('code', { source: 'default' })).toBe('Geist Mono')
    expect(fontChoiceLabel('interface', { source: 'system' })).toBe('System font')
  })

  it('picks the nearest weights a family has', () => {
    expect(pickFontWeights([400, 500, 600], [100, 200, 300, 400, 500, 600, 700])).toEqual([400, 500, 600])
    expect(pickFontWeights([400, 700], [400])).toEqual([400])
    // 500 is as close to 400 as to 600; the lighter wins.
    expect(pickFontWeights([400, 500, 600], [400, 600, 800])).toEqual([400, 600])
    expect(pickFontWeights([400, 700], [300, 800])).toEqual([300, 800])
    expect(pickFontWeights([400], [])).toEqual([])
  })

  it('lists sans and serif families for the interface and monospace ones for code, offline', () => {
    const code = googleFontsForRole('code')
    const ui = googleFontsForRole('interface')
    expect(code.length).toBeGreaterThan(20)
    expect(code.every((entry) => entry.category === 'monospace')).toBe(true)
    expect(ui.some((entry) => entry.category === 'serif')).toBe(true)
    expect(ui.some((entry) => entry.category === 'monospace')).toBe(false)
    // The bundled default is not offered again as a download.
    expect(code.some((entry) => entry.family === 'Geist Mono')).toBe(false)
    expect(ui.some((entry) => entry.family === 'Geist')).toBe(false)
    expect(findGoogleFont('jetbrains mono')?.family).toBe('JetBrains Mono')
    expect(findGoogleFont('Inter')?.weights).toContain(500)
  })

  it('ranks exact and prefix matches before other matches', () => {
    const names = ['Roboto Mono', 'Noto Sans Mono', 'Mono Lisa', 'Monoton', 'Mono']
    expect(searchFontNames(names, 'mono', (name) => name)).toEqual(['Mono', 'Mono Lisa', 'Monoton', 'Roboto Mono', 'Noto Sans Mono'])
    expect(searchFontNames(names, '  ', (name) => name)).toEqual(names)
    expect(searchFontNames(['JetBrains Mono'], 'jetbrainsmono', (name) => name)).toEqual(['JetBrains Mono'])
  })

  it('builds the Google Fonts CSS address for the weights', () => {
    expect(googleFontCssUrl('IBM Plex Mono', [700, 400])).toBe(
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap'
    )
    expect(fontCacheSlug('IBM Plex Mono')).toBe('ibm-plex-mono')
  })

  it('reads font files from a Google Fonts stylesheet and drops other hosts', () => {
    const css = `
/* cyrillic */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/cyr.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 500;
  src: url('https://fonts.gstatic.com/s/inter/v20/latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Inter';
  font-style: italic;
  font-weight: 100 900;
  src: url(https://fonts.gstatic.com/s/inter/v20/italic.woff2) format('woff2');
}
@font-face { font-family: 'X'; font-weight: 400; src: url(http://fonts.gstatic.com/s/x.woff2); }
@font-face { font-family: 'X'; font-weight: 400; src: url(https://evil.example/s/x.woff2); }
@font-face { font-family: 'X'; font-weight: 400; src: url(https://fonts.gstatic.com/s/y.woff2); unicode-range: U+0000; } body { }
`
    expect(parseGoogleFontCss(css)).toEqual([
      { weight: 400, style: 'normal', unicodeRange: 'U+0301, U+0400-045F, U+0490-0491', url: 'https://fonts.gstatic.com/s/inter/v20/cyr.woff2' },
      { weight: 500, style: 'normal', unicodeRange: 'U+0000-00FF, U+0131', url: 'https://fonts.gstatic.com/s/inter/v20/latin.woff2' },
      { weight: 100, style: 'italic', url: 'https://fonts.gstatic.com/s/inter/v20/italic.woff2' },
      { weight: 400, style: 'normal', unicodeRange: 'U+0000', url: 'https://fonts.gstatic.com/s/y.woff2' }
    ])
  })
})
