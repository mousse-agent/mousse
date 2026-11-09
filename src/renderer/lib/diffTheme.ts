import { useEffect, useState, type CSSProperties } from 'react'
import { CODE_FONT_VAR } from './typography'

// The app themes via `html[data-theme="…"]` (+ `color-scheme`), not the `.dark` class, so checking only
// `.dark` leaves the diff's theme stuck on "light". That renders light syntax tokens (dark text) on a dark
// `light-dark()` diff background, which is unreadable. Resolve against data-theme first, then computed
// color-scheme, then the legacy `.dark` class / OS preference.
export function resolveDiffThemeIsDark(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  const dataTheme = root.getAttribute('data-theme')
  if (dataTheme === 'light') return false
  if (dataTheme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) return window.matchMedia('(prefers-color-scheme: dark)').matches
    return true
  }
  // Every other theme id (dark, solarized-dark, github-dark, high-contrast, …) is dark-only.
  if (dataTheme) return true
  if (root.classList.contains('dark')) return true
  try {
    const colorScheme = getComputedStyle(root).colorScheme
    if (colorScheme.includes('dark')) return true
    if (colorScheme.includes('light')) return false
  } catch {
    // getComputedStyle unavailable (tests): fall through.
  }
  if (typeof window !== 'undefined' && window.matchMedia) return window.matchMedia('(prefers-color-scheme: dark)').matches
  return true
}

/** The diff's light or dark syntax theme, following the app theme while the diff is open. */
export function useDiffThemeType(): 'light' | 'dark' {
  const [themeType, setThemeType] = useState<'light' | 'dark'>(() => (resolveDiffThemeIsDark() ? 'dark' : 'light'))
  useEffect(() => {
    if (typeof window === 'undefined') return
    const updateTheme = () => setThemeType(resolveDiffThemeIsDark() ? 'dark' : 'light')
    updateTheme()
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', updateTheme)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', updateTheme)
    }
  }, [])
  return themeType
}

/**
 * Points the diff at the app's theme tokens instead of hardcoded black, and keeps the library's
 * `light-dark()` backgrounds in step with the syntax tokens (without `color-scheme`, dark text lands
 * on a dark background). `background` is the token the diff sits on.
 */
export function diffSurfaceStyle(themeType: 'light' | 'dark', background = 'var(--an-tool-background)'): CSSProperties {
  return {
    '--diffs-bg': background,
    '--diffs-bg-buffer-override': background,
    '--diffs-bg-context-override': background,
    '--diffs-bg-hover-override': 'var(--an-background-secondary)',
    '--diffs-bg-separator-override': 'var(--an-background-secondary)',
    '--diffs-font-family': CODE_FONT_VAR,
    colorScheme: themeType
  } as CSSProperties
}

/** The same tokens inside the diff's shadow root, where the page's custom properties do not reach every part. */
export function diffUnsafeCSS(themeType: 'light' | 'dark', background = 'var(--an-tool-background)'): string {
  return `
[data-diff],
[data-file],
[data-diffs-header],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: ${background};
  --diffs-bg-buffer-override: ${background};
  --diffs-bg-context-override: ${background};
  --diffs-bg-hover-override: var(--an-background-secondary);
  --diffs-bg-separator-override: var(--an-background-secondary);
  --diffs-font-family: ${CODE_FONT_VAR};
  color-scheme: ${themeType};
}
`
}
