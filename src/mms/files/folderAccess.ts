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
 * A stuck check holds a background thread of Node's small pool (file and DNS work share it), so calls on
 * one volume run one at a time and a stuck volume holds one thread at most. Volumes never wait on each
 * other. A call still running after {@link STUCK_AFTER_MS}, or that every caller stopped waiting for,
 * marks its volume not answering: the call settles in the background, no new call starts there until it
 * does, and requests fail at once ({@link FolderNotAnsweringError}) while turns wait for the answer.
 *
 * This does not help a network drive that hangs on every call: it can answer the check and hang later.
 */

/** How long a volume that answered is trusted before it is checked again. */
export const RECHECK_MS = 60_000
/** How long a volume's call may run before the volume counts as not answering (a pending prompt, a hung drive). */
export const STUCK_AFTER_MS = 3_000

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
  stuckAfterMs: number
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
      // A Git that never answers (a hung drive) is ended in the end; the caller stopped waiting long before.
      timeout: 120_000,
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
    stuckAfterMs: STUCK_AFTER_MS,
    platform: process.platform
  }
}

/** Symlinks followed before a path is taken as it is. */
const MAX_LINKS = 40
/** Folders whose resolved path and common directory are remembered. */
const TARGET_LIMIT = 512

/** A volume that has not answered for a while; see {@link STUCK_AFTER_MS}. */
export class FolderNotAnsweringError extends Error {
  readonly code = 'folder_not_answering'
  constructor(readonly volume: string) {
    super(`The drive or folder at ${volume} is not answering. If macOS is asking whether Mousse may access it, answer that prompt; the next request tries again.`)
    this.name = 'FolderNotAnsweringError'
  }
}

export interface WaitOptions {
  signal?: AbortSignal
  /**
   * What to do once a volume is not answering: `'wait'` (the default) waits until it answers, as a turn
   * does; `'fail'` throws {@link FolderNotAnsweringError} at once, so a request does not pile up behind it.
   */
  whenNotAnswering?: 'wait' | 'fail'
}

interface Context { signal: AbortSignal; fail: boolean }

/** The call a volume is running. Once it is stuck, nobody waits on it and it settles in the background. */
interface Busy { settled: Promise<void>; result: Promise<unknown>; done: boolean; stuck: boolean; becameStuck: Promise<void>; markStuck(): void }

interface Volume {
  busy?: Busy
  /** Callers blocked on this volume: running its call or queued behind it. */
  waiters: number
  answeredAt?: number
  /** Counts the volume's finished checks, so callers that waited behind one take its answer. */
  checks: number
}

interface Target { at: number; real: string; common: string | null }

const noop = (): void => undefined

export class FolderAccessGate {
  private deps: FolderAccessDeps
  private readonly volumes = new Map<string, Volume>()
  private readonly targets = new Map<string, Target>()
  private generation = 0

  constructor(deps: Partial<FolderAccessDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  /**
   * Resolves once every volume the folders (and their repositories' common directories) are on has
   * answered. Rejects with `signal`'s reason when it aborts first, and with {@link FolderNotAnsweringError}
   * when asked to. What a folder that cannot be read means is the caller's to find out. Relative and empty
   * paths are skipped.
   */
  async ready(paths: Iterable<string | null | undefined>, options: WaitOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const folders = [...new Set([...paths].filter((path): path is string => Boolean(path) && isAbsolute(path!)))]
    if (folders.length === 0) return
    // Ends every branch when this call returns, so a branch still queued on a volume stops counting as its waiter.
    const finished = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, finished.signal]) : finished.signal
    try {
      await Promise.all(folders.map((folder) => this.folder(folder, { signal, fail: options.whenNotAnswering === 'fail' })))
    } finally {
      finished.abort(new DOMException('Finished', 'AbortError'))
    }
  }

  /** For tests: replace what the checks call and forget everything checked so far. */
  reset(deps: Partial<FolderAccessDeps> = {}): void {
    this.deps = { ...defaultDeps(), ...deps }
    this.generation += 1
    this.volumes.clear()
    this.targets.clear()
  }

  private fresh(at: number | undefined): boolean {
    return at !== undefined && this.deps.now() - at < this.deps.recheckMs
  }

  private volumeOf(key: string): Volume {
    let volume = this.volumes.get(key)
    if (!volume) this.volumes.set(key, volume = { waiters: 0, checks: 0 })
    return volume
  }

  private async folder(path: string, ctx: Context): Promise<void> {
    const hit = this.targets.get(path)
    let target: Target
    if (hit && this.fresh(hit.at)) {
      target = hit
      await this.volume(target.real, ctx)
    } else {
      // Finding the target waits for the folder's volume already.
      target = await this.findTarget(path, ctx)
      if (this.targets.size >= TARGET_LIMIT) this.targets.delete(this.targets.keys().next().value!)
      this.targets.set(path, target)
    }
    if (target.common) await this.volume(target.common, ctx)
  }

  /** The folder's resolved path and its repository's resolved common directory. */
  private async findTarget(path: string, ctx: Context): Promise<Target> {
    const real = await this.resolvePath(path, ctx)
    // Git reads the folder, so it runs only once the folder's volume answered; as a child process it holds no
    // background thread while it waits on another volume.
    await this.volume(real, ctx)
    const common = await this.until(this.deps.commonDir(real), ctx, ctx.fail ? { volume: real, afterMs: this.deps.stuckAfterMs } : undefined)
    return { at: this.deps.now(), real, common: common ? await this.resolvePath(common, ctx) : null }
  }

  /**
   * `path` with its symlinks resolved, one part at a time, each `lstat` on the volume that part is on, so
   * a link on the system volume into a waiting volume waits on that volume, not on the system volume.
   */
  private async resolvePath(path: string, ctx: Context): Promise<string> {
    const absolute = resolve(path)
    if (this.deps.platform === 'win32') {
      return await this.call(this.deps.keyOf(absolute), () => this.deps.realpath(absolute).catch(() => absolute), ctx) ?? absolute
    }
    const rest = absolute.split(sep).filter(Boolean)
    let current: string = sep
    let links = 0
    while (rest.length) {
      const next = join(current, rest.shift()!)
      const key = this.deps.keyOf(next)
      const stats = await this.call(key, () => this.deps.lstat(next).catch(() => null), ctx)
      // A part that is not there: the rest cannot be resolved further.
      if (!stats) return join(next, ...rest)
      if (stats.isSymbolicLink() && links < MAX_LINKS) {
        links += 1
        const link = await this.call(key, () => this.deps.readlink(next).catch(() => null), ctx)
        if (!link) return join(next, ...rest)
        rest.unshift(...resolve(current, link).split(sep).filter(Boolean))
        current = sep
      } else {
        current = next
      }
    }
    return current
  }

  /** Reads a resolved folder unless its volume answered lately; callers waiting together share one read. */
  private async volume(real: string, ctx: Context): Promise<void> {
    const key = this.deps.keyOf(real)
    const volume = this.volumeOf(key)
    if (this.fresh(volume.answeredAt)) return
    const seen = volume.checks
    const generation = this.generation
    await this.call(key, () => this.deps.probe(real).then(
      () => { if (this.generation === generation) volume.answeredAt = this.deps.now() },
      noop
    ).finally(() => { volume.checks += 1 }), ctx, () => this.fresh(volume.answeredAt) || volume.checks !== seen)
  }

  /**
   * Runs `op` on the volume `key`, one call at a time per volume, so a stuck volume holds one background
   * thread at most and never delays another volume. A call still running after `stuckAfterMs`, or that every
   * caller stopped waiting for, marks the volume not answering: it settles in the background, and no new call
   * starts on that volume until it does. `skip` is asked after waiting behind an earlier call.
   */
  private async call<T>(key: string, op: () => Promise<T>, ctx: Context, skip?: () => boolean): Promise<T | undefined> {
    const volume = this.volumeOf(key)
    volume.waiters += 1
    try {
      for (let busy = volume.busy; busy; busy = volume.busy) await this.until(busy.settled, ctx, undefined, key, busy)
      if (skip?.()) return undefined
      const busy = this.start(volume, op)
      return await this.until(busy.result as Promise<T>, ctx, undefined, key, busy)
    } finally {
      volume.waiters -= 1
      if (volume.waiters === 0 && volume.busy && !volume.busy.done) volume.busy.markStuck()
    }
  }

  private start(volume: Volume, op: () => Promise<unknown>): Busy {
    let markStuck = noop
    const becameStuck = new Promise<void>((resolveStuck) => { markStuck = resolveStuck })
    const result = Promise.resolve().then(op)
    const busy: Busy = {
      result,
      settled: result.then(noop, noop),
      done: false,
      stuck: false,
      becameStuck,
      markStuck: () => {
        if (busy.done || busy.stuck) return
        busy.stuck = true
        markStuck()
      }
    }
    volume.busy = busy
    const timer = setTimeout(() => busy.markStuck(), this.deps.stuckAfterMs)
    timer.unref?.()
    // First handler on `settled`: the volume is free before any caller queued behind this call looks again.
    void busy.settled.then(() => {
      busy.done = true
      clearTimeout(timer)
      if (volume.busy === busy) volume.busy = undefined
    })
    return busy
  }

  /**
   * `work`, unless the caller's signal aborts first, or (for a caller that fails when a volume is not
   * answering) `busy` becomes stuck or `timeout` passes.
   */
  private async until<T>(work: Promise<T>, ctx: Context, timeout?: { volume: string; afterMs: number }, key?: string, busy?: Busy): Promise<T> {
    ctx.signal.throwIfAborted()
    const cleanups: Array<() => void> = []
    const stops: Array<Promise<never>> = [new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(ctx.signal.reason ?? new DOMException('Aborted', 'AbortError'))
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => ctx.signal.removeEventListener('abort', onAbort))
    })]
    if (ctx.fail && busy && key) stops.push(busy.becameStuck.then(() => { throw new FolderNotAnsweringError(key) }))
    if (timeout) {
      stops.push(new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new FolderNotAnsweringError(timeout.volume)), timeout.afterMs)
        timer.unref?.()
        cleanups.push(() => clearTimeout(timer))
      }))
    }
    for (const stop of stops) stop.catch(noop)
    try {
      return await Promise.race([work, ...stops])
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  }
}

/** The daemon's gate. */
export const folderAccess = new FolderAccessGate()

/** Waits until the volumes of `paths` answer; see {@link FolderAccessGate} and {@link WaitOptions}. */
export function waitForFolderAccess(paths: Iterable<string | null | undefined>, options?: WaitOptions): Promise<void> {
  return folderAccess.ready(paths, options)
}
