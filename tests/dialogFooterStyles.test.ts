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

  it('fades the edges of a scrolling body by scroll position instead of cutting rows at the header or footer', () => {
    const body = block('.modal-body')
    const mask =
      'linear-gradient(to bottom, transparent, #000 var(--modal-body-fade-top), #000 calc(100% - var(--modal-body-fade-bottom)), transparent)'
    expect(body['mask-image']).toBe(mask)
    expect(body['-webkit-mask-image']).toBe(mask)
    expect(body.animation).toBe('modal-body-fade-top linear both, modal-body-fade-bottom linear both')
    expect(body['animation-timeline']).toBe('scroll(self)')
    // Top fade grows over the first --modal-fade of scrolling; bottom fade shrinks over the last.
    expect(body['animation-range']).toBe('0px var(--modal-fade, 18px), calc(100% - var(--modal-fade, 18px)) 100%')
    expect(px(block('.modal-body:has(+ .modal-footer)')['padding-bottom'], tokens)).toBeLessThan(
      px(splitPadding(block('.modal-footer').padding)[0], tokens)
    )

    const fade = px('var(--modal-fade)', tokens)
    expect(fade).toBe(18)
    const keyframes = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*)\\s*\\}`).exec(css)?.[1] ?? ''
    // At the top of the list no top fade; once scrolled away, the full fade.
    expect(block('from', keyframes('modal-body-fade-top'))['--modal-body-fade-top']).toBe('0px')
    expect(block('to', keyframes('modal-body-fade-top'))['--modal-body-fade-top']).toMatch(/^var\(--modal-fade/)
    // While more is below the full fade; none at the end of the list.
    expect(block('from', keyframes('modal-body-fade-bottom'))['--modal-body-fade-bottom']).toMatch(/^var\(--modal-fade/)
    expect(block('to', keyframes('modal-body-fade-bottom'))['--modal-body-fade-bottom']).toBe('0px')

    // A body that fits has no active scroll timeline, so both fades fall back to none.
    for (const edge of ['top', 'bottom']) {
      const property = block(`@property --modal-body-fade-${edge}`)
      expect(property['initial-value']).toBe('0px')
      expect(property.syntax).toBe("'<length>'")
      expect(property.inherits).toBe('false')
    }
  })
})
