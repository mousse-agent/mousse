import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalStyles = readFileSync(new URL('../src/renderer/styles/global.css', import.meta.url), 'utf8')
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('title bar layout', () => {
  it('uses the responsive height range reduced by 20 percent', () => {
    expect(globalStyles).toMatch(/--titlebar-height:\s*clamp\(41\.6px,\s*6\.4vh,\s*57\.6px\)/)
  })

  it('keeps the bar, drag surface, and window controls sized from the shared height', () => {
    expect(appStyles).toMatch(/\.titlebar\s*\{[\s\S]*?height:\s*var\(--titlebar-height\)/)
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?height:\s*100%/)
    expect(appStyles).toMatch(/\.icon-btn-titlebar\s*\{[\s\S]*?width:\s*var\(--titlebar-height\)[\s\S]*?height:\s*var\(--titlebar-height\)/)
  })
})
