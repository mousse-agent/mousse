import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { shell } from 'electron'

/** System Ping sound — the same name posted on the Notification banner. */
export const MACOS_COMPLETION_SOUND_PATH = '/System/Library/Sounds/Ping.aiff'
const AFPLAY = '/usr/bin/afplay'

/**
 * Play the agent-completion sound explicitly.
 *
 * Used when no banner is posted (the finished thread is already on screen, or
 * platform notifications are unavailable). `shell.beep()` is only the
 * low-volume alert blip and is muted whenever UI sound effects are off, so on
 * macOS play the same Ping.aiff the banner uses instead.
 */
export function playThreadCompletionSound(deps?: {
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  spawnPlayer?: (file: string) => void
  beep?: () => void
}): void {
  const platform = deps?.platform ?? process.platform
  const exists = deps?.exists ?? existsSync
  const beep = deps?.beep ?? (() => shell.beep())
  const spawnPlayer =
    deps?.spawnPlayer ??
    ((file: string) => {
      const child = spawn(AFPLAY, [file], { stdio: 'ignore', detached: true })
      child.on('error', () => beep())
      child.unref()
    })

  try {
    if (platform === 'darwin' && exists(MACOS_COMPLETION_SOUND_PATH)) {
      spawnPlayer(MACOS_COMPLETION_SOUND_PATH)
      return
    }
  } catch {
    /* fall through to the alert beep */
  }
  try {
    beep()
  } catch {
    /* audio is best-effort */
  }
}
