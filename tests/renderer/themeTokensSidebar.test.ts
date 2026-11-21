import { describe, expect, it } from 'vitest'
import { themeTokensCss } from '../../src/renderer/lib/themeCss'

/**
 * A theme's background is the whole window frame: --surface-base reaches the title bar, the rail, the sidebar and the
 * acrylic tint, over the base themes' own frame colors. An older theme that colors only --surface-strong keeps its
 * colored sidebar. The look itself is tests/renderer/frameless-shell-electron.test.ts (scenario 5).
 */
const FRAME = ['--vscode-titleBar-activeBackground', '--vscode-activityBar-background', '--vscode-sideBar-background']

describe('themeTokensCss frame colors', () => {
  it.each([
    ['--surface-base alone', { '--surface-base': '#0d1512' }],
    ['--surface-base with a panel color', { '--surface-base': '#0d1512', '--surface-strong': '#102619' }],
    ['--surface-base with an invalid --surface-strong', { '--surface-base': '#0d1512', '--surface-strong': 'url(https://evil.example/x)' }]
  ])('%s colors the whole frame with it', (_label, colors) => {
    const css = themeTokensCss(colors)
    for (const name of FRAME) {
      expect(css).toContain(`${name}: var(--surface-base) !important;`)
      expect(css.split(`${name}:`).length - 1, name).toBe(1)
    }
    expect(css).toContain('--acrylic-base-rgb: var(--surface-base-rgb) !important;')
  })

  it('an older theme with only --surface-strong keeps its sidebar color and leaves the rest of the frame alone', () => {
    const css = themeTokensCss({ '--surface-strong': '#102619' })
    expect(css).toContain('--vscode-sideBar-background: var(--surface-strong) !important;')
    expect(css).not.toContain('--vscode-titleBar-activeBackground')
  })

  it('a base color without r, g, b channels leaves the acrylic tint alone', () => {
    expect(themeTokensCss({ '--surface-base': 'rgb(13 21 18)' })).not.toContain('--acrylic-base-rgb')
  })

  it('no frame color when neither surface token is valid', () => {
    const css = themeTokensCss({ '--accent': '#4ade80', '--surface-strong': 'url(https://evil.example/x)' })
    expect(css).toContain('--accent: #4ade80 !important;')
    for (const name of FRAME) expect(css).not.toContain(name)
  })
})
