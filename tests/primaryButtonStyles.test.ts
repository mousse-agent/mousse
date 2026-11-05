import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'src/renderer')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

/** Splits on commas outside parentheses (selector lists, shadow lists). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

interface Rule { file: string; selector: string; body: string }

/** Innermost `selector { declarations }` blocks, comments removed. */
function rules(file: string): Rule[] {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file: relative(root, file),
    selector: match[1].trim(),
    body: match[2]
  }))
}

const allRules = cssFiles(root).flatMap(rules)

const declarations = (body: string, property: RegExp) =>
  body.split(';').map((line) => line.trim()).filter((line) => property.test(line.split(':')[0]?.trim() ?? ''))

/** A blurred, non-inset shadow in the accent colour. Focus rings (no blur) are not glows. */
function hasAccentGlow(body: string): boolean {
  return declarations(body, /^box-shadow$/).some((line) =>
    splitTopLevel(line.slice(line.indexOf(':') + 1)).some((shadow) =>
      !shadow.startsWith('inset') &&
      /var\(--(accent|gradient)/.test(shadow) &&
      /^-?[\d.]+(px)?\s+-?[\d.]+(px)?\s+[1-9][\d.]*px/.test(shadow)
    )
  )
}

const usesGradient = (body: string) =>
  declarations(body, /^background(-image)?$/).some((line) => line.includes('--gradient-accent'))

// The composer and Chats Send buttons keep the accent fill; avatars are not buttons.
const SEND = /composer-action-btn-active|chat-send-button/
const isButton = (selector: string) => /btn|button/.test(selector)

const PRIMARY_CLASSES = [
  '.ui-btn-primary',
  '.btn-primary',
  '.chat-primary-button',
  '.an-approve-fill',
  '.composer-implement-btn',
  '.composer-question-submit',
  '.chat-run-paused-btn-primary',
  '.chat-workspace-recovery-btn-primary',
  '.scheduled-btn.primary',
  '.devices-dialog-btn.primary',
  '.side-card-git-pr-merge[data-ready]'
]

const polish = allRules.filter((rule) => rule.file === 'styles/polish.css')
const primaryRules = polish.filter((rule) => rule.selector.startsWith('html :is(') && rule.selector.includes('.btn-primary'))
/** The selector list inside the leading `html :is(...)`. */
function listOf(selector: string): string[] {
  const start = selector.indexOf('(') + 1
  let depth = 1
  let end = start
  while (depth > 0 && end < selector.length) {
    if (selector[end] === '(') depth += 1
    if (selector[end] === ')') depth -= 1
    end += 1
  }
  return splitTopLevel(selector.slice(start, end - 1))
}

describe('primary button styles', () => {
  it('no button except Send uses the accent gradient or an accent glow', () => {
    const offenders = allRules.flatMap((rule) => {
      if (!usesGradient(rule.body) && !hasAccentGlow(rule.body)) return []
      return splitTopLevel(rule.selector)
        .filter((selector) => isButton(selector) && !SEND.test(selector))
        .map((selector) => `${rule.file}: ${selector}`)
    })
    expect(offenders).toEqual([])
  })

  it('Send keeps the accent gradient', () => {
    expect(polish.some((rule) => SEND.test(rule.selector) && usesGradient(rule.body))).toBe(true)
  })

  it('every primary shares one rule: tinted neutral surface, semibold accent text, accent edge, no glow', () => {
    const [base] = primaryRules.filter((rule) => !/:hover|:disabled/.test(rule.selector))
    expect(base).toBeDefined()
    expect(listOf(base.selector)).toEqual(PRIMARY_CLASSES)
    expect(base.body).toMatch(/color:\s*var\(--btn-primary-fg\)/)
    expect(base.body).toMatch(/font-weight:\s*600/)
    expect(base.body).toMatch(/border:\s*1px solid var\(--btn-primary-border\)/)
    expect(base.body).toMatch(/background:\s*var\(--btn-primary-bg\)/)
    expect(base.body).toMatch(/box-shadow:\s*var\(--ui-specular\)/)
    expect(usesGradient(base.body) || hasAccentGlow(base.body)).toBe(false)
  })

  it('hover tints the fill and disabled drops the accent, for the same buttons', () => {
    const hover = primaryRules.find((rule) => rule.selector.includes(':hover'))
    const disabled = primaryRules.find((rule) => !rule.selector.includes(':hover') && rule.selector.includes(':disabled'))
    expect(listOf(hover!.selector)).toEqual(PRIMARY_CLASSES)
    expect(listOf(disabled!.selector)).toEqual(PRIMARY_CLASSES)
    expect(hover!.body).toMatch(/background:\s*var\(--btn-primary-hover-bg\)/)
    expect(disabled!.body).toMatch(/color:\s*var\(--text-primary\)/)
    expect(disabled!.body).toMatch(/background:\s*var\(--btn-primary-surface\)/)
    expect(disabled!.body).not.toMatch(/accent/)
  })

  it('derives the text tone from the accent, darker on light themes', () => {
    const tokens = readFileSync(resolve(root, 'styles/polish.css'), 'utf8')
    expect(tokens).toContain('--btn-primary-fg: oklch(from var(--accent) max(l, 0.76) c h);')
    expect(tokens.match(/--btn-primary-fg: oklch\(from var\(--accent\) min\(l, 0\.45\) c h\);/g)).toHaveLength(2)
  })

  it('leads its row: a stronger accent edge and an accent tint at rest, deeper on hover', () => {
    const tokens = readFileSync(resolve(root, 'styles/polish.css'), 'utf8')
    expect(tokens).toContain('--btn-primary-border: color-mix(in srgb, var(--accent) 55%, var(--ui-line-strong));')
    expect(tokens).toContain('--btn-primary-surface: var(--ui-raised);')
    expect(tokens).toContain('--btn-primary-bg: color-mix(in srgb, var(--accent) 6%, var(--btn-primary-surface));')
    expect(tokens).toContain('--btn-primary-hover-bg: color-mix(in srgb, var(--accent) 12%, var(--btn-primary-surface));')
  })

  it('sits on the same see-through surface as its neighbours on light themes, not on white', () => {
    const tokens = readFileSync(resolve(root, 'styles/polish.css'), 'utf8')
    expect(tokens.match(/--btn-primary-surface: transparent;/g)).toHaveLength(2)
    expect(tokens.match(/--btn-primary-bg: color-mix\(in srgb, var\(--accent\) 5%, var\(--btn-primary-surface\)\);/g)).toHaveLength(2)
  })

  it('next to the paused-run Resume now, Cancel and Stop are ghost buttons: no edge or fill at rest, a neutral fill on hover', () => {
    const banner = allRules.filter((rule) => rule.file === 'chat/components/pausedRunBanner.css')
    const base = banner.find((rule) => rule.selector === '.chat-run-paused-btn')
    const hover = banner.find((rule) => rule.selector === '.chat-run-paused-btn:hover')
    expect(base!.body).toMatch(/border:\s*1px solid transparent/)
    expect(base!.body).toMatch(/background:\s*transparent/)
    expect(base!.body).not.toMatch(/box-shadow/)
    expect(hover!.body).toMatch(/background:\s*var\(--ui-hover\)/)
  })

  it('no component rule repaints a primary with its own fill or text colour', () => {
    const repaint = allRules.filter((rule) =>
      rule.file !== 'styles/polish.css' &&
      PRIMARY_CLASSES.some((cls) => splitTopLevel(rule.selector).some((selector) => selector.endsWith(cls) || selector.includes(`${cls}:`))) &&
      declarations(rule.body, /^(background(-color|-image)?|color)$/).length > 0
    )
    expect(repaint.map((rule) => `${rule.file}: ${rule.selector}`)).toEqual([])
  })
})
