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
/**
 * New applets may not size themselves to the frame. Published applets that already do still load and render; the
 * page's height report ignores changes that only follow the frame. JavaScript that sets such sizes is not checked.
 */
function rejectViewportSizing(source: { html: string; css: string }): void {
  const found: string[] = []
  const inCss = viewportSizing(source.css)
  if (inCss) found.push(`"${inCss}" in css`)
  for (const block of source.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const inHtml = viewportSizing(block[1])
    if (inHtml) found.push(`"${inHtml}" in a <style> element`)
  }
  for (const tag of source.html.matchAll(/<([a-z][\w-]*)\b[^>]*?\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const style = tag[2].replace(/^["']|["']$/g, '')
    const unit = VIEWPORT_HEIGHT_UNIT.exec(style)
    const full = /^(?:html|body)$/i.test(tag[1]) ? FULL_HEIGHT.exec(style) : null
    if (unit) found.push(`"${unit[0].trim()}" in a style attribute`)
    else if (full) found.push(`"${full[1]}" on <${tag[1].toLowerCase()}>`)
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
