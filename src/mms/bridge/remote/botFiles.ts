import { open, realpath } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { NetError } from '../../../shared/net'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'
import { REMOTE_BOT_FILE_BYTES, REMOTE_BOT_FILE_PAGE_BYTES, isBotFileRef, isSvgName } from '../../../shared/bots/personal/remoteFiles'

/** The types a file's name says, for files that are not raster images. Never SVG. */
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime'
}
const IMAGE_NAMES = /\.(png|jpe?g|gif|webp)$/i
const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? ''

/** A file's type by its name, as a message's file is described to another device; `image` for PNG, JPEG, GIF and WebP. */
export function remoteFileType(name: string): { mime: string; image?: true } {
  const extension = extensionOf(name)
  if (IMAGE_NAMES.test(name.trim())) return { mime: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`, image: true }
  if (isSvgName(name)) return { mime: 'application/octet-stream' }
  return { mime: TYPES[extension] ?? 'application/octet-stream' }
}

/** The type an image's first bytes say it is; undefined for anything that is not a PNG, JPEG, GIF or WebP. */
export function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

/** Whether a file's first bytes are SVG, whatever its name says (an `<svg` element near the start, or its doctype). */
export function looksLikeSvg(head: Buffer): boolean {
  const text = head.toString('utf8').replace(/^﻿/, '').toLowerCase()
  return /<svg[\s>/]/.test(text) || text.includes('<!doctype svg')
}

/**
 * A file of a bot's chat as another device names it: its place inside a bot's files folder (`isBotFileRef`), or
 * undefined for a file elsewhere. The folder is `<profileHome>/bots/files/<botId>` (`botFilesFolder`), so the place is
 * what follows the first such folder in the file's full path (a folder inside it named alike is part of the place).
 * `bots.chat.file` reads it only inside the folder of the bot it names.
 */
export function botFileRef(path: string): string | undefined {
  if (!path) return undefined
  const slashed = path.replaceAll('\\', '/')
  const found = [...slashed.matchAll(/\/bots\/files\/([^/]+)\//g)].find((match) => isBotId(match[1]))
  if (!found) return undefined
  const ref = slashed.slice(found.index + found[0].length)
  return isBotFileRef(ref) ? ref : undefined
}

/** One page of a file of a bot's files folder, as `bots.chat.file` answers it. */
export interface BotFilePage {
  name: string
  mime: string
  size: number
  offset: number
  dataB64: string
  /** A PNG, JPEG, GIF or WebP by its first bytes. */
  image?: true
}

const gone = (): never => {
  throw new NetError('stream_unknown', 'This file is no longer on the computer.')
}

/**
 * A page of the file at `ref` inside `folder` (a bot's files folder), for another device. Only a file inside the
 * folder: the path is relative and plain (`isBotFileRef`), and the file it reaches after links are followed must still
 * be inside, so `..`, an absolute path and a link out all read as a file that is not there. Never SVG, by name or by
 * content; at most `REMOTE_BOT_FILE_BYTES`; read in pages of `REMOTE_BOT_FILE_PAGE_BYTES` from `offset`.
 */
export async function readBotFilePage(folder: string, ref: string, offset = 0): Promise<BotFilePage> {
  if (!isBotFileRef(ref)) gone()
  let root: string
  let real: string
  try {
    root = await realpath(folder)
    real = await realpath(join(root, ...ref.split('/')))
  } catch {
    return gone()
  }
  if (!real.startsWith(root + sep)) gone()
  const name = basename(ref)
  if (isSvgName(name) || isSvgName(real)) throw new NetError('conflict', 'SVG files don’t open on another device.', { details: { reason: 'svg' } })
  let handle
  try {
    handle = await open(real, 'r')
  } catch {
    return gone()
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) gone()
    const size = stat.size
    if (size > REMOTE_BOT_FILE_BYTES) throw new NetError('too_large', `${name} is too large to open here. Open it on the computer.`)
    if (offset > size) throw new NetError('bad_request')
    const head = Buffer.alloc(Math.min(1024, size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    if (looksLikeSvg(head)) throw new NetError('conflict', 'SVG files don’t open on another device.', { details: { reason: 'svg' } })
    const image = sniffImage(head)
    // A name that says picture on bytes that are not one is no picture.
    const named = remoteFileType(name)
    const part = Buffer.alloc(Math.min(REMOTE_BOT_FILE_PAGE_BYTES, size - offset))
    const { bytesRead } = part.length ? await handle.read(part, 0, part.length, offset) : { bytesRead: 0 }
    return {
      name,
      mime: image ?? (named.image ? 'application/octet-stream' : named.mime),
      size,
      offset,
      dataB64: part.subarray(0, bytesRead).toString('base64'),
      ...(image ? { image: true as const } : {})
    }
  } finally {
    await handle.close()
  }
}
