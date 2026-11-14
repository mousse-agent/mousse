import { externalLoadIn, THEME_CSS_MAX_LENGTH } from '../../shared/themes/cssSafety'
import { isThemeColorValue, isThemeTokenName } from '../../shared/themes/userThemes'

/** A rule or declaration left out of a theme, and why. */
export interface DroppedCss {
  text: string
  reason: string
}

export interface SanitizedThemeCss {
  /** The CSS that may be applied: every rule the browser could read and that loads nothing. */
  css: string
  dropped: DroppedCss[]
}

/** Rule kinds a theme keeps. Everything else (@import, @namespace, @counter-style, @function, …) is dropped. */
const GROUP_RULES = ['CSSMediaRule', 'CSSSupportsRule', 'CSSContainerRule', 'CSSLayerBlockRule', 'CSSScopeRule', 'CSSStartingStyleRule'] as const
const LEAF_RULES = ['CSSFontFaceRule', 'CSSPropertyRule', 'CSSLayerStatementRule', 'CSSNestedDeclarations'] as const

const MAX_RULES = 4000
const MAX_DEPTH = 8

type RuleKind = 'style' | 'group' | 'keyframes' | 'leaf' | null

function isA(rule: CSSRule, name: string): boolean {
  const ctor = (globalThis as Record<string, unknown>)[name]
  return typeof ctor === 'function' && rule instanceof (ctor as new () => CSSRule)
}

function kindOf(rule: CSSRule): RuleKind {
  if (isA(rule, 'CSSStyleRule')) return 'style'
  if (GROUP_RULES.some((name) => isA(rule, name))) return 'group'
  if (isA(rule, 'CSSKeyframesRule')) return 'keyframes'
  if (LEAF_RULES.some((name) => isA(rule, name))) return 'leaf'
  return null
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

/** Removes the declarations of `style` that could load something; the rest of the rule stays. */
function stripDeclarations(style: CSSStyleDeclaration | undefined, dropped: DroppedCss[]): void {
  if (!style) return
  const names = Array.from({ length: style.length }, (_, index) => style.item(index))
  for (const name of names) {
    const value = style.getPropertyValue(name)
    const reason = externalLoadIn(`${name}: ${value}`)
    if (!reason) continue
    style.removeProperty(name)
    dropped.push({ text: excerpt(`${name}: ${value}`), reason })
  }
}

interface RuleList {
  readonly cssRules: CSSRuleList
  deleteRule(index: number): void
}

/** Cleans `list` in place, last rule first so indexes stay valid. */
function cleanRules(list: RuleList, depth: number, dropped: DroppedCss[], budget: { rules: number }): void {
  for (let index = list.cssRules.length - 1; index >= 0; index--) {
    const rule = list.cssRules[index]
    const drop = (reason: string): void => {
      dropped.push({ text: excerpt(rule.cssText), reason })
      list.deleteRule(index)
    }
    budget.rules -= 1
    if (budget.rules < 0) { drop('the theme has too many rules'); continue }
    if (depth > MAX_DEPTH) { drop('nested too deeply'); continue }
    const kind = kindOf(rule)
    if (!kind) { drop('this kind of rule is not allowed in a theme'); continue }
    if (kind === 'style' || kind === 'leaf') stripDeclarations((rule as CSSStyleRule).style, dropped)
    if (kind === 'style' || kind === 'group') {
      const group = rule as unknown as RuleList
      if (group.cssRules) cleanRules(group, depth + 1, dropped, budget)
    }
    if (kind === 'keyframes') {
      for (const frame of Array.from((rule as CSSKeyframesRule).cssRules)) stripDeclarations((frame as CSSKeyframeRule).style, dropped)
    }
    // What the rule is now, as the browser writes it, is what gets applied: check all of it.
    const reason = externalLoadIn(rule.cssText)
    if (reason) drop(reason)
  }
}

/** Parses `css` as the browser does and returns its top-level rules after cleaning, or null when it cannot parse. */
function parseAndClean(css: string, dropped: DroppedCss[]): string | null {
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    // A constructed sheet ignores @import; invalid rules and declarations are dropped by the parser, one by one.
    sheet.replaceSync(css)
  } catch {
    return null
  }
  cleanRules(sheet, 0, dropped, { rules: MAX_RULES })
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
}

/**
 * Theme CSS that loads nothing from outside Mousse. The browser parses it first (so escapes, nesting and invalid
 * rules are resolved its way); then every rule it produced is checked as written back, and declarations or rules
 * that could load anything are dropped. The result is parsed and checked once more, rule by rule and as a whole: anything
 * found on that pass drops the whole CSS. What is returned is exactly the text that pass checked.
 */
export function sanitizeThemeCss(css: string): SanitizedThemeCss {
  const dropped: DroppedCss[] = []
  const input = css.length > THEME_CSS_MAX_LENGTH ? css.slice(0, THEME_CSS_MAX_LENGTH) : css
  if (!input.trim()) return { css: '', dropped }
  const first = parseAndClean(input, dropped)
  if (first === null) return { css: '', dropped: [{ text: excerpt(input), reason: 'the CSS could not be read' }] }
  const again: DroppedCss[] = []
  const second = parseAndClean(first, again)
  if (second === null || again.length > 0 || externalLoadIn(second)) {
    return { css: '', dropped: [...dropped, { text: 'the whole theme CSS', reason: 'it did not pass the check a second time' }] }
  }
  return { css: second, dropped }
}

/** `#rgb` or `#rrggbb` as `r, g, b`; null for any other color. */
function hexChannels(value: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) return null
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)).join(', ')
}

/**
 * A theme's color tokens as one `:root` rule. `!important`, so they win over the base theme's values, which Mousse sets
 * inline. A surface's `r, g, b` twin (`--surface-base-rgb`) follows a hex color unless the theme sets it.
 */
export function themeTokensCss(colors: Record<string, string>): string {
  const declarations: string[] = []
  for (const [name, value] of Object.entries(colors)) {
    if (!isThemeTokenName(name) || !isThemeColorValue(value)) continue
    declarations.push(`${name}: ${value.trim()} !important;`)
    const channels = hexChannels(value)
    if (channels && !(`${name}-rgb` in colors)) declarations.push(`${name}-rgb: ${channels} !important;`)
  }
  return declarations.length ? `:root { ${declarations.join(' ')} }` : ''
}

/**
 * While a person is asked to decide something (approve or deny a tool, allow a bot, a device or a browser), the page
 * shows Mousse as it is, without any theme: those controls carry `data-mousse-decision`, and while one is on the page
 * the theme sheet is off. A theme could otherwise relabel, hide, move or cover Approve and Deny.
 */
export const DECISION_SELECTOR = '[data-mousse-decision]'

let themeSheet: CSSStyleSheet | null = null
let guard: MutationObserver | null = null

/** Turns the theme sheet off while a decision is on the page, and on again once none is. */
function syncDecisionPause(doc: Document): void {
  if (!themeSheet) return
  const paused = doc.querySelector(DECISION_SELECTOR) !== null
  if (themeSheet.disabled !== paused) themeSheet.disabled = paused
  doc.documentElement.toggleAttribute('data-user-theme-paused', paused)
}

/**
 * Puts a theme on the page after the app's own styles (an adopted sheet comes after the document's): its color tokens
 * and its CSS, cleaned by `sanitizeThemeCss`. Empty takes it off. A mutation observer pauses it before the next frame
 * whenever a decision appears (mutation records are delivered before the page paints). Returns what was dropped.
 */
export function applyThemeCss(css: string, options: { tokens?: Record<string, string> } = {}, doc: Document = document): DroppedCss[] {
  const tokens = themeTokensCss(options.tokens ?? {})
  const { css: safe, dropped } = sanitizeThemeCss(tokens ? `${tokens}\n${css}` : css)
  // A page without constructable sheets (a test DOM) gets no theme at all.
  if (!Array.isArray(doc.adoptedStyleSheets)) return dropped
  const others = doc.adoptedStyleSheets.filter((sheet) => sheet !== themeSheet)
  if (!safe) {
    if (others.length !== doc.adoptedStyleSheets.length) doc.adoptedStyleSheets = others
    guard?.disconnect()
    guard = null
    doc.documentElement.removeAttribute('data-user-theme-paused')
    return dropped
  }
  themeSheet ??= new CSSStyleSheet()
  themeSheet.replaceSync(safe)
  syncDecisionPause(doc)
  if (!doc.adoptedStyleSheets.includes(themeSheet)) doc.adoptedStyleSheets = [...others, themeSheet]
  if (!guard && typeof MutationObserver === 'function') {
    guard = new MutationObserver(() => syncDecisionPause(doc))
    guard.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-mousse-decision'] })
  }
  return dropped
}
