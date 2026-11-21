import {
  IMAGE_MAX_DATA_CHARS,
  IMAGE_MAX_EDGE_PX,
  MESSAGE_IMAGES_MAX_DATA_CHARS,
  MESSAGE_MAX_IMAGES,
  isInlineImageMimeType
} from '../../shared/imageLimits'
import type { ImageAttachmentPayload } from '../utils/imageAttachments'

/**
 * Fits a message's images to what one message may carry (`shared/imageLimits.ts`) before it is sent. An image of a
 * type every provider takes, within its share of the message and its size in pixels, goes byte for byte as it is.
 * Any other is decoded and encoded again, smaller step by step until it fits: JPEG for an opaque image, WebP (or PNG
 * where WebP cannot be written) for one with see-through pixels, and an animated GIF as its first frame. One that
 * cannot be read, or that is past the message's image count, goes as a file instead. Decoding and encoding run in a
 * worker (`imageFitWorker.ts`), so the window never waits on them.
 */

export type EncodeType = 'image/jpeg' | 'image/webp' | 'image/png'

/** An image decoded for encoding again. `close` frees it. */
export interface DecodedImage {
  width: number
  height: number
  /** Whether any pixel is see-through. */
  hasAlpha: boolean
  /** The image drawn at `width` × `height` and encoded as `type` (a Blob of another type when that cannot be written). */
  encode(width: number, height: number, type: EncodeType, quality: number): Promise<Blob>
  close(): void
}

export interface ImageCodec {
  /** Width and height read from the file's header, without decoding it; null when they cannot be read there. */
  size(file: Blob): Promise<{ width: number; height: number } | null>
  /** The decoded image (an animated GIF's first frame), or null when it cannot be read. */
  decode(file: Blob): Promise<DecodedImage | null>
}

export interface ImageFitLimits {
  perImage: number
  total: number
  maxImages: number
  maxEdge: number
}

export const MESSAGE_IMAGE_LIMITS: ImageFitLimits = {
  perImage: IMAGE_MAX_DATA_CHARS,
  total: MESSAGE_IMAGES_MAX_DATA_CHARS,
  maxImages: MESSAGE_MAX_IMAGES,
  maxEdge: IMAGE_MAX_EDGE_PX
}

/** Why an image goes as a file instead of inline. */
export type AsFileReason = 'unreadable' | 'too_many' | 'too_large'

/** Size in bytes, and width and height in pixels when known. */
export interface ImageSize {
  bytes: number
  width?: number
  height?: number
}

/** An image sent inline: its bytes as attached, or (`changed`) a smaller or converted copy, and what that changed. */
export interface InlineFit {
  id: string
  image: ImageAttachmentPayload
  changed: boolean
  /** The attached image and the copy sent: set when `changed`. */
  from?: ImageSize
  to?: ImageSize
}

export interface FitResult {
  /** The images sent inline, in the order given. */
  images: InlineFit[]
  /** The images sent as files instead, and why. */
  asFiles: Array<{ id: string; reason: AsFileReason }>
}

/** Base64 characters of `bytes` bytes. */
export const base64Chars = (bytes: number): number => 4 * Math.ceil(bytes / 3)

/** A file's type as providers name it (`image/jpg` is JPEG). */
function canonicalType(type: string): string {
  const lower = type.toLowerCase()
  return lower === 'image/jpg' || lower === 'image/pjpeg' ? 'image/jpeg' : lower
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

/** The name with the extension of the type it was encoded as. */
function renamed(name: string, type: string): string {
  const extension = EXTENSIONS[type]
  if (!extension) return name
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name || 'image'}.${extension}`
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('Failed to read image'))
      else resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(blob)
  })
}

/** Below this long edge an image is not made any smaller: it goes as a file. */
const SMALLEST_EDGE_PX = 64
const QUALITIES = [0.9, 0.8]
const MAX_STEPS = 12

type FitOne = Omit<InlineFit, 'id'> | { fail: 'unreadable' | 'too_large' }

/**
 * What fitting each file at a share came to, kept while the file stays attached, so attaching or removing another
 * image fits again only those whose share changed. An image sent as attached fits any share at least its size.
 */
export type FitCache = WeakMap<File, Map<number, FitOne>>

function cachedFit(cache: FitCache | undefined, file: File, budget: number): FitOne | undefined {
  const byBudget = cache?.get(file)
  if (!byBudget) return undefined
  const exact = byBudget.get(budget)
  if (exact) return exact
  for (const result of byBudget.values()) {
    if ('fail' in result) {
      if (result.fail === 'unreadable') return result
    } else if (!result.changed && result.image.data.length <= budget) return result
  }
  return undefined
}

async function fitOne(file: File, budget: number, codec: ImageCodec, maxEdge: number): Promise<FitOne> {
  const type = canonicalType(file.type)
  const name = file.name || 'image'
  if (isInlineImageMimeType(type) && base64Chars(file.size) <= budget) {
    const size = await codec.size(file).catch(() => null)
    if (!size || Math.max(size.width, size.height) <= maxEdge) {
      return { image: { name, mimeType: type, data: await blobToBase64(file) }, changed: false }
    }
  }
  const decoded = await codec.decode(file).catch(() => null)
  if (!decoded) return { fail: 'unreadable' }
  try {
    const target: EncodeType = decoded.hasAlpha ? 'image/webp' : 'image/jpeg'
    const longEdge = Math.max(decoded.width, decoded.height)
    let scale = Math.min(1, maxEdge / longEdge)
    // The first try is at full size (within the edge limit) however small the image; only shrinking stops at the floor.
    for (let step = 0; step < MAX_STEPS && (step === 0 || longEdge * scale >= SMALLEST_EDGE_PX); step += 1) {
      const width = Math.max(1, Math.round(decoded.width * scale))
      const height = Math.max(1, Math.round(decoded.height * scale))
      let smallest = Number.POSITIVE_INFINITY
      for (const quality of QUALITIES) {
        const blob = await decoded.encode(width, height, target, quality)
        const chars = base64Chars(blob.size)
        if (chars <= budget) {
          const mimeType = canonicalType(blob.type || target)
          return {
            image: { name: renamed(name, mimeType), mimeType, data: await blobToBase64(blob) },
            changed: true,
            from: { bytes: file.size, width: decoded.width, height: decoded.height },
            to: { bytes: blob.size, width, height }
          }
        }
        smallest = Math.min(smallest, chars)
      }
      // Size goes with the area: shrink each side by the square root of what is over, and a little more.
      scale *= Math.min(0.85, Math.sqrt(budget / smallest) * 0.95)
    }
    return { fail: 'too_large' }
  } catch {
    // The worker stopped, or could not write the image: it goes as a file.
    return { fail: 'unreadable' }
  } finally {
    decoded.close()
  }
}

/**
 * Fits `files` (images attached to one message) to `limits`. The smallest go first, so each one that already fits
 * keeps its bytes, and what is left is shared among the larger ones: each gets at most the per-image size and an even
 * share of what the message has left. `cache` keeps each file's results for the next fit of the same message.
 */
export async function fitImages(
  files: ReadonlyArray<{ id: string; file: File }>,
  codec: ImageCodec = workerImageCodec(),
  limits: ImageFitLimits = MESSAGE_IMAGE_LIMITS,
  cache?: FitCache
): Promise<FitResult> {
  const kept = files.slice(0, limits.maxImages)
  const asFiles: FitResult['asFiles'] = files.slice(limits.maxImages).map(({ id }) => ({ id, reason: 'too_many' as const }))
  const order = kept.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.file.size - b.entry.file.size)
  const fitted: Array<InlineFit & { index: number }> = []
  let remaining = limits.total
  let left = order.length
  for (const { entry, index } of order) {
    const budget = Math.min(limits.perImage, Math.floor(remaining / left))
    left -= 1
    let result = cachedFit(cache, entry.file, budget)
    if (!result) {
      result = await fitOne(entry.file, budget, codec, limits.maxEdge)
      if (cache) cache.set(entry.file, (cache.get(entry.file) ?? new Map<number, FitOne>()).set(budget, result))
    }
    if ('fail' in result) {
      asFiles.push({ id: entry.id, reason: result.fail })
      continue
    }
    remaining -= result.image.data.length
    fitted.push({ ...result, index, id: entry.id })
  }
  fitted.sort((a, b) => a.index - b.index)
  return { images: fitted.map(({ index: _index, ...image }) => image), asFiles }
}

/** Width and height from a PNG, GIF, WebP or JPEG header; null for any other file or a header that cannot be read. */
export function headerSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (bytes.length >= 24 && bytes[0] === 0x89 && at(1, 'PNG') && at(12, 'IHDR')) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 10 && at(0, 'GIF8')) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes.length >= 30 && at(0, 'RIFF') && at(8, 'WEBP')) {
    if (at(12, 'VP8 ')) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (at(12, 'VP8L')) {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (at(12, 'VP8X')) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width, height }
    }
    return null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      const length = view.getUint16(offset + 2)
      // Start of frame (not DHT, JPG or DAC, which share the range).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

/** How much of a file is read for its header: a JPEG's frame size can come after a large EXIF block. */
const HEADER_BYTES = 256 * 1024

type WorkerReply = { id: number; ok: true; width?: number; height?: number; hasAlpha?: boolean; blob?: Blob } | { id: number; ok: false }

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, (reply: WorkerReply) => void>()

function failAll(): void {
  for (const answer of waiting.values()) answer({ id: 0, ok: false })
  waiting.clear()
  worker?.terminate()
  worker = null
}

function ask(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerReply> {
  if (!worker) {
    worker = new Worker(new URL('./imageFitWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const answer = waiting.get(event.data.id)
      waiting.delete(event.data.id)
      answer?.(event.data)
    }
    worker.onerror = failAll
  }
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    worker!.postMessage({ ...message, id }, transfer)
  })
}

/** Decodes and encodes in a worker; an image the worker cannot decode is null. */
export function workerImageCodec(): ImageCodec {
  return {
    size: async (file) => headerSize(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())),
    decode: async (file) => {
      let reply: WorkerReply
      try {
        reply = await ask({ op: 'decode', blob: file })
      } catch {
        return null
      }
      if (!reply.ok || !reply.width || !reply.height) return null
      const key = reply.id
      return {
        width: reply.width,
        height: reply.height,
        hasAlpha: reply.hasAlpha === true,
        encode: async (width, height, type, quality) => {
          const encoded = await ask({ op: 'encode', key, width, height, type, quality })
          if (!encoded.ok || !encoded.blob) throw new Error('The image could not be encoded')
          return encoded.blob
        },
        close: () => { if (worker) worker.postMessage({ op: 'close', key }) }
      }
    }
  }
}
