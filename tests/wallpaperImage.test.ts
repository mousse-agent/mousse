/**
 * What a wallpaper image may be, from its header alone: the daemon keeps only a PNG, JPEG or WebP whose stated size fits
 * the limits, so a small file claiming a huge canvas (a decompression bomb) or a file of another kind (SVG with
 * scripts, HTML, GIF) is refused before anything decodes it. Display copies must match their original's shape.
 */
import { describe, expect, it } from 'vitest'
import {
  bucketForDisplay,
  checkWallpaperImage,
  isWallpaperCopy,
  readWallpaperHeader,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_UPLOAD_MAX_BYTES
} from '../src/shared/themes/wallpaperImage'
import { jpegHeader, pngHeader, webpExtended, webpLossless, webpLossy } from './fixtures/wallpaperBytes'

describe('readWallpaperHeader and checkWallpaperImage', () => {
  it.each([
    ['PNG', pngHeader(5120, 2880), { type: 'image/png', width: 5120, height: 2880 }],
    ['JPEG (baseline, after APP0)', jpegHeader(4032, 3024), { type: 'image/jpeg', width: 4032, height: 3024 }],
    ['JPEG (progressive SOF2)', jpegHeader(800, 600, 0xc2), { type: 'image/jpeg', width: 800, height: 600 }],
    ['WebP lossy (VP8)', webpLossy(1920, 1080), { type: 'image/webp', width: 1920, height: 1080 }],
    ['WebP lossless (VP8L)', webpLossless(2560, 1440), { type: 'image/webp', width: 2560, height: 1440 }],
    ['WebP extended (VP8X)', webpExtended(7680, 4320), { type: 'image/webp', width: 7680, height: 4320 }]
  ])('keeps a %s within the limits, with the size its header states', (_name, bytes, info) => {
    expect(checkWallpaperImage(bytes)).toEqual(info)
  })

  it.each([
    ['an SVG (it can carry scripts)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['an HTML page', Buffer.from('<!doctype html><img src=x onerror=alert(1)>')],
    ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary')],
    ['a BMP', Buffer.from('BM\x00\x00\x00\x00', 'binary')],
    ['an empty file', Buffer.alloc(0)],
    ['a PNG cut before its size', pngHeader(10, 10).subarray(0, 20)],
    ['a PNG whose first chunk is not IHDR', Buffer.concat([pngHeader(10, 10).subarray(0, 12), Buffer.from('IDAT'), pngHeader(10, 10).subarray(16)])],
    ['a JPEG with no frame header before its image data', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0])],
    ['a RIFF that is not a WebP', Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'binary')],
    ['a VP8 frame without its start code', Buffer.from(webpLossy(10, 10).fill(0, 23, 26))]
  ])('refuses %s', (_name, bytes) => {
    expect(checkWallpaperImage(bytes)).toBeNull()
  })

  it.each([
    ['a side over 16,384 px', pngHeader(16_385, 100)],
    ['more than 40 megapixels within the side limit (a decompression bomb)', pngHeader(10_000, 4_001)],
    ['a zero width', pngHeader(0, 100)],
    ['a WebP canvas over the limit', webpExtended(16_384, 16_384)]
  ])('refuses %s, read from the header alone', (_name, bytes) => {
    expect(readWallpaperHeader(bytes)).not.toBeNull()
    expect(checkWallpaperImage(bytes)).toBeNull()
  })

  it('keeps an 8K image and refuses a file over 32 MB whatever it holds', () => {
    expect(checkWallpaperImage(pngHeader(7680, 4320))).not.toBeNull()
    expect(checkWallpaperImage(pngHeader(100, 100, WALLPAPER_MAX_BYTES))).toBeNull()
  })
})

describe('isWallpaperCopy', () => {
  const original = { width: 5120, height: 2880 }

  it('takes a WebP whose long edge is the bucket and whose shape is the original\'s', () => {
    expect(isWallpaperCopy(webpLossy(2560, 1440), original, 2560)).toBe(true)
    expect(isWallpaperCopy(webpLossy(3840, 2160), original, 3840)).toBe(true)
  })

  it('takes the copy of a photo the window turned upright (EXIF rotation): edges are compared long to long', () => {
    // A phone photo stored landscape (4032x3024) with orientation 6 shows portrait: its copy is 1440x1920.
    expect(isWallpaperCopy(webpLossy(1440, 1920), { width: 4032, height: 3024 }, 1920)).toBe(true)
  })

  it('never takes a copy larger than the image', () => {
    expect(isWallpaperCopy(webpLossy(1600, 900), { width: 1600, height: 900 }, 3840)).toBe(true)
    expect(isWallpaperCopy(webpLossy(3840, 2160), { width: 1600, height: 900 }, 3840)).toBe(false)
  })

  it.each([
    ['another shape', webpLossy(2560, 1600)],
    ['another size', webpLossy(1920, 1080)],
    ['a PNG', pngHeader(2560, 1440)],
    ['a file over the upload limit', Buffer.concat([webpLossy(2560, 1440), Buffer.alloc(WALLPAPER_UPLOAD_MAX_BYTES)])]
  ])('refuses %s', (_name, bytes) => {
    expect(isWallpaperCopy(bytes, original, 2560)).toBe(false)
  })
})

describe('bucketForDisplay', () => {
  it.each([[1366, 1920], [1920, 1920], [2560, 2560], [2880, 3840], [3840, 3840], [5120, 3840], [7680, 3840]])('a display %i px long gets the %i copy', (long, bucket) => {
    expect(bucketForDisplay(long)).toBe(bucket)
  })
})
