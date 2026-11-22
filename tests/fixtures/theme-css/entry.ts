import { applyThemeCss, setUserThemeActive } from '../../../src/renderer/lib/themeCss'

const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))

const style = (selector: string, property: string, pseudo?: string): string => {
  const element = document.querySelector(selector)
  return element ? getComputedStyle(element, pseudo).getPropertyValue(property) : 'missing'
}

/** Touches every element's computed style, so any image, font or cursor the CSS names would be requested now. */
function computeAll(): void {
  for (const element of Array.from(document.querySelectorAll('body *'))) {
    const computed = getComputedStyle(element)
    void computed.backgroundImage
    void computed.cursor
    void computed.fontFamily
    void getComputedStyle(element, '::before').content
  }
}

;(window as unknown as { qa: unknown }).qa = {
  /** Applies theme CSS the way the app does; returns the number of rules or declarations it dropped. */
  apply: (css: string, tokens?: Record<string, string>): number => { const dropped = applyThemeCss(css, { tokens }).length; computeAll(); return dropped },
  /** Puts a pending decision (an approval's buttons) on the page, or takes it off. */
  decision: (on: boolean): void => {
    if (on) { const element = document.createElement('div'); element.id = 'decision'; element.setAttribute('data-mousse-decision', ''); element.innerHTML = '<button class="permission-request-btn">Deny</button><button class="permission-request-btn">Approve</button>'; document.body.append(element) }
    else document.getElementById('decision')?.remove()
  },
  /** Opens or closes a page that guards its own access controls (Settings, the Automations page). */
  guarded: (on: boolean): void => {
    if (on) { const element = document.createElement('div'); element.id = 'guarded'; element.setAttribute('data-mousse-guarded', ''); document.body.append(element) }
    else document.getElementById('guarded')?.remove()
  },
  /** What a decision's button shows and the theme's sidebar and token, in the same task as the change. */
  look: () => ({
    sidebar: style('[data-mousse="sidebar"]', 'background-color'),
    token: getComputedStyle(document.documentElement).getPropertyValue('--probe-color').trim(),
    buttonAfter: style('#decision .permission-request-btn', 'content', '::after'),
    paused: document.documentElement.hasAttribute('data-user-theme-paused')
  }),
  /** The control: the same CSS straight into a style element, unchecked. */
  raw: (css: string): void => { const element = document.createElement('style'); element.textContent = css; document.head.append(element); computeAll() },
  /** A user theme with no CSS and no colors (one that only has a wallpaper) turned on or off. */
  plainTheme: (on: boolean): void => { applyThemeCss(''); setUserThemeActive(on) },
  clear: (): void => { applyThemeCss(''); setUserThemeActive(false); document.querySelectorAll('style[data-raw]').forEach((element) => element.remove()) },
  frames: (count: number): Promise<void> => new Promise((done) => { const step = (left: number) => (left <= 0 ? done() : requestAnimationFrame(() => step(left - 1))); step(count) }),
  measure: () => ({
    sidebar: style('[data-mousse="sidebar"]', 'background-color'),
    mixedColor: style('#mixed', 'color'),
    mixedImage: style('#mixed', 'background-image'),
    brokenWidth: style('#broken', 'width'),
    afterBad: style('#after-bad', 'color'),
    inMedia: style('#in-media', 'color'),
    keepData: style('#keep-data', 'background-image'),
    keyframes: style('#keep-anim', 'animation-name'),
    nested: style('#keep-nest .inner', 'color'),
    unquotedDataColor: style('#unquoted-data', 'color'),
    unquotedDataImage: style('#unquoted-data', 'background-image'),
    idUrlImage: style('#id-url', 'background-image'),
    stringHiddenColor: style('#string-hidden', 'color'),
    stringHiddenImage: style('#string-hidden', 'background-image'),
    escapedSvg: style('#escaped-svg', 'background-image'),
    braceColor: style('#brace', 'color'),
    braceImage: style('#brace', 'background-image'),
    afterBraceColor: style('#after-brace', 'color')
  }),
  errors: () => errors
}
