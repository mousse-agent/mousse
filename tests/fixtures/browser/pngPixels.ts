import { inflateSync } from 'node:zlib'

/** A decoded 8-bit, non-interlaced RGB or RGBA PNG (what Chromium's screenshots are). */
export interface PngPixels {
  width: number
  height: number
  /** The red, green and blue of the pixel at (x, y). */
  rgb(x: number, y: number): [number, number, number]
}

/** Decodes a PNG's pixels, undoing each row's filter (none, sub, up, average, Paeth). */
export function decodePng(bytes: Buffer): PngPixels {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const data: Buffer[] = []
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
      interlace = chunk[12]
    } else if (type === 'IDAT') data.push(chunk)
    else if (type === 'IEND') break
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(data))
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG data')
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0
      const up = above ? above[i] : 0
      const upLeft = above && i >= channels ? above[i - channels] : 0
      let predicted: number
      switch (filter) {
        case 0: predicted = 0; break
        case 1: predicted = left; break
        case 2: predicted = up; break
        case 3: predicted = (left + up) >> 1; break
        case 4: predicted = paeth(left, up, upLeft); break
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      row[i] = (line[i] + predicted) & 0xff
    }
  }
  return {
    width,
    height,
    rgb(x, y) {
      const at = Math.floor(y) * stride + Math.floor(x) * channels
      return [pixels[at], pixels[at + 1], pixels[at + 2]]
    }
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}
