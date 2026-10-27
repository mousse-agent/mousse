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

  it('dims idle tool chrome so assistant text keeps the contrast', () => {
    expect(globalCss).toMatch(
      /\.an-message-list \.an-tool-chrome\s*\{[\s\S]*?opacity:\s*0\.55/
    )
    // Hover and keyboard focus intentionally keep the dimmed level; only a
    // running shimmer or a card awaiting approval returns to full opacity.
    expect(globalCss).not.toMatch(/\.an-tool-chrome:hover/)
    expect(globalCss).not.toMatch(/\.an-tool-chrome:focus-within/)
    expect(globalCss).toMatch(
      /\.an-tool-chrome:has\(\.an-text-shimmer--active\)\s*\{\s*opacity:\s*1;/
    )
    expect(globalCss).toMatch(
      /\.an-tool-chrome\[data-awaiting-approval="true"\]\s*\{\s*opacity:\s*1;/
    )
    const toolRowBase = readFileSync(
      resolve(process.cwd(), 'src/renderer/chat/components/agent-elements/tools/tool-row-base.tsx'),
      'utf8'
    )
    expect(toolRowBase).toMatch(/an-tool-chrome/)
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

  it('renders quick-action bash with highlighting but no code header', () => {
    // The "Action" micro-label already names the block, so the Streamdown
    // language header row is hidden via CSS while shiki highlighting stays.
    expect(globalCss).toMatch(
      /\.an-code-no-header[\s\S]*?code-block-header[\s\S]*?display:\s*none/
    )
    // Bash preview matches the Git tab diff surface (12px).
    expect(globalCss).toMatch(
      /\.an-markdown\.an-code-no-header[\s\S]*?font-family:\s*inherit/
    )
    expect(globalCss).toMatch(
      /\.an-markdown\.an-code-no-header[\s\S]*?font-size:\s*12px/
    )
    const quickActionTool = readFileSync(
      resolve(process.cwd(), 'src/renderer/chat/components/agent-elements/tools/quick-action-tool.tsx'),
      'utf8'
    )
    expect(quickActionTool).toMatch(/codeHighlighter/)
    expect(quickActionTool).toMatch(/```bash/)
    expect(quickActionTool).toMatch(/an-code-no-header/)
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

  it('slides the overlay card in from the right with a scrim, and drops the slide for reduced motion', () => {
    const [overlayCard] = rulesFor(sideCardCss, '.thread-side-card-layer--overlay .thread-side-card').filter((rule) => rule.selector === '.thread-side-card-layer--overlay .thread-side-card')
    expect(overlayCard!.body).toMatch(/transform:\s*translateX\(calc\(100% \+ var\(--side-card-gutter\)\)\)/)
    expect(overlayCard!.body).toMatch(/width:\s*min\(var\(--side-card-width\), calc\(100% - 2 \* var\(--side-card-gutter\)\)\)/)
    expect(sideCardCss).toMatch(/\.thread-side-card-scrim\s*\{[^}]*position:\s*absolute/)
    const reduced = sideCardCss.slice(sideCardCss.indexOf('prefers-reduced-motion'))
    expect(reduced).toMatch(/\.thread-side-card\.thread-side-card\.thread-side-card\[data-shown\]\s*\{[^}]*transform:\s*none/)
  })
})
