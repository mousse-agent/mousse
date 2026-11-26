import { basename } from 'node:path'
import { MAX_BOT_IMAGE_BYTES } from '../../../shared/bots/personal/definition'
import { imageFileStem, imageTypeOf, saveBotPicture } from '../images/pictures'

/**
 * Pictures a tool hands a bot's turn (an MCP tool's image result), shown to the owner as a thread shows them: each is
 * saved in the bot's files folder, under `images/<date>/` as the pictures it makes are (`saveBotPicture`: never through a
 * link out of the folder), and the next message of that activation carries it as a file, so the chat shows it inline and
 * in the preview, and a phone can open it. Only PNG, JPEG, GIF and WebP, checked by their first bytes (never SVG); at
 * most `MAX_BOT_IMAGE_BYTES` each and `MAX_IMAGES_PER_MESSAGE` per message. Kept in memory until a message takes them:
 * after a restart the files stay in the folder, and the bot was told where. A picture that is not kept for its owner (too
 * large, no room left in the message, or not saved) is named in what the bot is told, so it never promises one its owner
 * never sees.
 */

/** Pictures one message shows, leaving room among its files (`MAX_BOT_CHAT_ATTACHMENTS`). */
export const MAX_IMAGES_PER_MESSAGE = 6
/** Activations whose pictures wait for a message; the oldest are let go first. */
const MAX_WAITING_ACTIVATIONS = 64

export interface KeptImage {
  name: string
  path: string
}

const waiting = new Map<string, KeptImage[]>()

/**
 * Keeps the pictures one tool call returned for `activationId`'s next message, saved in `filesFolder`. Returns the line
 * the bot is told (that its owner sees them, and where they are; which ones they don't, and why), or undefined when there
 * is nothing to tell (no picture the chat shows).
 */
export function keepToolImages(input: {
  activationId: string | undefined
  filesFolder: string | undefined
  /** Who returned them, for the file names: "github-screenshot". */
  source: string
  images: ReadonlyArray<{ data: string }>
  now?: Date
}): string | undefined {
  const { activationId, filesFolder } = input
  if (!activationId || !filesFolder || !input.images.length) return undefined
  const held = waiting.get(activationId) ?? []
  const room = MAX_IMAGES_PER_MESSAGE - held.length
  const kept: KeptImage[] = []
  const skipped = { large: 0, room: 0, unsaved: 0 }
  for (const image of input.images) {
    const bytes = Buffer.from(image.data, 'base64')
    const type = imageTypeOf(bytes)
    // Not a picture the chat shows (an SVG): never one, so nothing to tell.
    if (!type) continue
    if (bytes.length > MAX_BOT_IMAGE_BYTES) skipped.large += 1
    else if (kept.length >= room) skipped.room += 1
    else {
      try {
        const path = saveBotPicture(filesFolder, imageFileStem(input.source), type, bytes, input.now ?? new Date())
        kept.push({ name: basename(path), path })
      } catch {
        // Not saved (a link out of the folder, a full disk): the bot still sees it; the owner doesn't.
        skipped.unsaved += 1
      }
    }
  }
  if (kept.length) {
    waiting.delete(activationId)
    waiting.set(activationId, [...held, ...kept])
    while (waiting.size > MAX_WAITING_ACTIVATIONS) waiting.delete(waiting.keys().next().value as string)
  }
  const one = kept.length === 1
  const lines = kept.length
    ? [`[Your owner sees ${one ? 'this picture' : `these ${kept.length} pictures`} under your next message, so don't add ${one ? 'it' : 'them'} to it. Saved in your files folder: ${kept.map((image) => image.path).join(', ')}]`]
    : []
  const why = [
    ...(skipped.large ? [`${count(skipped.large)} over ${MAX_BOT_IMAGE_BYTES / (1024 * 1024)} MB`] : []),
    ...(skipped.room ? [`${count(skipped.room)} past the ${MAX_IMAGES_PER_MESSAGE} one message shows`] : []),
    ...(skipped.unsaved ? [`${count(skipped.unsaved)} that could not be saved in your files folder`] : [])
  ]
  if (why.length) lines.push(`[Not saved or shown to your owner: ${why.join('; ')}. Tell them in words what they need from ${skipped.large + skipped.room + skipped.unsaved === 1 ? 'it' : 'them'}.]`)
  return lines.length ? lines.join('\n') : undefined
}

const count = (n: number): string => (n === 1 ? '1 picture' : `${n} pictures`)

/** Whether a reply must carry pictures, even when no tool ledger was recorded. */
export function hasToolImages(activationId: string): boolean {
  return Boolean(waiting.get(activationId)?.length)
}

/** The pictures waiting for `activationId`'s next message, now taken by it. */
export function takeToolImages(activationId: string | undefined): KeptImage[] {
  if (!activationId) return []
  const kept = waiting.get(activationId) ?? []
  waiting.delete(activationId)
  return kept
}

/** Forgets every waiting picture (tests). */
export function resetToolImages(): void {
  waiting.clear()
}
