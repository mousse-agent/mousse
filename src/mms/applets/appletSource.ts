import { AppletValidationError, type AppletSubmission } from '../../shared/applets'

/**
 * Revising and reading an applet's stored source, so an agent never needs the source in its context: a revision sends
 * small edits against the revision it read, and a read returns one bounded page of one part.
 */

export const APPLET_PARTS = ['html', 'css', 'js'] as const
export type AppletPart = (typeof APPLET_PARTS)[number]

/** Characters `read_applet` returns by default, and at most. */
export const APPLET_READ_DEFAULT_CHARS = 16 * 1024
export const APPLET_READ_MAX_CHARS = 64 * 1024
/**
 * Bytes of source one read returns at most, as the tool's JSON result carries it (UTF-8, escapes included), so a page of
 * wide characters (CJK, emoji) or of escaped ones (tabs, quotes) is no larger than one of plain ASCII.
 */
export const APPLET_READ_MAX_BYTES = 64 * 1024
const SEARCH_MAX_MATCHES = 20
const SEARCH_CONTEXT_LINES = 2
/** At most this much text per match; all the matches together stay within `APPLET_READ_MAX_BYTES`. */
const SEARCH_EXCERPT_CHARS = 3 * 1024
/** The longest text a search looks for: enough to find an edit's old_str, and the result repeats it. */
export const APPLET_SEARCH_MAX_CHARS = 1024

const isPart = (value: unknown): value is AppletPart => (APPLET_PARTS as readonly unknown[]).includes(value)

const isPairAt = (text: string, at: number): boolean =>
  at + 1 < text.length && (text.charCodeAt(at) & 0xfc00) === 0xd800 && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00

/** The bytes one character takes in a JSON string: `\t`, `\"` and `\\` take two, other control characters and a lone surrogate `\uXXXX`. */
function jsonBytes(text: string, at: number): number {
  const code = text.charCodeAt(at)
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if ((code & 0xf800) === 0xd800) return isPairAt(text, at) ? 4 : 6
  return 3
}

/** The bytes `text` takes in a JSON string (`jsonBytes`). */
function jsonLength(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at += isPairAt(text, at) ? 2 : 1) bytes += jsonBytes(text, at)
  return bytes
}

/**
 * Where a page from `start` ends: at most `chars` characters and `bytes` bytes as JSON carries them, never inside a
 * surrogate pair, and never empty (a pair at `start` is returned whole even when `chars` is 1).
 */
function pageEnd(text: string, start: number, chars: number, bytes: number): number {
  const last = Math.min(text.length, start + chars)
  let end = start
  let used = 0
  while (end < text.length) {
    const pair = isPairAt(text, end)
    const size = jsonBytes(text, end)
    const next = end + (pair ? 2 : 1)
    if (end > start && (next > last || used + size > bytes)) break
    used += size
    end = next
  }
  return end
}

/** How many times `needle` occurs in `text`, counting no further than two. */
function occurrences(text: string, needle: string): number {
  const first = text.indexOf(needle)
  if (first < 0) return 0
  return text.indexOf(needle, first + 1) < 0 ? 1 : 2
}

/**
 * The parts after `edits`, applied in order to `base`'s parts, all or none. Each edit replaces a text that occurs
 * exactly once in its part as the earlier edits left it; an error names the edit by its position.
 */
export function applyAppletEdits(base: Pick<AppletSubmission, AppletPart>, edits: unknown): Record<AppletPart, string> {
  if (!Array.isArray(edits) || edits.length === 0) throw new AppletValidationError('edits must list at least one edit.')
  const parts: Record<AppletPart, string> = { html: base.html, css: base.css, js: base.js }
  edits.forEach((edit, index) => {
    const name = `Edit ${index + 1}`
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new AppletValidationError(`${name} must be an object with part, old_str and new_str.`)
    const { part, old_str: oldText, new_str: newText, ...rest } = edit as Record<string, unknown>
    if (Object.keys(rest).length) throw new AppletValidationError(`${name} has unsupported fields: ${Object.keys(rest).join(', ')}.`)
    if (!isPart(part)) throw new AppletValidationError(`${name} part must be html, css or js.`)
    if (typeof oldText !== 'string' || !oldText) throw new AppletValidationError(`${name} (${part}) old_str must be non-empty text.`)
    if (typeof newText !== 'string') throw new AppletValidationError(`${name} (${part}) new_str must be text.`)
    const count = occurrences(parts[part], oldText)
    if (count === 0) throw new AppletValidationError(`${name} (${part}): old_str was not found. Read the part with read_applet and copy the text exactly.`)
    if (count > 1) throw new AppletValidationError(`${name} (${part}): old_str occurs more than once. Include more of the surrounding text so it matches once.`)
    const at = parts[part].indexOf(oldText)
    parts[part] = parts[part].slice(0, at) + newText + parts[part].slice(at + oldText.length)
  })
  return parts
}

/**
 * The full submission a `publish_applet` call with `edits` stands for: the edited parts of `base` (the revision named by
 * `expectedRevision`), with each other field given in `args` or else `base`'s. Validation is the caller's, as for any
 * submission.
 */
export function appletRevisionFromEdits(args: Record<string, unknown>, base: AppletSubmission): Record<string, unknown> {
  for (const key of ['html', 'css', 'js', 'htmlPath', 'cssPath', 'jsPath'])
    if (args[key] !== undefined) throw new AppletValidationError(`Give edits or ${key}, not both: edits change the stored parts.`)
  const { edits, ...rest } = args
  const parts = applyAppletEdits(base, edits)
  return {
    // A version the call gives is validated like any submission's, not replaced.
    schemaVersion: rest.schemaVersion === undefined ? 1 : rest.schemaVersion,
    title: rest.title ?? base.title,
    description: rest.description ?? base.description,
    ...parts,
    ...('data' in rest ? (rest.data === undefined ? {} : { data: rest.data }) : base.data === undefined ? {} : { data: base.data }),
    stateVersion: rest.stateVersion ?? base.stateVersion,
    appletId: rest.appletId,
    expectedRevision: rest.expectedRevision
  }
}

const lineCount = (text: string): number => (text ? text.split('\n').length : 0)

/**
 * One bounded read of a revision's source. With no part: the parts' sizes, to choose what to read. With `search`: the
 * lines of the part that contain it, with line numbers and a little context, to copy an edit's old_str without reading
 * the whole part. Otherwise: `limit` characters from `offset` (and at most `APPLET_READ_MAX_BYTES`), with where the next page starts.
 */
export function readAppletSource(
  source: AppletSubmission,
  args: { part?: unknown; offset?: unknown; limit?: unknown; search?: unknown }
): Record<string, unknown> {
  if (args.part === undefined) {
    if (args.search !== undefined || args.offset !== undefined) throw new AppletValidationError('Name a part (html, css or js) to read or search.')
    return {
      parts: Object.fromEntries(APPLET_PARTS.map((part) => [part, { chars: source[part].length, lines: lineCount(source[part]) }])),
      ...(source.data !== undefined ? { dataChars: JSON.stringify(source.data, null, 2).length } : {}),
      stateVersion: source.stateVersion,
      hint: 'Read a part with part (and offset/limit for long ones), or find text in it with search.'
    }
  }
  if (!isPart(args.part) && args.part !== 'data') throw new AppletValidationError('part must be html, css, js or data.')
  const text = args.part === 'data' ? (source.data === undefined ? '' : JSON.stringify(source.data, null, 2)) : source[args.part]
  if (args.search !== undefined) {
    if (typeof args.search !== 'string' || !args.search) throw new AppletValidationError('search must be non-empty text.')
    if (args.search.length > APPLET_SEARCH_MAX_CHARS) throw new AppletValidationError(`search must be at most ${APPLET_SEARCH_MAX_CHARS} characters.`)
    const lines = text.split('\n')
    const matches: Array<{ line: number; column?: number; text: string }> = []
    let total = 0
    let bytes = 0
    let full = false
    for (let index = 0; index < lines.length; index += 1) {
      const column = lines[index]!.indexOf(args.search)
      if (column < 0) continue
      total += 1
      if (full || matches.length >= SEARCH_MAX_MATCHES) continue
      const from = Math.max(0, index - SEARCH_CONTEXT_LINES)
      const to = Math.min(lines.length, index + SEARCH_CONTEXT_LINES + 1)
      const context = lines.slice(from, to).join('\n')
      // A minified part can be one long line: a long excerpt is cut around the match, so the match is always in it.
      const hit = lines.slice(from, index).reduce((at, line) => at + line.length + 1, 0) + column
      let start = context.length <= SEARCH_EXCERPT_CHARS ? 0 : Math.max(0, Math.min(hit - SEARCH_EXCERPT_CHARS / 2, context.length - SEARCH_EXCERPT_CHARS))
      // Neither end cuts a surrogate pair, so the excerpt can be copied into an edit as it is.
      if (start > 0 && isPairAt(context, start - 1)) start -= 1
      let end = Math.min(context.length, start + SEARCH_EXCERPT_CHARS)
      if (end < context.length && isPairAt(context, end - 1)) end += 1
      const excerpt = context.slice(start, end)
      // Wide or escaped characters make an excerpt several times its length in bytes: the matches stop at one page's bytes.
      const size = jsonLength(excerpt)
      if (bytes + size > APPLET_READ_MAX_BYTES) {
        full = true
        continue
      }
      bytes += size
      matches.push({ line: index + 1, ...(start ? { column: column + 1 } : {}), text: excerpt })
    }
    return { part: args.part, search: args.search, matches, totalMatches: total, ...(total > matches.length ? { truncated: true } : {}) }
  }
  const offset = args.offset === undefined ? 0 : args.offset
  const limit = args.limit === undefined ? APPLET_READ_DEFAULT_CHARS : args.limit
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new AppletValidationError('offset must be a whole number of characters, 0 or more.')
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > APPLET_READ_MAX_CHARS)
    throw new AppletValidationError(`limit must be between 1 and ${APPLET_READ_MAX_CHARS} characters.`)
  if ((offset as number) > 0 && (offset as number) >= text.length) throw new AppletValidationError(`offset ${offset} is past the end of ${args.part}, which has ${text.length} characters.`)
  // An offset inside a surrogate pair starts at the pair, so the page never begins with half a character.
  const start = (offset as number) > 0 && isPairAt(text, (offset as number) - 1) ? (offset as number) - 1 : (offset as number)
  const end = pageEnd(text, start, limit as number, APPLET_READ_MAX_BYTES)
  return {
    part: args.part,
    offset: start,
    totalChars: text.length,
    text: text.slice(start, end),
    ...(end < text.length ? { nextOffset: end } : {})
  }
}
