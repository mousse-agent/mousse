import { unzipSync } from 'fflate'

/**
 * Reader for NumPy's `.npy` arrays and `.npz` archives (a zip of `.npy` files), enough to load
 * voice style matrices. Only little-endian float32 data in C order is supported, which is what the
 * voice files use; anything else is rejected rather than misread.
 */

export interface NpyArray {
  shape: number[]
  data: Float32Array
}

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] // \x93NUMPY

/** Parses one `.npy` file holding a little-endian float32 array in C order. */
export function parseNpy(bytes: Uint8Array): NpyArray {
  if (bytes.length < 10 || MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('Not a NumPy array file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const major = bytes[6]
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  const headerStart = major === 1 ? 10 : 12
  const dataStart = headerStart + headerLength
  if (dataStart > bytes.length) throw new Error('NumPy array header is truncated')
  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, dataStart))

  const descr = /'descr'\s*:\s*'([^']*)'/.exec(header)?.[1]
  if (descr !== '<f4') throw new Error(`Unsupported NumPy data type ${descr ?? '(missing)'}`)
  if (!/'fortran_order'\s*:\s*False/.test(header)) throw new Error('Unsupported NumPy array order')
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1]
  if (shapeText === undefined) throw new Error('NumPy array has no shape')
  const shape = shapeText
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
  const count = shape.reduce((total, size) => total * size, 1)
  if (shape.some((size) => !Number.isInteger(size) || size < 0) || dataStart + count * 4 > bytes.length) {
    throw new Error('NumPy array data is truncated')
  }
  // A copy, because the data may start at an offset that is not a multiple of four.
  const data = new Float32Array(bytes.slice(dataStart, dataStart + count * 4).buffer)
  return { shape, data }
}

/** Parses an `.npz` archive into its arrays, keyed by name without the `.npy` suffix. */
export function parseNpz(bytes: Uint8Array): Record<string, NpyArray> {
  const arrays: Record<string, NpyArray> = {}
  const entries = unzipSync(bytes, { filter: (file) => file.name.endsWith('.npy') })
  for (const [name, entry] of Object.entries(entries)) arrays[name.replace(/\.npy$/, '')] = parseNpy(entry)
  return arrays
}
