import type { ITheme, Terminal } from '@xterm/xterm'
import { CODE_FONT } from './typography'

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

export const XTERM_FONT = CODE_FONT

function readTerminalBackground(): string {
  if (document.documentElement.dataset.acrylic === 'true') return '#00000000'
  const value = getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim()
  return value || '#1a1228'
}

export function followXtermAppearance(terminal: Terminal): void {
  const observer = new MutationObserver(() => {
    terminal.options.theme = getXtermTheme()
  })
  terminal.loadAddon({
    activate() {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-acrylic', 'data-theme', 'style']
      })
    },
    dispose() { observer.disconnect() }
  })
}

export function getXtermTheme(): ITheme {
  return {
    ...XTERM_THEME_BASE,
    background: readTerminalBackground()
  }
}
