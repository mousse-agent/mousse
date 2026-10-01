import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalStyles = readFileSync(new URL('../src/renderer/styles/global.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('title bar layout', () => {
  it('uses a fixed title bar height (not viewport-relative)', () => {
    expect(globalStyles).toMatch(/--titlebar-height:\s*48px/)
    expect(globalStyles).not.toMatch(/--titlebar-height:[^;]*vh/)
  })

  it('keeps the bar and drag surface sized from the shared height with compact controls', () => {
    expect(appStyles).toMatch(/\.titlebar\s*\{[\s\S]*?height:\s*var\(--titlebar-height\)/)
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?height:\s*100%/)
    expect(appStyles).toMatch(/\.icon-btn-titlebar\s*\{[\s\S]*?width:\s*34px[\s\S]*?height:\s*34px/)
  })

  it('vertically centers the compact profile control in the title bar', () => {
    expect(appStyles).toMatch(
      /\.profile-switcher\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?height:\s*var\(--titlebar-height\)/
    )
  })

  it('uses native app-region drag on the title bar (not JS setBounds drag)', () => {
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?-webkit-app-region:\s*drag/)
    expect(appStyles).toMatch(/\.titlebar-controls\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(appStyles).toMatch(/\.titlebar-sidebar-toggle\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
  })

  it('keeps overlay-page headers clear of the macOS traffic lights', () => {
    // Back buttons must not crowd the native red/yellow/green cluster:
    // inset plus breathing room, darwin only.
    expect(globalStyles).toMatch(
      /html\.platform-darwin \.overlay-page-drag-header\s*\{[\s\S]*?padding-left:\s*calc\(var\(--titlebar-traffic-light-inset\)[^;]*\)/
    )
  })
})
