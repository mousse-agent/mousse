import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A bot's face picture (`face.png` in its files folder): its face as the app draws it, a 512 px square PNG, front view,
 * still, for the bot to use where its owner wants its picture. The app draws it (the face shader lives in the renderer)
 * and hands it over (`bots.facePicture.save`); Mousse writes it here. The picture carries the key of what it was drawn
 * from (the look, the art version, the size) in a PNG text chunk, so the app draws it again only when that changes, and a
 * picture someone replaced or deleted is drawn again too.
 */

export const FACE_PICTURE_FILE = 'face.png'
/** The largest picture taken: a 512 px face is about 150 KB. */
export const MAX_FACE_PICTURE_BYTES = 2 * 1024 * 1024
/** The longest key taken. */
export const MAX_FACE_PICTURE_KEY = 512
/** The PNG text chunk's keyword for the key. */
const KEYWORD = 'mousse-face'
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Bytes read to find the key: the signature, the header chunk, then the text chunk, which is written right after it. */
const HEAD_BYTES = 8 + 25 + 12 + KEYWORD.length + 1 + MAX_FACE_PICTURE_KEY

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Whether `png` starts like a PNG with its header chunk first. */
export function isPng(png: Buffer): boolean {
  return png.length > 33 && png.subarray(0, 8).equals(SIGNATURE) && png.toString('latin1', 12, 16) === 'IHDR'
}

/** `key` is printable ASCII, at most `MAX_FACE_PICTURE_KEY` characters. */
export function isFacePictureKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_FACE_PICTURE_KEY && /^[\x20-\x7e]+$/.test(key)
}

/** `png` with a text chunk holding `key` right after its header chunk. */
export function withFaceKey(png: Buffer, key: string): Buffer {
  const headerEnd = 8 + 8 + png.readUInt32BE(8) + 4
  const data = Buffer.from(`${KEYWORD}\0${key}`, 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return Buffer.concat([png.subarray(0, headerEnd), chunk, png.subarray(headerEnd)])
}

/** The key in the text chunk right after the header chunk of a PNG's first bytes, else undefined. */
export function faceKeyOf(head: Buffer): string | undefined {
  if (head.length < 33 || !head.subarray(0, 8).equals(SIGNATURE)) return undefined
  const at = 8 + 8 + head.readUInt32BE(8) + 4
  if (head.length < at + 8 || head.toString('latin1', at + 4, at + 8) !== 'tEXt') return undefined
  const length = head.readUInt32BE(at)
  if (head.length < at + 8 + length) return undefined
  const text = head.toString('latin1', at + 8, at + 8 + length)
  return text.startsWith(`${KEYWORD}\0`) ? text.slice(KEYWORD.length + 1) : undefined
}

/**
 * The bots' face pictures in their files folders: where each is, and the key it was drawn from, read once per change of
 * the file (its size and time), so the Bots list and each turn's system text cost a stat, not a read.
 */
export class BotFacePictures {
  private readonly known = new Map<string, { mtimeMs: number; size: number; key: string | undefined }>()

  constructor(private readonly filesFolder: (botId: string) => string) {}

  path(botId: string): string {
    return join(this.filesFolder(botId), FACE_PICTURE_FILE)
  }

  /** The picture's path and key, or undefined when there is none. */
  current(botId: string): { path: string; key: string | undefined } | undefined {
    const path = this.path(botId)
    let stat: { mtimeMs: number; size: number; isFile(): boolean }
    try {
      stat = statSync(path)
    } catch {
      this.known.delete(botId)
      return undefined
    }
    if (!stat.isFile()) return undefined
    const seen = this.known.get(botId)
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) return { path, key: seen.key }
    let key: string | undefined
    try {
      const fd = openSync(path, 'r')
      try {
        const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
        readSync(fd, head, 0, head.length, 0)
        key = faceKeyOf(head)
      } finally {
        closeSync(fd)
      }
    } catch {
      key = undefined
    }
    this.known.set(botId, { mtimeMs: stat.mtimeMs, size: stat.size, key })
    return { path, key }
  }

  /** Writes the picture whole (a temporary file, then a rename), carrying `key`. Throws when `png` is no PNG. */
  save(botId: string, key: string, png: Buffer): string {
    if (!isFacePictureKey(key)) throw new Error('A face picture key is 1 to 512 printable characters.')
    if (png.length > MAX_FACE_PICTURE_BYTES || !isPng(png)) throw new Error('A face picture is a PNG of at most 2 MB.')
    const folder = this.filesFolder(botId)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const path = this.path(botId)
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, withFaceKey(png, key))
    renameSync(temporary, path)
    this.known.delete(botId)
    return path
  }
}
