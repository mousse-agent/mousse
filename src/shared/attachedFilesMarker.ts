/**
 * The `[Attached files: …]` marker a sent message carries for its non-image files. The model reads each file's
 * path from it: `[Attached files: a.mp4 (C:\clips\a.mp4), b.pdf (/tmp/b.pdf)]`. Messages from before paths were
 * added name the files only: `[Attached files: a.mp4, b.pdf]`.
 */
export interface AttachedFileEntry {
  name: string
  /** Absolute path on the computer the thread's agent runs on; absent in a name-only (older) marker. */
  path?: string
}

/** The largest pasted file a thread's composer copies to a temporary file (a dropped or picked one has its own path). */
export const MAX_STAGED_FILE_BYTES = 200 * 1024 * 1024

export function stagedFileTooLargeText(name: string): string {
  return `${name} is larger than ${MAX_STAGED_FILE_BYTES / 1024 / 1024} MB. Drop or attach the file instead of pasting it.`
}

/** An absolute path's start: `C:\` or `C:/`, `\\server`, or `/`. */
const ABSOLUTE = String.raw`(?:[A-Za-z]:[\\/]|\\\\|/)`
/** One `name (path)` entry: the path runs to the `)` that ends the list or comes before the next entry. */
const ENTRY = new RegExp(String.raw`(.+?) \((${ABSOLUTE}.*?)\)(?=, .+? \(${ABSOLUTE}|$)`, 'y')
/**
 * A marker. The composer writes it as its own paragraph, so it ends at a `]` that ends the line, which lets a path
 * hold `]` (a second marker on the line is not swallowed). An older marker written inside a line ends at its first `]`.
 */
const MARKER = /\[Attached files: ((?:(?!\[Attached files: ).)*?)\](?=[ \t]*(?:\r?\n|$))|\[Attached files: ([^\]\n]+)\]/g

/** Text in a marker stays on one line, so a name can never end the marker early. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ')

export function formatAttachedFilesMarker(entries: readonly AttachedFileEntry[]): string {
  if (!entries.length) return ''
  return `[Attached files: ${entries.map(({ name, path }) => (path ? `${oneLine(name)} (${path})` : oneLine(name))).join(', ')}]`
}

/** The entries of a marker's list, `name (path)` ones when every entry has a path, else names split at `, `. */
export function parseAttachedFilesList(list: string): AttachedFileEntry[] {
  const entries: AttachedFileEntry[] = []
  let at = 0
  while (at < list.length) {
    ENTRY.lastIndex = at
    const match = ENTRY.exec(list)
    if (!match) break
    entries.push({ name: match[1]!.trim(), path: match[2]! })
    at = ENTRY.lastIndex
    if (list.startsWith(', ', at)) at += 2
  }
  if (entries.length && at >= list.length) return entries
  return list.split(', ').map((name) => name.trim()).filter(Boolean).map((name) => ({ name }))
}

/** A fenced code block's opening line: three or more backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/**
 * `text` cut into the parts outside fenced code blocks and the blocks themselves. A marker is never inside a block:
 * one there is text the person pasted, such as a log quoting a message.
 */
function fencedParts(text: string): Array<{ text: string; fenced: boolean }> {
  const parts: Array<{ text: string; fenced: boolean }> = []
  const lines = text.split(/(?<=\n)/)
  let outside = ''
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]!)
    if (!open) {
      outside += lines[i]
      continue
    }
    const fence = open[1]!
    const closes = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*\r?\n?$`)
    let end = i + 1
    while (end < lines.length && !closes.test(lines[end]!)) end += 1
    if (outside) parts.push({ text: outside, fenced: false })
    outside = ''
    parts.push({ text: lines.slice(i, end + 1).join(''), fenced: true })
    i = end
  }
  if (outside) parts.push({ text: outside, fenced: false })
  return parts
}

/** `text` with each marker replaced by what `replace` returns for its entries; fenced code blocks are left alone. */
export function replaceAttachedFilesMarkers(text: string, replace: (entries: AttachedFileEntry[]) => string): string {
  if (!text.includes('[Attached files: ')) return text
  return fencedParts(text)
    .map((part) => part.fenced ? part.text : part.text.replace(MARKER, (_match, list?: string, legacy?: string) => replace(parseAttachedFilesList(list ?? legacy ?? ''))))
    .join('')
}

/** Every file the markers in `text` name, in order. */
export function attachedFilesIn(text: string): AttachedFileEntry[] {
  const entries: AttachedFileEntry[] = []
  replaceAttachedFilesMarkers(text, (found) => {
    entries.push(...found)
    return ''
  })
  return entries
}
