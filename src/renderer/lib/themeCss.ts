import { externalLoadIn, THEME_CSS_MAX_LENGTH, themeCssTooLong, withoutExternalLoads } from '../../shared/themes/cssSafety'
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
 * Theme CSS that loads nothing from outside Mousse. First the CSS as written: every url() must be one quoted `data:`
 * address and nothing may name another resource (`withoutExternalLoads`, which drops the narrowest declaration or rule
 * that fails). Then the browser parses it (so escapes, nesting and invalid rules are resolved its way), every rule it
 * produced is checked as written back, and declarations or rules that could load anything are dropped. The result is
 * parsed and checked once more, rule by rule and as a whole: anything found on that pass drops the whole CSS. What is
 * returned is exactly the text that pass checked. CSS over `maxLength` is refused whole, never cut.
 */
export function sanitizeThemeCss(css: string, maxLength: number = THEME_CSS_MAX_LENGTH): SanitizedThemeCss {
  const dropped: DroppedCss[] = []
  if (css.length > maxLength) return { css: '', dropped: [{ text: 'the whole theme CSS', reason: themeCssTooLong(css.length) }] }
  if (!css.trim()) return { css: '', dropped }
  const written = withoutExternalLoads(css, dropped)
  if (!written.trim()) return { css: '', dropped }
  const first = parseAndClean(written, dropped)
  if (first === null) return { css: '', dropped: [{ text: excerpt(css), reason: 'the CSS could not be read' }] }
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
  const applied = new Set<string>()
  for (const [name, value] of Object.entries(colors)) {
    if (!isThemeTokenName(name) || !isThemeColorValue(value)) continue
    applied.add(name)
    declarations.push(`${name}: ${value.trim()} !important;`)
    const channels = hexChannels(value)
    if (channels && !(`${name}-rgb` in colors)) declarations.push(`${name}-rgb: ${channels} !important;`)
  }
  // Mousse Dark sets --vscode-sideBar-background inline (#000000) and vscode-compat maps it to --surface-base, so a
  // user theme setting --surface-strong ("sidebar and raised panels") or --surface-base would otherwise never reach the
  // sidebar unless it also set the VS Code token directly.
  if (applied.has('--surface-strong')) declarations.push('--vscode-sideBar-background: var(--surface-strong) !important;')
  else if (applied.has('--surface-base')) declarations.push('--vscode-sideBar-background: var(--surface-base) !important;')
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
/** Whether a user theme is on: the guard runs while one is, whatever it carries (CSS, colors, a wallpaper or nothing). */
let themeActive = false

/**
 * Pauses the theme while a decision is on the page: the sheet is turned off and `html[data-user-theme-paused]` is set,
 * which also hides the wallpaper (app CSS). On again once no decision is left.
 */
function syncDecisionPause(doc: Document): void {
  const paused = themeActive && doc.querySelector(DECISION_SELECTOR) !== null
  if (themeSheet && themeSheet.disabled !== paused) themeSheet.disabled = paused
  if (doc.documentElement.hasAttribute('data-user-theme-paused') !== paused) doc.documentElement.toggleAttribute('data-user-theme-paused', paused)
}

/**
 * Starts or stops the decision guard. It runs while a user theme is on, even one with no CSS and no colors (a theme that
 * only has a wallpaper), so nothing of a theme shows while a person decides. A mutation observer pauses it before the
 * next frame whenever a decision appears (mutation records are delivered before the page paints).
 */
export function setUserThemeActive(active: boolean, doc: Document = document): void {
  themeActive = active
  if (active && !guard && typeof MutationObserver === 'function') {
    guard = new MutationObserver(() => syncDecisionPause(doc))
    guard.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-mousse-decision'] })
  } else if (!active) {
    guard?.disconnect()
    guard = null
  }
  syncDecisionPause(doc)
}

/**
 * Puts a theme on the page after the app's own styles (an adopted sheet comes after the document's): its color tokens
 * and its CSS, cleaned by `sanitizeThemeCss`. Empty takes the sheet off; the decision guard stays as
 * `setUserThemeActive` set it. CSS to apply turns the guard on. Returns what was dropped.
 */
export function applyThemeCss(css: string, options: { tokens?: Record<string, string> } = {}, doc: Document = document): DroppedCss[] {
  const tokens = themeTokensCss(options.tokens ?? {})
  // CSS over the limit is not applied at all; the colors still are.
  const tooLong = css.length > THEME_CSS_MAX_LENGTH
  const own = tooLong ? '' : css
  const { css: safe, dropped } = sanitizeThemeCss(tokens ? `${tokens}
${own}` : own, THEME_CSS_MAX_LENGTH + tokens.length + 1)
  if (tooLong) dropped.unshift({ text: 'the whole theme CSS', reason: themeCssTooLong(css.length) })
  // A page without constructable sheets (a test DOM) gets no theme at all.
  if (!Array.isArray(doc.adoptedStyleSheets)) return dropped
  const others = doc.adoptedStyleSheets.filter((sheet) => sheet !== themeSheet)
  if (!safe) {
    if (others.length !== doc.adoptedStyleSheets.length) doc.adoptedStyleSheets = others
    return dropped
  }
  themeSheet ??= new CSSStyleSheet()
  themeSheet.replaceSync(safe)
  if (!themeActive) setUserThemeActive(true, doc)
  else syncDecisionPause(doc)
  if (!doc.adoptedStyleSheets.includes(themeSheet)) doc.adoptedStyleSheets = [...others, themeSheet]
  return dropped
}
