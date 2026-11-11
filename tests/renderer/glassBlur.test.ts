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

const BLUR = /backdrop-filter:\s*(blur\(|var\()/
const allRules = () => cssFiles(RENDERER).flatMap((file) => rules(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).map(([selector, body]) => ({ file: relative(RENDERER, file).replace(/\\/g, '/'), selector, body })))

describe('no blur where nothing shows through', () => {
  it('has no glass blur token left: the native window material blurs once, so nothing reads or sets it', () => {
    const users = cssFiles(RENDERER).filter((file) => readFileSync(file, 'utf8').includes('--glass-blur')).map((file) => relative(RENDERER, file))
    expect(users).toEqual([])
    expect(source('hooks/useTheme.ts')).not.toContain('--glass-blur')
  })

  it('leaves no backdrop blur on the persistent chrome, the Automations page or each prompt, with acrylic on or off', () => {
    const all = allRules()
    const chrome = ['.titlebar', '.sidebar', '.main-area .header', '.composer', '.threads-sidebar', '.message-user', '.chat-user-bubble', '.panel-toolbar', '.browser-toolbar', '.automations-page', '.usage-rail-page']
    for (const name of chrome) {
      const blurring = all.filter(({ selector, body }) =>
        selector.split(',').some((part) => part.trim() === name || part.trim().endsWith(` ${name}`)) &&
        BLUR.test(body) &&
        // Kept: the frosted composer setting, a deliberate see-through card.
        !selector.includes("data-frosted-composer='true'")
      )
      expect(blurring.map(({ file, selector }) => `${file}: ${selector}`), name).toEqual([])
    }
  })

  it('keeps a prompt row as solid as before: its own surface colour, no blur', () => {
    const [, body] = rules(source('styles/app.css')).find(([selector]) => selector === '.message-user')!
    expect(body).toContain('background: var(--bg-secondary)')
    expect(body).not.toMatch(/backdrop-filter/)
  })

  it('keeps the Automations page on its own opaque fill, with no blur under it', () => {
    const [, body] = rules(source('styles/automations-page.css')).find(([selector]) => selector.split(',')[0]!.trim() === '.automations-page')!
    expect(body).toContain('background-color: var(--bg-primary, #15171b)')
    expect(body).not.toMatch(/backdrop-filter/)
  })
})

describe('blur that stays: something varied shows through it', () => {
  it('keeps the frosted composer setting and toasts', () => {
    const frosted = rules(source('styles/polish.css')).find(([selector]) => selector.includes("html[data-frosted-composer='true'] .app .chat:not(.chat--empty) .chat-input-area .composer"))!
    expect(frosted[1]).toMatch(/backdrop-filter: blur\(var\(--frosted-composer-blur/)
    expect(source('styles/toast.css')).toMatch(/backdrop-filter: blur\(22px\)/)
  })

  it('keeps the dialog blur over the content behind dialogs, Search and the integrations dialog', () => {
    expect(source('styles/app.css')).toMatch(/--ui-dialog-blur: blur\(3px\);/)
    const users = allRules().filter(({ body }) => /backdrop-filter:\s*var\(--ui-dialog-blur\)/.test(body)).map(({ selector }) => selector).sort()
    expect(users).toEqual(['.integration-modal-backdrop', '.modal-overlay', '.thread-search-overlay'])
  })

  it('keeps the image viewer blur', () => {
    expect(source('chat/components/agent-elements/image-lightbox.tsx')).toMatch(/image-preview-overlay[^"]*backdrop-blur-sm/)
  })
})

describe('the acrylic switch at runtime', () => {
  beforeEach(() => {
    vi.stubGlobal('mousse', { platform: 'win32' })
  })
  afterEach(() => {
    document.documentElement.removeAttribute('style')
    vi.unstubAllGlobals()
  })

  it.each([true, false])('sets no glass blur with acrylic %s', (acrylic) => {
    applyAcrylic(acrylic, 50, 'dark')
    expect(document.documentElement.style.getPropertyValue('--glass-blur')).toBe('')
  })
})
