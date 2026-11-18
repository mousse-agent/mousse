/**
 * Image headers for wallpaper tests: just enough bytes for each format's size to be read. None of them decodes; the
 * daemon never decodes an image, it only reads its header.
 */

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0))

export function pngHeader(width: number, height: number, extra = 0): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(extra).fill(0)
  ])
}

/** A JPEG with an APP0 segment before its frame header, as cameras and encoders write them. */
export function jpegHeader(width: number, height: number, marker = 0xc0): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, marker, 0x00, 0x11, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0
  ])
}

function riff(chunk: string, payload: number[]): Buffer {
  const body = [...ascii('WEBP'), ...ascii(chunk), ...[payload.length, 0, 0, 0], ...payload]
  return Buffer.from([...ascii('RIFF'), body.length & 255, (body.length >> 8) & 255, 0, 0, ...body])
}

export function webpLossy(width: number, height: number): Buffer {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0])
}

export function webpLossless(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  return riff('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0])
}

export function webpExtended(width: number, height: number): Buffer {
  return riff('VP8X', [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0])
}
