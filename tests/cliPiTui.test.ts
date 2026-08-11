import { describe, expect, it, vi } from 'vitest'
import { canUsePiTui } from '../src/cli/interactive/piTui'

describe('CLI pi-tui capability detection', () => {
  it('uses pi-tui only with genuine TTY streams and raw mode', () => {
    expect(canUsePiTui({
      stdin: { isTTY: true, setRawMode: vi.fn() },
      stdout: { isTTY: true }
    })).toBe(true)
  })

  it('rejects Electron Windows console handles that libuv does not expose as TTYs', () => {
    expect(canUsePiTui({
      stdin: { isTTY: false },
      stdout: { isTTY: false }
    })).toBe(false)
  })

  it('rejects streams that cannot enter raw mode', () => {
    expect(canUsePiTui({
      stdin: { isTTY: true },
      stdout: { isTTY: true }
    })).toBe(false)
  })

  it('uses pi-tui in the packaged console host when real raw TTY streams are available', () => {
    expect(canUsePiTui({
      stdin: { isTTY: true, setRawMode: vi.fn() },
      stdout: { isTTY: true }
    })).toBe(true)
  })
})
