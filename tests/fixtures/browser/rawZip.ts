import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'fflate'

/**
 * Writes ZIP archives byte by byte so tests can build shapes a normal ZIP
 * library would never produce: raw names, any file type, and central and
 * local headers that disagree.
 */
export interface RawZipEntry {
  name: string
  data?: Uint8Array | string
  /** Full Unix st_mode, for example 0o100644, 0o040755 or 0o120777. */
  mode?: number
  /** "Made by" host: 3 is Unix (the default), 0 is MS-DOS. */
  host?: number
  /** 0 stores, 8 deflates. */
  method?: 0 | 8
  /** Local header overrides, to make it disagree with the central directory. */
  localName?: string
  localMethod?: number
  /** Central directory override of the uncompressed size. */
  centralUncompressedSize?: number
  /** Writes the local entry but leaves it out of the central directory. */
  omitFromCentral?: boolean
}

export const S_IFREG = 0o100000
export const S_IFDIR = 0o040000
export const S_IFLNK = 0o120000
export const S_IFIFO = 0o010000
export const S_IFCHR = 0o020000
export const S_IFBLK = 0o060000
export const S_IFSOCK = 0o140000

export function file(name: string, data: Uint8Array | string = 'x', extra: Partial<RawZipEntry> = {}): RawZipEntry {
  return { name, data, mode: S_IFREG | 0o644, ...extra }
}
export function dir(name: string, extra: Partial<RawZipEntry> = {}): RawZipEntry {
  return { name: name.endsWith('/') ? name : `${name}/`, mode: S_IFDIR | 0o755, ...extra }
}
export function link(name: string, target: string | Uint8Array, extra: Partial<RawZipEntry> = {}): RawZipEntry {
  return { name, data: target, mode: S_IFLNK | 0o755, ...extra }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()
const bytesOf = (value: Uint8Array | string | undefined): Uint8Array => typeof value === 'string' ? encoder.encode(value) : value ?? new Uint8Array()

export function rawZip(entries: RawZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const data = bytesOf(entry.data)
    const method = entry.method ?? 0
    const stored = method === 8 ? deflateSync(data) : data
    const crc = crc32(data)
    const name = encoder.encode(entry.name)
    const localName = entry.localName === undefined ? name : encoder.encode(entry.localName)
    const local = new Uint8Array(30 + localName.length + stored.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, entry.localMethod ?? method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, stored.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, localName.length, true)
    local.set(localName, 30)
    local.set(stored, 30 + localName.length)
    locals.push(local)
    if (!entry.omitFromCentral) {
      const central = new Uint8Array(46 + name.length)
      const cv = new DataView(central.buffer)
      cv.setUint32(0, 0x02014b50, true)
      cv.setUint8(4, 20)
      cv.setUint8(5, entry.host ?? 3)
      cv.setUint16(6, 20, true)
      cv.setUint16(8, 0x0800, true)
      cv.setUint16(10, method, true)
      cv.setUint32(16, crc, true)
      cv.setUint32(20, stored.length, true)
      cv.setUint32(24, entry.centralUncompressedSize ?? data.length, true)
      cv.setUint16(28, name.length, true)
      cv.setUint32(38, ((entry.mode ?? (S_IFREG | 0o644)) * 0x10000) >>> 0, true)
      cv.setUint32(42, offset, true)
      central.set(name, 46)
      centrals.push(central)
    }
    offset += local.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const output = new Uint8Array(offset + centralSize + 22)
  let cursor = 0
  for (const part of [...locals, ...centrals, end]) { output.set(part, cursor); cursor += part.length }
  return output
}

/**
 * True when this process can create symlinks. Windows needs developer mode or
 * admin rights; tests that create links on disk skip without them, while the
 * archive checks that refuse before writing run everywhere.
 */
export function canCreateSymlinks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-symlink-probe-'))
  try { symlinkSync('target', join(directory, 'probe')); return true } catch { return false } finally { rmSync(directory, { recursive: true, force: true }) }
}
