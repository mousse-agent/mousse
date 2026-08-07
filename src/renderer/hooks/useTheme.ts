import { useEffect } from 'react'
import type { AppearanceSettings, ThemeId } from '../../shared/settings'
import { glassTokensFromIntensity, normalizeAppearance } from '../../shared/settings'
import { buildAccentCssVars } from '../../shared/accentPalette'

/** Themes with fixed workbench surfaces (not derived from accent). */
const FIXED_SURFACE_THEMES: Partial<
  Record<
    ThemeId,
    Record<string, string>
  >
> = {
  'cursor-dark': {
    '--surface-base': '#171717',
    '--surface-strong': '#141414',
    '--surface-soft': '#1f1f1f',
    '--surface-muted': '#111111',
    '--surface-elevated': '#272727',
    '--surface-base-rgb': '23, 23, 23',
    '--surface-strong-rgb': '20, 20, 20',
    '--surface-soft-rgb': '31, 31, 31',
    '--surface-muted-rgb': '17, 17, 17',
    '--surface-elevated-rgb': '39, 39, 39',
    '--acrylic-base-rgb': '23, 23, 23',
    '--acrylic-strong-rgb': '20, 20, 20',
    '--acrylic-soft-rgb': '31, 31, 31',
    '--terminal-bg': '#141414',
    '--floating-surface': '#1f1f1f',
    '--text-primary': '#d6d6dd',
    '--text-secondary': 'rgba(214, 214, 221, 0.62)',
    '--border': 'rgba(255, 255, 255, 0.06)'
  },
  'dark-modern': {
    '--surface-base': '#1f1f1f',
    '--surface-strong': '#181818',
    '--surface-soft': '#2b2b2b',
    '--surface-muted': '#141414',
    '--surface-elevated': '#333333',
    '--surface-base-rgb': '31, 31, 31',
    '--surface-strong-rgb': '24, 24, 24',
    '--surface-soft-rgb': '43, 43, 43',
    '--surface-muted-rgb': '20, 20, 20',
    '--surface-elevated-rgb': '51, 51, 51',
    '--acrylic-base-rgb': '31, 31, 31',
    '--acrylic-strong-rgb': '24, 24, 24',
    '--acrylic-soft-rgb': '43, 43, 43',
    '--terminal-bg': '#181818',
    '--floating-surface': '#2b2b2b',
    '--text-primary': '#cccccc',
    '--text-secondary': 'rgba(204, 204, 204, 0.65)',
    '--border': 'rgba(255, 255, 255, 0.07)'
  },
  'one-dark': {
    '--surface-base': '#282c34',
    '--surface-strong': '#21252b',
    '--surface-soft': '#2c313a',
    '--surface-muted': '#1b1e23',
    '--surface-elevated': '#3a3f4b',
    '--surface-base-rgb': '40, 44, 52',
    '--surface-strong-rgb': '33, 37, 43',
    '--surface-soft-rgb': '44, 49, 58',
    '--surface-muted-rgb': '27, 30, 35',
    '--surface-elevated-rgb': '58, 63, 75',
    '--acrylic-base-rgb': '40, 44, 52',
    '--acrylic-strong-rgb': '33, 37, 43',
    '--acrylic-soft-rgb': '44, 49, 58',
    '--terminal-bg': '#21252b',
    '--floating-surface': '#2c313a',
    '--text-primary': '#abb2bf',
    '--text-secondary': 'rgba(171, 178, 191, 0.68)',
    '--border': 'rgba(171, 178, 191, 0.09)'
  },
  monokai: {
    '--surface-base': '#272822',
    '--surface-strong': '#1e1f1c',
    '--surface-soft': '#3e3d32',
    '--surface-muted': '#161713',
    '--surface-elevated': '#49483e',
    '--surface-base-rgb': '39, 40, 34',
    '--surface-strong-rgb': '30, 31, 28',
    '--surface-soft-rgb': '62, 61, 50',
    '--surface-muted-rgb': '22, 23, 19',
    '--surface-elevated-rgb': '73, 72, 62',
    '--acrylic-base-rgb': '39, 40, 34',
    '--acrylic-strong-rgb': '30, 31, 28',
    '--acrylic-soft-rgb': '62, 61, 50',
    '--terminal-bg': '#1e1f1c',
    '--floating-surface': '#3e3d32',
    '--text-primary': '#f8f8f2',
    '--text-secondary': 'rgba(248, 248, 242, 0.62)',
    '--border': 'rgba(253, 151, 31, 0.08)'
  },
  'solarized-dark': {
    '--surface-base': '#002b36',
    '--surface-strong': '#073642',
    '--surface-soft': '#0a3a45',
    '--surface-muted': '#001e26',
    '--surface-elevated': '#094654',
    '--surface-base-rgb': '0, 43, 54',
    '--surface-strong-rgb': '7, 54, 66',
    '--surface-soft-rgb': '10, 58, 69',
    '--surface-muted-rgb': '0, 30, 38',
    '--surface-elevated-rgb': '9, 70, 84',
    '--acrylic-base-rgb': '0, 43, 54',
    '--acrylic-strong-rgb': '7, 54, 66',
    '--acrylic-soft-rgb': '10, 58, 69',
    '--terminal-bg': '#002b36',
    '--floating-surface': '#073642',
    '--text-primary': '#839496',
    '--text-secondary': 'rgba(147, 161, 161, 0.78)',
    '--border': 'rgba(131, 148, 150, 0.11)'
  },
  'github-dark': {
    '--surface-base': '#0d1117',
    '--surface-strong': '#161b22',
    '--surface-soft': '#1c232b',
    '--surface-muted': '#080c12',
    '--surface-elevated': '#21262d',
    '--surface-base-rgb': '13, 17, 23',
    '--surface-strong-rgb': '22, 27, 34',
    '--surface-soft-rgb': '28, 35, 43',
    '--surface-muted-rgb': '8, 12, 18',
    '--surface-elevated-rgb': '33, 38, 45',
    '--acrylic-base-rgb': '13, 17, 23',
    '--acrylic-strong-rgb': '22, 27, 34',
    '--acrylic-soft-rgb': '28, 35, 43',
    '--terminal-bg': '#0d1117',
    '--floating-surface': '#1c232b',
    '--text-primary': '#e6edf3',
    '--text-secondary': 'rgba(139, 148, 158, 0.95)',
    '--border': 'rgba(48, 54, 61, 0.55)'
  },
  'high-contrast': {
    '--surface-base': '#000000',
    '--surface-strong': '#000000',
    '--surface-soft': '#1a1a1a',
    '--surface-muted': '#000000',
    '--surface-elevated': '#262626',
    '--surface-base-rgb': '0, 0, 0',
    '--surface-strong-rgb': '0, 0, 0',
    '--surface-soft-rgb': '26, 26, 26',
    '--surface-muted-rgb': '0, 0, 0',
    '--surface-elevated-rgb': '38, 38, 38',
    '--acrylic-base-rgb': '0, 0, 0',
    '--acrylic-strong-rgb': '0, 0, 0',
    '--acrylic-soft-rgb': '26, 26, 26',
    '--terminal-bg': '#000000',
    '--floating-surface': '#1a1a1a',
    '--text-primary': '#ffffff',
    '--text-secondary': 'rgba(255, 255, 255, 0.78)',
    '--border': 'rgba(255, 255, 255, 0.45)'
  }
}

const GLASS_OWNED_VARS = [
  '--glass-bg',
  '--glass-bg-strong',
  '--glass-bg-soft',
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--app-window-bg',
  '--gradient-surface',
  '--glass-blur',
  '--glass-alpha-base',
  '--glass-alpha-strong',
  '--glass-alpha-soft',
  '--acrylic-intensity'
] as const

function applyAccent(accentColor: string): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(buildAccentCssVars(accentColor))) {
    root.style.setProperty(name, value)
  }
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme)
}

function applyFixedSurfaces(theme: ThemeId): void {
  const root = document.documentElement
  const fixed = FIXED_SURFACE_THEMES[theme]
  if (!fixed) return
  for (const [name, value] of Object.entries(fixed)) {
    root.style.setProperty(name, value)
  }
}

function themeUsesLightSurfaces(theme: ThemeId): boolean {
  if (theme === 'light') return true
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false
  }
  return false
}

function applyAcrylic(acrylic: boolean, intensity: number, theme: ThemeId): void {
  const root = document.documentElement
  root.setAttribute('data-acrylic', acrylic ? 'true' : 'false')

  const tokens = glassTokensFromIntensity(intensity)
  root.style.setProperty('--acrylic-intensity', String(intensity))
  root.style.setProperty('--glass-alpha-base', String(tokens.alphaBase))
  root.style.setProperty('--glass-alpha-strong', String(tokens.alphaStrong))
  root.style.setProperty('--glass-alpha-soft', String(tokens.alphaSoft))

  // Ensure acrylic channel vars exist for accent-tinted themes (CSS also sets these).
  if (!FIXED_SURFACE_THEMES[theme]) {
    if (themeUsesLightSurfaces(theme)) {
      root.style.setProperty('--acrylic-base-rgb', 'var(--surface-light-base-rgb)')
      root.style.setProperty('--acrylic-strong-rgb', 'var(--surface-light-strong-rgb)')
      root.style.setProperty('--acrylic-soft-rgb', 'var(--surface-light-soft-rgb)')
    } else {
      root.style.setProperty('--acrylic-base-rgb', 'var(--surface-base-rgb)')
      root.style.setProperty('--acrylic-strong-rgb', 'var(--surface-strong-rgb)')
      root.style.setProperty('--acrylic-soft-rgb', 'var(--surface-soft-rgb)')
    }
  }

  if (acrylic) {
    // Windows already composites the whole window with native acrylic. Applying
    // backdrop-filter to every nested glass surface duplicates off-screen render
    // targets and significantly increases GPU-process memory. Keep translucency,
    // but let the single native material provide the blur.
    root.style.setProperty('--glass-blur', 'none')
    root.style.setProperty(
      '--glass-bg',
      `rgba(var(--acrylic-base-rgb), ${tokens.alphaBase})`
    )
    root.style.setProperty(
      '--glass-bg-strong',
      `rgba(var(--acrylic-strong-rgb), ${tokens.alphaStrong})`
    )
    root.style.setProperty(
      '--glass-bg-soft',
      `rgba(var(--acrylic-soft-rgb), ${tokens.alphaSoft})`
    )
    root.style.setProperty('--bg-primary', 'var(--glass-bg)')
    root.style.setProperty('--bg-secondary', 'var(--glass-bg-strong)')
    root.style.setProperty('--bg-tertiary', 'var(--glass-bg-soft)')
    root.style.setProperty('--app-window-bg', 'transparent')
    root.style.setProperty(
      '--gradient-surface',
      `linear-gradient(180deg, rgba(var(--acrylic-strong-rgb), ${tokens.alphaStrong}) 0%, rgba(var(--acrylic-base-rgb), ${tokens.alphaBase}) 100%)`
    )
  } else {
    // Drop inline glass tokens so theme CSS solid surfaces apply.
    for (const name of GLASS_OWNED_VARS) {
      root.style.removeProperty(name)
    }
    root.style.setProperty('--glass-blur', 'none')
    root.setAttribute('data-acrylic', 'false')
  }
}

function applyAppearance(appearance: AppearanceSettings): void {
  const normalized = normalizeAppearance(appearance)
  applyTheme(normalized.theme)
  applyAccent(normalized.accentColor)
  applyFixedSurfaces(normalized.theme)
  // Performance mode: do not create translucent compositor surfaces. The
  // appearance setting remains readable for forward compatibility, but the
  // renderer deliberately uses solid theme surfaces.
  applyAcrylic(false, normalized.acrylicIntensity, normalized.theme)
}

async function syncWindowBackground(): Promise<void> {
  try {
    await window.mousse.window.syncBackground()
  } catch {
    /* material may require restart on some platforms */
  }
}

export function useTheme(options?: { windowMaterial?: boolean }): void {
  const applyMaterial = options?.windowMaterial !== false

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      const settings = await window.mousse.settings.get()
      if (cancelled) return
      applyAppearance(settings.appearance)
      if (applyMaterial) {
        await syncWindowBackground()
      }
    }

    void load()

    const unsub = window.mousse.settings.onChanged((settings) => {
      applyAppearance(settings.appearance)
      if (applyMaterial) {
        void syncWindowBackground()
      }
    })

    // System theme: re-apply acrylic channel targets when OS color scheme flips.
    const mql = window.matchMedia?.('(prefers-color-scheme: light)')
    const onScheme = (): void => {
      void window.mousse.settings.get().then((settings) => {
        if (settings.appearance.theme === 'system') {
          applyAppearance(settings.appearance)
        }
      })
    }
    mql?.addEventListener?.('change', onScheme)

    return () => {
      cancelled = true
      unsub()
      mql?.removeEventListener?.('change', onScheme)
    }
  }, [applyMaterial])
}

export { applyTheme, applyAccent, applyAcrylic, applyAppearance, syncWindowBackground }
