import { basename } from 'node:path'
import { MAX_BOT_IMAGE_BYTES } from '../../../shared/bots/personal/definition'
import { imageFileStem, imageTypeOf, saveBotPicture } from '../images/pictures'

/**
 * Pictures a tool hands a bot's turn (an MCP tool's image result), shown to the owner as a thread shows them: each is
 * saved in the bot's files folder, under `images/<date>/` as the pictures it makes are (`saveBotPicture`: never through a
 * link out of the folder), and the next message of that activation carries it as a file, so the chat shows it inline and
 * in the preview, and a phone can open it. Only PNG, JPEG, GIF and WebP, checked by their first bytes (never SVG); at
 * most `MAX_BOT_IMAGE_BYTES` each and `MAX_IMAGES_PER_MESSAGE` per message. Kept in memory until a message takes them:
 * after a restart the files stay in the folder, and the bot was told where.
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
 * the bot is told (that its owner sees them, and where they are), or undefined when nothing was kept.
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
  for (const image of input.images) {
    if (kept.length >= room) break
    const bytes = Buffer.from(image.data, 'base64')
    const type = imageTypeOf(bytes)
    if (!type || bytes.length > MAX_BOT_IMAGE_BYTES) continue
    try {
      const path = saveBotPicture(filesFolder, imageFileStem(input.source), type, bytes, input.now ?? new Date())
      kept.push({ name: basename(path), path })
    } catch {
      // Not saved (a link out of the folder, a full disk): the bot still sees it; the owner doesn't.
    }
  }
  if (!kept.length) return undefined
  waiting.delete(activationId)
  waiting.set(activationId, [...held, ...kept])
  while (waiting.size > MAX_WAITING_ACTIVATIONS) waiting.delete(waiting.keys().next().value as string)
  const one = kept.length === 1
  return `[Your owner sees ${one ? 'this picture' : `these ${kept.length} pictures`} under your next message, so don't add ${one ? 'it' : 'them'} to it. Saved in your files folder: ${kept.map((image) => image.path).join(', ')}]`
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
