import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readStyle = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('slash command popover styles', () => {
  it('uses the opaque floating surface token', () => {
    const css = readStyle('src/renderer/styles/app.css')

    expect(css).toMatch(
      /\.composer-command-suggestions\s*\{[\s\S]*?background:\s*var\(--floating-surface\);/
    )
  })

  it('maps the floating surface to solid colors in light themes', () => {
    expect(readStyle('src/renderer/styles/themes/light.css')).toContain(
      '--floating-surface: var(--surface-light-strong);'
    )
  })

  it('keeps opaque floating surfaces on dark themes', () => {
    expect(readStyle('src/renderer/styles/themes/dark.css')).toContain(
      '--floating-surface: var(--surface-strong);'
    )
    expect(readStyle('src/renderer/styles/themes/blacksphere-plus.css')).toContain(
      '--floating-surface: #161616;'
    )
  })

  it('defaults the floating surface to the opaque dark surface', () => {
    expect(readStyle('src/renderer/styles/global.css')).toContain(
      '--floating-surface: var(--surface-strong);'
    )
  })

  it('does not clip the popup inside .composer (the dropdown overflows above it)', () => {
    const css = readStyle('src/renderer/styles/app.css')
    const blocks = [...css.matchAll(/\.composer\s*\{([^}]*)\}/g)].map((match) => match[1])
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toMatch(/overflow(-[xy])?\s*:\s*(hidden|clip|auto|scroll)/)
    }
  })

  it('keeps the collapse wrapper from clipping the popup when open', () => {
    const css = readStyle('src/renderer/styles/app.css')
    expect(css).toMatch(/\.composer-collapse-inner\s*\{[^}]*overflow:\s*visible/)
  })
})
