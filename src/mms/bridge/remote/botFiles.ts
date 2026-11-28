import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { constants as zlib, gunzipSync } from 'node:zlib'
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

/** How much of a file's start is read to tell whether it is SVG (`looksLikeSvg`). */
export const SVG_SNIFF_BYTES = 64 * 1024
/** How much of a gzip file is unpacked to see what it holds: at most about 4 MiB comes out of it. */
const GZIP_SNIFF_BYTES = 4 * 1024

/** Bytes as text: UTF-8, or UTF-16 by its byte-order mark or by the zero bytes of its first character. */
function asText(bytes: Buffer): string {
  const swapped = (from: Buffer): Buffer => {
    const copy = Buffer.from(from.subarray(0, from.length - (from.length % 2)))
    return copy.swap16()
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return swapped(bytes.subarray(2)).toString('utf16le')
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) return bytes.toString('utf16le')
  if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] !== 0) return swapped(bytes).toString('utf16le')
  return bytes.toString('utf8')
}

/**
 * What the first element of markup is, past white space, the XML declaration, processing instructions, comments and a
 * doctype: `svg` (with or without a namespace prefix, `<x:svg`), or a doctype that names SVG; `other` for anything else
 * (text, another element, binary bytes); `open` when the text ends before an element starts.
 */
function rootOf(text: string): 'svg' | 'other' | 'open' {
  let at = 0
  for (;;) {
    while (at < text.length && /[\s﻿]/.test(text[at]!)) at += 1
    if (at >= text.length) return 'open'
    if (text[at] !== '<') return 'other'
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2)
      if (end < 0) return 'open'
      at = end + 2
      continue
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4)
      if (end < 0) return 'open'
      at = end + 3
      continue
    }
    const head = text.slice(at, at + 512)
    if (/^<!doctype/i.test(head)) {
      if (/^<!doctype\s+([\w.-]+:)?svg\b/i.test(head)) return 'svg'
      // A doctype's own declarations (`[ … ]`) can hold a `>`.
      const close = text.indexOf('>', at)
      const open = text.indexOf('[', at)
      const from = open >= 0 && (close < 0 || open < close) ? text.indexOf(']', open) : at
      const end = from < 0 ? -1 : text.indexOf('>', from)
      if (end < 0) return 'open'
      at = end + 1
      continue
    }
    return /^<([A-Za-z_][\w.-]*:)?svg(?:[\s>/]|$)/i.test(head) ? 'svg' : 'other'
  }
}

/**
 * Whether a file is SVG, whatever its name says, from its first bytes (`SVG_SNIFF_BYTES` of them, or the whole file):
 * markup whose first element is `<svg` or `<x:svg`, or whose doctype is SVG, in UTF-8 or UTF-16, past a byte-order
 * mark, white space and comments; a gzip file is unpacked first (an `.svgz` under any name). `whole`: `start` is the
 * whole file. A start that is all white space and comments, of a file that goes on past it, counts as SVG: what it
 * hides is not read.
 */
export function looksLikeSvg(start: Buffer, whole: boolean): boolean {
  if (start[0] === 0x1f && start[1] === 0x8b) {
    let unpacked: Buffer
    try {
      unpacked = gunzipSync(start.subarray(0, GZIP_SNIFF_BYTES), { finishFlush: zlib.Z_SYNC_FLUSH, maxOutputLength: 8 * 1024 * 1024 })
    } catch {
      // Not readable as gzip: nothing shows it as a picture either.
      return false
    }
    const root = rootOf(asText(unpacked.subarray(0, SVG_SNIFF_BYTES)))
    return root === 'svg' || (root === 'open' && !(whole && start.length <= GZIP_SNIFF_BYTES && unpacked.length <= SVG_SNIFF_BYTES))
  }
  const root = rootOf(asText(start.subarray(0, SVG_SNIFF_BYTES)))
  return root === 'svg' || (root === 'open' && !(whole && start.length <= SVG_SNIFF_BYTES))
}

/**
 * A file of a bot's chat as another device names it: its place inside the folder of the bot `botId`
 * (`isBotFileRef`), or undefined for a file elsewhere, another bot's folder included. The folder is
 * `<profileHome>/bots/files/<botId>` (`botFilesFolder`), so the place is what follows the first such folder in the
 * file's full path (a folder inside it named alike is part of the place). `bots.chat.file` reads it only inside the
 * folder of the bot it names.
 */
export function botFileRef(path: string, botId: string): string | undefined {
  if (!path) return undefined
  const slashed = path.replaceAll('\\', '/')
  const found = [...slashed.matchAll(/\/bots\/files\/([^/]+)\//g)].find((match) => isBotId(match[1]))
  if (!found || found[1] !== botId) return undefined
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
 * Opens `path` to read, only while it is the plain file inside `root` that was checked: both are real paths (`realpath`,
 * which reads links the way the system does, Windows junctions too). A link put at the name since is not followed
 * (`O_NOFOLLOW` where the system has it), and the open file must be the one at the name (the same device and inode, the
 * name's real path unchanged), so nothing swapped in between the check and the open is read. A file with other names
 * (a hard link, which can be a file outside the folder) is refused. Undefined for a file that is not there (any more).
 */
export async function openInside(root: string, path: string): Promise<{ handle: FileHandle; size: number } | undefined> {
  if (!path.startsWith(root + sep)) return undefined
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return undefined
  }
  try {
    const [opened, named, real] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path)])
    if (!opened.isFile() || !named.isFile() || named.ino !== opened.ino || named.dev !== opened.dev || real !== path) {
      await handle.close()
      return undefined
    }
    if (opened.nlink > 1n) {
      await handle.close()
      throw new NetError('conflict', 'This file has other names on the computer, so it doesn’t open on another device.', { details: { reason: 'linked' } })
    }
    return { handle, size: Number(opened.size) }
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof NetError) throw error
    return undefined
  }
}

const svgRefused = (): never => {
  throw new NetError('conflict', 'SVG files don’t open on another device.', { details: { reason: 'svg' } })
}

/**
 * A page of the file at `ref` inside `folder` (a bot's files folder), for another device. Only a file inside the
 * folder: the path is relative and plain (`isBotFileRef`), the file it reaches after links are followed must still be
 * inside, and it is opened only as that file (`openInside`), so `..`, an absolute path, a link out, a link swapped in
 * and a hard link all read as a file that is not there or is refused. Never SVG, by name or by content
 * (`looksLikeSvg`); at most `REMOTE_BOT_FILE_BYTES`; read in pages of `REMOTE_BOT_FILE_PAGE_BYTES` from `offset`.
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
  if (isSvgName(name) || isSvgName(real)) svgRefused()
  const opened = await openInside(root, real)
  if (!opened) return gone()
  const { handle, size } = opened
  try {
    if (size > REMOTE_BOT_FILE_BYTES) throw new NetError('too_large', `${name} is too large to open here. Open it on the computer.`)
    if (offset > size) throw new NetError('bad_request')
    const head = Buffer.alloc(Math.min(SVG_SNIFF_BYTES, size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    if (looksLikeSvg(head, head.length === size)) svgRefused()
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
