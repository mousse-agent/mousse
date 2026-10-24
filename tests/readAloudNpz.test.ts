import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseNpy, parseNpz } from '../src/renderer/readAloud/npz'

/** A `.npy` file the way NumPy writes it: magic, version, padded header, then the values. */
function npy(values: number[], shape: number[], options: { descr?: string; fortran?: boolean; version?: 1 | 2 } = {}): Uint8Array {
  const { descr = '<f4', fortran = false, version = 1 } = options
  const dims = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`
  let header = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': ${dims}, }`
  const prefix = version === 1 ? 10 : 12
  while ((prefix + header.length + 1) % 64 !== 0) header += ' '
  header += '\n'
  const bytes = new Uint8Array(prefix + header.length + values.length * 4)
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0])
  const view = new DataView(bytes.buffer)
  if (version === 1) view.setUint16(8, header.length, true)
  else view.setUint32(8, header.length, true)
  bytes.set(strToU8(header), prefix)
  values.forEach((value, index) => view.setFloat32(prefix + header.length + index * 4, value, true))
  return bytes
}

describe('npy parsing', () => {
  it('reads shape and little-endian float32 values', () => {
    const array = parseNpy(npy([1, 2, 3, 4, 5, 6], [2, 3]))
    expect(array.shape).toEqual([2, 3])
    expect(Array.from(array.data)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('reads version 2 headers and one-dimensional shapes', () => {
    const array = parseNpy(npy([0.5, -1.5], [2], { version: 2 }))
    expect(array.shape).toEqual([2])
    expect(Array.from(array.data)).toEqual([0.5, -1.5])
  })

  it('reads data that starts at an odd offset inside a larger buffer', () => {
    const file = npy([7, 8], [2])
    const padded = new Uint8Array(file.length + 3)
    padded.set(file, 3)
    expect(Array.from(parseNpy(padded.subarray(3)).data)).toEqual([7, 8])
  })

  it('rejects files it cannot read correctly', () => {
    expect(() => parseNpy(strToU8('not a numpy file at all'))).toThrow('Not a NumPy')
    expect(() => parseNpy(npy([1], [1], { descr: '<f8' }))).toThrow('Unsupported NumPy data type <f8')
    expect(() => parseNpy(npy([1, 2], [1, 2], { fortran: true }))).toThrow('order')
    expect(() => parseNpy(npy([1, 2], [3]))).toThrow('truncated')
  })
})

describe('npz parsing', () => {
  it('returns every array by name without the .npy suffix', () => {
    const archive = zipSync({ 'a.npy': [npy([1, 2], [2]), { level: 0 }], 'b.npy': [npy([3, 4, 5, 6], [2, 2]), { level: 6 }], 'notes.txt': strToU8('skip me') })
    const arrays = parseNpz(archive)
    expect(Object.keys(arrays).sort()).toEqual(['a', 'b'])
    expect(Array.from(arrays.a.data)).toEqual([1, 2])
    expect(arrays.b.shape).toEqual([2, 2])
    expect(Array.from(arrays.b.data)).toEqual([3, 4, 5, 6])
  })
})
