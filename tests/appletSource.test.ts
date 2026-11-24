/**
 * Revising an applet with edits and reading its stored source in bounded pages (`src/mms/applets/appletSource.ts`), so
 * an agent never needs the source in its context. The tools' path through a turn is in tests/run/appToolApplets.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { APPLET_READ_MAX_CHARS, applyAppletEdits, appletRevisionFromEdits, readAppletSource } from '../src/mms/applets/appletSource'
import type { AppletSubmission } from '../src/shared/applets'

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

  it.each(['html', 'css', 'js', 'htmlPath', 'cssPath', 'jsPath'])('refuses edits given with %s', (key) => {
    expect(() => appletRevisionFromEdits({ ...revise, [key]: 'x' }, base)).toThrow(`Give edits or ${key}, not both`)
  })
})

describe('readAppletSource', () => {
  it('without a part, gives the sizes to choose what to read', () => {
    expect(readAppletSource(base, {})).toMatchObject({ parts: { html: { chars: base.html.length, lines: 3 }, css: { chars: base.css.length, lines: 1 }, js: { chars: 6, lines: 1 } }, dataChars: 10, stateVersion: 2 })
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

  it('never returns more than the most a page may hold', () => {
    const big = { ...base, js: 'x'.repeat(APPLET_READ_MAX_CHARS * 2) }
    expect((readAppletSource(big, { part: 'js', limit: APPLET_READ_MAX_CHARS }).text as string).length).toBe(APPLET_READ_MAX_CHARS)
    expect(() => readAppletSource(big, { part: 'js', limit: APPLET_READ_MAX_CHARS + 1 })).toThrow(/limit must be between 1 and/)
  })

  it.each([
    ['an unknown part', { part: 'svg' }, /part must be html, css, js or data/],
    ['an offset past the end', { part: 'js', offset: 6 }, /offset 6 is past the end of js, which has 6 characters/],
    ['a negative offset', { part: 'js', offset: -1 }, /offset must be a whole number/],
    ['a search with no part', { search: 'teal' }, /Name a part/],
    ['an empty search', { part: 'css', search: '' }, /search must be non-empty/]
  ])('refuses %s', (_name, args, reason) => {
    expect(() => readAppletSource(base, args)).toThrow(reason)
  })
})
