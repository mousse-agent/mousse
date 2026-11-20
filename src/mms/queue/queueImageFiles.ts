import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedMessage } from '../../shared/types'
import { QUEUE_IMAGES_MAX_DATA_CHARS } from '../../shared/imageLimits'
import { atomicWriteFileSync } from '../data/AtomicFs'

/**
 * Queued messages' images are kept in files beside `queue.json` (`queue-images/`), not in it: a message may carry
 * 80 MB of images, and `queue.json` is written whole on every change to the queue and read often. Each image file is
 * written once, named by its message, its place and its content; `queue.json` names it in the image's `dataFile`.
 * A queue saved by an older version (images inline) still loads, and is moved out on its next save.
 */

export const QUEUE_IMAGES_DIR = 'queue-images'
const IMAGE_FILE = /^[a-f0-9]{16}-\d{1,3}-[a-f0-9]{16}\.b64$/

type StoredImage = { name: string; mimeType: string; data?: string; dataFile?: string }

/** An image's file name: its message, its place in it, and a fingerprint of its data (its length and both ends). */
export function queueImageFileName(itemId: string, index: number, data: string): string {
  const item = createHash('sha256').update(itemId).digest('hex').slice(0, 16)
  const content = createHash('sha256').update(String(data.length)).update(data.slice(0, 4096)).update(data.slice(-4096)).digest('hex').slice(0, 16)
  return `${item}-${index}-${content}.b64`
}

/**
 * The queue as `queue.json` holds it: every image's data written to its file (when not there already) and named by
 * `dataFile`. Returns the items to write and the files they name; `sweepQueueImages` removes the rest once
 * `queue.json` is written.
 */
export function storeQueueImages(threadDir: string, items: readonly QueuedMessage[]): { items: unknown[]; files: Set<string> } {
  const dir = join(threadDir, QUEUE_IMAGES_DIR)
  const files = new Set<string>()
  const stored = items.map((item) => {
    if (!item.images?.length) return item
    const images = (item.images as StoredImage[]).map((image, index) => {
      if (typeof image.data !== 'string' || !image.data) {
        // Loaded without its file (it went missing): it keeps naming the file it had.
        if (image.dataFile && IMAGE_FILE.test(image.dataFile)) files.add(image.dataFile)
        return image
      }
      const file = queueImageFileName(item.id, index, image.data)
      files.add(file)
      const path = join(dir, file)
      if (!existsSync(path)) {
        mkdirSync(dir, { recursive: true })
        atomicWriteFileSync(path, image.data)
      }
      return { name: image.name, mimeType: image.mimeType, dataFile: file }
    })
    return { ...item, images }
  })
  return { items: stored, files }
}

/** Removes the image files no queued message names any more. */
export function sweepQueueImages(threadDir: string, kept: ReadonlySet<string>): void {
  const dir = join(threadDir, QUEUE_IMAGES_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!IMAGE_FILE.test(name) || kept.has(name)) continue
    const path = join(dir, name)
    forget(path)
    try { unlinkSync(path) } catch { /* removed meanwhile, or held open: the next save tries again */ }
  }
}

/**
 * Image data read back from files, newest first, up to one full queue's worth: the queue is loaded often, and an
 * image file never changes once written (its name holds its content), so a read is reused.
 */
const readCache = new Map<string, string>()
let cachedChars = 0

function forget(path: string): void {
  const data = readCache.get(path)
  if (data === undefined) return
  readCache.delete(path)
  cachedChars -= data.length
}

function readImage(path: string): string | undefined {
  const hit = readCache.get(path)
  if (hit !== undefined) {
    readCache.delete(path)
    readCache.set(path, hit)
    return hit
  }
  let data: string
  try {
    data = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  readCache.set(path, data)
  cachedChars += data.length
  for (const [key, value] of readCache) {
    if (cachedChars <= QUEUE_IMAGES_MAX_DATA_CHARS || key === path) break
    readCache.delete(key)
    cachedChars -= value.length
  }
  return data
}

/** The queue as loaded from `queue.json`: each image named by `dataFile` given its data again (by name only if its file is gone). */
export function loadQueueImages(threadDir: string, items: QueuedMessage[]): QueuedMessage[] {
  const dir = join(threadDir, QUEUE_IMAGES_DIR)
  return items.map((item) => {
    if (!item.images?.some((image) => (image as StoredImage).dataFile)) return item
    const images = (item.images as StoredImage[]).map((image) => {
      if (!image.dataFile || !IMAGE_FILE.test(image.dataFile)) return image
      const data = readImage(join(dir, image.dataFile))
      return data !== undefined ? { name: image.name, mimeType: image.mimeType, data } : image
    })
    return { ...item, images } as QueuedMessage
  })
}
