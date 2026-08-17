import { describe, expect, it, vi } from 'vitest'
import { canUsePiTui } from '../src/cli/interactive/piTui'

describe('CLI pi-tui capability detection', () => {
  const tty = {
    stdin: { isTTY: true, setRawMode: vi.fn() },
    stdout: { isTTY: true }
  }

  it('uses pi-tui only with genuine TTY streams and raw mode outside Electron main', () => {
    expect(
      canUsePiTui(tty, { isElectronMain: false, env: {} })
    ).toBe(true)
  })

  it('rejects Electron main even when TTY + setRawMode look available', () => {
    expect(
      canUsePiTui(tty, { isElectronMain: true, env: {} })
    ).toBe(false)
  })

  it('allows forcing pi-tui under Electron via MOUSSE_FORCE_TUI=1', () => {
    expect(
      canUsePiTui(tty, { isElectronMain: true, env: { MOUSSE_FORCE_TUI: '1' } })
    ).toBe(true)
  })

  it('rejects Electron Windows console handles that libuv does not expose as TTYs', () => {
    expect(
      canUsePiTui(
        { stdin: { isTTY: false }, stdout: { isTTY: false } },
        { isElectronMain: false, env: {} }
      )
    ).toBe(false)
  })

  it('rejects streams that cannot enter raw mode', () => {
    expect(
      canUsePiTui(
        { stdin: { isTTY: true }, stdout: { isTTY: true } },
        { isElectronMain: false, env: {} }
      )
    ).toBe(false)
  })
})
