/** Explicit, offline applet submissions. Ownership and permissions are never model supplied. */
export const APPLET_SOURCE_LIMIT = 512 * 1024
export const APPLET_STATE_LIMIT = 64 * 1024
export const APPLETS_PER_MESSAGE = 3
export interface AppletSubmission {
  schemaVersion: 1
  title: string
  description: string
  html: string
  css: string
  js: string
  data?: unknown
  stateVersion: number
  appletId?: string
  expectedRevision?: string
}
export interface AppletReference {
  appletId: string
  revisionId: string
  sourceHash: string
  title: string
  description: string
}
export interface AppletBundle extends AppletReference {
  schemaVersion: 1
  source: AppletSubmission
  threadId: string
  messageId: string
  turnId: string
  createdAt: string
  runtimePolicyVersion: 1
  previousRevisionId?: string
}
export type AppletPresentationPart =
  { type: 'text'; text: string } | { type: 'applet'; reference: AppletReference }
export type AppletExtractedPart =
  | { type: 'text'; text: string }
  | { type: 'submission'; submission: AppletSubmission }
  | { type: 'error'; message: string; source: string }
export class AppletValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppletValidationError'
  }
}
export function appletJsonBytes(value: unknown): number {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new AppletValidationError('Applet data must be JSON serializable.')
  }
  if (json === undefined) throw new AppletValidationError('Applet data must be JSON serializable.')
  return new TextEncoder().encode(json).length
}
/** Lengths that follow the frame's height: the frame grows to fit the page, so the page would grow with it. */
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.#])[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([sld]?(?:vh|vb|vmin|vmax))(?![\w-])/i
const FULL_HEIGHT = /(?:^|;)\s*((?:min-)?height\s*:\s*100%)/i
/** True when a selector's last compound is the page root or body (`html`, `body.dark`, `:root[data-x]`). */
function selectsPage(selector: string): boolean {
  const last = selector.trim().split(/[\s>+~]+/).at(-1) ?? ''
  return /^(?:html|body|:root)(?![\w-])/i.test(last)
}
/** Finds what sizes the applet to its frame in CSS text: a viewport-height unit, or a full height on html or body. */
function viewportSizing(css: string): string | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const unit = VIEWPORT_HEIGHT_UNIT.exec(text)
  if (unit) return unit[0].trim()
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!rule[1].split(',').some(selectsPage)) continue
    const full = FULL_HEIGHT.exec(rule[2])
    if (full) return `${rule[1].trim()} { ${full[1]} }`
  }
  return null
}
/** A quoted piece of source in a message, kept short: the message goes back to the model, which has the source. */
const shown = (text: string): string => (text.length > 60 ? text.slice(0, 59) + '…' : text)
/**
 * New applets may not size themselves to the frame. Published applets that already do still load and render; the
 * page's height report ignores changes that only follow the frame. JavaScript that sets such sizes is not checked.
 */
function rejectViewportSizing(source: { html: string; css: string }): void {
  const found: string[] = []
  const inCss = viewportSizing(source.css)
  if (inCss) found.push(`"${shown(inCss)}" in css`)
  for (const block of source.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const inHtml = viewportSizing(block[1])
    if (inHtml) found.push(`"${shown(inHtml)}" in a <style> element`)
  }
  for (const tag of source.html.matchAll(/<([a-z][\w-]*)\b[^>]*?\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const style = tag[2].replace(/^["']|["']$/g, '')
    const unit = VIEWPORT_HEIGHT_UNIT.exec(style)
    const full = /^(?:html|body)$/i.test(tag[1]) ? FULL_HEIGHT.exec(style) : null
    if (unit) found.push(`"${shown(unit[0].trim())}" in a style attribute`)
    else if (full) found.push(`"${shown(full[1])}" on <${shown(tag[1].toLowerCase())}>`)
  }
  if (found.length)
    throw new AppletValidationError(
      `Applet sizes itself to the viewport (${found.slice(0, 3).join(', ')}). The applet frame grows to fit its content, so vh, svh, lvh, dvh, vmin and vmax units, and height or min-height 100% on html or body, would make it grow without end. Use content-driven heights or pixel heights instead.`
    )
}
/**
 * `publishing` is set where a new applet enters the thread (the publish tool and a completed reply's fences). Loading,
 * recovering and exporting an applet already published leave it unset, so older applets keep working.
 */
export function validateAppletSubmission(
  value: unknown,
  { publishing = false }: { publishing?: boolean } = {}
): AppletSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppletValidationError('Applet must be a JSON object.')
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'schemaVersion',
    'title',
    'description',
    'html',
    'css',
    'js',
    'data',
    'stateVersion',
    'appletId',
    'expectedRevision'
  ])
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new AppletValidationError('Applet contains unsupported fields.')
  if (input.schemaVersion !== 1)
    throw new AppletValidationError('Unsupported applet schema version.')
  for (const field of ['title', 'description', 'html', 'css', 'js']) {
    if (typeof input[field] !== 'string')
      throw new AppletValidationError(`Applet ${field} must be text.`)
  }
  if (
    !(input.title as string).trim() ||
    (input.title as string).length > 120 ||
    (input.description as string).length > 1000
  )
    throw new AppletValidationError('Applet title or description is too long or empty.')
  const stateVersion = input.stateVersion ?? 1
  if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1)
    throw new AppletValidationError('Invalid applet state version.')
  const id = /^[a-zA-Z0-9_-]{1,80}$/
  for (const field of ['appletId', 'expectedRevision'])
    if (
      input[field] !== undefined &&
      (typeof input[field] !== 'string' || !id.test(input[field] as string))
    )
      throw new AppletValidationError(`Invalid applet ${field}.`)
  if (Boolean(input.appletId) !== Boolean(input.expectedRevision))
    throw new AppletValidationError('Applet updates need both appletId and expectedRevision.')
  if (appletJsonBytes(input) > APPLET_SOURCE_LIMIT)
    throw new AppletValidationError('Applet exceeds the 512 KiB source limit.')
  if (publishing) rejectViewportSizing(input as { html: string; css: string })
  // Clone to reject circular data and detach caller-owned objects from durable publication.
  return JSON.parse(JSON.stringify({ ...input, stateVersion })) as AppletSubmission
}
/**
 * Call with complete=false during streaming: all source remains inert text. `publishing` applies the checks for a new
 * applet (see validateAppletSubmission); recovering an earlier reply leaves it off.
 */
export function extractAppletParts(
  content: string,
  complete: boolean,
  options: { publishing?: boolean } = {}
): AppletExtractedPart[] {
  if (!complete) return [{ type: 'text', text: content }]
  const parts: AppletExtractedPart[] = []
  // Consume every fence, including unterminated ordinary fences, before looking for applets.
  const openings = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/gm
  let cursor = 0
  let count = 0
  let opening: RegExpExecArray | null
  while ((opening = openings.exec(content))) {
    const marker = opening[1]
    const closing = new RegExp(`^${marker[0]}{${marker.length},}[ \t]*(?:\\r?\\n|$)`, 'gm')
    closing.lastIndex = openings.lastIndex
    const end = closing.exec(content)
    if (!end) break
    const bodyStart = openings.lastIndex
    openings.lastIndex = end.index + end[0].length
    if (opening[2].trim() !== 'mousse-applet') continue
    const start = opening.index
    if (start > cursor) parts.push({ type: 'text', text: content.slice(cursor, start) })
    try {
      if (++count > APPLETS_PER_MESSAGE)
        throw new AppletValidationError('Only three applets are allowed per message.')
      parts.push({
        type: 'submission',
        submission: validateAppletSubmission(JSON.parse(content.slice(bodyStart, end.index)), options)
      })
    } catch (error) {
      parts.push({
        type: 'error',
        message:
          error instanceof AppletValidationError ? error.message : 'Applet contains invalid JSON.',
        source: content.slice(start, openings.lastIndex)
      })
    }
    cursor = openings.lastIndex
  }
  if (cursor < content.length || parts.length === 0)
    parts.push({ type: 'text', text: content.slice(cursor) })
  return parts
}
/**
 * The line that stands for an applet where a model reads a reply (a handoff, a run's result, `thread_read`): its source
 * stays in the applet store, where `read_applet` reads it, and is never repeated into another model's context.
 */
export function appletReferenceLine(applet: { title: string; appletId?: string; revisionId?: string }): string {
  // One line, with no fence marker: a title's own line breaks would start lines that could read as a code fence, and a
  // run of three backticks or tildes would read as one when the line is redacted again.
  const title = applet.title.replace(/([`~])\1{2,}/g, '$1$1').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
  return applet.appletId && applet.revisionId
    ? `[Applet: ${title} (appletId ${applet.appletId}, revision ${applet.revisionId})]`
    : `[Applet: ${title}]`
}
/** The applets a reply's stored parts show as published, in order. */
export function publishedApplets(parts: unknown): AppletReference[] {
  if (!Array.isArray(parts)) return []
  return (parts as AppletPresentationPart[]).flatMap((part) => (part?.type === 'applet' && part.reference ? [part.reference] : []))
}
/**
 * A stored reply as a model reads it: the text the model wrote with every applet fence cut (`redactAppletFences`),
 * each published applet named by its reference line. The stored text keeps its fences, which recovery and a bot's chat
 * match on. The stored parts are not read as text: publication adds to them, which could end a cut early.
 */
export function modelFacingReplyText(message: { role?: unknown; content?: unknown; presentationParts?: unknown }): string {
  const content = typeof message.content === 'string' ? message.content : ''
  // A person's message never publishes an applet: a fence pasted there is what they wrote, kept for the model to read.
  return message.role === 'user' ? content : redactAppletFences(content, publishedApplets(message.presentationParts))
}
/** The marker of the code block `text` leaves open, as `extractAppletParts` reads blocks, if any. */
function openCodeBlock(text: string): string | undefined {
  const probe = text.endsWith('\n') ? text : text + '\n'
  const openings = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/gm
  let opening: RegExpExecArray | null
  while ((opening = openings.exec(probe))) {
    const marker = opening[1]
    const closing = new RegExp(`^${marker[0]}{${marker.length},}[ \t]*(?:\\r?\\n|$)`, 'gm')
    closing.lastIndex = openings.lastIndex
    const end = closing.exec(text)
    if (!end) return marker
    openings.lastIndex = end.index + end[0].length
  }
  return undefined
}
/**
 * Where an applet fence may open, read more widely than publication reads one: anywhere on a line (a stopped run's
 * rows can join without a line break), any case, any spacing. It is tried only where a run of backticks or tildes
 * starts, and the run is taken whole, so a long run is scanned once.
 */
const APPLET_OPENING = /(?:(?<!`)(`{3,})(?!`)|(?<!~)(~{3,})(?!~))[^\S\r\n]*mousse-applet(?![\w-])/gi
/** The fences in one cut whose bodies are read for a title; the rest are named `[Applet]`. */
const TITLED_FENCES = 10

/** A cut fence as its body names it: a title if it is a JSON object with one, and whether it has all three parts. */
interface CutFence {
  title?: string
  whole: boolean
}

/** What an applet fence's body gives (`CutFence`): a body that is not a JSON object stays unnamed. */
function readFence(body: string): CutFence {
  try {
    const value = JSON.parse(body) as Record<string, unknown> | null
    const title = typeof value?.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 200) : undefined
    return { title, whole: Boolean(value && ['html', 'css', 'js'].every((part) => typeof value[part] === 'string')) }
  } catch {
    return { whole: false }
  }
}

/** One stretch of text `redactAppletFences` cuts: the fences that open in it, and whether it closes. */
interface AppletCut {
  start: number
  end: number
  fences: CutFence[]
  closed: boolean
}

/**
 * The stretches of `text` that hold applet fences, read so that no reading of the text leaves an applet's source
 * out. It ignores other code blocks (an applet inside one is still cut), counts, sizes and validity. A fence ends at the
 * first line, after a line break, of its marker at least as long (publication also ends one after U+2028, U+2029 or
 * `\r`, never later), or at the end of the text; a fence opening inside a stretch extends it to its own end.
 */
function appletCuts(text: string): AppletCut[] {
  if (!/mousse-applet/i.test(text)) return []
  const opening = new RegExp(APPLET_OPENING.source, APPLET_OPENING.flags)
  // The first closing line at or after a position, by marker, so a cut with many fences scans the text once per marker.
  const closings = new Map<string, { from: number; close: RegExpExecArray | null }>()
  const closingAfter = (marker: string, from: number): RegExpExecArray | null => {
    const known = closings.get(marker)
    if (known && known.from <= from && (!known.close || known.close.index >= from)) return known.close
    const closing = new RegExp(`(?<=\\n)${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|(?![\\s\\S]))`, 'g')
    closing.lastIndex = from
    const close = closing.exec(text)
    closings.set(marker, { from, close })
    return close
  }
  const cuts: AppletCut[] = []
  let next = opening.exec(text)
  while (next) {
    const cut: AppletCut = { start: next.index, end: next.index, fences: [], closed: true }
    do {
      const lineEnd = text.indexOf('\n', next.index + next[0].length)
      const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1
      const close = closingAfter(next[1] ?? next[2]!, bodyStart)
      cut.fences.push(cut.fences.length < TITLED_FENCES ? readFence(text.slice(bodyStart, close ? close.index : text.length)) : { whole: false })
      if (!close) cut.closed = false
      cut.end = Math.max(cut.end, close ? close.index + close[0].length : text.length)
      opening.lastIndex = next.index + next[0].length
      next = cut.end < text.length ? opening.exec(text) : null
    } while (next && next.index < cut.end)
    cuts.push(cut)
  }
  return cuts
}

/**
 * `text` with every applet fence cut out (`appletCuts`) and one line naming each in its place (`[Applet: title]`, or
 * `[Applet]` when no title can be read), for a reader that gets the applet's name but never its source: a run's
 * result, a handoff, `thread_read`. It fails closed, unlike publication, which refuses what it cannot read.
 * `published` are the applets the text published, in order: a cut fence with all three parts and the next one's title
 * is named by its reference line, and any left unnamed follow the text. With `from`, only the text from there on is returned, read as
 * part of the whole: a fence opened before `from` is still cut (a turn's last row, read after the rows before it).
 */
export function redactAppletFences(text: string, published: readonly AppletReference[] = [], from = 0): string {
  const references = published.map(appletReferenceLine)
  let out = ''
  let cursor = from
  let used = 0
  for (const cut of appletCuts(text)) {
    if (cut.end <= from) continue
    const lines = cut.fences.map(({ title, whole }) => {
      if (title === undefined) return '[Applet]'
      if (whole && used < published.length && published[used]!.title.trim().slice(0, 200) === title) return references[used++]!
      return appletReferenceLine({ title })
    })
    // A cut that took its closing line's break gives the naming lines one.
    out += text.slice(cursor, Math.max(cursor, cut.start)) + lines.join('\n') + (text[cut.end - 1] === '\n' ? '\n' : '')
    cursor = cut.end
  }
  out += text.slice(cursor)
  return used < references.length ? [out, ...references.slice(used)].filter(Boolean).join('\n\n') : out
}

/**
 * `text`, a reply, with `fences` (applets a tool staged) after everything the model wrote, so they never fall inside
 * an applet fence as `redactAppletFences` reads one, where their closing lines could end its cut early. A code block
 * the reply leaves open is closed first, or the fences would be text inside it; one an applet fence leaves open is not,
 * so an applet the model left unfinished is never published.
 */
/** The stretches of `text` `redactAppletFences` cuts, for a change to the text that must leave them whole. */
export function appletFenceSpans(text: string): Array<{ start: number; end: number }> {
  return appletCuts(text).map(({ start, end }) => ({ start, end }))
}

/**
 * `tail`, the end of `whole` (a turn's last row after the rows before it, joined as they streamed), with its applet
 * fences cut as part of `whole`: a fence an earlier row opened is still cut. A `tail` that is not the end of `whole` is
 * cut on its own.
 */
export function redactAppletTail(whole: string, tail: string): string {
  const text = whole.trimEnd()
  const end = tail.trim()
  return end && text.endsWith(end) ? redactAppletFences(text, [], text.length - end.length) : redactAppletFences(tail)
}

export function appendStagedApplets(text: string, fences: string): string {
  if (!fences) return text
  const open = openCodeBlock(text)
  if (!open || appletCuts(text).some((cut) => !cut.closed)) return text + fences
  return (text.endsWith('\n') ? text : text + '\n') + open + fences
}
