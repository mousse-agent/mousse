import { posix } from 'path'

/**
 * Icons a project declares in its own manifests (Expo, web app manifest, `index.html`, electron-builder, Tauri),
 * as paths relative to the project folder. Pure parsing: the caller reads the files, within its budget, and checks
 * each path is a real image inside the folder.
 */

/** Image types a declared icon may have; anything else (`.icns`, a URL) is skipped. */
const IMAGE_EXTENSION = /\.(svg|png|webp|ico|jpe?g|gif)$/i
const TYPE_RANK: Record<string, number> = { svg: 0, png: 1, webp: 2, ico: 3, jpg: 4, jpeg: 4, gif: 5 }

/** At most this many paths are taken from one manifest. */
const PER_SOURCE = 4

function extensionOf(path: string): string {
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
}

function typeRank(path: string): number {
  return TYPE_RANK[extensionOf(path)] ?? 9
}

/** The largest square size in a manifest `sizes` value or a file name (`512x512`, `128x128@2x`); 0 when none. */
export function iconSize(text: string): number {
  let best = 0
  for (const match of text.matchAll(/(\d{1,4})x(\d{1,4})(?:@(\d)x)?/gi)) {
    const [w, h, scale] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 1)]
    if (w === h) best = Math.max(best, w * scale)
  }
  return best
}

/** A reference from a manifest, cleaned: no query or fragment, no URL scheme, no template placeholder. */
function cleanReference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let ref = value.trim().replace(/[?#].*$/, '').replace(/^%(?:PUBLIC_URL|BASE_URL)%/, '')
  if (!ref || ref.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || /[{}<>%$]/.test(ref)) return null
  ref = ref.replace(/\\/g, '/')
  return ref
}

/** `ref` resolved from `base` (both relative to the project folder); null when it leaves the folder. */
export function insideProject(base: string, ref: string): string | null {
  const joined = posix.normalize(posix.join(base || '.', ref.replace(/^\/+/, '')))
  if (joined === '.' || joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null
  return joined.replace(/^\.\//, '')
}

/**
 * Where a reference from a web file can point, best first. A root-relative `/x` is served from the app's `public/`
 * folder (Vite, Create React App) or the folder itself; a relative one from the file's own folder.
 */
function webTargets(ref: string, fileDir: string, appRoot: string): string[] {
  const bases = ref.startsWith('/')
    ? [posix.join(appRoot || '.', 'public'), fileDir, appRoot]
    : [fileDir, posix.join(fileDir || '.', 'public')]
  return [...new Set(bases.map((base) => insideProject(base === '.' ? '' : base, ref)).filter((path): path is string => Boolean(path)))]
}

function imagesOnly(paths: readonly (string | null)[]): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path && IMAGE_EXTENSION.test(path))))]
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Expo `app.json` / `app.config.json`: `expo.icon`, `expo.ios.icon`, `expo.web.favicon`, then the adaptive icon's foreground. */
export function expoIcons(json: unknown, manifestDir: string): string[] {
  const root = asObject(json)
  const expo = asObject(root?.expo) ?? root
  const refs = [
    expo?.icon,
    asObject(expo?.ios)?.icon,
    asObject(expo?.web)?.favicon,
    asObject(asObject(expo?.android)?.adaptiveIcon)?.foregroundImage
  ].map(cleanReference)
  return imagesOnly(refs.map((ref) => (ref ? insideProject(manifestDir, ref) : null))).slice(0, PER_SOURCE)
}

/** A web app manifest's `icons[]`: an SVG first, then the largest square image; maskable- or monochrome-only icons last. */
export function webManifestIcons(json: unknown, manifestDir: string, appRoot: string): string[] {
  const icons = asObject(json)?.icons
  if (!Array.isArray(icons)) return []
  const entries = icons
    .map((icon, index) => {
      const entry = asObject(icon)
      const ref = cleanReference(entry?.src)
      if (!ref) return null
      const purpose = typeof entry?.purpose === 'string' ? entry.purpose.split(/\s+/) : ['any']
      const plain = purpose.includes('any') || !purpose.some((p) => p === 'maskable' || p === 'monochrome')
      const svg = extensionOf(ref) === 'svg' || entry?.type === 'image/svg+xml'
      const sizes = typeof entry?.sizes === 'string' ? entry.sizes : ''
      return { ref, index, plain, svg, size: Math.max(iconSize(sizes), iconSize(ref)) }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => Number(b.plain) - Number(a.plain) || Number(b.svg) - Number(a.svg) || b.size - a.size || typeRank(a.ref) - typeRank(b.ref) || a.index - b.index)
  return imagesOnly(entries.flatMap((entry) => webTargets(entry.ref, manifestDir, appRoot))).slice(0, PER_SOURCE)
}

/** `<link rel="icon">` (and `shortcut icon`) in an HTML page, an SVG first, then `apple-touch-icon`. */
export function htmlIconLinks(html: string, htmlDir: string, appRoot: string): string[] {
  const links: { ref: string; touch: boolean; index: number }[] = []
  let index = 0
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
    const relMatch = attr('rel')
    const rel = (relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? '').toLowerCase().split(/\s+/)
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    if (!rel.includes('icon') && !touch) continue
    const hrefMatch = attr('href')
    const ref = cleanReference(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3])
    if (ref) links.push({ ref, touch, index: index++ })
  }
  links.sort((a, b) => Number(a.touch) - Number(b.touch) || typeRank(a.ref) - typeRank(b.ref) || a.index - b.index)
  return imagesOnly(links.flatMap((link) => webTargets(link.ref, htmlDir, appRoot))).slice(0, PER_SOURCE)
}

/** electron-builder's `build.icon` in `package.json` (also `build.win.icon`, `build.linux.icon`); a path without an extension is tried as PNG and ICO. */
export function electronBuilderIcons(json: unknown, packageDir: string): string[] {
  const build = asObject(asObject(json)?.build)
  const refs = [build?.icon, asObject(build?.win)?.icon, asObject(build?.linux)?.icon].map(cleanReference)
  const paths: (string | null)[] = []
  for (const ref of refs) {
    if (!ref) continue
    const variants = extensionOf(ref) && IMAGE_EXTENSION.test(ref) ? [ref] : /\.[a-z0-9]+$/i.test(ref) ? [] : [`${ref}.png`, `${ref}.ico`]
    // Relative to the project, or to electron-builder's build resources folder.
    for (const variant of variants) paths.push(insideProject(packageDir, variant), insideProject(posix.join(packageDir || '.', 'build'), variant))
  }
  return imagesOnly(paths).slice(0, PER_SOURCE)
}

/** Tauri's `bundle.icon[]` (v1: `tauri.bundle.icon[]`): the largest PNG, then an ICO. */
export function tauriIcons(json: unknown, configDir: string): string[] {
  const root = asObject(json)
  const icons = asObject(root?.bundle)?.icon ?? asObject(asObject(root?.tauri)?.bundle)?.icon
  if (!Array.isArray(icons)) return []
  const refs = icons
    .map(cleanReference)
    .filter((ref): ref is string => Boolean(ref && IMAGE_EXTENSION.test(ref)))
    .map((ref, index) => ({ ref, index, size: iconSize(ref) }))
    .sort((a, b) => typeRank(a.ref) - typeRank(b.ref) || b.size - a.size || a.index - b.index)
  return imagesOnly(refs.map((entry) => insideProject(configDir, entry.ref))).slice(0, PER_SOURCE)
}

/** Each declared raster icon preceded by an SVG of the same name beside it, which stays sharp when it exists. */
export function withSvgSiblings(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => (extensionOf(path) === 'svg' ? [path] : [path.replace(/\.[a-z0-9]+$/i, '.svg'), path])))]
}

/**
 * The folders of a monorepo's apps, from the root `package.json` `workspaces` (entries without wildcards) and the
 * usual app folder names present at the root, at most `limit`.
 */
export function appFolders(rootPackage: unknown, rootNames: ReadonlySet<string>, limit = 4): string[] {
  const workspaces = asObject(rootPackage)?.workspaces
  const declared = Array.isArray(workspaces) ? workspaces : asObject(workspaces)?.packages
  const folders: string[] = []
  for (const entry of Array.isArray(declared) ? declared : []) {
    const ref = cleanReference(entry)
    const path = ref && !/[*!?[\]]/.test(ref) ? insideProject('', ref) : null
    if (path) folders.push(path)
  }
  for (const name of ['web', 'frontend', 'client', 'mobile', 'app']) if (rootNames.has(name)) folders.push(name)
  return [...new Set(folders)].slice(0, limit)
}

/** The manifest files read in an app folder, in the order their icons are preferred, and how each is parsed. */
export function manifestFiles(appRoot: string): { path: string; parse: (text: string) => string[] }[] {
  const at = (name: string) => (appRoot ? `${appRoot}/${name}` : name)
  const json = (parse: (value: unknown) => string[]) => (text: string) => {
    try {
      return parse(JSON.parse(text.replace(/^﻿/, '')))
    } catch {
      return []
    }
  }
  const dirOf = (path: string) => posix.dirname(path).replace(/^\.$/, '')
  return [
    ...['app.json', 'app.config.json'].map((name) => ({ path: at(name), parse: json((value) => expoIcons(value, appRoot)) })),
    ...['index.html', 'public/index.html', 'src/index.html'].map((name) => {
      const path = at(name)
      return { path, parse: (text: string) => htmlIconLinks(text, dirOf(path), appRoot) }
    }),
    ...['public/manifest.json', 'public/site.webmanifest', 'public/manifest.webmanifest', 'manifest.json', 'site.webmanifest', 'static/manifest.json'].map((name) => {
      const path = at(name)
      return { path, parse: json((value) => webManifestIcons(value, dirOf(path), appRoot)) }
    }),
    { path: at('package.json'), parse: json((value) => electronBuilderIcons(value, appRoot)) },
    { path: at('src-tauri/tauri.conf.json'), parse: json((value) => tauriIcons(value, at('src-tauri'))) }
  ]
}
