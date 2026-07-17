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
    expect(readStyle('src/renderer/styles/themes/light-acrylic.css')).toContain(
      '--floating-surface: var(--surface-light-strong);'
    )
    expect(readStyle('src/renderer/styles/themes/dark-acrylic.css')).toContain(
      '--floating-surface: var(--surface-light-strong);'
    )
  })

  it('defaults the floating surface to the opaque dark surface', () => {
    expect(readStyle('src/renderer/styles/global.css')).toContain(
      '--floating-surface: var(--surface-strong);'
    )
  })
})
