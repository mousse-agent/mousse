// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAcrylic } from '../../src/renderer/hooks/useTheme'

// jsdom replaces URL, so paths are resolved from this file's folder.
const RENDERER = resolve(__dirname, '../../src/renderer')
const source = (path: string) => readFileSync(join(RENDERER, path), 'utf8').replace(/\r\n/g, '\n')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

/** Every rule as [selector, body], comments removed; nested blocks (media queries) are read for their own rules. */
function rules(css: string): [string, string][] {
  const out: [string, string][] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([match[1]!.trim(), match[2]!])
  return out
}

const BLUR = /backdrop-filter:\s*(blur\(|var\(--glass-blur\))/

describe('glass blur on surfaces that stay on screen', () => {
  it('defaults the glass blur to none, as the window material does the blurring', () => {
    expect(source('styles/global.css')).toMatch(/--glass-blur: none;/)
  })

  it('leaves no backdrop blur on the persistent chrome or on each prompt in the transcript', () => {
    const all = cssFiles(RENDERER).flatMap((file) => rules(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).map(([selector, body]) => ({ file: relative(RENDERER, file), selector, body })))
    const chrome = ['.titlebar', '.sidebar', '.main-area .header', '.composer', '.threads-sidebar', '.message-user', '.panel-toolbar', '.browser-toolbar']
    for (const name of chrome) {
      const blurring = all.filter(({ selector, body }) =>
        selector.split(',').some((part) => part.trim() === name || part.trim().endsWith(` ${name}`)) &&
        BLUR.test(body) &&
        // Kept: the frosted composer setting, a deliberate see-through card.
        !selector.includes("data-frosted-composer='true'") &&
        // Acrylic's own surfaces are left as they are.
        !selector.includes("data-acrylic='true'")
      )
      expect(blurring.map(({ file, selector }) => `${file}: ${selector}`), name).toEqual([])
    }
  })

  it('keeps a prompt row as solid as before: its own surface colour, no blur', () => {
    const [, body] = rules(source('styles/app.css')).find(([selector]) => selector === '.message-user')!
    expect(body).toContain('background: var(--bg-secondary)')
    expect(body).not.toMatch(/backdrop-filter/)
  })

  it('uses the glass blur token only in the acrylic theme file and the Automations page', () => {
    const users = cssFiles(RENDERER)
      .filter((file) => /backdrop-filter:\s*var\(--glass-blur\)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(RENDERER, file).replace(/\\/g, '/'))
      .sort()
    // The Automations page keeps its own styles; the token is `none` outside acrylic, so it draws no blur there.
    expect(users).toEqual(['styles/automations-page.css', 'styles/themes/acrylic.css'])
  })

  it('keeps the blur where something shows through: the frosted composer and toasts', () => {
    const frosted = rules(source('styles/polish.css')).find(([selector]) => selector.includes("html[data-frosted-composer='true'] .app .chat:not(.chat--empty) .chat-input-area .composer"))!
    expect(frosted[1]).toMatch(/backdrop-filter: blur\(var\(--frosted-composer-blur/)
    expect(source('styles/toast.css')).toMatch(/backdrop-filter: blur\(22px\)/)
  })
})

describe('the glass blur token at runtime', () => {
  beforeEach(() => {
    vi.stubGlobal('mousse', { platform: 'win32' })
  })
  afterEach(() => {
    document.documentElement.removeAttribute('style')
    vi.unstubAllGlobals()
  })

  it.each([true, false])('is none with acrylic %s: the native material blurs once for the whole window', (acrylic) => {
    applyAcrylic(acrylic, 50, 'dark')
    expect(document.documentElement.style.getPropertyValue('--glass-blur')).toBe('none')
  })
})
