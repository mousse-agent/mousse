/** Only presentation values cross into the opaque applet renderer. No acrylic tokens. */
export const APPLET_APPEARANCE_TOKENS = [
  '--accent',
  '--accent-hover',
  '--accent-pale',
  '--accent-rgb',
  '--accent-pale-rgb',
  '--surface-base',
  '--surface-strong',
  '--surface-soft',
  '--surface-muted',
  '--surface-elevated',
  '--surface-base-rgb',
  '--surface-strong-rgb',
  '--surface-soft-rgb',
  '--surface-muted-rgb',
  '--surface-elevated-rgb',
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border',
  '--gradient-accent',
  '--success',
  '--warning',
  '--danger',
  '--status-running',
  '--ui-hover',
  '--ui-pressed',
  '--ui-selected',
  '--ui-line',
  '--ui-line-strong',
  '--ui-faint',
  '--ui-raised',
  '--ui-row-radius',
  '--ui-control-radius',
  '--ui-card-radius',
  '--ui-row-height',
  '--ui-gutter',
  '--ui-specular',
  '--ui-specular-accent',
  '--ui-sheen',
  '--ui-sheen-accent',
  '--ui-focus-ring',
  '--ui-on-accent',
  '--theme-spacing-xs',
  '--theme-spacing-sm',
  '--theme-spacing-md',
  '--theme-spacing-lg',
  '--theme-spacing-xl',
  '--theme-spacing-2xl',
  '--theme-spacing-3xl',
  '--theme-radius-sm',
  '--theme-radius-md',
  '--theme-radius-lg',
  '--theme-radius-xl',
  '--theme-radius-2xl',
  '--theme-btn-padding',
  '--theme-btn-radius',
  '--theme-input-padding',
  '--theme-input-radius',
  '--theme-card-padding',
  '--vscode-input-background',
  '--vscode-input-foreground',
  '--vscode-input-border',
  '--vscode-input-placeholderForeground',
  '--vscode-button-background',
  '--vscode-button-foreground',
  '--vscode-button-hoverBackground',
  '--vscode-scrollbarSlider-background',
  '--vscode-scrollbarSlider-hoverBackground',
  '--vscode-focusBorder',
  '--vscode-textLink-foreground',
  '--vscode-editor-background',
  '--vscode-editor-foreground'
] as const
export interface AppletAppearance {
  theme: string
  colorScheme: 'dark' | 'light'
  fontFamily: string
  fontSize: string
  reducedMotion: boolean
  tokens: Partial<Record<(typeof APPLET_APPEARANCE_TOKENS)[number], string>>
}
const safeValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 512 &&
  !/[<>;{}@\u0000-\u001f]/.test(value) &&
  !/url\s*\(|expression\s*\(/i.test(value)
export function validateAppletAppearance(value: unknown): AppletAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid applet appearance.')
  const raw = value as Record<string, unknown>
  if (
    typeof raw.theme !== 'string' ||
    !/^[a-z0-9-]{1,40}$/.test(raw.theme) ||
    !['dark', 'light'].includes(String(raw.colorScheme)) ||
    typeof raw.reducedMotion !== 'boolean' ||
    !safeValue(raw.fontFamily) ||
    !safeValue(raw.fontSize) ||
    !raw.tokens ||
    typeof raw.tokens !== 'object' ||
    Array.isArray(raw.tokens)
  )
    throw new Error('Invalid applet appearance.')
  const tokens: AppletAppearance['tokens'] = {}
  for (const key of APPLET_APPEARANCE_TOKENS) {
    const token = (raw.tokens as Record<string, unknown>)[key]
    if (token !== undefined) {
      if (!safeValue(token)) throw new Error('Invalid applet appearance token.')
      tokens[key] = token
    }
  }
  return {
    theme: raw.theme,
    colorScheme: raw.colorScheme as AppletAppearance['colorScheme'],
    fontFamily: raw.fontFamily,
    fontSize: raw.fontSize,
    reducedMotion: raw.reducedMotion,
    tokens
  }
}
