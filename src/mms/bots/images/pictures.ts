import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/** The pictures in a bot's files folder: the ones it makes (`BotImageMaker`) and the ones a tool hands its turn (`keepToolImages`). */

/** The owner's local day of `at`, as YYYY-MM-DD. */
export function dayOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..'))
}

/** The type a picture's first bytes say it is, among those the chat shows; undefined for anything else. */
export function imageTypeOf(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | 'gif' | undefined {
  const at = (index: number) => bytes[index]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) return 'gif'
  return undefined
}

/** A file name from the description's first words: lower case letters and digits, joined by dashes, at most 40. */
export function imageFileStem(prompt: string): string {
  const words = prompt.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
  let stem = ''
  for (const word of words) {
    const next = stem ? `${stem}-${word}` : word
    if (next.length > 40) break
    stem = next
  }
  return stem.replace(/[^a-z0-9-]/g, '') || 'picture'
}

/**
 * Saves `bytes` under `<files folder>/images/<date>/` as `<stem>-<time>.<type>`, as a new file: never over an existing
 * one, and never through a link out of the bot's files folder (its real path is checked, and the file is created only if
 * nothing is there). A picture the bot made, or one a tool handed its turn (`keepToolImages`).
 */
export function saveBotPicture(files: string, stem: string, type: string, bytes: Uint8Array, now: Date): string {
  mkdirSync(files, { recursive: true })
  const root = realpathSync.native(files)
  // The files folder itself is the bot's own, where Mousse keeps it: not a link to another place.
  if (root !== join(realpathSync.native(dirname(files)), basename(files))) throw new Error('the files folder is not where Mousse keeps it')
  // One folder at a time, each checked before anything is made inside it: a link out of the files folder makes nothing.
  let folder = root
  for (const part of ['images', dayOf(now)]) {
    const next = join(folder, part)
    if (!existsSync(next)) mkdirSync(next)
    folder = realpathSync.native(next)
    if (!inside(root, folder)) throw new Error('the images folder leads out of the files folder')
  }
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const base = `${stem}-${time}`
  for (let n = 1; n < 100; n += 1) {
    const path = join(folder, `${base}${n > 1 ? `-${n}` : ''}.${type}`)
    let fd: number
    try {
      // `wx`: created only if nothing (a file or a link) is there.
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    return path
  }
  throw new Error('too many pictures with the same name')
}
