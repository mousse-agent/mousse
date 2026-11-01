import { execFile } from 'node:child_process'
import { lstat, opendir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Waits, without blocking the daemon, until the folders a request or turn works in can be read.
 *
 * Much of the daemon's Git and checkout code reads and writes a project's folder synchronously. While
 * macOS asks "Mousse would like to access files on a removable volume" (or in Documents, Desktop,
 * Downloads, iCloud Drive), the first such call waits for the answer, and a synchronous wait stops the
 * whole daemon: every other thread, settings, `service stop`. Requests and turns that work in a project
 * folder wait here first. Every call here is async, so only a background thread or a child process
 * waits for the prompt; once it is answered the synchronous code runs without waiting.
 *
 * What is checked is where the synchronous code will go: the folder with its symlinks resolved, and the
 * repository's Git common directory (where Mousse keeps its repository metadata), which a linked
 * worktree can have on another volume.
 *
 * macOS grants that access per volume (or per protected folder), so a volume that answered is trusted
 * for {@link RECHECK_MS} and then checked again, which catches a remount or a reset permission. A failed
 * check (no such folder, access refused) is not remembered: the folder answered, so the caller goes on.
 *
 * A stuck check holds a background thread of Node's small pool (file and DNS work share it), so checks
 * on one volume run one at a time, and at most {@link MAX_CHECKS} run at once across volumes.
 *
 * This does not help a network drive that hangs on every call: it can answer the check and hang later.
 */

/** How long a volume that answered is trusted before it is checked again. */
export const RECHECK_MS = 60_000
/** Checks that may hold a background thread at once, across all volumes. */
export const MAX_CHECKS = 2

export interface FolderAccessDeps {
  /** Reads the folder the way the synchronous code would; settles once its volume answers. */
  probe(path: string): Promise<void>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  readlink(path: string): Promise<string>
  /** The folder's resolved path where symlinks cannot be walked one part at a time (Windows). */
  realpath(path: string): Promise<string>
  /** The absolute Git common directory of the repository `folder` is in, or null. Runs as a child process. */
  commonDir(folder: string): Promise<string | null>
  /** The volume (or protected folder) a path is on, from the path alone. */
  keyOf(path: string): string
  now(): number
  recheckMs: number
  maxChecks: number
  platform: NodeJS.Platform
}

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

function gitCommonDir(folder: string): Promise<string | null> {
  return new Promise((settle) => {
    execFile('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: folder,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout) => settle(error ? null : stdout.trim() || null))
  })
}

/** Home folders macOS asks about one by one, each its own grant. */
const PROTECTED_HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents')]

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

/**
 * The volume (or protected folder) `path` is on, from the path alone: finding the device would need the
 * very call that waits. Give it a resolved path; paths on the system volume share one key.
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

function defaultDeps(): FolderAccessDeps {
  return {
    probe: readFolder,
    lstat,
    readlink,
    realpath,
    commonDir: gitCommonDir,
    keyOf: (path) => volumeKey(path),
    now: Date.now,
    recheckMs: RECHECK_MS,
    maxChecks: MAX_CHECKS,
    platform: process.platform
  }
}

/** Symlinks followed before a path is taken as it is. */
const MAX_LINKS = 40
/** Folders whose resolved path and common directory are remembered. */
const TARGET_LIMIT = 512

interface Target { at: number; settled: boolean; done: Promise<{ real: string; common: string | null }> }

export class FolderAccessGate {
  private deps: FolderAccessDeps
  private readonly answeredAt = new Map<string, number>()
  private readonly volumeChecks = new Map<string, Promise<void>>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly targets = new Map<string, Target>()
  private running = 0
  private readonly waitingForSlot: Array<() => void> = []
  private generation = 0

  constructor(deps: Partial<FolderAccessDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  /**
   * Resolves once every volume the folders (and their repositories' common directories) are on has
   * answered. Rejects only with `signal`'s reason when it aborts first; what a folder that cannot be
   * read means is the caller's to find out. Relative and empty paths are skipped.
   */
  async ready(paths: Iterable<string | null | undefined>, options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options
    signal?.throwIfAborted()
    const folders = [...new Set([...paths].filter((path): path is string => Boolean(path) && isAbsolute(path!)))]
    if (folders.length === 0) return
    const work = Promise.all(folders.map((folder) => this.folder(folder)))
    if (!signal) {
      await work
      return
    }
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([work, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** For tests: replace what the checks call and forget everything checked so far. */
  reset(deps: Partial<FolderAccessDeps> = {}): void {
    this.deps = { ...defaultDeps(), ...deps }
    this.generation += 1
    this.answeredAt.clear()
    this.volumeChecks.clear()
    this.lanes.clear()
    this.targets.clear()
    this.running = 0
    this.waitingForSlot.length = 0
  }

  private fresh(at: number | undefined): boolean {
    return at !== undefined && this.deps.now() - at < this.deps.recheckMs
  }

  private async folder(path: string): Promise<void> {
    const hit = this.targets.get(path)
    const remembered = hit?.settled === true && this.fresh(hit.at)
    const { real, common } = await this.target(path)
    // A target found just now waited for the folder's volume already.
    if (remembered) await this.volume(real)
    if (common) await this.volume(common)
  }

  /** The folder's resolved path and its repository's resolved common directory, remembered for a while. */
  private target(path: string): Promise<{ real: string; common: string | null }> {
    const hit = this.targets.get(path)
    if (hit && (!hit.settled || this.fresh(hit.at))) return hit.done
    const done = (async () => {
      const real = await this.resolvePath(path)
      // Git reads the folder, so it runs only once the folder's volume answered; as a child process it holds
      // no background thread while it waits on another volume.
      await this.volume(real)
      const common = await this.deps.commonDir(real)
      return { real, common: common ? await this.resolvePath(common) : null }
    })()
    if (this.targets.size >= TARGET_LIMIT) this.targets.delete(this.targets.keys().next().value!)
    const entry: Target = { at: this.deps.now(), settled: false, done }
    this.targets.set(path, entry)
    // A target found while its volume waited is dated from when it was found.
    void done.then(() => { entry.settled = true; entry.at = this.deps.now() }, () => { if (this.targets.get(path) === entry) this.targets.delete(path) })
    return done
  }

  /**
   * `path` with its symlinks resolved, one part at a time, each `lstat` on the volume that part is on, so
   * a link on the system volume into a waiting volume waits on that volume, not on the system volume.
   */
  private async resolvePath(path: string): Promise<string> {
    const absolute = resolve(path)
    if (this.deps.platform === 'win32') {
      return this.inLane(this.deps.keyOf(absolute), () => this.deps.realpath(absolute)).catch(() => absolute)
    }
    const rest = absolute.split(sep).filter(Boolean)
    let current: string = sep
    let links = 0
    while (rest.length) {
      const next = join(current, rest.shift()!)
      const key = this.deps.keyOf(next)
      const stats = await this.inLane(key, () => this.deps.lstat(next)).catch(() => null)
      // A part that is not there: the rest cannot be resolved further.
      if (!stats) return join(next, ...rest)
      if (stats.isSymbolicLink() && links < MAX_LINKS) {
        links += 1
        const link = await this.inLane(key, () => this.deps.readlink(next)).catch(() => null)
        if (link === null) return join(next, ...rest)
        rest.unshift(...resolve(current, link).split(sep).filter(Boolean))
        current = sep
      } else {
        current = next
      }
    }
    return current
  }

  /** One read of a resolved folder per volume at a time; callers on that volume share it. */
  private volume(real: string): Promise<void> {
    const key = this.deps.keyOf(real)
    if (this.fresh(this.answeredAt.get(key))) return Promise.resolve()
    const running = this.volumeChecks.get(key)
    if (running) return running
    const generation = this.generation
    const check: Promise<void> = this.inLane(key, () => this.deps.probe(real)).then(
      () => { if (this.generation === generation) this.answeredAt.set(key, this.deps.now()) },
      () => undefined
    ).finally(() => { if (this.volumeChecks.get(key) === check) this.volumeChecks.delete(key) })
    this.volumeChecks.set(key, check)
    return check
  }

  /** Runs `op` after the volume's earlier calls, holding one of the {@link MAX_CHECKS} slots while it runs. */
  private inLane<T>(key: string, op: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const result = previous.then(async () => {
      await this.acquire()
      try {
        return await op()
      } finally {
        if (this.generation === generation) this.release()
      }
    })
    const settled = result.then(() => undefined, () => undefined)
    this.lanes.set(key, settled)
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key) })
    return result
  }

  private acquire(): Promise<void> {
    if (this.running < this.deps.maxChecks) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise((granted) => this.waitingForSlot.push(() => { this.running += 1; granted() }))
  }

  private release(): void {
    this.running -= 1
    this.waitingForSlot.shift()?.()
  }
}

/** The daemon's gate. */
export const folderAccess = new FolderAccessGate()

/** Waits until the volumes of `paths` answer, or `signal` aborts; see {@link FolderAccessGate}. */
export function waitForFolderAccess(paths: Iterable<string | null | undefined>, options?: { signal?: AbortSignal }): Promise<void> {
  return folderAccess.ready(paths, options)
}
