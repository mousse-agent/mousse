import type { ProcessHost } from './host'
import { createUnixHost } from './unixHost'

/**
 * The host of the system this daemon runs on, or none when the endpoint cannot run there. Linux and macOS have
 * one. Windows has none yet: its host (a helper program named `sshd.exe` for each session, and a Job object for
 * each device) is the next change, and goes here. Until then a Windows computer carries editor connections to
 * its own OpenSSH server, as it did before the endpoint existed.
 */
export function systemProcessHost(
  platform: NodeJS.Platform = process.platform
): ProcessHost | undefined {
  if (platform === 'linux' || platform === 'darwin') {
    try {
      return createUnixHost({ platform })
    } catch {
      // The account of the daemon cannot be read (a user id with no entry in the passwd file, as in some containers):
      // the endpoint is unavailable and the system's SSH server is used, and Net starts as it did before.
      return undefined
    }
  }
  return undefined
}
