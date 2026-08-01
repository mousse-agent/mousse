import { describe, expect, it } from 'vitest'
import {
  appendBoundedScrollback,
  MAX_PTY_SCROLLBACK_CHARS
} from '../src/mms/terminals/PtyManager'
import {
  clearStalePtyBinding,
  resolveTerminalShellAction
} from '../src/renderer/utils/terminalSession'

describe('appendBoundedScrollback', () => {
  it('keeps short buffers intact', () => {
    expect(appendBoundedScrollback('hello', ' world', 100)).toBe('hello world')
  })

  it('bounds memory by retaining only the tail', () => {
    const existing = 'a'.repeat(100)
    const chunk = 'b'.repeat(50)
    const result = appendBoundedScrollback(existing, chunk, 80)
    expect(result.length).toBe(80)
    expect(result.endsWith('b'.repeat(50))).toBe(true)
    expect(result.startsWith('a'.repeat(30))).toBe(true)
  })

  it('uses the production max constant', () => {
    expect(MAX_PTY_SCROLLBACK_CHARS).toBeGreaterThan(10_000)
    const huge = 'x'.repeat(MAX_PTY_SCROLLBACK_CHARS + 500)
    const next = appendBoundedScrollback('', huge)
    expect(next.length).toBe(MAX_PTY_SCROLLBACK_CHARS)
  })
})

describe('resolveTerminalShellAction', () => {
  it('shows genuine exits without auto-respawn', () => {
    expect(
      resolveTerminalShellAction({ ptyId: null, exited: true, isAlive: false })
    ).toBe('show_exited')
    expect(
      resolveTerminalShellAction({ ptyId: 'dead', exited: true, isAlive: false })
    ).toBe('show_exited')
  })

  it('leaves live sessions alone', () => {
    expect(
      resolveTerminalShellAction({ ptyId: 'live-1', exited: false, isAlive: true })
    ).toBe('none')
  })

  it('recreates when renderer holds a stale PTY id', () => {
    expect(
      resolveTerminalShellAction({ ptyId: 'stale-uuid', exited: false, isAlive: false })
    ).toBe('recreate')
  })

  it('spawns when the tab has no PTY yet', () => {
    expect(
      resolveTerminalShellAction({ ptyId: null, exited: false, isAlive: false })
    ).toBe('spawn_missing')
  })
})

describe('clearStalePtyBinding', () => {
  it('clears ptyId without marking exited', () => {
    expect(clearStalePtyBinding({ ptyId: 'stale', exited: false })).toEqual({
      ptyId: null,
      exited: false
    })
  })
})
