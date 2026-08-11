import { describe, expect, it, vi } from 'vitest'
import { ensureWindowsConsoleTty } from '../src/cli/parseArgs'

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
