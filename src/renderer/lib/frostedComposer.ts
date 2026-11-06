import { clampFrostedComposer } from '../../shared/settings'
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
