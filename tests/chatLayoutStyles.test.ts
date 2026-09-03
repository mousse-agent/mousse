import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')

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
    expect(globalCss).toMatch(/\.an-tool-chrome:hover/)
    expect(globalCss).toMatch(/\.an-tool-chrome:focus-within/)
    expect(globalCss).toMatch(/:has\(\.an-text-shimmer--active\)/)
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
})
