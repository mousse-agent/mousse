import type { ProcessHost } from './host'
import { createUnixHost } from './unixHost'
import { createWindowsHost, findSshdHelper } from './windowsHost'

/**
 * The host of the system this daemon runs on, or none when the endpoint cannot run there. Linux and macOS have
 * one. Windows has one when the helper `sshd.exe` is there (in a packaged app, always; in a checkout, once
 * `native/sshd-helper` is built); without it a Windows computer carries editor connections to its own OpenSSH
 * server, as it did before the endpoint existed.
 */
export function systemProcessHost(
  platform: NodeJS.Platform = process.platform,
  helper: () => string | undefined = findSshdHelper,
  /** The profile's folder for the copy of the helper that sessions run from (see `helperCopy`). */
  folder?: string
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
  if (platform === 'win32') {
    const path = helper()
    return path ? createWindowsHost({ helper: path, ...(folder ? { folder } : {}) }) : undefined
  }
  return undefined
}
