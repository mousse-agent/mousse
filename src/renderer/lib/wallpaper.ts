import { useSyncExternalStore } from 'react'
import type { ThemeWallpaper } from '../../shared/themes/userThemes'
import {
  bucketForDisplay,
  copyLongEdge,
  WALLPAPER_UPLOAD_MAX_BYTES,
  type StoredWallpaperInfo,
  type WallpaperBucket,
  type WallpaperPieceResult
} from '../../shared/themes/wallpaperImage'
import { contrastFloor, type Rgba, type SeeThrough } from './wallpaperContrast'

/** How much of the wallpaper shows under acrylic, so the window's glass shows through it. */
export const WALLPAPER_ACRYLIC_OPACITY = 0.55

/**
 * A theme's wallpaper in this window. The daemon keeps the image (`WallpaperStore`); this window shows a copy sized for
 * the largest display, made once from the original and kept by the daemon for every window after it, so the original is
 * decoded once per size and never painted. The copy becomes a `blob:` URL: theme CSS still cannot load anything, and no
 * file path reaches the page.
 *
 * `showWallpaper` is called with the active theme's wallpaper on every appearance change; `useWallpaperLayer` is what
 * the chat's layer draws. The layer and `html[data-wallpaper]` appear only once a copy is ready, so a missing or broken
 * image leaves the plain theme.
 */

/** What the wallpaper layer draws. */
export interface WallpaperLayer {
  url: string
  fit: ThemeWallpaper['fit']
  position: ThemeWallpaper['position']
  /** The theme's background colour, resolved (`rgb(r g b)`), painted under the image (when `opacity` is 1) and as its scrim. */
  base: string
  /**
   * How much of the layer shows, 0 to 1: 1 on a solid window, `WALLPAPER_ACRYLIC_OPACITY` under acrylic, where the layer
   * has no solid colour under it and the window's glass shows through.
   */
  opacity: number
  /** How much of the scrim covers the image, 0 to 1: the theme's dim, raised when text needs it. */
  scrim: number
  /** The dim the theme asks for and the least that keeps text readable, both 0 to 1. */
  dim: number
  floor: number
}

interface LoadedCopy {
  url: string
  /** The copy drawn small, RGBA, for the contrast floor. */
  samples: Uint8ClampedArray
}

/** The bridge this module uses: `window.mousse.wallpapers`, replaced in tests. */
export interface WallpaperBridge {
  read(profileId: string, id: string, bucket: number | null, offset: number): Promise<WallpaperPieceResult>
  saveCopy(profileId: string, id: string, bucket: number, dataBase64: string, replace: boolean): Promise<boolean>
  displayLongEdge(): Promise<number>
  onDisplaysChanged?(cb: () => void): () => void
}

/** The copy is drawn this small to measure contrast (14,400 samples). */
const SAMPLE_WIDTH = 160
const SAMPLE_HEIGHT = 90

function defaultBridge(): WallpaperBridge | undefined {
  return (globalThis as { mousse?: { wallpapers?: WallpaperBridge } }).mousse?.wallpapers
}

let bridgeFor: () => WallpaperBridge | undefined = defaultBridge

const copies = new Map<string, Promise<LoadedCopy | null>>()
/** The copies loaded so far, by key, so the ones no longer shown can be released. */
const loaded = new Map<string, LoadedCopy>()
/** Originals this window could not decode: not tried again while it is open. */
const undecodable = new Set<string>()
let cacheProfile: string | null = null
let displayLong: Promise<number> | null = null
let generation = 0
let layer: WallpaperLayer | null = null
let problem: string | null = null
let requested: { profileId: string; wallpaper: ThemeWallpaper } | null = null
const listeners = new Set<() => void>()
let watchingDisplays = false

function notify(): void {
  for (const listener of listeners) listener()
}

/** Tests: the bridge to use and a fresh window state. */
export function resetWallpapersForTests(bridge?: WallpaperBridge): void {
  bridgeFor = bridge ? () => bridge : defaultBridge
  clearCopies()
  undecodable.clear()
  displayLong = null
  layer = null
  problem = null
  requested = null
  watchingDisplays = false
  listeners.clear()
}

function clearCopies(): void {
  for (const pending of copies.values()) void pending.then((copy) => { if (copy) URL.revokeObjectURL(copy.url) })
  copies.clear()
  loaded.clear()
}

/** Releases every loaded copy but the one shown: a theme switched back to reads its copy from the daemon again. */
function releaseUnused(shown: string | undefined): void {
  for (const [key, copy] of loaded) {
    if (copy.url === shown) continue
    URL.revokeObjectURL(copy.url)
    loaded.delete(key)
    copies.delete(key)
  }
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** A whole stored file, read piece by piece into one buffer; null when it is not stored. */
async function readStored(bridge: WallpaperBridge, profileId: string, id: string, bucket: WallpaperBucket | null): Promise<Blob | null> {
  const first = await bridge.read(profileId, id, bucket, 0)
  if ('missing' in first) return null
  const bytes = new Uint8Array(first.size)
  let filled = 0
  let piece: WallpaperPieceResult = first
  for (;;) {
    if ('missing' in piece) return null
    const data = fromBase64(piece.data)
    if (!data.length || piece.offset !== filled || filled + data.length > bytes.length) return null
    bytes.set(data, filled)
    filled += data.length
    if (filled >= bytes.length) break
    piece = await bridge.read(profileId, id, bucket, filled)
  }
  return new Blob([bytes], { type: first.type })
}

function sample(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
  const context = canvas.getContext('2d')
  if (!context) return new Uint8ClampedArray()
  context.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
  return context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data
}

/** Encodes `bitmap` as a WebP within the upload limit, lowering the quality until it fits. */
async function encodeCopy(bitmap: ImageBitmap): Promise<Blob | null> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(bitmap, 0, 0)
  for (const quality of [0.86, 0.76, 0.66, 0.56]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    if (blob.type === 'image/webp' && blob.size <= WALLPAPER_UPLOAD_MAX_BYTES) return blob
  }
  return null
}

/**
 * Makes the copy for `bucket` from the original: decoded once (the browser applies its EXIF rotation), scaled so its
 * long edge is the bucket's (never larger than the image), encoded as WebP and handed to the daemon for other windows.
 */
async function buildCopy(bridge: WallpaperBridge, profileId: string, id: string, bucket: WallpaperBucket, replace: boolean): Promise<{ blob: Blob; bitmap: ImageBitmap } | null> {
  const original = await readStored(bridge, profileId, id, null)
  if (!original) return null
  let full: ImageBitmap
  try {
    full = await createImageBitmap(original)
  } catch {
    undecodable.add(id)
    return null
  }
  const long = copyLongEdge(bucket, Math.max(full.width, full.height))
  const scale = long / Math.max(full.width, full.height)
  let scaled: ImageBitmap
  try {
    scaled = await createImageBitmap(full, {
      resizeWidth: Math.max(1, Math.round(full.width * scale)),
      resizeHeight: Math.max(1, Math.round(full.height * scale)),
      resizeQuality: 'high'
    })
  } finally {
    full.close()
  }
  const blob = await encodeCopy(scaled)
  if (!blob) { scaled.close(); return null }
  // Other windows (and this one next time) use the kept copy; a failed save only costs this decode again later.
  void blob.arrayBuffer().then((buffer) => bridge.saveCopy(profileId, id, bucket, base64(new Uint8Array(buffer)), replace)).catch(() => false)
  return { blob, bitmap: scaled }
}

async function loadCopy(bridge: WallpaperBridge, profileId: string, id: string, bucket: WallpaperBucket): Promise<LoadedCopy | null> {
  let blob = await readStored(bridge, profileId, id, bucket)
  let bitmap: ImageBitmap | null = null
  let rebuild = false
  if (blob) {
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      // A kept copy that does not decode is made again once and replaces it.
      rebuild = true
      blob = null
    }
  }
  if (!blob || !bitmap) {
    if (undecodable.has(id)) return null
    const built = await buildCopy(bridge, profileId, id, bucket, rebuild)
    if (!built) return null
    blob = built.blob
    bitmap = built.bitmap
  }
  try {
    return { url: URL.createObjectURL(blob), samples: sample(bitmap) }
  } finally {
    bitmap.close()
  }
}

function bucketNow(bridge: WallpaperBridge): Promise<number> {
  if (!watchingDisplays && bridge.onDisplaysChanged) {
    watchingDisplays = true
    bridge.onDisplaysChanged(() => {
      displayLong = null
      if (requested) showWallpaper(requested.profileId, requested.wallpaper)
    })
  }
  displayLong ??= bridge.displayLongEdge().catch(() => 2560)
  return displayLong
}

/**
 * A colour the page uses, as RGBA: a token (`--text-primary`) or a CSS colour using tokens, resolved by the browser,
 * then read back through a canvas.
 */
function resolvedColor(token: string, doc: Document): Rgba {
  const probe = doc.createElement('span')
  probe.style.color = token.startsWith('--') ? `var(${token})` : token
  probe.style.display = 'none'
  doc.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return { r: 0, g: 0, b: 0, a: 1 }
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = computed
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  return { r, g, b, a: a / 255 }
}

function placeLayer(next: WallpaperLayer | null, doc: Document): void {
  layer = next
  releaseUnused(next?.url)
  const root = doc.documentElement
  if (next) {
    root.setAttribute('data-wallpaper', '')
    root.style.setProperty('--mousse-wallpaper', `url("${next.url}")`)
  } else {
    root.removeAttribute('data-wallpaper')
    root.style.removeProperty('--mousse-wallpaper')
  }
  notify()
}

/**
 * Shows `wallpaper` (the active user theme's) for `profileId`, or takes the wallpaper off when it is undefined. Safe to
 * call on every appearance change: the copy is loaded once and only the scrim is measured again, against the colours the
 * page has now.
 */
export function showWallpaper(profileId: string | null | undefined, wallpaper: ThemeWallpaper | undefined, doc: Document = document): void {
  const run = ++generation
  const bridge = bridgeFor()
  if (profileId !== cacheProfile) {
    // Another profile's images are never shown here, and their URLs are released.
    clearCopies()
    cacheProfile = profileId ?? null
  }
  if (!wallpaper || !profileId || !bridge || typeof createImageBitmap !== 'function') {
    requested = null
    problem = null
    placeLayer(null, doc)
    return
  }
  requested = { profileId, wallpaper }
  const id = wallpaper.id
  void (async () => {
    const bucket = bucketForDisplay(await bucketNow(bridge))
    const key = `${id}|${bucket}`
    let pending = copies.get(key)
    if (!pending) {
      pending = loadCopy(bridge, profileId, id, bucket).catch(() => null)
      copies.set(key, pending)
      // A failure is not kept: the next appearance change tries again.
      void pending.then((copy) => {
        if (copy) loaded.set(key, copy)
        else if (copies.get(key) === pending) copies.delete(key)
      })
    }
    const copy = await pending
    if (run !== generation) return
    if (!copy) {
      problem = undecodable.has(id) ? 'This image could not be shown.' : null
      placeLayer(null, doc)
      return
    }
    problem = null
    const base = resolvedColor('--surface-base', doc)
    const texts = [resolvedColor('--text-primary', doc), resolvedColor('--text-secondary', doc)]
    // Under acrylic the layer is see-through: text sits on the image at that opacity over the window's tint, so the
    // floor is measured against that, not against a solid base.
    const acrylic = doc.documentElement.getAttribute('data-acrylic') === 'true'
    const seeThrough: SeeThrough | undefined = acrylic
      ? { opacity: WALLPAPER_ACRYLIC_OPACITY, backdrop: { ...resolvedColor('rgb(var(--acrylic-base-rgb, var(--surface-base-rgb)))', doc), a: 1 } }
      : undefined
    const floor = contrastFloor(copy.samples, { ...base, a: 1 }, texts, seeThrough)
    const dim = wallpaper.dim / 100
    placeLayer({
      url: copy.url,
      fit: wallpaper.fit,
      position: wallpaper.position,
      base: `rgb(${base.r} ${base.g} ${base.b})`,
      opacity: seeThrough?.opacity ?? 1,
      scrim: Math.max(dim, floor),
      dim,
      floor
    }, doc)
  })().catch(() => {
    if (run === generation) placeLayer(null, doc)
  })
}

/**
 * Shows `dim` (0 to 100) on the layer at once, for the dim slider while it moves: only the scrim changes, and never below
 * the floor already measured, which does not depend on the dim. The theme's own change follows and measures again.
 */
export function previewWallpaperDim(dim: number): void {
  if (!layer) return
  const next = dim / 100
  if (next === layer.dim) return
  layer = { ...layer, dim: next, scrim: Math.max(next, layer.floor) }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The layer the chat draws, or null for none. */
export function useWallpaperLayer(): WallpaperLayer | null {
  return useSyncExternalStore(subscribe, () => layer, () => null)
}

/** Why the active wallpaper does not show, when the image itself is the reason. */
export function useWallpaperProblem(): string | null {
  return useSyncExternalStore(subscribe, () => problem, () => null)
}

/**
 * The display copy of a stored image at the largest size, as base64, for a theme file. Null when it cannot be read.
 */
export async function wallpaperForExport(profileId: string, id: string): Promise<string | null> {
  const bridge = bridgeFor()
  if (!bridge) return null
  const bucket: WallpaperBucket = 3840
  const kept = await readStored(bridge, profileId, id, bucket).catch(() => null)
  const blob = kept ?? (await buildCopy(bridge, profileId, id, bucket, false).then((built) => {
    built?.bitmap.close()
    return built?.blob ?? null
  }).catch(() => null))
  return blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null
}

export type { StoredWallpaperInfo }

/** The layer as it is now, outside React (tests). */
export function wallpaperLayerNow(): WallpaperLayer | null {
  return layer
}

/** Tests: shows `next` as the layer without loading an image. */
export function showWallpaperLayerForTests(next: WallpaperLayer | null): void {
  layer = next
  notify()
}
