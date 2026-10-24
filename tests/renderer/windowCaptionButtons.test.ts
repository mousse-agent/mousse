import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowCaptionButtons } from '../../src/renderer/components/WindowCaptionButtons'

const render = (platform: string) => {
  vi.stubGlobal('window', { mousse: { platform } })
  return renderToStaticMarkup(createElement(WindowCaptionButtons))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WindowCaptionButtons', () => {
  it('draws minimize, maximize and close on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      const markup = render(platform)
      expect(markup, platform).toContain('aria-label="Minimize"')
      expect(markup, platform).toContain('aria-label="Maximize"')
      expect(markup, platform).toContain('aria-label="Close"')
    }
  })

  it('draws nothing on macOS, which has native traffic lights', () => {
    expect(render('darwin')).toBe('')
  })

  it('appears in the Settings header, which covers the app title bar', () => {
    const source = readFileSync(new URL('../../src/renderer/components/SettingsPage.tsx', import.meta.url), 'utf8')
    const header = source.slice(source.indexOf('const settingsHeader = ('), source.indexOf('</header>'))
    expect(header).toContain('<WindowCaptionButtons />')
  })
})
