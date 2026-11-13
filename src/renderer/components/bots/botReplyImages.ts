import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { botImageSource, fileNameOf, isImageAttachment, isImageFile } from './imageSources'
import { linkBotPaths } from './botPaths'

/**
 * The pictures of a bot's reply, which the chat shows as a messenger does: above the reply's words, at a good size,
 * several side by side in a carousel. They are the reply's pictures from this computer: the Markdown images in its
 * words (a picture it made is one, `![…](file:///…)`), the paths it names that are pictures, and the pictures it sent
 * as files. Pure: nothing is read here.
 */

/**
 * One picture of a reply: a file of this computer, or a `data:` image. `key` is its path or its URL. `chip`: its path
 * also stays in the words as a chip (a path the reply names), so a picture that can't be read needs nothing more.
 */
export type ReplyImage = { key: string; name: string; chip?: true } & ({ path: string; url?: undefined } | { url: string; path?: undefined })

/** A Markdown image, `![alt](src)` or `![alt](<src> "title")`. */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g
/** A path the chat links as a file (botPaths.ts), in the words after linking. */
const FILE_LINK = /\]\(mousse-file:\/\/open\?path=([^)\s]+)\)/g

/**
 * The reply's pictures, in the order they come (its words first, then its files; each once), and its words without
 * the Markdown images that now show above them. A path to a picture stays in the words as its chip; a web image
 * stays as its link (it never loads); fenced code is left as written.
 */
export function replyImages(message: Pick<BotChatMessage, 'text' | 'attachments'>): { images: ReplyImage[]; text: string } {
  const images: ReplyImage[] = []
  const add = (image: ReplyImage) => {
    const known = images.find((entry) => entry.key === image.key)
    if (known) { if (image.chip) known.chip = true; return }
    images.push(image)
  }
  let fence: string | null = null
  const lines = message.text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null
      return line
    }
    if (marker) {
      fence = marker
      return line
    }
    const kept = line.replace(MARKDOWN_IMAGE, (whole, alt: string, bracketed?: string, bare?: string) => {
      const source = botImageSource(bracketed ?? bare)
      if (source.kind === 'file') add({ key: source.path, path: source.path, name: alt.trim() || fileNameOf(source.path) })
      else if (source.kind === 'data') add({ key: source.url, url: source.url, name: alt.trim() || 'Picture' })
      else return whole
      return ''
    })
    for (const [, encoded] of linkBotPaths(kept).matchAll(FILE_LINK)) {
      let path: string
      try { path = decodeURIComponent(encoded!) } catch { continue }
      if (isImageFile(path)) add({ key: path, path, name: fileNameOf(path), chip: true })
    }
    // A line that held only pictures goes with them.
    return kept.trim() || !line.trim() ? kept : null
  })
  for (const file of message.attachments ?? []) {
    if (file.path && isImageAttachment(file)) add({ key: file.path, path: file.path, name: file.name })
  }
  const text = lines.filter((line): line is string => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { images, text }
}
