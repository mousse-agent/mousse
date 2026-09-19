import { describe, expect, it, vi } from 'vitest'
import {
  dimensionsChanged,
  fitVisibleTerminal,
  hasUsableTerminalLayout,
  isUsableTerminalDimensions,
  type XtermDimensions
} from '../src/renderer/utils/xtermTerminal'

type Host = Parameters<typeof hasUsableTerminalLayout>[0]
type Terminal = Parameters<typeof fitVisibleTerminal>[1]
type FitAddon = Parameters<typeof fitVisibleTerminal>[2]

function host(width = 800, height = 400, connected = true, clientRects = 1): Host {
  return {
    isConnected: connected,
    getBoundingClientRect: () => ({ width, height }),
    getClientRects: () => ({ length: clientRects })
  }
}

function terminal(baseY: number, viewportY: number) {
  return {
    buffer: { active: { baseY, viewportY } },
    scrollToBottom: vi.fn()
  } satisfies Terminal
}

function fitAddon(dimensions: XtermDimensions | undefined) {
  return {
    proposeDimensions: vi.fn(() => dimensions),
    fit: vi.fn()
  } satisfies FitAddon
}

describe('terminal resize policy', () => {
  it.each([
    ['detached', host(800, 400, false)],
    ['display-none', host(800, 400, true, 0)],
    ['zero-width', host(0, 400)],
    ['zero-height', host(800, 0)]
  ])('does not fit a %s terminal host', (_name, hiddenHost) => {
    const xterm = terminal(100, 100)
    const addon = fitAddon({ cols: 2, rows: 1 })

    expect(fitVisibleTerminal(hiddenHost, xterm, addon)).toBeUndefined()
    expect(addon.proposeDimensions).not.toHaveBeenCalled()
    expect(addon.fit).not.toHaveBeenCalled()
    expect(xterm.scrollToBottom).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { cols: Number.NaN, rows: 20 },
    { cols: 0, rows: 20 },
    { cols: 80, rows: 0 },
    { cols: 80.5, rows: 20 }
  ])('rejects invalid proposed dimensions without fitting (%j)', (dimensions) => {
    const addon = fitAddon(dimensions)

    expect(fitVisibleTerminal(host(), terminal(0, 0), addon)).toBeUndefined()
    expect(addon.fit).not.toHaveBeenCalled()
  })

  it('keeps xterm in charge of a user-scrolled viewport during reflow', () => {
    const xterm = terminal(500, 320)
    const addon = fitAddon({ cols: 120, rows: 30 })

    expect(fitVisibleTerminal(host(), xterm, addon)).toEqual({ cols: 120, rows: 30 })
    expect(addon.fit).toHaveBeenCalledOnce()
    expect(xterm.scrollToBottom).not.toHaveBeenCalled()
  })

  it('continues following output when the viewport was already at the bottom', () => {
    const xterm = terminal(500, 500)
    const addon = fitAddon({ cols: 120, rows: 30 })

    expect(fitVisibleTerminal(host(), xterm, addon)).toEqual({ cols: 120, rows: 30 })
    expect(addon.fit).toHaveBeenCalledOnce()
    expect(xterm.scrollToBottom).toHaveBeenCalledOnce()
  })

  it('only forwards actual dimension changes to the PTY', () => {
    expect(dimensionsChanged(undefined, { cols: 80, rows: 24 })).toBe(true)
    expect(dimensionsChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false)
    expect(dimensionsChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(true)
    expect(isUsableTerminalDimensions({ cols: 80, rows: 24 })).toBe(true)
  })
})
