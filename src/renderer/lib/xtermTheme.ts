import type { ITheme } from '@xterm/xterm'

const XTERM_THEME_BASE = {
  foreground: '#f0def1',
  cursor: '#c5a7d9',
  selectionBackground: 'rgba(138, 102, 182, 0.35)',
  black: '#1a1228',
  red: '#e07a8a',
  green: '#7ec99a',
  yellow: '#d4b06a',
  blue: '#a785c7',
  magenta: '#bc9cd4',
  cyan: '#c5a7d9',
  white: '#f0def1',
  brightBlack: '#8f70b1',
  brightRed: '#f0a0ab',
  brightGreen: '#9eddb5',
  brightYellow: '#e8cc92',
  brightBlue: '#c5a7d9',
  brightMagenta: '#e3cbeb',
  brightCyan: '#f0def1',
  brightWhite: '#f4e5f4'
} as const

export const XTERM_FONT = 'Consolas, "Courier New", monospace'

function readTerminalBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim()
  return value || '#1a1228'
}

export function getXtermTheme(): ITheme {
  return {
    ...XTERM_THEME_BASE,
    background: readTerminalBackground()
  }
}
