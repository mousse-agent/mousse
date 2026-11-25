/**
 * Revising an applet with edits and reading its stored source in bounded pages (`src/mms/applets/appletSource.ts`), so
 * an agent never needs the source in its context. The tools' path through a turn is in tests/run/appToolApplets.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { APPLET_READ_MAX_BYTES, APPLET_READ_MAX_CHARS, APPLET_SEARCH_MAX_CHARS, applyAppletEdits, appletRevisionFromEdits, readAppletSource } from '../src/mms/applets/appletSource'
import { validateAppletSubmission, type AppletSubmission } from '../src/shared/applets'

const base: AppletSubmission = {
  schemaVersion: 1,
  title: 'Costs',
  description: 'Monthly costs',
  html: '<h1>Costs</h1>\n<p>a</p>\n<p>a</p>',
  css: 'h1 { color: teal; }',
  js: 'void 0',
  data: { rows: 3 },
  stateVersion: 2
}
const parts = { html: base.html, css: base.css, js: base.js }

describe('applyAppletEdits', () => {
  it('applies edits in order, each to the part as the earlier ones left it', () => {
    expect(applyAppletEdits(base, [
      { part: 'css', old_str: 'teal', new_str: 'red' },
      { part: 'css', old_str: 'red', new_str: 'crimson' },
      { part: 'html', old_str: '<h1>Costs</h1>', new_str: '' }
    ])).toEqual({ ...parts, html: '\n<p>a</p>\n<p>a</p>', css: 'h1 { color: crimson; }' })
  })

  it.each([
    ['no edits', [], /at least one edit/],
    ['edits that are not a list', { part: 'css' }, /at least one edit/],
    ['an edit that is not an object', ['x'], /Edit 1 must be an object/],
    ['an unknown part', [{ part: 'data', old_str: 'a', new_str: 'b' }], /Edit 1 part must be html, css or js/],
    ['an empty old_str', [{ part: 'css', old_str: '', new_str: 'b' }], /Edit 1 \(css\) old_str must be non-empty/],
    ['a missing new_str', [{ part: 'css', old_str: 'teal' }], /Edit 1 \(css\) new_str must be text/],
    ['an extra field', [{ part: 'css', old_str: 'teal', new_str: 'red', all: true }], /Edit 1 has unsupported fields: all/],
    ['an old_str that is not there', [{ part: 'js', old_str: 'navy', new_str: 'red' }], /Edit 1 \(js\): old_str was not found/],
    ['an old_str that occurs twice', [{ part: 'html', old_str: '<p>a</p>', new_str: '' }], /Edit 1 \(html\): old_str occurs more than once/],
    // The first edit removed the only match the second needs: nothing of the first is kept either.
    ['a later edit that no longer matches', [{ part: 'css', old_str: 'teal', new_str: 'red' }, { part: 'css', old_str: 'teal', new_str: 'blue' }], /Edit 2 \(css\): old_str was not found/]
  ])('refuses %s, naming the edit', (_name, edits, reason) => {
    expect(() => applyAppletEdits(base, edits)).toThrow(reason)
  })
})

describe('appletRevisionFromEdits', () => {
  const revise = { schemaVersion: 1, appletId: 'applet_a', expectedRevision: 'rev_a', edits: [{ part: 'css', old_str: 'teal', new_str: 'red' }] }

  it('keeps every field the call leaves out, and takes the ones it gives', () => {
    expect(appletRevisionFromEdits(revise, base)).toEqual({ ...base, css: 'h1 { color: red; }', appletId: 'applet_a', expectedRevision: 'rev_a' })
    expect(appletRevisionFromEdits({ ...revise, title: 'Spend', data: { rows: 4 }, stateVersion: 3 }, base)).toMatchObject({ title: 'Spend', description: 'Monthly costs', data: { rows: 4 }, stateVersion: 3 })
  })

  it('keeps a schema version the call gives, for validation to refuse', () => {
    for (const schemaVersion of [2, null]) expect(() => validateAppletSubmission(appletRevisionFromEdits({ ...revise, schemaVersion }, base))).toThrow(/schema version/)
  })

  it.each(['html', 'css', 'js', 'htmlPath', 'cssPath', 'jsPath'])('refuses edits given with %s', (key) => {
    expect(() => appletRevisionFromEdits({ ...revise, [key]: 'x' }, base)).toThrow(`Give edits or ${key}, not both`)
  })
})

describe('readAppletSource', () => {
  it('without a part, gives the sizes to choose what to read', () => {
    expect(readAppletSource(base, {})).toMatchObject({ parts: { html: { chars: base.html.length, lines: 3 }, css: { chars: base.css.length, lines: 1 }, js: { chars: 6, lines: 1 } }, dataChars: JSON.stringify(base.data, null, 2).length, stateVersion: 2 })
  })

  it('pages a part from an offset, saying where the next page starts', () => {
    expect(readAppletSource(base, { part: 'css', limit: 4 })).toEqual({ part: 'css', offset: 0, totalChars: base.css.length, text: 'h1 {', nextOffset: 4 })
    expect(readAppletSource(base, { part: 'css', offset: 15 })).toEqual({ part: 'css', offset: 15, totalChars: base.css.length, text: 'l; }' })
    expect(readAppletSource(base, { part: 'data' })).toMatchObject({ text: JSON.stringify(base.data, null, 2) })
  })

  it('finds the lines that contain a text, with their numbers and context', () => {
    expect(readAppletSource(base, { part: 'html', search: '<p>a' })).toEqual({
      part: 'html', search: '<p>a', totalMatches: 2,
      matches: [{ line: 2, text: base.html }, { line: 3, text: '<h1>Costs</h1>\n<p>a</p>\n<p>a</p>' }]
    })
    const many = { ...base, js: Array.from({ length: 30 }, (_, i) => `hit ${i}`).join('\n') }
    expect(readAppletSource(many, { part: 'js', search: 'hit' })).toMatchObject({ totalMatches: 30, truncated: true, matches: expect.toSatisfy((matches: unknown[]) => matches.length === 20) })
  })

  it('shows a match deep in a long minified line, and keeps every match together within a page', () => {
    const minified = { ...base, js: Array.from({ length: 25 }, (_, i) => 'x'.repeat(20_000) + `needle${i}` + 'y'.repeat(20_000)).join('\n') }
    const found = readAppletSource(minified, { part: 'js', search: 'needle' }) as { matches: Array<{ line: number; column?: number; text: string }> }
    expect(found.matches[0]).toMatchObject({ line: 1, column: 20_001, text: expect.stringContaining('needle0') })
    expect(found.matches.every((match, i) => match.text.includes(`needle${i}`))).toBe(true)
    expect(found.matches.reduce((chars, match) => chars + match.text.length, 0)).toBeLessThanOrEqual(APPLET_READ_MAX_CHARS)
  })

  it('never cuts an emoji at either end of a search excerpt', () => {
    const emoji = { ...base, js: '😀'.repeat(2_000) + 'X' + '😀'.repeat(2_000) }
    const [match] = (readAppletSource(emoji, { part: 'js', search: 'X' }) as { matches: Array<{ text: string }> }).matches
    expect(match!.text).toContain('X')
    expect(match!.text).toMatch(/^😀[\s\S]*😀$/u)
  })

  it('keeps the matches of wide characters within a page in bytes', () => {
    const wide = { ...base, js: Array.from({ length: 20 }, (_, i) => '界'.repeat(4_000) + `needle${i}`).join('\n') }
    const found = readAppletSource(wide, { part: 'js', search: 'needle' }) as { matches: Array<{ text: string }>; totalMatches: number; truncated?: boolean }
    expect(found.matches.reduce((bytes, match) => bytes + Buffer.byteLength(match.text), 0)).toBeLessThanOrEqual(APPLET_READ_MAX_BYTES)
    expect(found).toMatchObject({ totalMatches: 20, truncated: true })
  })

  it('never returns more than the most a page may hold', () => {
    const big = { ...base, js: 'x'.repeat(APPLET_READ_MAX_CHARS * 2) }
    expect((readAppletSource(big, { part: 'js', limit: APPLET_READ_MAX_CHARS }).text as string).length).toBe(APPLET_READ_MAX_CHARS)
    expect(() => readAppletSource(big, { part: 'js', limit: APPLET_READ_MAX_CHARS + 1 })).toThrow(/limit must be between 1 and/)
  })

  it('pages wide characters by bytes too, never splitting one, and the pages join back into the part', () => {
    const wide = { ...base, js: '界'.repeat(APPLET_READ_MAX_CHARS) + '😀😀' }
    let offset = 0
    let joined = ''
    for (;;) {
      const page = readAppletSource(wide, { part: 'js', offset, limit: APPLET_READ_MAX_CHARS }) as { text: string; nextOffset?: number }
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(APPLET_READ_MAX_BYTES)
      joined += page.text
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    }
    expect(joined).toBe(wide.js)
    // A page of one character holds the whole emoji, and the next page starts after it.
    const emoji = { ...base, js: '😀b' }
    expect(readAppletSource(emoji, { part: 'js', limit: 1 })).toMatchObject({ text: '😀', nextOffset: 2 })
    expect(readAppletSource(emoji, { part: 'js', offset: 2, limit: 1 })).toMatchObject({ text: 'b' })
    // An offset inside the emoji starts at the emoji.
    expect(readAppletSource(emoji, { part: 'js', offset: 1, limit: 1 })).toMatchObject({ offset: 0, text: '😀', nextOffset: 2 })
  })

  it('counts the escapes the JSON result adds toward a page', () => {
    const tabs = { ...base, html: '\t'.repeat(APPLET_READ_MAX_CHARS) }
    const page = readAppletSource(tabs, { part: 'html', limit: APPLET_READ_MAX_CHARS })
    expect(Buffer.byteLength(JSON.stringify(page.text))).toBeLessThanOrEqual(APPLET_READ_MAX_BYTES + 2)
    expect(page.nextOffset).toBe(APPLET_READ_MAX_BYTES / 2)
  })

  it.each([
    ['an unknown part', { part: 'svg' }, /part must be html, css, js or data/],
    ['an offset past the end', { part: 'js', offset: 6 }, /offset 6 is past the end of js, which has 6 characters/],
    ['a negative offset', { part: 'js', offset: -1 }, /offset must be a whole number/],
    ['a search with no part', { search: 'teal' }, /Name a part/],
    ['an empty search', { part: 'css', search: '' }, /search must be non-empty/],
    ['a search longer than an edit needs', { part: 'css', search: 'x'.repeat(APPLET_SEARCH_MAX_CHARS + 1) }, /search must be at most/]
  ])('refuses %s', (_name, args, reason) => {
    expect(() => readAppletSource(base, args)).toThrow(reason)
  })
})
