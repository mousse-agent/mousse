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
    expect(appStyles).toMatch(/\.titlebar\s*\{[^}]*?height:\s*var\(--theme-titlebar-height,\s*var\(--titlebar-height\)\)/)
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?height:\s*100%/)
    expect(appStyles).toMatch(/\.icon-btn-titlebar\s*\{[^}]*?width:\s*32px[^}]*?height:\s*32px/)
  })

  it('uses native app-region drag on the title bar (not JS setBounds drag)', () => {
    expect(appStyles).toMatch(/\.titlebar-drag\s*\{[\s\S]*?-webkit-app-region:\s*drag/)
    expect(appStyles).toMatch(/\.titlebar-controls\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(appStyles).toMatch(/\.titlebar-start-actions\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/)
  })

  it('keeps the "Mousse" word after the logo, before the start actions, in the sans font', () => {
    const titleBar = readFileSync(new URL('../src/renderer/components/TitleBar.tsx', import.meta.url), 'utf8')
    const fonts = readFileSync(new URL('../src/renderer/styles/geist-fonts.css', import.meta.url), 'utf8')
    const compact = readFileSync(new URL('../src/renderer/styles/compact-shell.css', import.meta.url), 'utf8')
    const logo = titleBar.indexOf('titlebar-logo-icon')
    const word = titleBar.search(/>\s*Mousse\s*</)
    expect(logo).toBeGreaterThan(-1)
    expect(word).toBeGreaterThan(logo)
    expect(titleBar.indexOf('titlebar-start-actions')).toBeGreaterThan(word)
    expect(titleBar).toMatch(/titlebar-title\$\{threadsSidebarOpen \? ' titlebar-title-visible' : ''\}/)

    const title = appStyles.match(/\n\.titlebar-title\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(title).toMatch(/font-size:\s*calc\(var\(--titlebar-height\)\s*\*\s*0\.54\)/)
    expect(title).toMatch(/font-weight:\s*600/)
    expect(title).toMatch(/letter-spacing:\s*-0\.02em/)
    expect(title).toMatch(/color:\s*var\(--text-primary\)/)
    expect(fonts).toMatch(/body,\s*\.titlebar-title\s*\{\s*font-family:\s*var\(--font-sans\)/)
    expect(compact).toMatch(/\.app \.titlebar-title,\s*\.overlay-titlebar h1\s*\{\s*font-size:\s*18px/)
  })

  it('keeps the start actions from shrinking and hides the word only below 560px', () => {
    expect(appStyles).toMatch(/\.titlebar-start-actions\s*\{[^}]*flex-shrink:\s*0/)
    expect(appStyles).toMatch(/\.titlebar-brand\s*\{[^}]*min-width:\s*var\(--navigation-rail-width\)/)
    expect(appStyles).toMatch(
      /@media \(max-width:\s*560px\)\s*\{\s*\.titlebar-title\.titlebar-title-visible\s*\{[^}]*max-width:\s*0/
    )
  })

  it('keeps overlay-page headers clear of the macOS traffic lights', () => {
    // Back buttons must not crowd the native red/yellow/green cluster:
    // inset plus breathing room, darwin only. Every overlay drag header is
    // an `.overlay-titlebar`, which carries the inset.
    expect(globalStyles).toMatch(
      /html\.platform-darwin \.overlay-titlebar\s*\{[^}]*?padding-left:\s*calc\(var\(--titlebar-traffic-light-inset\)\s*\+[^;]*\)/
    )
  })
})
