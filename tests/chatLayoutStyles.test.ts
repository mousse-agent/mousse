import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')
const sideCardCss = readFileSync(resolve(process.cwd(), 'src/renderer/components/sideCard/sideCard.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration blocks whose selector list mentions `selector`. */
const rulesFor = (source: string, selector: string) =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]!.includes(selector))
    .map((match) => ({ selector: match[1]!.trim(), body: match[2]! }))

describe('chat layout styles', () => {
  it('allows the chat flex containers to shrink so messages remain scrollable', () => {
    expect(css).toMatch(/\.chat\s*\{[\s\S]*?min-height:\s*0;/)
    expect(css).toMatch(/\.chat-messages\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/)
  })

  it('keeps the universal reset layered so Tailwind spacing utilities win', () => {
    // An unlayered `* { margin: 0; padding: 0 }` beats every layered utility
    // and silently zeroes all p-*/m-*/space-* classes (transcript gutters,
    // user bubbles, tool rows). It must live in `base`, below `utilities`.
    expect(globalCss).toMatch(
      /@layer base\s*\{[\s\S]*?\*,\s*\*::before,\s*\*::after\s*\{[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0;/
    )
  })

  it('preserves single newlines in prose as line breaks', () => {
    // Chat convention (verses, addresses): a lone \n breaks the line.
    // Scoped to text elements so fences, tables, and list structure keep
    // spec behavior.
    expect(globalCss).toMatch(
      /\.an-markdown \.an-md-p,[\s\S]*?\{[\s\S]*?white-space:\s*pre-line/
    )
  })

  it('registers Streamdown internals for Tailwind scanning', () => {
    // Streamdown renders its own utilities at runtime (space-y-4 stanza
    // rhythm, code-block padding, dark: shiki variants) from inside
    // node_modules, which automatic content detection skips (gitignored).
    // Without an explicit @source those classes never compile.
    expect(globalCss).toMatch(/@source\s+["'][^"']*streamdown[^"']*["']/)
  })

  it('keeps the scrollbar at the pane edge when the side card is reserved', () => {
    // The card's clearance used to be padding on the pane, which inset the scroller
    // and left its scrollbar floating left of a strip under the card. It now
    // narrows only the content column and the composer, through a px variable the
    // card writes, so the scroller keeps the pane's full width.
    expect(sideCardCss).not.toMatch(/\.keep-mounted-pane\s*\{[^}]*padding/)
    expect(sideCardCss).not.toMatch(/sidebar-side-card/)
    const column = rulesFor(sideCardCss, '.an-message-list > div').filter((rule) => rule.body.includes('--side-card-reserved'))
    expect(column).toHaveLength(1)
    expect(column[0]!.selector).toContain('.chat-input-area')
    expect(column[0]!.body).not.toMatch(/padding/)
    // Nothing in the reservation targets the scroller itself, or its parents, with an inset.
    for (const selector of ['.an-message-list', '.an-message-list-wrap', '.keep-mounted-pane', '.chat']) {
      for (const rule of rulesFor(sideCardCss, selector)) {
        if (rule.selector.includes('.an-message-list > div')) continue
        expect(rule.body, rule.selector).not.toMatch(/(padding|margin)-right/)
      }
    }
  })

  it('animates the reserved column unless motion is reduced', () => {
    const column = rulesFor(sideCardCss, '.an-message-list > div')
    const reduced = sideCardCss.slice(sideCardCss.indexOf('prefers-reduced-motion'))
    expect(column[0]!.body).toMatch(/transition:\s*width/)
    expect(reduced).toMatch(/\.an-message-list > div[\s\S]*?transition:\s*none/)
  })

})
