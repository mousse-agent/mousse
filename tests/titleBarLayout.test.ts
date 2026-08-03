import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalStyles = readFileSync(new URL('../src/renderer/styles/global.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('title bar layout', () => {
  it('uses a fixed title bar height (not viewport-relative)', () => {
    expect(globalStyles).toMatch(/--titlebar-height:\s*48px/)
    expect(globalStyles).not.toMatch(/--titlebar-height:[^;]*vh/)
  })

  it('keeps the bar, drag surface, and window controls sized from the shared height', () => {
    expect(appStyles).toMatch(/\.titlebar\s*\{[\s\S]*?height:\s*var\(--titlebar-height\)/)
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?height:\s*100%/)
    expect(appStyles).toMatch(/\.icon-btn-titlebar\s*\{[\s\S]*?width:\s*var\(--titlebar-height\)[\s\S]*?height:\s*var\(--titlebar-height\)/)
  })

  it('uses native app-region drag on the title bar (not JS setBounds drag)', () => {
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?-webkit-app-region:\s*drag/)
    expect(appStyles).toMatch(/\.titlebar-controls\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(appStyles).toMatch(/\.titlebar-sidebar-toggle\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
  })
})
