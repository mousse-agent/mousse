import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  findGoogleFont,
  fontCacheSlug,
  FONT_ROLE_WEIGHTS,
  googleFontCssUrl,
  parseGoogleFontCss,
  pickFontWeights,
  type FontRole,
  type LoadedGoogleFont
} from '../../shared/fontSettings'

/**
 * Google Fonts families, downloaded once and kept under `root`. A family's files for one set of
 * weights live in `<root>/<family>/<weights>/` with a manifest; the folder only appears once
 * every file is written, so a cached family is always complete.
 */

/** Google serves WOFF2 only to browsers it recognizes. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const MAX_FILES = 800
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 96 * 1024 * 1024
const DOWNLOAD_CONCURRENCY = 8
const FILE_NAME = /^\d{1,4}\.woff2$/

interface ManifestFace {
  weight: number
  style: 'normal' | 'italic'
  unicodeRange?: string
  file: string
}

interface Manifest {
  version: 1
  family: string
  weights: number[]
  faces: ManifestFace[]
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface GoogleFontCacheOptions {
  root: string
  fetch: FetchLike
}

export class GoogleFontCache {
  private readonly downloads = new Map<string, Promise<void>>()

  constructor(private readonly options: GoogleFontCacheOptions) {}

  /**
   * The family's font files for the weights a role uses. Reads the cache; downloads only when
   * `download` is set (the user just chose the font). Not cached and not downloading: `null`.
   */
  async load(family: string, role: FontRole, download: boolean): Promise<LoadedGoogleFont | null> {
    const entry = findGoogleFont(family)
    if (!entry) throw new Error(`${family} is not in the Google Fonts list.`)
    const weights = pickFontWeights(FONT_ROLE_WEIGHTS[role], entry.weights)
    const folder = join(this.options.root, fontCacheSlug(entry.family), weights.join('-'))

    const cached = await readCached(folder, entry.family)
    if (cached || !download) return cached

    let pending = this.downloads.get(folder)
    if (!pending) {
      pending = this.download(entry.family, weights, folder).finally(() => this.downloads.delete(folder))
      this.downloads.set(folder, pending)
    }
    await pending
    return readCached(folder, entry.family)
  }

  private async download(family: string, weights: number[], folder: string): Promise<void> {
    const cssResponse = await this.options.fetch(googleFontCssUrl(family, weights), {
      headers: { 'User-Agent': BROWSER_USER_AGENT }
    })
    if (!cssResponse.ok) throw new Error(`Google Fonts returned HTTP ${cssResponse.status} for ${family}.`)
    const faces = parseGoogleFontCss(await cssResponse.text()).filter(
      (face) => face.style === 'normal' && weights.includes(face.weight)
    )
    if (faces.length === 0) throw new Error(`Google Fonts listed no files for ${family}.`)

    // Variable fonts list the same file for every weight; fetch each file once.
    const urls = [...new Set(faces.map((face) => face.url))]
    if (urls.length > MAX_FILES) throw new Error(`${family} has too many font files to cache.`)

    const staging = `${folder}.partial-${randomUUID()}`
    await mkdir(staging, { recursive: true })
    try {
      let total = 0
      const fileFor = new Map(urls.map((url, index) => [url, `${index}.woff2`]))
      await runLimited(urls, DOWNLOAD_CONCURRENCY, async (url) => {
        const response = await this.options.fetch(url)
        if (!response.ok) throw new Error(`Downloading ${family} failed with HTTP ${response.status}.`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) throw new Error(`A font file for ${family} has an unexpected size.`)
        total += bytes.byteLength
        if (total > MAX_TOTAL_BYTES) throw new Error(`${family} is too large to cache.`)
        await writeFile(join(staging, fileFor.get(url)!), bytes)
      })
      const manifest: Manifest = {
        version: 1,
        family,
        weights,
        faces: faces.map((face) => ({
          weight: face.weight,
          style: face.style,
          ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
          file: fileFor.get(face.url)!
        }))
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest))
      try {
        await rename(staging, folder)
      } catch (error) {
        // Another window finished the same download first; keep that copy.
        if (await readCached(folder, family)) return
        throw error
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function readCached(folder: string, family: string): Promise<LoadedGoogleFont | null> {
  let manifest: Manifest
  try {
    manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
  if (!isManifest(manifest) || manifest.family !== family) return null
  const files = new Map<string, Uint8Array>()
  try {
    for (const face of manifest.faces) {
      if (!files.has(face.file)) files.set(face.file, new Uint8Array(await readFile(join(folder, face.file))))
    }
  } catch {
    return null
  }
  return {
    family,
    faces: manifest.faces.map((face) => ({
      weight: face.weight,
      style: face.style,
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
      data: files.get(face.file)!
    }))
  }
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<Manifest>
  return (
    manifest.version === 1 &&
    typeof manifest.family === 'string' &&
    Array.isArray(manifest.faces) &&
    manifest.faces.length > 0 &&
    manifest.faces.every(
      (face) =>
        face &&
        typeof face.file === 'string' &&
        FILE_NAME.test(face.file) &&
        Number.isInteger(face.weight) &&
        (face.style === 'normal' || face.style === 'italic') &&
        (face.unicodeRange === undefined || typeof face.unicodeRange === 'string')
    )
  )
}

async function runLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await work(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
