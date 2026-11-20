import { describe, expect, it } from 'vitest'
import { themeTokensCss } from '../../src/renderer/lib/themeCss'

describe('themeTokensCss sidebar bridge', () => {
  it.each([
    [
      'bridges --surface-strong to --vscode-sideBar-background',
      { '--surface-strong': '#102619' },
      '--vscode-sideBar-background: var(--surface-strong) !important;'
    ],
    [
      'bridges --surface-base to --vscode-sideBar-background when --surface-strong is absent',
      { '--surface-base': '#0d1512' },
      '--vscode-sideBar-background: var(--surface-base) !important;'
    ],
    [
      'prefers --surface-strong over --surface-base when both are set',
      { '--surface-base': '#0d1512', '--surface-strong': '#102619' },
      '--vscode-sideBar-background: var(--surface-strong) !important;'
    ],
    [
      'ignores an invalid --surface-strong value and falls back to valid --surface-base',
      { '--surface-base': '#0d1512', '--surface-strong': 'url(https://evil.example/x)' },
      '--vscode-sideBar-background: var(--surface-base) !important;'
    ]
  ])('%s', (_label, colors, expected) => {
    const css = themeTokensCss(colors)
    expect(css).toContain(expected)
    expect(css.match(/--vscode-sideBar-background:/g)?.length).toBe(1)
  })

  it('does not emit --vscode-sideBar-background when neither surface token is valid', () => {
    const css = themeTokensCss({ '--accent': '#4ade80', '--surface-strong': 'url(https://evil.example/x)' })
    expect(css).toContain('--accent: #4ade80 !important;')
    expect(css).not.toContain('--vscode-sideBar-background')
  })
})
