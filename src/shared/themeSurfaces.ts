import { buildAccentCssVars } from './accentPalette'
import type { AppearanceSettings, ThemeId } from './settings'

/** Themes with fixed workbench surfaces (not derived from accent). */
export const FIXED_SURFACE_THEMES: Partial<
  Record<
    ThemeId,
    Record<string, string>
  >
> = {
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
  },
  'blacksphere-plus': {
    '--surface-base': '#000000',
    '--surface-strong': '#000000',
    '--surface-soft': '#121212',
    '--surface-muted': '#050505',
    '--surface-elevated': '#1a1a1a',
    '--surface-base-rgb': '0, 0, 0',
    '--surface-strong-rgb': '0, 0, 0',
    '--surface-soft-rgb': '18, 18, 18',
    '--surface-muted-rgb': '5, 5, 5',
    '--surface-elevated-rgb': '26, 26, 26',
    '--acrylic-base-rgb': '0, 0, 0',
    '--acrylic-strong-rgb': '0, 0, 0',
    '--acrylic-soft-rgb': '18, 18, 18',
    '--terminal-bg': '#000000',
    '--floating-surface': '#121212',
    '--text-primary': '#e6e6e6',
    '--text-secondary': 'rgba(230, 230, 230, 0.68)',
    '--border': 'rgba(255, 255, 255, 0.14)'
  }
}

export function appearanceSurfaceBase(
  appearance: Pick<AppearanceSettings, 'theme' | 'accentColor'>,
  systemDark = true
): string {
  const accent = buildAccentCssVars(appearance.accentColor)
  if (appearance.theme === 'light' || (appearance.theme === 'system' && !systemDark)) {
    return accent['--surface-light-base']
  }
  return FIXED_SURFACE_THEMES[appearance.theme]?.['--surface-base'] ?? accent['--surface-base']
}

