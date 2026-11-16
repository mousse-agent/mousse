import { createHash, randomUUID } from 'node:crypto'
import { constants, readlink as readlinkCallback } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, utimes, type FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join, posix, win32 } from 'node:path'
import {
  checkWallpaperImage,
  isWallpaperBucket,
  isWallpaperCopy,
  isWallpaperId,
  readWallpaperHeader,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_REFUSED,
  WALLPAPER_UPLOAD_MAX_BYTES,
  type WallpaperBucket,
  type WallpaperImageInfo,
  type WallpaperImageType
} from '../../shared/themes/wallpaperImage'

/**
 * The profile's wallpaper images (`<profileHome>/wallpapers`), named by the sha-256 of their bytes: the original a person
 * or an agent chose (`<sha>.png|jpg|webp`) and the display copies windows made from it (`<sha>.c1.w<bucket>.webp`).
 * Settings name an image only by that sha, so nothing outside this folder can be read through it, and a moved or
 * deleted source file does not matter once it is stored.
 *
 * Every image is checked from its header before it is kept (`checkWallpaperImage`). Files are written to a temporary
 * name and renamed, and an existing file is never replaced by a different one (the same name means the same bytes).
 * Images no theme uses are removed a week after they were last chosen, when the profile starts (`collect`).
 */

/** What callers see when a file cannot be used, whatever the reason, so a file's existence cannot be probed. */
export class WallpaperRefused extends Error {
  constructor(message = WALLPAPER_REFUSED) {
    super(message)
    this.name = 'WallpaperRefused'
  }
}

export interface StoredWallpaper extends WallpaperImageInfo {
  id: string
}

export interface WallpaperPiece {
  type: WallpaperImageType
  /** The whole file's size. */
  size: number
  offset: number
  data: Buffer
}

/** How long an image no theme uses is kept after it was last chosen. */
export const WALLPAPER_UNUSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000
/** How long a temporary file of an interrupted write is kept. */
const TEMP_KEEP_MS = 60 * 60 * 1000
/** The most the store may hold before new images are refused. */
export const WALLPAPER_STORE_MAX_BYTES = 1024 * 1024 * 1024
/** How long one import may take before its caller is told it failed. */
export const WALLPAPER_IMPORT_DEADLINE_MS = 15_000
/** The most read in one piece. */
export const WALLPAPER_PIECE_MAX_BYTES = 1024 * 1024
/** The copy format: raised when copies are made differently, so old ones are made again. */
const COPY_VERSION = 'c1'

const EXTENSIONS: Record<WallpaperImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const TYPES_BY_EXTENSION: Record<string, WallpaperImageType> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const STORE_FILE = /^([0-9a-f]{64})\.(?:png|jpg|webp|c\d+\.w\d+\.webp)$/
const TEMP_FILE = /^\.tmp-[0-9a-f-]+$/

/** Windows names that open a device whatever folder they are in, with or without an extension. */
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i

const readlink = promisify(readlinkCallback)

/** Opening never follows a link at the last step or waits on a FIFO or device; Windows has neither flag. */
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW | constants.O_NONBLOCK))

/**
 * Why `path` may not be read as a wallpaper source, or null. Absolute paths only. Windows device namespaces (`\\?\`,
 * `\\.\`) and reserved device names (`CON`, `NUL`, `COM1`…) are never allowed. A network path (`\\host\share`) makes
 * Windows sign in to that host with the person's credentials, so it is allowed only when `network` is set: a path the
 * person picked in the file dialog, never one an agent wrote.
 */
export function sourcePathRefusal(path: string, options: { network: boolean; platform?: NodeJS.Platform }): string | null {
  const platform = options.platform ?? process.platform
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) return 'not a path'
  if (platform !== 'win32') return posix.isAbsolute(path) ? null : 'not an absolute path'
  const slashed = path.replace(/\//g, '\\')
  if (/^\\\\[?.]\\/.test(slashed) || /^\\\?\?\\/.test(slashed)) return 'a device path'
  const network = slashed.startsWith('\\\\')
  if (network && !options.network) return 'a network path'
  if (!network && !/^[a-zA-Z]:\\/.test(slashed)) return 'not an absolute path'
  for (const part of slashed.split('\\')) {
    // `CON.txt`, `nul .png` and `COM1.` all open the device.
    const stem = part.replace(/[. ]+$/, '').split('.')[0].trimEnd()
    if (RESERVED_WINDOWS_NAME.test(stem)) return 'a device name'
  }
  return null
}

/** A Windows link target as a plain path: `\\?\C:\x` is `C:\x`, `\\?\UNC\host\share` is `\\host\share`. */
function plainLinkTarget(target: string): string {
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(target) || /^\\\?\?\\[a-zA-Z]:\\/.test(target)) return target.slice(4)
  if (/^\\\\\?\\UNC\\/i.test(target)) return `\\\\${target.slice(8)}`
  return target
}

/**
 * `path` with every link (symlink or junction) followed, each target checked by `sourcePathRefusal` before anything
 * looks at it, so a link cannot lead to a network share or a device. Built on lstat and readlink, which never open
 * the target (unlike the native realpath, which opens the file).
 */
export async function resolveSourcePath(path: string, options: { network: boolean }, depth = 0): Promise<string> {
  const refusal = sourcePathRefusal(path, options)
  if (refusal) throw new WallpaperRefused()
  if (depth > 32) throw new WallpaperRefused()
  const pathApi = process.platform === 'win32' ? win32 : posix
  const normalized = pathApi.normalize(path)
  const root = pathApi.parse(normalized).root
  const parts = normalized.slice(root.length).split(pathApi.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    const next = pathApi.join(current, parts[index])
    const stats = await lstat(next)
    if (stats.isSymbolicLink()) {
      const target = plainLinkTarget(await readlink(next))
      const absolute = pathApi.isAbsolute(target) ? target : pathApi.resolve(current, target)
      return resolveSourcePath(pathApi.join(absolute, ...parts.slice(index + 1)), options, depth + 1)
    }
    current = next
  }
  return current
}

/** One import (or collection) at a time in this process, held until the file call really ends even past its deadline. */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>, deadlineMs?: number): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  if (!deadlineMs) return run
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WallpaperRefused()), deadlineMs)
    timer.unref?.()
    run.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

async function readWhole(handle: FileHandle, size: number): Promise<Buffer> {
  const data = Buffer.alloc(size)
  let filled = 0
  while (filled < size) {
    const { bytesRead } = await handle.read(data, filled, size - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === size ? data : data.subarray(0, filled)
}

function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export class WallpaperStore {
  readonly root: string
  private realHome: Promise<string> | null = null
  private readonly now: () => number
  private readonly used: () => ReadonlySet<string>
  private readonly maxBytes: number

  /**
   * `used`: the ids the profile's themes name now, so a full store can drop what none of them uses. `maxBytes`: the
   * most the store holds (tests use a small one).
   */
  constructor(private readonly profileHome: string, options: { now?: () => number; used?: () => ReadonlySet<string>; maxBytes?: number } = {}) {
    this.root = join(profileHome, 'wallpapers')
    this.now = options.now ?? Date.now
    this.used = options.used ?? (() => new Set())
    this.maxBytes = options.maxBytes ?? WALLPAPER_STORE_MAX_BYTES
  }

  /**
   * The store folder, made when missing. It must be a real folder inside the profile, not a link or junction to one
   * elsewhere; otherwise every call fails and themes show without their wallpaper.
   */
  private async folder(): Promise<string> {
    // Checked on every call, so a folder swapped for a link after an earlier check is refused too.
    await mkdir(this.root, { recursive: true })
    const stats = await lstat(this.root)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('The wallpaper folder is not a folder.')
    this.realHome ??= realpath(this.profileHome)
    this.realHome.catch(() => { this.realHome = null })
    const [real, home] = await Promise.all([realpath(this.root), this.realHome])
    const expected = join(home, 'wallpapers')
    const same = process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected
    if (!same) throw new Error('The wallpaper folder is outside the profile.')
    return this.root
  }

  /**
   * Stores the image at `path` and returns its id. Only absolute paths on this computer; `network` allows a network
   * share (a path the person picked, never an agent's). Every failure is `WallpaperRefused` with the same sentence.
   */
  importFile(path: string, options: { network?: boolean } = {}): Promise<StoredWallpaper> {
    return serialized(async () => {
      let data: Buffer
      try {
        const resolved = await resolveSourcePath(path, { network: Boolean(options.network) })
        const handle = await open(resolved, OPEN_FLAGS)
        try {
          const stats = await handle.stat({ bigint: true })
          if (!stats.isFile() || stats.size === 0n || stats.size > BigInt(WALLPAPER_MAX_BYTES)) throw new WallpaperRefused()
          data = await readWhole(handle, Number(stats.size))
        } finally {
          await handle.close()
        }
      } catch {
        throw new WallpaperRefused()
      }
      return this.keep(data)
    }, WALLPAPER_IMPORT_DEADLINE_MS)
  }

  /** Stores an image sent as bytes (a theme file's wallpaper), at most `WALLPAPER_UPLOAD_MAX_BYTES`. */
  importBytes(data: Buffer): Promise<StoredWallpaper> {
    return serialized(async () => {
      if (data.length > WALLPAPER_UPLOAD_MAX_BYTES) throw new WallpaperRefused()
      return this.keep(data)
    }, WALLPAPER_IMPORT_DEADLINE_MS)
  }

  private async keep(data: Buffer): Promise<StoredWallpaper> {
    const info = checkWallpaperImage(data)
    if (!info) throw new WallpaperRefused()
    const folder = await this.folder()
    const id = createHash('sha256').update(data).digest('hex')
    const target = join(folder, `${id}.${EXTENSIONS[info.type]}`)
    const existing = await stat(target).catch(() => null)
    if (existing?.isFile()) {
      // Chosen again: it is young again, so a week passes before it can be removed unused.
      const now = new Date(this.now())
      await utimes(target, now, now).catch(() => {})
    } else {
      // Full: images no theme uses go first, however recently they were chosen; refused only if that is not enough.
      if ((await this.usedBytes(folder)) + data.length > this.maxBytes) await this.collectIn(folder, this.used(), 0)
      if ((await this.usedBytes(folder)) + data.length > this.maxBytes)
        throw new WallpaperRefused('Too many wallpapers are stored. Delete themes you no longer use, then try again.')
      await this.write(target, data, false)
    }
    return { id, ...info }
  }

  private async usedBytes(folder: string): Promise<number> {
    let total = 0
    for (const name of await readdir(folder)) {
      if (!STORE_FILE.test(name)) continue
      const stats = await lstat(join(folder, name)).catch(() => null)
      if (stats?.isFile()) total += stats.size
    }
    return total
  }

  /** Writes `data` to `target` through a temporary file; an existing `target` is kept unless `replace`. */
  private async write(target: string, data: Uint8Array, replace: boolean): Promise<void> {
    const temporary = join(dirname(target), `.tmp-${randomUUID()}`)
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
    await handle.close()
    try {
      if (!replace && (await lstat(target).catch(() => null))) return
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, target)
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          // Windows refuses a rename while another process has the target open: a concurrent writer of the same bytes.
          if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && !replace && (await lstat(target).catch(() => null))) return
          if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 5) throw error
          await new Promise((resolve) => setTimeout(resolve, 8 * 2 ** attempt))
        }
      }
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  /** The original's file, when stored. */
  private async originalName(folder: string, id: string): Promise<string | null> {
    for (const extension of Object.values(EXTENSIONS)) {
      const name = `${id}.${extension}`
      const stats = await lstat(join(folder, name)).catch(() => null)
      if (stats?.isFile()) return name
    }
    return null
  }

  private copyName(id: string, bucket: WallpaperBucket): string {
    return `${id}.${COPY_VERSION}.w${bucket}.webp`
  }

  /**
   * Opens a store file for reading, never through a link: on Windows (no O_NOFOLLOW) the opened file must be the one
   * `lstat` saw.
   */
  private async openStored(path: string): Promise<{ handle: FileHandle; size: number } | null> {
    const before = await lstat(path, { bigint: true }).catch(() => null)
    if (!before?.isFile()) return null
    const handle = await open(path, OPEN_FLAGS).catch(() => null)
    if (!handle) return null
    const after = await handle.stat({ bigint: true }).catch(() => null)
    if (!after?.isFile() || !sameIdentity(before, after) || after.size > BigInt(WALLPAPER_MAX_BYTES)) {
      await handle.close()
      return null
    }
    return { handle, size: Number(after.size) }
  }

  /**
   * A piece of a stored image: the original (no bucket) or the display copy for `bucket`. Null when it is not stored.
   */
  async read(id: string, bucket: WallpaperBucket | undefined, offset: number, length: number): Promise<WallpaperPiece | null> {
    if (!isWallpaperId(id) || (bucket !== undefined && !isWallpaperBucket(bucket))) return null
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) return null
    const folder = await this.folder()
    const name = bucket === undefined ? await this.originalName(folder, id) : this.copyName(id, bucket)
    if (!name) return null
    const opened = await this.openStored(join(folder, name))
    if (!opened) return null
    try {
      const take = Math.max(0, Math.min(length, WALLPAPER_PIECE_MAX_BYTES, opened.size - offset))
      const data = Buffer.alloc(take)
      let filled = 0
      while (filled < take) {
        const { bytesRead } = await opened.handle.read(data, filled, take - filled, offset + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      const type = bucket === undefined ? TYPES_BY_EXTENSION[name.slice(name.lastIndexOf('.') + 1)] : 'image/webp'
      return { type, size: opened.size, offset, data: data.subarray(0, filled) }
    } finally {
      await opened.handle.close()
    }
  }

  /** The original's header, read from the store. */
  private async originalInfo(folder: string, id: string): Promise<WallpaperImageInfo | null> {
    const name = await this.originalName(folder, id)
    if (!name) return null
    const opened = await this.openStored(join(folder, name))
    if (!opened) return null
    try {
      const head = Buffer.alloc(Math.min(opened.size, 1024 * 1024))
      const { bytesRead } = await opened.handle.read(head, 0, head.length, 0)
      return readWallpaperHeader(head.subarray(0, bytesRead))
    } finally {
      await opened.handle.close()
    }
  }

  /**
   * Keeps a display copy a window made of the stored image `id` for `bucket`. Refused unless the original is stored and
   * `data` is a WebP of the expected size and shape. The first copy kept stays, unless `replace` (a window found the
   * kept copy would not decode). Returns whether `data` is now the stored copy or an equal one was already there.
   */
  saveCopy(id: string, bucket: WallpaperBucket, data: Buffer, options: { replace?: boolean } = {}): Promise<boolean> {
    if (!isWallpaperId(id) || !isWallpaperBucket(bucket)) return Promise.resolve(false)
    // In turn with imports and collection: two windows saving a copy at once cannot both pass "first writer wins".
    return serialized(async () => {
      const folder = await this.folder()
      const original = await this.originalInfo(folder, id)
      if (!original || !isWallpaperCopy(data, original, bucket)) return false
      await this.write(join(folder, this.copyName(id, bucket)), data, Boolean(options.replace))
      return true
    })
  }

  /**
   * Removes images no theme in `used` names that were last chosen over a week ago, their copies, and temporary files
   * of interrupted writes. Runs with imports in turn, so an image chosen while it runs is never removed.
   */
  collect(used: ReadonlySet<string>): Promise<number> {
    return serialized(async () => this.collectIn(await this.folder(), used, WALLPAPER_UNUSED_KEEP_MS))
  }

  /** What `collect` does, for images unused for longer than `keepMs`; runs inside the queue. */
  private async collectIn(folder: string, used: ReadonlySet<string>, keepMs: number): Promise<number> {
    const now = this.now()
    let removed = 0
    for (const name of await readdir(folder)) {
      const path = join(folder, name)
      const stats = await lstat(path).catch(() => null)
      if (!stats?.isFile()) continue
      const id = STORE_FILE.exec(name)?.[1]
      const old = id
        ? !used.has(id) && now - stats.mtimeMs > keepMs && !(await this.originalYoung(folder, id, now, keepMs))
        : TEMP_FILE.test(name) && now - stats.mtimeMs > TEMP_KEEP_MS
      if (!old) continue
      await unlink(path).then(() => { removed++ }, () => {})
    }
    return removed
  }

  /** A copy goes with its original: it stays while the original was chosen within the week. */
  private async originalYoung(folder: string, id: string, now: number, keepMs: number): Promise<boolean> {
    const name = await this.originalName(folder, id)
    if (!name) return false
    const stats = await lstat(join(folder, name)).catch(() => null)
    return Boolean(stats && now - stats.mtimeMs <= keepMs)
  }
}

/** The image ids `themes` name: what collection keeps. */
export function usedWallpapers(themes: ReadonlyArray<{ wallpaper?: { id: string } }>): Set<string> {
  return new Set(themes.flatMap((theme) => (theme.wallpaper ? [theme.wallpaper.id] : [])))
}
