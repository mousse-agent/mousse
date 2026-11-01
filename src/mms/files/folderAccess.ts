import { opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Waits, without blocking the daemon, until a project's folder can be read.
 *
 * Much of the daemon's Git and checkout code reads and writes a project's folder synchronously. While
 * macOS asks "Mousse would like to access files on a removable volume" (or in Documents, Desktop,
 * Downloads, iCloud Drive), the first such call waits for the answer, and a synchronous wait stops the
 * whole daemon: every other thread, settings, `service stop`. Requests and turns that name a project
 * folder wait here first. The check is an async `stat` and `opendir`, so only a background thread waits
 * for the prompt; once it is answered the synchronous code runs without waiting.
 *
 * macOS grants that access per volume (or per protected folder), so a volume that answered once is not
 * checked again for the life of the process. A failed check (no such folder, access refused) is not
 * remembered: the folder answered, so the caller goes on, and the next request checks again.
 *
 * This does not help a network drive that hangs on every call: it can answer the check and hang later.
 */

/** Reads `path` the way the synchronous code would; resolves or rejects once the volume answers. */
export type FolderProbe = (path: string) => Promise<void>

async function readFolder(path: string): Promise<void> {
  await stat(path)
  // A permission prompt for a volume's files can be raised by reading a folder, not only by `stat`.
  const dir = await opendir(path)
  try {
    await dir.read()
  } finally {
    await dir.close()
  }
}

/** Home folders macOS asks about one by one, each its own grant. */
const PROTECTED_HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents')]

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

/**
 * The volume (or protected folder) `path` is on, worked out from the path alone: finding the device
 * would need the very call that waits. Paths on the system volume share one key.
 */
export function volumeKey(path: string, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const absolute = resolve(path)
  if (platform === 'win32') {
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(absolute)
    if (unc) return unc[0].toLowerCase()
    return absolute.slice(0, 2).toUpperCase()
  }
  const parts = absolute.split(sep).filter(Boolean)
  if (platform === 'darwin') {
    if (parts[0] === 'Volumes' && parts[1]) return join(sep, 'Volumes', parts[1])
    for (const folder of PROTECTED_HOME_FOLDERS) {
      const full = join(home, folder)
      if (within(absolute, full)) return full
    }
    const cloud = join(home, 'Library', 'CloudStorage')
    if (within(absolute, cloud)) {
      const provider = absolute.slice(cloud.length + 1).split(sep)[0]
      return provider ? join(cloud, provider) : cloud
    }
    return sep
  }
  if (parts[0] === 'media' && parts[2]) return join(sep, 'media', parts[1]!, parts[2])
  if (parts[0] === 'run' && parts[1] === 'media' && parts[3]) return join(sep, 'run', 'media', parts[2]!, parts[3])
  if (parts[0] === 'mnt' && parts[1]) return join(sep, 'mnt', parts[1])
  return sep
}

export class FolderAccessGate {
  private readonly answered = new Set<string>()
  private readonly checking = new Map<string, Promise<void>>()

  constructor(
    private probe: FolderProbe = readFolder,
    private keyOf: (path: string) => string = (path) => volumeKey(path)
  ) {}

  /**
   * Resolves once every volume the given folders are on has answered. Never rejects: what a folder
   * that cannot be read means is the caller's to find out. Relative and empty paths are skipped.
   */
  async ready(paths: Iterable<string | null | undefined>): Promise<void> {
    const waits = new Map<string, Promise<void>>()
    for (const path of paths) {
      if (!path || !isAbsolute(path)) continue
      const key = this.keyOf(path)
      if (this.answered.has(key) || waits.has(key)) continue
      waits.set(key, this.check(key, path))
    }
    if (waits.size) await Promise.all(waits.values())
  }

  /** One check at a time per volume, so a stuck volume holds at most one background thread. */
  private check(key: string, path: string): Promise<void> {
    const running = this.checking.get(key)
    if (running) return running
    const check: Promise<void> = new Promise<void>((settle) => settle(this.probe(path))).then(
      () => { if (this.checking.get(key) === check) this.answered.add(key) },
      () => undefined
    ).finally(() => { if (this.checking.get(key) === check) this.checking.delete(key) })
    this.checking.set(key, check)
    return check
  }

  /** For tests: check with `probe`, tell volumes apart with `keyOf`, and forget every volume that answered. */
  reset(probe: FolderProbe = readFolder, keyOf: (path: string) => string = (path) => volumeKey(path)): void {
    this.probe = probe
    this.keyOf = keyOf
    this.answered.clear()
    this.checking.clear()
  }
}

/** The daemon's gate. */
export const folderAccess = new FolderAccessGate()

/** Waits until the volumes of `paths` answer; see {@link FolderAccessGate}. */
export function waitForFolderAccess(...paths: Array<string | null | undefined>): Promise<void> {
  return folderAccess.ready(paths)
}
