/**
 * Hand-built archives for the agent install tests: entries a real packer would refuse to write
 * (`..` names, absolute paths, links, devices) are exactly what the extractor must reject.
 */
import { crc32, gzipSync } from 'node:zlib'

export interface ArchiveEntry {
  name: string
  data?: string | Buffer
  mode?: number
  /** tar type flag: `0` file, `5` folder, `2` symlink, `1` hardlink, `3` char device, `6` FIFO. */
  type?: '0' | '5' | '2' | '1' | '3' | '6'
  link?: string
}

function field(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, length, 'utf8')
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

/** A gzipped ustar archive of `entries`, written as given. */
export function tarGzOf(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.type && entry.type !== '0' ? Buffer.alloc(0) : Buffer.from(entry.data ?? '')
    const header = Buffer.alloc(512)
    field(header, 0, 100, entry.name)
    field(header, 100, 8, octal(entry.mode ?? (entry.type === '5' ? 0o755 : 0o644), 8))
    field(header, 108, 8, octal(0, 8))
    field(header, 116, 8, octal(0, 8))
    field(header, 124, 12, octal(data.length, 12))
    field(header, 136, 12, octal(Math.floor(Date.now() / 1000), 12))
    field(header, 148, 8, '        ')
    field(header, 156, 1, entry.type ?? '0')
    field(header, 157, 100, entry.link ?? '')
    field(header, 257, 6, 'ustar\0')
    field(header, 263, 2, '00')
    let sum = 0
    for (const byte of header) sum += byte
    field(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** A stored (uncompressed) zip of `entries`; `mode` goes into the Unix external attributes. */
export function zipOf(entries: Array<{ name: string; data?: string | Buffer; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data ?? '')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
