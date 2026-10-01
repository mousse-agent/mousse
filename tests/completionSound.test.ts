import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_COMPLETION_SOUND_PATH,
  playThreadCompletionSound,
  WINDOWS_COMPLETION_SOUND_PATH
} from '../src/main/notifications/completionSound'

describe('playThreadCompletionSound', () => {
  it('plays Ping via the system player on macOS', () => {
    const spawnPlayer = vi.fn()
    const beep = vi.fn()
    playThreadCompletionSound({
      platform: 'darwin',
      exists: () => true,
      spawnPlayer,
      beep
    })
    expect(spawnPlayer).toHaveBeenCalledWith(MACOS_COMPLETION_SOUND_PATH)
    expect(beep).not.toHaveBeenCalled()
  })

  it('plays the softer system notification chime on Windows', () => {
    const spawnPlayer = vi.fn()
    const beep = vi.fn()
    playThreadCompletionSound({
      platform: 'win32',
      exists: () => true,
      spawnPlayer,
      beep
    })
    expect(spawnPlayer).toHaveBeenCalledWith(WINDOWS_COMPLETION_SOUND_PATH)
    expect(beep).not.toHaveBeenCalled()
  })

  it('falls back to the alert beep when the platform sound is missing', () => {
    const beep = vi.fn()
    playThreadCompletionSound({
      platform: 'darwin',
      exists: () => false,
      spawnPlayer: vi.fn(),
      beep
    })
    expect(beep).toHaveBeenCalledTimes(1)

    const winBeep = vi.fn()
    playThreadCompletionSound({
      platform: 'win32',
      exists: () => false,
      spawnPlayer: vi.fn(),
      beep: winBeep
    })
    expect(winBeep).toHaveBeenCalledTimes(1)
  })
})
