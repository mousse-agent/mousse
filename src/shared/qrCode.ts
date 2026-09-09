/**
 * Self-contained pure-TypeScript QR Code Model 2 generator.
 * Supports Byte Mode with Error Correction Level L.
 * Produces clean SVG strings or boolean module matrices.
 */

// Galois Field GF(256) tables with primitive polynomial 0x11d
const EXP_TABLE = new Uint8Array(512)
const LOG_TABLE = new Uint8Array(256)

;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x
    EXP_TABLE[i + 255] = x
    LOG_TABLE[x] = i
    x <<= 1
    if (x & 0x100) {
      x ^= 0x11d
    }
  }
})()

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]]
}

// Generate Reed-Solomon generator polynomial for degree n
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const factor = EXP_TABLE[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], factor)
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount)
  const res = new Uint8Array(data.length + ecCount)
  res.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gmul(gen[j], coef)
      }
    }
  }
  return res.slice(data.length)
}

// Table of QR parameters: version -> [totalDataBytes, ecBytesPerBlock, numBlocksG1, dataBytesG1, numBlocksG2, dataBytesG2]
const QR_SPECS_L: Record<number, [number, number, number, number, number, number]> = {
  1: [19, 7, 1, 19, 0, 0],
  2: [34, 10, 1, 34, 0, 0],
  3: [55, 15, 1, 55, 0, 0],
  4: [80, 20, 1, 80, 0, 0],
  5: [108, 26, 1, 108, 0, 0],
  6: [136, 18, 2, 68, 0, 0],
  7: [156, 20, 2, 78, 0, 0],
  8: [194, 24, 2, 97, 0, 0],
  9: [232, 30, 2, 116, 0, 0],
  10: [274, 18, 2, 68, 2, 69],
  11: [324, 20, 4, 81, 0, 0],
  12: [370, 24, 2, 92, 2, 93],
  13: [428, 26, 4, 107, 0, 0],
  14: [461, 30, 3, 115, 1, 116],
  15: [523, 22, 5, 87, 1, 88],
  16: [589, 24, 5, 98, 1, 99],
  17: [647, 28, 1, 107, 5, 108],
  18: [721, 30, 5, 120, 1, 121],
  19: [795, 28, 3, 113, 4, 114],
  20: [861, 28, 3, 107, 5, 108]
}

const ALIGNMENT_PATTERN_POSITIONS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90]
}

export class QrMatrix {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(size: number) {
    this.size = size
    this.modules = Array.from({ length: size }, () => Array(size).fill(false))
    this.isFunction = Array.from({ length: size }, () => Array(size).fill(false))
  }

  set(r: number, c: number, val: boolean, isFunc = false): void {
    if (r >= 0 && r < this.size && c >= 0 && c < this.size) {
      this.modules[r][c] = val
      if (isFunc) this.isFunction[r][c] = true
    }
  }

  get(r: number, c: number): boolean {
    return this.modules[r]?.[c] ?? false
  }
}

export function generateQrMatrix(text: string): boolean[][] {
  const encoder = new TextEncoder()
  const rawBytes = encoder.encode(text)
  const length = rawBytes.length

  let version = 1
  for (let v = 1; v <= 20; v++) {
    const spec = QR_SPECS_L[v]
    if (!spec) break
    const charCountBits = v <= 9 ? 8 : 16
    const totalRequiredBits = 4 + charCountBits + length * 8
    const totalCapacityBits = spec[0] * 8
    if (totalRequiredBits <= totalCapacityBits) {
      version = v
      break
    }
  }

  const spec = QR_SPECS_L[version]
  if (!spec) throw new Error(`Text too long for QR generator (length ${length})`)

  const [totalDataBytes, ecBytesPerBlock, b1Count, b1DataLen, b2Count, b2DataLen] = spec

  const bits: number[] = []
  function pushBits(val: number, numBits: number) {
    for (let i = numBits - 1; i >= 0; i--) {
      bits.push((val >> i) & 1)
    }
  }

  pushBits(0b0100, 4)
  const countBits = version <= 9 ? 8 : 16
  pushBits(length, countBits)
  for (let i = 0; i < length; i++) {
    pushBits(rawBytes[i], 8)
  }

  const totalDataBits = totalDataBytes * 8
  const termLen = Math.min(4, totalDataBits - bits.length)
  pushBits(0, termLen)

  while (bits.length % 8 !== 0) {
    bits.push(0)
  }

  const padBytes = [0xec, 0x11]
  let padIdx = 0
  while (bits.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8)
    padIdx++
  }

  const dataBytes = new Uint8Array(totalDataBytes)
  for (let i = 0; i < totalDataBytes; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j]
    }
    dataBytes[i] = b
  }

  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0

  for (let i = 0; i < b1Count; i++) {
    const blk = dataBytes.slice(offset, offset + b1DataLen)
    dataBlocks.push(blk)
    ecBlocks.push(rsEncode(blk, ecBytesPerBlock))
    offset += b1DataLen
  }
  for (let i = 0; i < b2Count; i++) {
    const blk = dataBytes.slice(offset, offset + b2DataLen)
    dataBlocks.push(blk)
    ecBlocks.push(rsEncode(blk, ecBytesPerBlock))
    offset += b2DataLen
  }

  const interleaved: number[] = []
  const maxDataLen = Math.max(b1DataLen, b2DataLen)
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) {
        interleaved.push(blk[i])
      }
    }
  }
  for (let i = 0; i < ecBytesPerBlock; i++) {
    for (const ec of ecBlocks) {
      if (i < ec.length) {
        interleaved.push(ec[i])
      }
    }
  }

  const size = 17 + 4 * version
  const matrix = new QrMatrix(size)

  function drawFinder(top: number, left: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r
        const col = left + c
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                        (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        matrix.set(row, col, isBlack, true)
      }
    }
  }

  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    matrix.set(6, i, i % 2 === 0, true)
    matrix.set(i, 6, i % 2 === 0, true)
  }

  matrix.set(4 * version + 9, 8, true, true)

  const alignPos = ALIGNMENT_PATTERN_POSITIONS[version] || []
  for (const r of alignPos) {
    for (const c of alignPos) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8)) {
        continue
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const isBlack = Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0)
          matrix.set(r + dy, c + dx, isBlack, true)
        }
      }
    }
  }

  for (let i = 0; i <= 8; i++) {
    matrix.set(8, i, false, true)
    matrix.set(i, 8, false, true)
  }
  for (let i = 0; i < 8; i++) {
    matrix.set(8, size - 1 - i, false, true)
    matrix.set(size - 1 - i, 8, false, true)
  }

  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        matrix.set(r, size - 11 + c, false, true)
        matrix.set(size - 11 + c, r, false, true)
      }
    }
  }

  const finalBits: number[] = []
  for (const byte of interleaved) {
    for (let b = 7; b >= 0; b--) {
      finalBits.push((byte >> b) & 1)
    }
  }

  let bitIdx = 0
  let col = size - 1
  let direction = -1
  let row = size - 1

  while (col > 0) {
    if (col === 6) col--

    for (let i = 0; i < size; i++) {
      const r = row
      for (let c = 0; c < 2; c++) {
        const currCol = col - c
        if (!matrix.isFunction[r][currCol]) {
          let bit = 0
          if (bitIdx < finalBits.length) {
            bit = finalBits[bitIdx++]
          }
          const mask = (r + currCol) % 2 === 0
          matrix.set(r, currCol, (bit === 1) !== mask)
        }
      }
      row += direction
    }
    direction = -direction
    row += direction
    col -= 2
  }

  const formatInfo = 0x5c49
  for (let i = 0; i < 15; i++) {
    const bit = ((formatInfo >> (14 - i)) & 1) === 1
    if (i < 6) matrix.set(8, i, bit, true)
    else if (i === 6) matrix.set(8, 7, bit, true)
    else if (i === 7) matrix.set(8, 8, bit, true)
    else if (i === 8) matrix.set(7, 8, bit, true)
    else matrix.set(14 - i, 8, bit, true)

    if (i < 8) matrix.set(size - 1 - i, 8, bit, true)
    else matrix.set(8, size - 15 + i, bit, true)
  }

  return matrix.modules
}

export function qrMatrixToSvg(matrix: boolean[][], margin = 4, cellSize = 6): string {
  const size = matrix.length
  const total = (size + margin * 2) * cellSize
  let path = ''

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        const x = (c + margin) * cellSize
        const y = (r + margin) * cellSize
        path += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="100%" height="100%" shape-rendering="crispEdges">
  <rect width="${total}" height="${total}" fill="#ffffff" rx="8" />
  <path d="${path.trim()}" fill="#0f172a" />
</svg>`
}
