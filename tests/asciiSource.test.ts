import { describe, expect, it } from 'vitest'
import { toAsciiSource } from '../scripts/ascii-source.mjs'

const run = (code: string): unknown => new Function(`${code}; return value`)()

describe('toAsciiSource', () => {
  it('leaves no character outside ASCII, so V8 keeps the text at one byte per character', () => {
    const code = [
      '// HEAD → working tree, § 3',
      '/** a — b */',
      'const value = { text: "x → y · z", template: `a ${1} ²`, regex: /^[«»]$/u.test("«"), emoji: "😀".length, accent: "é" }'
    ].join('\n')
    const out = toAsciiSource(code)
    expect(out).toMatch(/^[\x00-\x7f]*$/)
    expect(run(out)).toEqual(run(code))
  })

  it('keeps what an identity escape and an astral character in a unicode regex mean', () => {
    const code = 'const value = ["\\→".length, /\\§/.test("§"), /^😀$/u.test("😀"), /^[😀]$/u.test("😀")]'
    const out = toAsciiSource(code)
    expect(out).toMatch(/^[\x00-\x7f]*$/)
    expect(run(out)).toEqual([1, true, true, true])
  })

  it('leaves a tagged template as it is: its tag can read the raw text', () => {
    const code = 'const value = String.raw`→ ${1}` + "→"'
    const out = toAsciiSource(code)
    expect(out).toBe('const value = String.raw`→ ${1}` + "\\u2192"')
    expect(run(out)).toBe('→ 1→')
  })

  it('returns pure ASCII unchanged', () => {
    const code = 'const value = 1'
    expect(toAsciiSource(code)).toBe(code)
  })
})
