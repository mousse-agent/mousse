import {
  APPLET_APPEARANCE_TOKENS,
  validateAppletAppearance,
  type AppletAppearance
} from '../../../shared/appletAppearance'

/** Resolve only whitelisted visual values; translucent host backgrounds become opaque applet surfaces. */
export function readAppletAppearance(): AppletAppearance {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const body = getComputedStyle(document.body ?? root)
  const resolve = (name: string): string => {
    let value = style.getPropertyValue(name).trim()
    for (let pass = 0; pass < 8 && value.includes('var('); pass++) {
      const next = value.replace(
        /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
        (_match, key: string, fallback?: string) =>
          style.getPropertyValue(key).trim() || fallback?.trim() || ''
      )
      if (next === value) break
      value = next
    }
    return value
  }
  const tokens: AppletAppearance['tokens'] = {}
  for (const name of APPLET_APPEARANCE_TOKENS) {
    const value = resolve(name)
    if (value && !value.includes('var(')) tokens[name] = value
  }
  const solid = {
    '--bg-primary': '--surface-base',
    '--bg-secondary': '--surface-strong',
    '--bg-tertiary': '--surface-soft'
  } as const
  for (const [background, surface] of Object.entries(solid)) {
    const value = tokens[surface as keyof typeof tokens]
    if (value) tokens[background as keyof typeof tokens] = value
    else delete tokens[background as keyof typeof tokens]
  }
  const theme = root.dataset.theme ?? 'dark'
  return validateAppletAppearance({
    theme,
    colorScheme:
      theme === 'light' ||
      (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
        ? 'light'
        : 'dark',
    fontFamily: body.fontFamily || style.fontFamily || 'system-ui, sans-serif',
    fontSize: body.fontSize || style.fontSize || '14px',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    tokens
  })
}

const subscribers = new Set<(appearance: AppletAppearance) => void>()
let observer: MutationObserver | null = null
let media: MediaQueryList[] = []
let mediaListener: (() => void) | null = null
let frame = 0
let snapshot: AppletAppearance | null = null
export function subscribeAppletAppearance(
  callback: (appearance: AppletAppearance) => void
): () => void {
  if (!observer) {
    snapshot = readAppletAppearance()
    const refresh = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = readAppletAppearance()
        if (JSON.stringify(next) === JSON.stringify(snapshot)) return
        snapshot = next
        for (const subscriber of subscribers) subscriber(next)
      })
    }
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true })
    if (document.body)
      observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] })
    media = [
      matchMedia('(prefers-color-scheme: light)'),
      matchMedia('(prefers-reduced-motion: reduce)')
    ]
    mediaListener = refresh
    for (const query of media) query.addEventListener('change', refresh)
  }
  subscribers.add(callback)
  callback(snapshot!)
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      observer?.disconnect()
      observer = null
      if (mediaListener)
        for (const query of media) query.removeEventListener('change', mediaListener)
      media = []
      mediaListener = null
      cancelAnimationFrame(frame)
      frame = 0
      snapshot = null
    }
  }
}
