/**
 * Inline attachment chips in a sent message (#1823). Where the composer showed an attachment's or a reference's chip in
 * the text, the sent text names it in brackets at that place, so the agent reads which file is meant where:
 * `compare [image 1: before.png] with [file: after.tsx]`. An image the agent receives inline is named with its place
 * among the message's images; a file sent as a path, and a reference, by its kind and name (the message's
 * `[Attached files: …]` marker and references block carry the paths). The sent bubble draws each one that names an
 * attachment of the message as its chip again (`sentAttachmentChips`).
 */

/** What a sent chip names: an inline image (with its place, from 1), a file sent as a path, or a reference of a kind. */
export type SentChipKind = 'image' | 'file' | 'folder' | 'project' | 'thread' | 'terminal' | 'browser' | 'agent'

export interface SentChip {
  kind: SentChipKind
  name: string
  /** An inline image's place among the message's images, from 1. */
  image?: number
}

const KINDS = ['image', 'file', 'folder', 'project', 'thread', 'terminal', 'browser', 'agent'] as const

/** A name as it goes between the brackets: on one line, without brackets or the composer's invisible marks. */
export function sentChipName(name: string): string {
  return name
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatSentChip(chip: SentChip): string {
  const name = sentChipName(chip.name)
  if (!name) return ''
  const kind = chip.kind === 'image' && chip.image ? `image ${chip.image}` : chip.kind
  return `[${kind}: ${name}]`
}

const SENT_CHIP = new RegExp(String.raw`\[(${KINDS.join('|')})(?: (\d{1,3}))?: ([^\]\n]{1,300})\]`, 'g')

export interface SentChipSpan extends SentChip {
  index: number
  length: number
}

/** Every bracketed chip in `text`, in order; whether one names an attachment of the message is for the caller to say. */
export function findSentChips(text: string): SentChipSpan[] {
  if (!text.includes('[')) return []
  const spans: SentChipSpan[] = []
  for (const match of text.matchAll(SENT_CHIP)) {
    const kind = match[1] as SentChipKind
    // Only an image has a place: `[file 2: x]` is text.
    if (match[2] && kind !== 'image') continue
    const name = match[3]!.trim()
    if (!name) continue
    spans.push({ index: match.index, length: match[0].length, kind, name, ...(match[2] ? { image: Number(match[2]) } : {}) })
  }
  return spans
}
