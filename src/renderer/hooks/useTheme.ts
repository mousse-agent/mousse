import { useEffect } from 'react'
import type { ThemeId } from '../../shared/settings'
import { buildAccentCssVars } from '../../shared/accentPalette'

function applyAccent(accentColor: string): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(buildAccentCssVars(accentColor))) {
    root.style.setProperty(name, value)
  }
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme)
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
      applyTheme(settings.appearance.theme)
      applyAccent(settings.appearance.accentColor)
      if (applyMaterial) {
        await syncWindowBackground()
      }
    }

    void load()

    const unsub = window.mousse.settings.onChanged((settings) => {
      applyTheme(settings.appearance.theme)
      applyAccent(settings.appearance.accentColor)
      if (applyMaterial) {
        void syncWindowBackground()
      }
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [applyMaterial])
}

export { applyTheme, applyAccent, syncWindowBackground }
