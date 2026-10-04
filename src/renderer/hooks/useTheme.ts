import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { AppearanceSettings, ThemeId } from '../../shared/settings'
import { glassTokensFromIntensity, normalizeAppearance } from '../../shared/settings'
import { buildAccentCssVars } from '../../shared/accentPalette'
import { BLACKSPHERE_COLORS, BLACKSPHERE_TOKEN_COLORS, applyVsCodeColors, clearVsCodeColors, injectTokenColors, clearTokenColors } from '../../shared/vscodeTheme'

import { FIXED_SURFACE_THEMES } from '../../shared/themeSurfaces'

const FIXED_SURFACE_VARS = [
  ...new Set(Object.values(FIXED_SURFACE_THEMES).flatMap((vars) => Object.keys(vars ?? {})))
]

/** Light palettes fill the shared surface slots so chrome built on them turns light as well. */
const LIGHT_SURFACE_VARS: Record<string, string> = {
  '--surface-base': 'var(--surface-light-base)',
  '--surface-strong': 'var(--surface-light-strong)',
  '--surface-soft': 'var(--surface-light-soft)',
  '--surface-muted': 'var(--surface-light-soft)',
  '--surface-elevated': '#ffffff',
  '--surface-base-rgb': 'var(--surface-light-base-rgb)',
  '--surface-strong-rgb': 'var(--surface-light-strong-rgb)',
  '--surface-soft-rgb': 'var(--surface-light-soft-rgb)',
  '--surface-muted-rgb': 'var(--surface-light-soft-rgb)',
  '--surface-elevated-rgb': '255, 255, 255'
}

/** Accent output tuned for dark surfaces; light theme CSS supplies its own values. */
const LIGHT_THEME_CSS_OWNED_VARS = ['--border', '--terminal-bg'] as const

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

/** Fixed palettes are inline; drop them so the next theme does not inherit their colours. */
function clearFixedSurfaces(): void {
  const root = document.documentElement
  for (const name of FIXED_SURFACE_VARS) {
    root.style.removeProperty(name)
  }
}

function applyFixedSurfaces(theme: ThemeId): void {
  const root = document.documentElement
  const fixed = FIXED_SURFACE_THEMES[theme]
  if (!fixed) return
  for (const [name, value] of Object.entries(fixed)) {
    root.style.setProperty(name, value)
  }
}

function applyLightSurfaces(theme: ThemeId): void {
  if (!themeUsesLightSurfaces(theme)) return
  const root = document.documentElement
  for (const [name, value] of Object.entries(LIGHT_SURFACE_VARS)) {
    root.style.setProperty(name, value)
  }
  for (const name of LIGHT_THEME_CSS_OWNED_VARS) {
    root.style.removeProperty(name)
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
  const linux = window.mousse.platform === 'linux'
  root.classList.toggle('platform-linux', linux)

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
      'rgba(var(--acrylic-base-rgb), var(--glass-alpha-base))'
    )
    root.style.setProperty(
      '--glass-bg-strong',
      'rgba(var(--acrylic-strong-rgb), var(--glass-alpha-strong))'
    )
    root.style.setProperty(
      '--glass-bg-soft',
      'rgba(var(--acrylic-soft-rgb), var(--glass-alpha-soft))'
    )
    root.style.setProperty('--bg-primary', 'var(--glass-bg)')
    root.style.setProperty('--bg-secondary', 'var(--glass-bg-strong)')
    root.style.setProperty('--bg-tertiary', 'var(--glass-bg-soft)')
    root.style.setProperty('--app-window-bg', 'transparent')
    root.style.setProperty(
      '--gradient-surface',
      'linear-gradient(180deg, rgba(var(--acrylic-strong-rgb), var(--glass-alpha-strong)) 0%, rgba(var(--acrylic-base-rgb), var(--glass-alpha-base)) 100%)'
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

function applyVsCodeTheme(theme: ThemeId): void {
  if (theme === 'blacksphere-plus') {
    applyVsCodeColors(BLACKSPHERE_COLORS)
    injectTokenColors(BLACKSPHERE_TOKEN_COLORS)
    const root = document.documentElement
    for (const [k, v] of Object.entries(BLACKSPHERE_COLORS)) {
      root.style.setProperty(`--theme-vscode-${k.replace(/\./g, '-')}`, v)
    }
  } else {
    clearVsCodeColors()
    clearTokenColors()
    const root = document.documentElement
    for (const k of Object.keys(BLACKSPHERE_COLORS)) {
      root.style.removeProperty(`--theme-vscode-${k.replace(/\./g, '-')}`)
    }
  }
}

function applyLayoutTokens(theme: ThemeId): void {
  const root = document.documentElement
  if (theme === 'blacksphere-plus') {
    root.style.setProperty('--theme-header-padding', '10px 14px')
    root.style.setProperty('--theme-chat-messages-padding', '10px clamp(10px, 1.2vw, 16px) 16px')
  } else {
    root.style.removeProperty('--theme-header-padding')
    root.style.removeProperty('--theme-chat-messages-padding')
  }
}

function applyAppearance(appearance: AppearanceSettings): void {
  const normalized = normalizeAppearance(appearance)
  applyTheme(normalized.theme)
  clearFixedSurfaces()
  applyAccent(normalized.accentColor)
  applyFixedSurfaces(normalized.theme)
  applyLightSurfaces(normalized.theme)
  applyVsCodeTheme(normalized.theme)
  applyLayoutTokens(normalized.theme)
  applyAcrylic(normalized.acrylic, normalized.acrylicIntensity, normalized.theme)
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
  const profileId = useAppStore((state) => state.profileId)

  useEffect(() => {
    if (window.mousse.platform !== 'linux') return
    const root = document.documentElement
    root.classList.add('platform-linux')
    // The auxiliary window stays floating and does not use the main window's
    // maximize IPC. Keep its radius independent of the main window's state.
    if (!applyMaterial) return
    let revision = 0
    let disposed = false
    const sync = (maximized: boolean): void => {
      root.setAttribute('data-window-maximized', String(maximized))
    }
    const unsubscribe = window.mousse.window.onMaximizedChange((maximized) => {
      revision += 1
      sync(maximized)
    })
    void window.mousse.window.isMaximized().then((maximized) => {
      if (!disposed && revision === 0) sync(maximized)
    })
    return () => { disposed = true; unsubscribe() }
  }, [applyMaterial])

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
        if (cancelled) return
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
  }, [applyMaterial, profileId])
}

export { applyTheme, applyAccent, applyAcrylic, applyAppearance, syncWindowBackground }
