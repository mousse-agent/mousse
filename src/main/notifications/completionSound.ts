import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'

/** System Ping sound — the same name posted on the Notification banner. */
export const MACOS_COMPLETION_SOUND_PATH = '/System/Library/Sounds/Ping.aiff'
/** A softer Windows system chime than Electron's default alert beep. */
export const WINDOWS_COMPLETION_SOUND_PATH = join(
  process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows',
  'Media',
  'Windows Notify Messaging.wav'
)
const AFPLAY = '/usr/bin/afplay'
const POWERSHELL = 'powershell.exe'

/**
 * Play the agent-completion sound explicitly.
 *
 * Used when no banner is posted (the finished thread is already on screen, or
 * platform notifications are unavailable). `shell.beep()` is only the
 * low-volume alert blip and is muted whenever UI sound effects are off, so on
 * macOS plays the same Ping.aiff the banner uses. Windows uses a softer
 * built-in notification chime instead of Electron's harsh alert beep.
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
      const windows = platform === 'win32'
      const escapedFile = file.replaceAll("'", "''")
      const child = spawn(
        windows ? POWERSHELL : AFPLAY,
        windows
          ? [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-Command',
              `[System.Media.SoundPlayer]::new('${escapedFile}').PlaySync()`
            ]
          : [file],
        { stdio: 'ignore', detached: true, windowsHide: windows }
      )
      child.on('error', () => beep())
      child.unref()
    })

  try {
    if (platform === 'darwin' && exists(MACOS_COMPLETION_SOUND_PATH)) {
      spawnPlayer(MACOS_COMPLETION_SOUND_PATH)
      return
    }
    if (platform === 'win32' && exists(WINDOWS_COMPLETION_SOUND_PATH)) {
      spawnPlayer(WINDOWS_COMPLETION_SOUND_PATH)
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
