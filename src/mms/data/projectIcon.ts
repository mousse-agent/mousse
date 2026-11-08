import { constants } from 'fs'
import { open, readdir, realpath } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import type { Project } from '../../shared/types'
import { PROJECT_ICON_MAX_BYTES, type ProjectIconImage } from '../../shared/projectIcon'
import { appFolders, manifestFiles, withSvgSiblings } from './projectIconManifests'

/** How long a found icon (or finding none) is trusted before the folder is looked at again. */
export const PROJECT_ICON_DETECT_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The version of the detection rules. A result found by older rules (or none found) is looked for again at once,
 * instead of waiting out {@link PROJECT_ICON_DETECT_TTL_MS}. Raise it whenever the rules find more.
 */
export const PROJECT_ICON_DETECTOR_VERSION = 2

/** Formats in the order they are preferred: a vector icon stays sharp at any size; an ICO is the last resort. */
const FORMATS = ['svg', 'png', 'ico'] as const

/**
 * The standard places of an app's or project's icon, best first, without an extension, with `/` separators. Every
 * format is tried at every place before the next format, so an SVG anywhere wins over a PNG.
 */
const STEMS: readonly string[] = [
  // A website's favicon, where web frameworks keep it.
  ...['', 'public/', 'static/', 'src/', 'app/', 'web/', 'assets/'].map((dir) => `${dir}favicon`),
  // Next.js app router icons.
  'src/app/icon',
  'app/icon',
  // App and project icons and logos.
  ...['', 'assets/', 'resources/', 'build/', 'src/assets/'].flatMap((dir) => [`${dir}icon`, `${dir}logo`]),
  // A touch icon, Tauri and Android launcher icons.
  ...['', 'public/', 'static/'].map((dir) => `${dir}apple-touch-icon`),
  'src-tauri/icons/icon',
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher',
  // Expo's default icons, and Flutter's web icons.
  'assets/images/icon',
  'assets/images/favicon',
  'assets/adaptive-icon',
  'web/icons/Icon-192',
  'web/icons/Icon-512'
]

/** The standard places in a monorepo's app folder: its web favicon and its app icon. */
const APP_STEMS: readonly string[] = ['public/favicon', 'favicon', 'assets/icon', 'assets/images/icon']

/** Most folders listed and manifest files read for one project, so a large or odd folder stays cheap. */
const MAX_LISTINGS = 48
const MAX_MANIFEST_READS = 12
/** The largest manifest read. */
const MAX_MANIFEST_BYTES = 256 * 1024

/** A logo file in the project's own name at its root, such as `mousse_logo_icon.svg` or `acme-logo.svg`. */
const ROOT_LOGO_ICON = /^[\w.-]*logo[_-]?icon\.svg$/i
const ROOT_NAMED_LOGO = /^[\w.-]+[_-]logo[\w.-]*\.svg$/i

/** The standard icon paths, relative to the project folder, in the order they are tried (the root logo files aside). */
export function projectIconCandidates(): string[] {
  return FORMATS.flatMap((format) => STEMS.map((stem) => `${stem}.${format}`))
}

/** The standard icon paths in a monorepo's app folder (`web`, a workspace), in the order they are tried. */
export function appIconCandidates(appRoot: string): string[] {
  return FORMATS.flatMap((format) => APP_STEMS.map((stem) => `${appRoot}/${stem}.${format}`))
}

/** The root logo files among a folder's entries, best first: a logo icon before a plain named logo, shorter first. */
export function rootLogoCandidates(names: readonly string[]): string[] {
  const rank = (name: string) => (ROOT_LOGO_ICON.test(name) ? 0 : 1)
  return names
    .filter((name) => ROOT_LOGO_ICON.test(name) || ROOT_NAMED_LOGO.test(name))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
}

/** Opening never waits on a FIFO or a device swapped in for the file; Windows has no such flag. */
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

/**
 * Reads an icon file and returns it as a data URL, or null when it is missing, too large or not an image. The
 * size and type are checked on the opened file, and at most {@link PROJECT_ICON_MAX_BYTES} are read, so a file
 * that is swapped or grows after the check is still refused.
 */
export async function readIconFile(file: string): Promise<{ dataUrl: string; mime: string } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, OPEN_FLAGS)
    const info = await handle.stat()
    if (!info.isFile() || info.size === 0 || info.size > PROJECT_ICON_MAX_BYTES) return null
    const cached = dataUrlCache.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.image
    const buffer = Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length === 0 || length > PROJECT_ICON_MAX_BYTES) return null
    const bytes = buffer.subarray(0, length)
    const mime = imageMime(bytes)
    const image = mime ? { mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` } : null
    rememberDataUrl(file, { mtimeMs: info.mtimeMs, size: info.size, image })
    return image
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Reads an icon found in the project folder, or null when it is not there or, through a symlink, is outside the
 * folder: a cloned repository chooses its own files and links, and only files of its own are shown as found icons.
 */
export async function readProjectIconFile(root: string, path: string, realRoot?: string): Promise<{ dataUrl: string; mime: string } | null> {
  if (isAbsolute(path)) return null
  try {
    const base = realRoot ?? (await realpath(root))
    const real = await realpath(join(root, path))
    const inside = relative(base, real)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
    return await readIconFile(real)
  } catch {
    return null
  }
}

/** Reads a text file of the project (a manifest), or null when it is missing, too large or, through a symlink, outside it. */
async function readProjectText(root: string, path: string, realRoot: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const real = await realpath(join(root, path))
    const inside = relative(realRoot, real)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
    handle = await open(real, OPEN_FLAGS)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null
  } catch {
    return null
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The image type of a file's bytes, by their content and never by the file's extension; null when not an image shown. */
export function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  // An ICO header: reserved 0, type 1 (icon), at least one image, and room for every image's 16-byte entry.
  if (bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4)
    if (count > 0 && bytes.length >= 6 + 16 * count) return 'image/x-icon'
  }
  if (isSvg(bytes)) return 'image/svg+xml'
  return null
}

function isSvg(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4096)).replace(/^\uFEFF/, '').trimStart()
  return /^(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(head)
}

/**
 * The first icon found in the folder, or null. In order: a logo file in the project's name at its root; the icons
 * its manifests declare (Expo, web app manifest, `index.html`, electron-builder, Tauri), at its root and then in its
 * monorepo app folders; the standard places at its root; the standard places in its app folders. Looks only at
 * fixed paths and the files they name, never through the tree, within a fixed number of listings and reads.
 */
export async function detectProjectIcon(root: string): Promise<ProjectIconImage | null> {
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return null
  // Each folder is listed once, so names match whatever their case.
  const listings = new Map<string, Promise<Map<string, string>>>()
  const list = (dir: string) => {
    let listing = listings.get(dir)
    if (!listing) {
      listing = listings.size >= MAX_LISTINGS
        ? Promise.resolve(new Map<string, string>())
        : readdir(join(root, dir)).then(
          (names) => new Map(names.map((name) => [name.toLowerCase(), name])),
          () => new Map<string, string>()
        )
      listings.set(dir, listing)
    }
    return listing
  }
  /** The path as it is on disk, or null when its folder does not list it. */
  const listed = async (candidate: string): Promise<string | null> => {
    const slash = candidate.lastIndexOf('/')
    const dir = slash < 0 ? '' : candidate.slice(0, slash)
    const name = (await list(dir)).get(candidate.slice(slash + 1).toLowerCase())
    return name ? (dir ? `${dir}/${name}` : name) : null
  }
  let reads = 0
  const declared = async (appRoot: string): Promise<string[]> => {
    const found: string[] = []
    for (const manifest of manifestFiles(appRoot)) {
      if (reads >= MAX_MANIFEST_READS) break
      const path = await listed(manifest.path)
      if (!path) continue
      reads += 1
      const text = await readProjectText(root, path, realRoot)
      if (text) found.push(...withSvgSiblings(manifest.parse(text)))
    }
    return found
  }
  const rootNames = await list('')
  const rootPackage = rootNames.has('package.json') ? parseJson(await readProjectText(root, rootNames.get('package.json')!, realRoot)) : null
  const apps = appFolders(rootPackage, new Set(rootNames.keys()))
  const tried = new Set<string>()
  const attempt = async (candidate: string): Promise<ProjectIconImage | null> => {
    const path = await listed(candidate)
    if (!path || tried.has(path)) return null
    tried.add(path)
    const image = await readProjectIconFile(root, path, realRoot)
    return image ? { dataUrl: image.dataUrl, source: 'auto', path } : null
  }
  const stages: Array<() => Promise<string[]> | string[]> = [
    () => rootLogoCandidates([...rootNames.values()]),
    () => declared(''),
    async () => {
      const found: string[] = []
      for (const app of apps) found.push(...(await declared(app)))
      return found
    },
    () => projectIconCandidates(),
    () => apps.flatMap(appIconCandidates)
  ]
  for (const stage of stages) {
    for (const candidate of await stage()) {
      const image = await attempt(candidate)
      if (image) return image
    }
  }
  return null
}

/** Where a stored icon path points: relative paths are inside the project folder. */
export function resolveStoredIconPath(root: string, stored: string): string {
  return isAbsolute(stored) ? stored : join(root, stored)
}

/** The path to store for a chosen file: relative to the project folder when inside it, else absolute. */
export function toStoredIconPath(root: string, chosen: string): string {
  const absolute = resolve(root, chosen)
  const inside = relative(root, absolute)
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside.split('\\').join('/')
  return absolute
}

export interface DetectedIconRecorder {
  recordDetectedIcon(projectId: string, path: string | null): void
}

/**
 * The icon a project of this computer shows, or null for the folder glyph: none when icons are off for it, the
 * user's file when they chose one, else one found in the folder. A found icon (or none) is remembered with the
 * project and looked for again after a while or when the project is opened again.
 */
export async function projectIconFor(project: Project, recorder: DetectedIconRecorder, now = Date.now()): Promise<ProjectIconImage | null> {
  if (project.iconOff) return null
  if (project.iconPath) {
    const image = await readIconFile(resolveStoredIconPath(project.path, project.iconPath))
    return image ? { dataUrl: image.dataUrl, source: 'custom', path: project.iconPath } : null
  }
  const checkedAt = project.iconDetectedAt ? Date.parse(project.iconDetectedAt) : Number.NaN
  // A result of older detection rules, or none found by them, is looked for again now.
  const current = project.iconDetector === PROJECT_ICON_DETECTOR_VERSION
  if (current && Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt < PROJECT_ICON_DETECT_TTL_MS) {
    if (!project.detectedIconPath) return null
    const image = await readProjectIconFile(project.path, project.detectedIconPath)
    if (image) return { dataUrl: image.dataUrl, source: 'auto', path: project.detectedIconPath }
  }
  // Windows asking for the same project at once share one look through its folder.
  const key = `${project.id} ${project.path}`
  let detecting = detections.get(key)
  if (!detecting) {
    detecting = detectProjectIcon(project.path)
      .then((found) => {
        recorder.recordDetectedIcon(project.id, found?.path ?? null)
        return found
      })
      .finally(() => detections.delete(key))
    detections.set(key, detecting)
  }
  return detecting
}

const detections = new Map<string, Promise<ProjectIconImage | null>>()

interface CachedDataUrl {
  mtimeMs: number
  size: number
  image: { dataUrl: string; mime: string } | null
}

/** Icons read lately, by file, so a window asking again only opens the file. Kept within a count and a size. */
const dataUrlCache = new Map<string, CachedDataUrl>()
const DATA_URL_CACHE_LIMIT = 200
const DATA_URL_CACHE_BYTES = 16 * 1024 * 1024
let dataUrlCacheBytes = 0

const entryBytes = (entry: CachedDataUrl) => entry.image?.dataUrl.length ?? 0

function rememberDataUrl(file: string, entry: CachedDataUrl): void {
  const previous = dataUrlCache.get(file)
  if (previous) {
    dataUrlCacheBytes -= entryBytes(previous)
    dataUrlCache.delete(file)
  }
  dataUrlCache.set(file, entry)
  dataUrlCacheBytes += entryBytes(entry)
  while (dataUrlCache.size > DATA_URL_CACHE_LIMIT || dataUrlCacheBytes > DATA_URL_CACHE_BYTES) {
    const oldest = dataUrlCache.keys().next().value as string
    dataUrlCacheBytes -= entryBytes(dataUrlCache.get(oldest)!)
    dataUrlCache.delete(oldest)
  }
}
