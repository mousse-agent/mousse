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

/** `text` with each marker replaced by what `replace` returns for its entries. */
export function replaceAttachedFilesMarkers(text: string, replace: (entries: AttachedFileEntry[]) => string): string {
  return text.replace(MARKER, (_match, list?: string, legacy?: string) => replace(parseAttachedFilesList(list ?? legacy ?? '')))
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
