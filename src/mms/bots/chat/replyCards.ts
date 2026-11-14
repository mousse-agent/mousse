import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, relative } from 'node:path'
import { MAX_BOT_IMAGE_BYTES } from '../../../shared/bots/personal/definition'
import { cardsProblem, type BotCard, type BotGalleryCard } from '../../../shared/bots/personal/cards'
import { imageTypeOf } from '../images/pictures'

/**
 * Cards a bot's turn made with `show_card` (issue #1123), kept for the activation's next message as the pictures a tool
 * hands a turn are (`toolImages.ts`): its reply, or its work's report. In memory only: after a restart the turn that made
 * them has ended, and its message was posted without them. At most `MAX_CARDS_PER_MESSAGE` and `MAX_CARDS_JSON_BYTES`
 * per message (`cardsProblem`).
 */

/** Activations whose cards wait for a message; the oldest are let go first. */
const MAX_WAITING_ACTIVATIONS = 64

const waiting = new Map<string, BotCard[]>()

/** Keeps `card` for `activationId`'s next message; why not, when that message holds as many cards as it can. */
export function keepReplyCard(activationId: string, card: BotCard): { kept: true } | { problem: string } {
  const held = waiting.get(activationId) ?? []
  const problem = cardsProblem([...held, card])
  if (problem) return { problem }
  waiting.delete(activationId)
  waiting.set(activationId, [...held, card])
  while (waiting.size > MAX_WAITING_ACTIVATIONS) waiting.delete(waiting.keys().next().value as string)
  return { kept: true }
}

/** Whether cards wait for `activationId`'s next message. */
export function hasReplyCards(activationId: string | undefined): boolean {
  return Boolean(activationId && waiting.get(activationId)?.length)
}

/** The cards waiting for `activationId`'s next message, now taken by it. */
export function takeReplyCards(activationId: string | undefined): BotCard[] {
  if (!activationId) return []
  const kept = waiting.get(activationId) ?? []
  waiting.delete(activationId)
  return kept
}

/** Lets go of an activation's waiting cards (it ended with no message to carry them). */
export function dropReplyCards(activationId: string): void {
  waiting.delete(activationId)
}

/** Forgets every waiting card (tests). */
export function resetReplyCards(): void {
  waiting.clear()
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..`)
}

/**
 * A picture a gallery shows, as its full path inside the bot's files folder (`filesFolder`), or why not. A path may be
 * full, a `file://` address, or relative to the folder; links are followed, and the file they reach must be inside the
 * folder, a PNG, JPEG, GIF or WebP by its first bytes (never SVG) and at most `MAX_BOT_IMAGE_BYTES`. Checked when the
 * card is made and again whenever the picture is read (`bots.chat.attachment`).
 */
export function galleryPicture(filesFolder: string, given: string): { path: string } | { problem: string } {
  let path = given.trim()
  try {
    if (/^file:\/\//i.test(path)) path = fileURLToPath(path)
  } catch {
    return { problem: `${given} is not a file path.` }
  }
  const full = isAbsolute(path) ? path : join(filesFolder, path)
  let real: string
  let root: string
  try {
    root = realpathSync.native(filesFolder)
    real = realpathSync.native(full)
  } catch {
    return { problem: `${given} is not in your files folder.` }
  }
  if (!inside(root, real)) return { problem: `${given} is outside your files folder. A gallery shows pictures from your files folder only.` }
  let fd: number | undefined
  try {
    const stat = statSync(real)
    if (!stat.isFile()) return { problem: `${given} is not a file.` }
    if (stat.size > MAX_BOT_IMAGE_BYTES) return { problem: `${given} is too large to show.` }
    fd = openSync(real, 'r')
    const head = Buffer.alloc(16)
    const read = readSync(fd, head, 0, head.length, 0)
    if (!imageTypeOf(head.subarray(0, read))) return { problem: `${given} is not a PNG, JPEG, GIF or WebP picture.` }
  } catch {
    return { problem: `${given} can't be read.` }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { path: real }
}

/** A gallery with each picture checked (`galleryPicture`) and named by its full path; any other card as it is. */
export function checkedCard(filesFolder: string, card: BotCard): BotCard | { problem: string } {
  if (card.type !== 'gallery') return card
  const files: BotGalleryCard['files'] = []
  for (const file of card.files) {
    const found = galleryPicture(filesFolder, file.path)
    if ('problem' in found) return found
    if (!files.some((kept) => kept.path === found.path)) files.push({ ...file, path: found.path })
  }
  return { ...card, files }
}
