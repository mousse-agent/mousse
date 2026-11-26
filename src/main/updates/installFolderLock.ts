import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface InstallFolderLockOptions {
  /** The install folder (the executable's folder). */
  folder: string
  /** Where lock files go: a folder every home of this user shares, such as the system temp folder. */
  directory: string
  pid?: number
  now?: () => number
  /** A lock older than this whose process is gone is taken over (`MOUSSE_NET_UPDATE_LOCK_STALE_MS`). */
  staleMs: number
  /** Whether `pid` still runs. */
  alive?: (pid: number) => boolean
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The lock file of an install folder: one per folder, whatever the Mousse home. */
export function installFolderLockPath(directory: string, folder: string): string {
  const key = createHash('sha256').update(process.platform === 'win32' ? folder.toLowerCase() : folder).digest('hex').slice(0, 16)
  return join(directory, `mousse-update-${key}.lock`)
}

/**
 * One update at a time per install folder, whether this home, another home sharing the install or another computer
 * started it. Returns a function that lets go, or null while another process holds it. A download's lock whose process
 * is gone (a crash) is taken over at once; an install's stays for `staleMs`, since its process quit for the installer,
 * which may still be running. Any lock older than `staleMs` is taken over.
 */
export function takeInstallFolderLock(
  options: InstallFolderLockOptions,
  purpose: 'download' | 'install'
): (() => void) | null {
  const path = installFolderLockPath(options.directory, options.folder)
  const pid = options.pid ?? process.pid
  const now = options.now ?? Date.now
  const alive = options.alive ?? processAlive
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid, at: now(), purpose }))
      } finally {
        closeSync(fd)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          const held = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
          if (held.pid === pid) unlinkSync(path)
        } catch {
          // Already gone, or taken over as stale.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let held: { pid?: unknown; at?: unknown; purpose?: unknown } = {}
    try {
      held = JSON.parse(readFileSync(path, 'utf8')) as typeof held
    } catch {
      // Half written or unreadable: judged by its age below, as if its holder were gone.
    }
    const holder = typeof held.pid === 'number' ? held.pid : undefined
    const at = typeof held.at === 'number' ? held.at : 0
    if (holder === pid) return () => undefined
    const recent = now() - at < options.staleMs
    const gone = holder === undefined || !alive(holder)
    if (recent && !gone) return null
    // A holder that quit for the installer: the installer may be running now.
    if (recent && held.purpose === 'install') return null
    try {
      unlinkSync(path)
    } catch {
      // Another process took it over first; the next attempt sees theirs.
    }
  }
  return null
}
