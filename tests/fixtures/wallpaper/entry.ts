import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ChatWallpaper } from '../../../src/renderer/components/ChatWallpaper'
import { resetWallpapersForTests, showWallpaper, wallpaperLayerNow, type WallpaperBridge } from '../../../src/renderer/lib/wallpaper'
import { isWallpaperCopy, readWallpaperHeader, type WallpaperPieceResult } from '../../../src/shared/themes/wallpaperImage'
import type { ThemeWallpaper } from '../../../src/shared/themes/userThemes'

/**
 * The window's wallpaper pipeline against an in-memory daemon: the original is a JPEG stored landscape (64x32) with EXIF
 * orientation 6, so it shows portrait. Records what the daemon was asked and what it kept.
 */

const ID = 'a'.repeat(64)
const PIECE = 1000

/** A JPEG 64x32: white on the left half, black on the right, with an EXIF block saying "rotate 90° clockwise". */
async function rotatedJpeg(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(64, 32)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, 32, 32)
  context.fillStyle = '#000'
  context.fillRect(32, 0, 32, 32)
  const plain = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer())
  // APP1: "Exif\0\0", a big-endian TIFF header, IFD0 with one entry: Orientation (0x0112), SHORT, 1, value 6.
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const app1 = [0xff, 0xe1, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload]
  const out = new Uint8Array(plain.length + app1.length)
  out.set(plain.subarray(0, 2), 0)
  out.set(app1, 2)
  out.set(plain.subarray(2), 2 + app1.length)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

const until = async (check: () => boolean, ms = 8000): Promise<boolean> => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

;(window as unknown as { qa: unknown }).qa = {
  run: async () => {
    document.documentElement.style.setProperty('--surface-base', '#101418')
    document.documentElement.style.setProperty('--text-primary', '#e6e6e6')
    document.documentElement.style.setProperty('--text-secondary', 'rgba(230, 230, 230, 0.68)')
    const original = await rotatedJpeg()
    const originalHeader = readWallpaperHeader(original)!
    const copies = new Map<number, Uint8Array>()
    const log = { originalReads: 0, saves: [] as Array<{ bucket: number; replace: boolean; accepted: boolean }> }
    const piece = (bytes: Uint8Array, type: 'image/jpeg' | 'image/webp', offset: number): WallpaperPieceResult =>
      ({ type, size: bytes.length, offset, data: toBase64(bytes.subarray(offset, offset + PIECE)) })
    const bridge: WallpaperBridge = {
      read: async (profileId, id, bucket, offset) => {
        if (profileId !== 'p1' || id !== ID) return { missing: true }
        if (bucket === null) {
          if (offset === 0) log.originalReads++
          return piece(original, 'image/jpeg', offset)
        }
        const copy = copies.get(bucket)
        return copy ? piece(copy, 'image/webp', offset) : { missing: true }
      },
      saveCopy: async (_profileId, _id, bucket, dataBase64, replace) => {
        const bytes = Uint8Array.from(atob(dataBase64), (ch) => ch.charCodeAt(0))
        // The daemon's own check, against the original's header (which does not know about the rotation).
        const accepted = isWallpaperCopy(bytes, originalHeader, bucket as 1920)
        log.saves.push({ bucket, replace, accepted })
        if (accepted && (replace || !copies.has(bucket))) copies.set(bucket, bytes)
        return accepted
      },
      displayLongEdge: async () => 1600
    }
    const wallpaper: ThemeWallpaper = { id: ID, type: 'image/jpeg', width: 64, height: 32, fit: 'cover', position: 'center', dim: 10 }

    // First window: the copy is made from the original, once, and kept.
    resetWallpapersForTests(bridge)
    showWallpaper('p1', wallpaper)
    const shown = await until(() => wallpaperLayerNow() !== null && copies.has(1920))
    const first = wallpaperLayerNow()
    const copy = copies.get(1920)
    const copyHeader = copy ? readWallpaperHeader(copy) : null
    // Shown again (an appearance change): nothing is read again.
    showWallpaper('p1', { ...wallpaper, dim: 20 })
    await until(() => wallpaperLayerNow()?.dim === 0.2)
    const readsAfterFirstWindow = log.originalReads

    // A second window: it reads the kept copy, never the original.
    resetWallpapersForTests(bridge)
    showWallpaper('p1', wallpaper)
    await until(() => wallpaperLayerNow() !== null)
    const readsAfterSecondWindow = log.originalReads

    // The profile switches: the layer and html[data-wallpaper] go at once, and the old URL is released.
    const oldUrl = wallpaperLayerNow()!.url
    showWallpaper('p2', undefined)
    const afterSwitch = { layer: wallpaperLayerNow(), attribute: document.documentElement.hasAttribute('data-wallpaper'), variable: document.documentElement.style.getPropertyValue('--mousse-wallpaper') }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const oldUrlReleased = await fetch(oldUrl).then(() => false, () => true)

    // A kept copy that does not decode is made again once and replaces it.
    copies.set(1920, copy!.slice(0, 40))
    resetWallpapersForTests(bridge)
    showWallpaper('p1', wallpaper)
    await until(() => wallpaperLayerNow() !== null && log.saves.length >= 2)

    // The layer as drawn, solid and under acrylic: what the browser computes for the element the chat mounts.
    const host = document.createElement('div')
    host.style.cssText = 'position: relative; width: 400px; height: 300px'
    document.body.appendChild(host)
    flushSync(() => createRoot(host).render(createElement(ChatWallpaper)))
    const drawn = () => {
      const element = host.querySelector<HTMLElement>('[data-mousse="wallpaper"]')
      if (!element) return null
      const style = getComputedStyle(element)
      return { opacity: style.opacity, backgroundColor: style.backgroundColor, image: style.backgroundImage.includes('blob:') }
    }
    const solidDrawn = drawn()
    const solidLayer = wallpaperLayerNow()
    document.documentElement.style.setProperty('--acrylic-base-rgb', '16, 20, 24')
    document.documentElement.setAttribute('data-acrylic', 'true')
    showWallpaper('p1', wallpaper)
    await until(() => wallpaperLayerNow()?.opacity !== 1)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const acrylicDrawn = drawn()
    const acrylicLayer = wallpaperLayerNow()
    document.documentElement.setAttribute('data-acrylic', 'false')
    showWallpaper('p1', wallpaper)
    await until(() => wallpaperLayerNow()?.opacity === 1)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const offAgainDrawn = drawn()

    return {
      drawn: {
        solid: solidDrawn,
        solidFloor: solidLayer?.floor ?? null,
        acrylic: acrylicDrawn,
        acrylicLayer: acrylicLayer && { opacity: acrylicLayer.opacity, floor: acrylicLayer.floor, scrim: acrylicLayer.scrim },
        offAgain: offAgainDrawn
      },
      shown,
      first: first && { dim: first.dim, floor: first.floor, scrim: first.scrim, base: first.base, fit: first.fit, url: first.url.startsWith('blob:') },
      copy: copyHeader,
      copyAccepted: log.saves[0],
      readsAfterFirstWindow,
      readsAfterSecondWindow,
      afterSwitch,
      oldUrlReleased,
      rebuilt: { saves: log.saves, originalReads: log.originalReads, shown: wallpaperLayerNow() !== null }
    }
  }
}
