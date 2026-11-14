import { applyThemeCss } from '../../../src/renderer/lib/themeCss'

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
  apply: (css: string): number => { const dropped = applyThemeCss(css).length; computeAll(); return dropped },
  /** The control: the same CSS straight into a style element, unchecked. */
  raw: (css: string): void => { const element = document.createElement('style'); element.textContent = css; document.head.append(element); computeAll() },
  clear: (): void => { applyThemeCss(''); document.querySelectorAll('style[data-raw]').forEach((element) => element.remove()) },
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
    nested: style('#keep-nest .inner', 'color')
  }),
  errors: () => errors
}
