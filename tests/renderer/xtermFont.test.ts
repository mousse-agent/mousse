// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { applyFontSettings } from '../../src/renderer/lib/appFonts'
import { followXtermAppearance } from '../../src/renderer/lib/xtermTheme'

function fakeTerminal() {
  const fonts: string[] = []
  const addons: { activate(): void; dispose(): void }[] = []
  const terminal = {
    options: {
      set fontFamily(value: string) { fonts.push(value) },
      set theme(_value: unknown) {}
    },
    loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }) {
      addon.activate(terminal)
      addons.push(addon)
    }
  }
  return { terminal: terminal as unknown as Terminal, fonts, dispose: () => addons.forEach((addon) => addon.dispose()) }
}

describe('terminal code font', () => {
  it('takes a new code font and refits its grid, until it is disposed', () => {
    const { terminal, fonts, dispose } = fakeTerminal()
    const refit = vi.fn()
    followXtermAppearance(terminal, refit)

    applyFontSettings({ codeFont: { source: 'installed', family: 'Menlo' } })
    expect(fonts.at(-1)).toMatch(/^"Menlo", /)
    expect(refit).toHaveBeenCalledTimes(1)

    dispose()
    applyFontSettings({ codeFont: { source: 'system' } })
    expect(refit).toHaveBeenCalledTimes(1)
  })
})
