import { fileLocation } from '../../utils/filesBrowse'
import { SHOWN_IMAGE_TYPES } from './imageSources'

/**
 * The pictures of image files a bot's chat (or a thread) shows, kept for the window. Plain module, no components, so
 * the bots store can hand it the composer's pictures of a message just sent.
 */

export type FileImage = {
  url?: string
  failed?: true
  /** The file's size and write time when it was read; absent when unknown. */
  stamp?: string
  /** The composer's picture of the file just sent, shown until the file itself is read. */
  provisional?: true
}

/**
 * Each path's picture, kept for the window. A file can be written again at the same path (a bot saving a new
 * picture over its last one), so each new look at a path checks the file's size and write time and rereads it only
 * when they changed; the picture already shown stays until the new one is read.
 */
export const fileImages = new Map<string, FileImage>()
/** Checks and reads in flight; a path's next look after one ends checks again. */
const loading = new Map<string, Promise<void>>()
export const listeners = new Set<() => void>()

/** A read that failed is tried again after these waits (the file may be still being written, or the daemon busy). */
const RETRY_DELAYS_MS = [500, 1500, 4000]
const retries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>()

const stampOf = (file: { size: number; mtimeMs?: number }) => (typeof file.mtimeMs === 'number' ? `${file.size}:${file.mtimeMs}` : undefined)

/** The picture of an image file of this computer, once read; undefined while it is read or when it can't be. */
export function botFileImageUrl(path: string): string | undefined {
  return fileImages.get(path)?.url
}

/**
 * Reads an image file through the Files panel's preview path; only PNG, JPEG, GIF and WebP become a picture. A path
 * read before is read again only when its size or write time changed since.
 */
export function loadFileImage(path: string): Promise<void> {
  const known = loading.get(path)
  if (known) return known
  const done = (image: FileImage) => {
    const was = fileImages.get(path)
    fileImages.set(path, image)
    for (const listener of listeners) listener()
    // The old picture goes once everything showing it has been told about the new one.
    if (was?.url && was.url !== image.url) URL.revokeObjectURL(was.url)
  }
  const at = fileLocation(path)
  const read = (async () => {
    const was = fileImages.get(path)
    // A picture read without a write time (an older daemon) can't be checked: it stays, as it always did.
    if (was?.url && !was.stamp && !was.provisional) return
    if (was?.stamp) {
      const stamp = await window.mousse.fs.assetStamp(at.path, undefined, null, at.root).then(stampOf, () => undefined)
      if (stamp === was.stamp) return
    }
    try {
      const asset = await window.mousse.fs.readAsset(at.path, undefined, null, at.root)
      const stamp = stampOf(asset)
      if (!SHOWN_IMAGE_TYPES.has(asset.mimeType)) return done({ failed: true, stamp })
      const bytes = Uint8Array.from(asset.data)
      retries.delete(path)
      done({ url: URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType })), stamp })
    } catch {
      // A picture already shown stays when the file can't be read again (gone, or the read failed); its name shows
      // otherwise. Either way it is tried again a few times, and on each new look.
      if (!was?.url) done({ failed: true })
      retryLater(path)
    }
  })().finally(() => loading.delete(path))
  loading.set(path, read)
  return read
}

function retryLater(path: string): void {
  const retry = retries.get(path) ?? { attempt: 0 }
  if (retry.timer || retry.attempt >= RETRY_DELAYS_MS.length) return
  retry.timer = setTimeout(() => {
    retry.timer = undefined
    retry.attempt += 1
    void loadFileImage(path)
  }, RETRY_DELAYS_MS[retry.attempt])
  retries.set(path, retry)
}

/**
 * Shows `url`, the composer's picture of an image just sent, as the file at `path` until the file is read, so the
 * picture stays in place from sending to sent. Takes the URL over: it is revoked when the file's own picture replaces
 * it, or at once when the path already has a picture.
 */
export function adoptFilePreview(path: string, url: string): void {
  if (!path || fileImages.get(path)?.url) {
    URL.revokeObjectURL(url)
    return
  }
  fileImages.set(path, { url, provisional: true })
  for (const listener of listeners) listener()
}

/** Forgets the pictures read so far. Tests start clean. */
export function resetBotFileImages(): void {
  for (const image of fileImages.values()) if (image.url) URL.revokeObjectURL(image.url)
  for (const retry of retries.values()) clearTimeout(retry.timer)
  fileImages.clear()
  loading.clear()
  retries.clear()
}
