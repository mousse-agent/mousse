import { describe, expect, it, vi } from 'vitest'
import { ensureWindowsConsoleTty, shouldUseReadlineTerminal } from '../src/cli/parseArgs'

function mockStream(isTTY: boolean): NodeJS.ReadStream {
  const stream = {
    isTTY,
    resume: vi.fn()
  }
  return stream as unknown as NodeJS.ReadStream
}

describe('ensureWindowsConsoleTty', () => {
  it('no-ops on non-Windows platforms', () => {
    if (process.platform === 'win32') return
    const stdin = mockStream(false)
    const stdout = mockStream(false) as unknown as NodeJS.WriteStream
    const stderr = mockStream(false) as unknown as NodeJS.WriteStream
    expect(ensureWindowsConsoleTty({ stdin, stdout, stderr })).toBe(false)
    expect(stdin.isTTY).toBe(false)
  })

  it('marks stdio TTY when already TTY without changing flags', () => {
    const stdin = mockStream(true)
    const stdout = mockStream(true) as unknown as NodeJS.WriteStream
    const stderr = mockStream(true) as unknown as NodeJS.WriteStream
    // On real win32 console this may patch nothing if already TTY
    ensureWindowsConsoleTty({ stdin, stdout, stderr })
    expect(stdin.isTTY).toBe(true)
    expect(stdout.isTTY).toBe(true)
  })
})

describe('shouldUseReadlineTerminal', () => {
  it('uses cooked mode on Windows Electron so the console host echoes keys', () => {
    expect(
      shouldUseReadlineTerminal(true, {
        platform: 'win32',
        isElectronMain: true,
        env: {}
      })
    ).toBe(false)
  })

  it('keeps readline terminal mode for plain Node on Windows', () => {
    expect(
      shouldUseReadlineTerminal(true, {
        platform: 'win32',
        isElectronMain: false,
        env: {}
      })
    ).toBe(true)
  })

  it('keeps readline terminal mode for Electron on non-Windows', () => {
    expect(
      shouldUseReadlineTerminal(true, {
        platform: 'darwin',
        isElectronMain: true,
        env: {}
      })
    ).toBe(true)
  })

  it('allows forcing readline terminal mode under Windows Electron', () => {
    expect(
      shouldUseReadlineTerminal(true, {
        platform: 'win32',
        isElectronMain: true,
        env: { MOUSSE_FORCE_READLINE_TERMINAL: '1' }
      })
    ).toBe(true)
  })

  it('stays non-terminal when stdin is not interactive', () => {
    expect(
      shouldUseReadlineTerminal(false, {
        platform: 'win32',
        isElectronMain: false,
        env: {}
      })
    ).toBe(false)
  })
})
