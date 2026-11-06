import { clampFrostedComposer, type FrostedComposerSlider } from '../../shared/settings'
import type { AppearanceSettings } from '../../shared/settings'

type FrostedComposerValues = Pick<
  AppearanceSettings,
  'frostedComposer' | 'frostedComposerOpacity' | 'frostedComposerBlur' | 'frostedComposerSaturation'
>

const FROSTED_COMPOSER_VARS = [
  '--frosted-composer-alpha',
  '--frosted-composer-blur',
  '--frosted-composer-saturate'
] as const

/**
 * Turns the frosted composer on or off (polish.css reads `data-frosted-composer` and these vars).
 * Off removes everything, so the composer renders exactly as it does without the setting.
 */
export function applyFrostedComposer(values: FrostedComposerValues, root = document.documentElement): void {
  if (!values.frostedComposer) {
    root.removeAttribute('data-frosted-composer')
    for (const name of FROSTED_COMPOSER_VARS) root.style.removeProperty(name)
    return
  }
  root.setAttribute('data-frosted-composer', 'true')
  const opacity = clampFrostedComposer('frostedComposerOpacity', values.frostedComposerOpacity)
  root.style.setProperty('--frosted-composer-alpha', String(opacity / 100))
  root.style.setProperty('--frosted-composer-blur', `${clampFrostedComposer('frostedComposerBlur', values.frostedComposerBlur)}px`)
  root.style.setProperty('--frosted-composer-saturate', String(clampFrostedComposer('frostedComposerSaturation', values.frostedComposerSaturation)))
}

export type FrostedComposerPatch = Partial<Record<FrostedComposerSlider, number>>

/**
 * Debounced save for the frosted composer sliders. Values moved within the delay are saved together,
 * so moving two sliders quickly keeps both, and `dispose` still saves what is pending when Settings closes.
 */
export function createFrostedComposerSaver<T>(
  save: (patch: FrostedComposerPatch) => Promise<T>,
  onSaved: (saved: T) => void,
  delayMs = 120
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: FrostedComposerPatch = {}
  let generation = 0
  let disposed = false

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const patch = pending
    pending = {}
    if (Object.keys(patch).length === 0) return
    const current = ++generation
    void save(patch).then((saved) => {
      // A newer save, or values still waiting, would be undone by this reply.
      if (disposed || current !== generation || Object.keys(pending).length > 0) return
      onSaved(saved)
    }, () => undefined)
  }

  return {
    queue(key: FrostedComposerSlider, value: number) {
      pending = { ...pending, [key]: value }
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    dispose() {
      flush()
      disposed = true
    }
  }
}
