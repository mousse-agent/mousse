import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import type { LightboxImage } from '../../chat/components/agent-elements/image-lightbox'
import { markdownImages } from '../../chat/components/agent-elements/image-sources'
import { isAbsolutePath } from '../../utils/filesBrowse'

/**
 * The images of a bot's chat: the owner's attached photos and screenshots, files from the bot's work and images in
 * its replies. Only raster types show (PNG, JPEG, GIF, WebP): never SVG, which can carry scripts. A file on this
 * computer is read through the Files panel's own preview path (`fs.readAsset`); a `data:` image shows as it is. A
 * remote image never loads (it would tell its server who read the chat and when): it shows as a link instead.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
/** The types an image file must turn out to be once read. */
export const SHOWN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i

export type BotImageSource =
  | { kind: 'data'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'link'; url: string }
  | { kind: 'blocked' }

/** True when a file name or path ends in a type the chat shows as a picture. */
export function isImageFile(name: string): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase()
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension)
}

const decoded = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** A local image path from a `file:` URL or a full path; null for anything else (network shares included). */
function localPath(src: string): string | null {
  let path: string | null = src
  if (/^file:/i.test(src)) {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return null
    }
    if (url.host && url.host !== 'localhost') return null
    path = decoded(url.pathname)
    // file:///C:/photo.png names C:/photo.png.
    if (path && /^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1)
  } else {
    // Markdown escapes a path's spaces and other characters (%20).
    path = decoded(src)
  }
  if (!path || path.includes('\0') || /^[\\/]{2}/.test(path) || !isAbsolutePath(path)) return null
  return isImageFile(path) ? path : null
}

/** What an image's `src` in a bot chat may show as. */
export function botImageSource(src: string | undefined | null): BotImageSource {
  const value = src?.trim() ?? ''
  if (!value) return { kind: 'blocked' }
  if (/^data:/i.test(value)) return DATA_IMAGE.test(value) ? { kind: 'data', url: value } : { kind: 'blocked' }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'link', url: url.toString() } : { kind: 'blocked' }
    } catch {
      return { kind: 'blocked' }
    }
  }
  const path = localPath(value)
  return path ? { kind: 'file', path } : { kind: 'blocked' }
}

/** The last part of a path, for a tooltip and the preview's label. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

type BotFile = NonNullable<BotChatMessage['attachments']>[number]

/** An attached file shows as a picture when its copy (or, before it is sent, its name) is an image type. */
export const isImageAttachment = (file: BotFile): boolean => isImageFile(file.path || file.name)

/**
 * Every image the chat shows, in display order, for the shared preview's Previous and Next: an owner's message shows
 * its attached images above its words, a bot's its words (with their images) above the files it sent. A file's
 * image is in the set once it has been read (`fileUrl`); the same image twice is in it once, where it first shows.
 * An image's id is its path, or its `data:` URL, as its tile opens it.
 */
export function botChatImages(messages: readonly BotChatMessage[], fileUrl: (path: string) => string | undefined): LightboxImage[] {
  const images: LightboxImage[] = []
  const fromFiles = (message: BotChatMessage) => {
    for (const file of message.attachments ?? []) {
      if (!file.path || !isImageAttachment(file)) continue
      const url = fileUrl(file.path)
      if (url) images.push({ id: file.path, url, filename: file.name })
    }
  }
  const fromText = (message: BotChatMessage) => {
    for (const { src, alt } of markdownImages(message.text)) {
      const source = botImageSource(src)
      if (source.kind === 'data') images.push({ id: source.url, url: source.url, filename: alt })
      else if (source.kind === 'file') {
        const url = fileUrl(source.path)
        if (url) images.push({ id: source.path, url, filename: alt ?? fileNameOf(source.path) })
      }
    }
  }
  for (const message of messages) {
    if (message.author === 'owner') {
      fromFiles(message)
      fromText(message)
    } else {
      fromText(message)
      fromFiles(message)
    }
  }
  const seen = new Set<string>()
  return images.filter((image) => !seen.has(image.id) && Boolean(seen.add(image.id)))
}
