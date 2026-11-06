import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from 'tailwindcss'
import { describe, expect, it } from 'vitest'

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const globalCss = read('src/renderer/styles/global.css')
const appCss = read('src/renderer/styles/app.css')

/** Every `{…}` body (balanced) whose prelude ends with `prelude`, plus the text before it. */
function blocks(source: string, prelude: string): { before: string; body: string }[] {
  const found: { before: string; body: string }[] = []
  let from = 0
  for (;;) {
    const at = source.indexOf(`${prelude} {`, from)
    if (at === -1) return found
    const open = source.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++
      else if (source[end] === '}' && --depth === 0) break
    }
    found.push({ before: source.slice(0, at), body: source.slice(open + 1, end) })
    from = end
  }
}

function declarations(body: string): Map<string, string> {
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()])
  )
}

const literalColour = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i

describe('chat theme tokens', () => {
  const darkBridge = declarations(blocks(globalCss, ':root')[0]!.body)
  // The dark bridge's fixed colours are exactly the ones a light theme must replace.
  const fixedColourTokens = [...darkBridge]
    .filter(([name, value]) => name.startsWith('--an-') && literalColour.test(value))
    .map(([name]) => name)

  it('finds the fixed dark colours the transcript is bridged to', () => {
    expect(fixedColourTokens).toEqual(
      expect.arrayContaining([
        '--an-foreground',
        '--an-user-message-bg',
        '--an-tool-background',
        '--an-border-color'
      ])
    )
  })

  const lightBlocks = {
    light: blocks(globalCss, "html[data-theme='light']").find((block) =>
      block.body.includes('--an-foreground')
    ),
    'system on a light OS': blocks(globalCss, "html[data-theme='system']").find(
      (block) =>
        block.body.includes('--an-foreground') &&
        block.before.lastIndexOf('@media (prefers-color-scheme: light)') >
          block.before.lastIndexOf('@media (prefers-color-scheme: dark)')
    )
  }

  for (const [label, block] of Object.entries(lightBlocks)) {
    it(`gives every bridged chat colour a theme token in ${label}`, () => {
      expect(block).toBeDefined()
      const light = declarations(block!.body)
      for (const name of fixedColourTokens) {
        const value = light.get(name)
        expect(value, name).toBeDefined()
        expect(value, name).toMatch(/var\(--/)
        expect(value, name).not.toMatch(literalColour)
      }
    })
  }

  it('resolves dark: utilities from the app theme, not the OS colour scheme', async () => {
    const variant = blocks(globalCss, '@custom-variant dark')[0]
    expect(variant).toBeDefined()
    const compiler = await compile(`@custom-variant dark {${variant!.body}}\n@tailwind utilities;`)
    const css = compiler.build(['dark:text-[red]'])
    expect(css).toContain(":where(html:not([data-theme='light']):not([data-theme='system']) *)")
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*\S+:where\(html\[data-theme='system'\] \*\)/
    )
    // Without the custom variant, Tailwind's default would key on the OS alone.
    expect(css.replace(/@media[^{]+\{[^{}]*\{[^{}]*\}\s*\}/g, '')).not.toContain('@media')
  })

  it('keeps the composer placeholder readable on light surfaces', () => {
    expect(appCss).toMatch(
      /html\[data-theme='light'\] \.composer-input::placeholder[^{]*\{\s*color:\s*var\(--text-secondary\)/
    )
    expect(appCss).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*html\[data-theme='system'\] \.composer-input::placeholder\s*\{\s*color:\s*var\(--text-secondary\)/
    )
  })
})
