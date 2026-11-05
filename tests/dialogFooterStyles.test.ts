import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The shared dialog (ui/Modal): a scrolling body, then the footer as its own row.
const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Declarations of every innermost block whose selector is exactly `selector`, later ones winning. */
function block(selector: string, source = css): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].trim() !== selector) continue
    for (const line of match[2].split(';')) {
      const at = line.indexOf(':')
      if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  return out
}

/** `var(--name, fallback)` or a plain length, resolved against the dialog's own tokens, in px. */
function px(value: string, tokens: Record<string, string>): number {
  const token = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(value)
  const resolved = token ? tokens[token[1]] ?? token[2] : value
  const number = /^(-?[\d.]+)px$/.exec(resolved?.trim() ?? '')
  if (!number) throw new Error(`not a px length: ${value}`)
  return Number(number[1])
}

const splitPadding = (value: string) => value.match(/var\([^)]*\)|\S+/g) ?? []

describe('dialog footer', () => {
  const tokens = block('.modal')
  const inset = px('var(--modal-inset)', tokens)

  it('sits on its own row with the dialog inset and a clear gap above the buttons', () => {
    const footer = block('.modal-footer')
    const [top, right, bottom] = splitPadding(footer.padding).map((part) => px(part, tokens))
    expect(inset).toBe(16)
    expect(top).toBeGreaterThanOrEqual(12)
    expect(right).toBe(inset)
    expect(bottom).toBe(inset)
    expect(footer['flex-shrink']).toBe('0')
    // No divider above dialog footers.
    expect(footer['border-top']).toBeUndefined()
    expect(footer.border).toBeUndefined()
  })

  it('shares its inset with the header and the body', () => {
    expect(splitPadding(block('.modal-header').padding).at(-1)).toMatch(/^var\(--modal-inset/)
    const body = splitPadding(block('.modal-body').padding)
    expect(px(body[1], tokens)).toBe(inset)
    expect(block('.modal-body')['overflow-y']).toBe('auto')
  })

  it('keeps footer buttons at the one 28px control height', () => {
    const button = block('.modal-footer > button')
    expect(button.height).toBe('var(--settings-control-h, 28px)')
    expect(button['min-height']).toBe('0')
  })

  it('fades the last rows of a scrolling body instead of cutting them at the footer', () => {
    const body = block('.modal-body:has(+ .modal-footer)')
    const mask = 'linear-gradient(to bottom, #000 calc(100% - var(--modal-body-fade)), transparent)'
    expect(body['mask-image']).toBe(mask)
    expect(body['-webkit-mask-image']).toBe(mask)
    expect(body['animation-timeline']).toBe('scroll(self)')
    expect(body.animation).toMatch(/^modal-body-fade\b/)
    expect(px(body['padding-bottom'], tokens)).toBeLessThan(px(splitPadding(block('.modal-footer').padding)[0], tokens))

    // 16-20px while more is below, none at the end of the list.
    const fade = px('var(--modal-fade)', tokens)
    expect(fade).toBeGreaterThanOrEqual(16)
    expect(fade).toBeLessThanOrEqual(20)
    const keyframes = /@keyframes modal-body-fade\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/.exec(css)?.[1] ?? ''
    expect(block('0%, 90%', keyframes)['--modal-body-fade']).toMatch(/^var\(--modal-fade/)
    expect(block('100%', keyframes)['--modal-body-fade']).toBe('0px')

    // A body that does not scroll has no active scroll timeline, so the fade falls back to none.
    const property = block('@property --modal-body-fade')
    expect(property['initial-value']).toBe('0px')
    expect(property.syntax).toBe("'<length>'")
  })
})
