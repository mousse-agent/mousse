import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_COMPLETION_SOUND_PATH,
  playThreadCompletionSound
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

  it('falls back to the alert beep when Ping is missing or off-macOS', () => {
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
      exists: () => true,
      spawnPlayer: vi.fn(),
      beep: winBeep
    })
    expect(winBeep).toHaveBeenCalledTimes(1)
  })
})
