/**
 * What a wallpaper image may be, read from its first bytes without decoding it. The daemon checks every image it keeps
 * (`WallpaperStore`) here before anything decodes it, so a file that is not a PNG, JPEG or WebP, or one whose size
 * would take too much memory once decoded (a "decompression bomb": a small file that claims a huge canvas), is refused.
 * The type comes from the bytes, never from a file name or a stored field.
 */

export type WallpaperImageType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface WallpaperImageInfo {
  type: WallpaperImageType
  /** As the file's header says, before any EXIF rotation. */
  width: number
  height: number
}

/** The largest image file kept. */
export const WALLPAPER_MAX_BYTES = 32 * 1024 * 1024
/** The longest side an image may have, in pixels. */
export const WALLPAPER_MAX_SIDE = 16_384
/** The most pixels an image may have (an 8K image has 33 million). */
export const WALLPAPER_MAX_PIXELS = 40_000_000
/**
 * The widths of the copies a window shows, by the long edge: the smallest one at least as long as the largest display,
 * never more than the image itself. The original is never painted.
 */
export const WALLPAPER_BUCKETS = [1920, 2560, 3840] as const
export type WallpaperBucket = (typeof WALLPAPER_BUCKETS)[number]
/**
 * The largest image sent in one request (a display copy, or an image carried in a theme file): one protocol request
 * is at most 4 MiB, the bytes travel as base64 (4 characters for 3 bytes), and 64 KiB is left for the rest.
 */
export const WALLPAPER_UPLOAD_MAX_BYTES = Math.floor(((4 * 1024 * 1024 - 64 * 1024) * 3) / 4)
/** The base64 text of the largest upload. */
export const WALLPAPER_UPLOAD_MAX_BASE64 = Math.ceil(WALLPAPER_UPLOAD_MAX_BYTES / 3) * 4
/** How much of a JPEG is searched for its size: its header comes before the image data. */
const JPEG_SCAN_BYTES = 1024 * 1024

/** The sentence every refused image gets, so a caller cannot tell a missing file from an unreadable or invalid one. */
export const WALLPAPER_REFUSED =
  'Mousse could not use that file as a wallpaper: it must be a PNG, JPEG or WebP on this computer, at most 32 MB, 16,384 pixels a side and 40 megapixels.'

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1]
const u32be = (bytes: Uint8Array, at: number): number => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
const u16le = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8)
const u24le = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length))

function png(bytes: Uint8Array): WallpaperImageInfo | null {
  // Signature, then the IHDR chunk must come first: length 13, type IHDR, width, height.
  if (bytes.length < 24) return null
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return null
  return { type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

/** Start-of-frame markers: SOF0–SOF15 without DHT (C4), JPG (C8) and DAC (CC). */
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function jpeg(bytes: Uint8Array): WallpaperImageInfo | null {
  const end = Math.min(bytes.length, JPEG_SCAN_BYTES)
  let at = 2
  while (at + 4 <= end) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes before a marker.
    if (marker === 0xff) { at += 1; continue }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    // End of image or start of scan before any frame header: no size to read.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(bytes, at + 2)
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      if (at + 9 > end || length < 7) return null
      return { type: 'image/jpeg', height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) }
    }
    at += 2 + length
  }
  return null
}

function webp(bytes: Uint8Array): WallpaperImageInfo | null {
  if (bytes.length < 30 || ascii(bytes, 8, 4) !== 'WEBP') return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    // Canvas width and height, each minus one, in 24 bits.
    return { type: 'image/webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    // A key frame: frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { type: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // Signature 0x2F, then 14-bit width and height, each minus one.
    if (bytes[20] !== 0x2f) return null
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/** The type and size the image's header states, or null when it is not a PNG, JPEG or WebP whose size can be read. */
export function readWallpaperHeader(bytes: Uint8Array): WallpaperImageInfo | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return png(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes)
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') return webp(bytes)
  return null
}

/** Whether `info` is too large to keep. */
function tooLarge(info: WallpaperImageInfo): boolean {
  const { width, height } = info
  return width < 1 || height < 1 || width > WALLPAPER_MAX_SIDE || height > WALLPAPER_MAX_SIDE || width * height > WALLPAPER_MAX_PIXELS
}

/** The image an original may be: a PNG, JPEG or WebP within the size limits, or null. */
export function checkWallpaperImage(bytes: Uint8Array): WallpaperImageInfo | null {
  if (bytes.length === 0 || bytes.length > WALLPAPER_MAX_BYTES) return null
  const info = readWallpaperHeader(bytes)
  return info && !tooLarge(info) ? info : null
}

/** The long edge of the copy for `bucket` of an image whose long edge is `originalLong`: never larger than the image. */
export function copyLongEdge(bucket: WallpaperBucket, originalLong: number): number {
  return Math.min(bucket, originalLong)
}

/**
 * Whether `bytes` is a display copy of `original` for `bucket`: a WebP within the upload limit whose long edge is the
 * expected one and whose shape matches the original's within 1%. Edges are compared long to long and short to short,
 * because the window applies the image's EXIF rotation and the original's header does not.
 */
export function isWallpaperCopy(bytes: Uint8Array, original: Pick<WallpaperImageInfo, 'width' | 'height'>, bucket: WallpaperBucket): boolean {
  if (bytes.length === 0 || bytes.length > WALLPAPER_UPLOAD_MAX_BYTES) return false
  const info = readWallpaperHeader(bytes)
  if (!info || info.type !== 'image/webp' || tooLarge(info)) return false
  const long = Math.max(info.width, info.height)
  const short = Math.min(info.width, info.height)
  const originalLong = Math.max(original.width, original.height)
  const originalShort = Math.min(original.width, original.height)
  if (long !== copyLongEdge(bucket, originalLong)) return false
  const expectedShort = (originalShort * long) / originalLong
  return Math.abs(short - expectedShort) <= Math.max(1, expectedShort * 0.01)
}

export function isWallpaperBucket(value: unknown): value is WallpaperBucket {
  return typeof value === 'number' && (WALLPAPER_BUCKETS as readonly number[]).includes(value)
}

/** The copy a display whose long edge is `displayLong` physical pixels needs. */
export function bucketForDisplay(displayLong: number): WallpaperBucket {
  return WALLPAPER_BUCKETS.find((bucket) => bucket >= displayLong) ?? WALLPAPER_BUCKETS[WALLPAPER_BUCKETS.length - 1]
}

/** A wallpaper id: the sha-256 of the original image, in lower-case hex. */
export function isWallpaperId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** An image the daemon stored: its id and what its header says. */
export interface StoredWallpaperInfo extends WallpaperImageInfo {
  id: string
}

/** One piece of a stored image, as a window reads it; `missing` when it is not stored. */
export type WallpaperPieceResult = { missing: true } | { type: WallpaperImageType; size: number; offset: number; data: string }
