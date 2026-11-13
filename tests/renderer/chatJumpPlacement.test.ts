import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const polish = readFileSync(new URL('../../src/renderer/styles/polish.css', import.meta.url), 'utf8')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

/** The px offset added to the composer's height in `calc(var(--chat-composer-stack, …) ± Npx)`. */
const offset = (text: string, sign = 1) => {
  const match = /var\(--chat-composer-stack, \d+px\) ([+-]) (\d+)px/.exec(text)
  expect(match, text).not.toBeNull()
  return (match![1] === '-' ? -1 : 1) * Number(match![2]) * sign
}

describe('Go to latest', () => {
  it('floats over the transcript a few px above the composer, and takes no height', () => {
    const jump = rule(polish, '.chat-jump')
    const bottom = offset(/bottom: (.*);/.exec(jump)![1]!)
    expect(bottom).toBeGreaterThanOrEqual(4)
    expect(bottom).toBeLessThanOrEqual(12)
    // Positioned over the list, not laid out in it.
    const list = readFileSync(new URL('../../src/renderer/chat/components/agent-elements/message-list.tsx', import.meta.url), 'utf8')
    expect(list).toMatch(/"chat-jump absolute left-1\/2 [^"]*-translate-x-1\/2"/)
  })

  it('is a quiet pill: chevron and "Go to latest" in muted text on a subtle fill, no border', () => {
    const jump = rule(polish, '.chat-jump')
    expect(jump).toContain('border: 0')
    expect(jump).toContain('border-radius: 999px')
    expect(jump).toContain('color: var(--text-secondary)')
    expect(jump).toMatch(/background: color-mix\(in srgb, var\(--text-primary\) \d+%, var\(--surface-base\)\)/)
    const hover = rule(polish, '.chat-jump:hover')
    expect(hover).toContain('color: var(--text-primary)')
    expect(hover).toMatch(/background: color-mix/)
    const list = readFileSync(new URL('../../src/renderer/chat/components/agent-elements/message-list.tsx', import.meta.url), 'utf8')
    expect(list).toMatch(/<IconChevronDown className="chat-jump-icon"[^>]*\/>\s*<span>Go to latest<\/span>/)
  })

  it('takes no input while the view follows the end', () => {
    const list = readFileSync(new URL('../../src/renderer/chat/components/agent-elements/message-list.tsx', import.meta.url), 'utf8')
    expect(list).toContain('inert={!showJumpButton}')
  })

  it('lets the transcript run down to the composer, fading only in the last few px above it', () => {
    const mask = rule(polish, '.chat:not(.chat--empty) .an-message-list')
    // `100% - stack - Npx` from the top is N px above the composer.
    const stops = [...mask.matchAll(/(#000|transparent) max\(28px, calc\((100% - var\(--chat-composer-stack, \d+px\) [+-] \d+px)\)\)/g)]
    const opaque = offset(stops.find((stop) => stop[1] === '#000')![2]!, -1)
    const clear = offset(stops.find((stop) => stop[1] === 'transparent')![2]!, -1)
    expect(opaque).toBeLessThanOrEqual(16)
    expect(clear).toBe(0)
    // At the end of the transcript, the last line ends above the fade, and not much higher.
    const padding = offset(rule(polish, '.chat:not(.chat--empty) .an-message-list > div:not([data-end-reserve])'))
    expect(padding).toBeGreaterThanOrEqual(opaque)
    expect(padding).toBeLessThanOrEqual(opaque + 8)
  })

  it('hides while a composer menu or the notice slot is open', () => {
    expect(rule(polish, '.chat:has(.chat-composer-stack [aria-expanded="true"], .composer-notice-slot) .chat-jump')).toContain('display: none')
  })
})
