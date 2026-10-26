export const MOUSSE_REFERENCE_MIME = 'application/x-mousse-reference'
export const MOUSSE_FILE_SCHEME = 'mousse-file:'

export type ChatReferenceKind = 'file' | 'project' | 'thread' | 'terminal' | 'browser' | 'agent' | 'review-comment'

export interface ChatReference {
  id: string
  kind: ChatReferenceKind
  title: string
  path?: string
  line?: number
  /** Last line of a `review-comment` range; absent for a single line. */
  endLine?: number
  column?: number
  /** `review-comment` text the user wrote. */
  comment?: string
  /** `review-comment` selected lines of the modified side, capped (see `capReviewExcerpt`). */
  excerpt?: string
  /** Version a `review-comment` was made on: `turn:<turnId>`, `thread`, `worktree:staged` or `worktree:unstaged`. */
  reviewScope?: string
  /** Human label of `reviewScope` for the agent and the pill: "Turn 3" or "Working tree". */
  scopeLabel?: string
  threadId?: string
  projectId?: string
  tabId?: string
  sessionId?: string
  url?: string
  agentId?: string
  metadataPath?: string
  cwd?: string
}

const KINDS = new Set<ChatReferenceKind>(['file', 'project', 'thread', 'terminal', 'browser', 'agent', 'review-comment'])
const MAX_FIELD = 16_384
export const REVIEW_COMMENT_MAX_CHARS = 4_096
const REVIEW_EXCERPT_MAX_INPUT = 8_192
export const REVIEW_EXCERPT_MAX_LINES = 40
export const REVIEW_EXCERPT_MAX_CHARS = 4_096
const EXCERPT_MARKER = '…'
/** Turn ids are Run Engine run ids (`run:thread:<encoded>:ordinal:<n>`), so they contain colons and percent escapes. */
const REVIEW_SCOPE_RE = /^(turn:[^\s\]]{1,256}|thread|worktree:(staged|unstaged))$/

function cleanString(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean && clean.length <= max ? clean : undefined
}

/**
 * Strips control characters other than `\n` and `\t`, and rewrites any line that starts like a block
 * marker so the text cannot end the `[Mousse references]` block early. Idempotent. The rewrite adds a
 * character per line, so lengths must be checked on the result, not the input.
 */
export function neutralizeBlockMarkers(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/^\[(\/?Mousse references)/, '[ $1'))
    .join('\n')
}

/**
 * Multi-line text for `comment` and `excerpt`: see `neutralizeBlockMarkers`. Does not trim; callers
 * decide what whitespace is meaningful. Rejects input longer than `maxInput`. The result can be
 * longer than the input (the marker rewrite adds characters), so callers cut it to their own limit.
 */
function cleanText(value: unknown, maxInput: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxInput) return undefined
  return neutralizeBlockMarkers(value)
}

/** Cuts an excerpt to `REVIEW_EXCERPT_MAX_LINES` lines and `REVIEW_EXCERPT_MAX_CHARS` characters, ending with a `…` marker line when cut. Idempotent. */
export function capReviewExcerpt(excerpt: string): string {
  let text = excerpt
  let cut = false
  if (text === EXCERPT_MARKER || text.endsWith(`\n${EXCERPT_MARKER}`)) {
    text = text.slice(0, text.length - EXCERPT_MARKER.length).replace(/\n$/, '')
    cut = true
  }
  let lines = text.split('\n')
  if (lines.length > REVIEW_EXCERPT_MAX_LINES) {
    lines = lines.slice(0, REVIEW_EXCERPT_MAX_LINES)
    cut = true
  }
  text = lines.join('\n')
  if (text.length > REVIEW_EXCERPT_MAX_CHARS) {
    text = text.slice(0, REVIEW_EXCERPT_MAX_CHARS)
    // Drop the partial last line so the cut falls on a line boundary when there is one.
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak > 0) text = text.slice(0, lastBreak)
    cut = true
  }
  return cut ? `${text}\n${EXCERPT_MARKER}` : text
}

/** The turn id inside a `turn:<turnId>` review scope, or undefined for other scopes. */
export function turnIdOfScope(reviewScope: string | undefined): string | undefined {
  if (!reviewScope?.startsWith('turn:')) return undefined
  return reviewScope.slice('turn:'.length) || undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Validate untrusted drag/persisted data and retain only the documented fields. */
export function parseChatReference(value: unknown): ChatReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!KINDS.has(raw.kind as ChatReferenceKind)) return null
  const title = cleanString(raw.title, 512)
  if (!title) return null
  const kind = raw.kind as ChatReferenceKind
  const reference: ChatReference = {
    id: cleanString(raw.id, 256) ?? `${kind}:${crypto.randomUUID()}`,
    kind,
    title
  }
  for (const key of ['path', 'threadId', 'projectId', 'tabId', 'sessionId', 'url', 'agentId', 'metadataPath', 'cwd'] as const) {
    const clean = cleanString(raw[key])
    if (clean) reference[key] = clean
  }
  reference.line = positiveInteger(raw.line)
  reference.column = positiveInteger(raw.column)
  if (kind === 'review-comment') {
    const endLine = positiveInteger(raw.endLine)
    if (endLine !== undefined && reference.line !== undefined && endLine >= reference.line) reference.endLine = endLine
    // Cut after the marker rewrite so the stored comment stays within the limit and parses again unchanged.
    const comment = cleanText(raw.comment, REVIEW_COMMENT_MAX_CHARS)?.slice(0, REVIEW_COMMENT_MAX_CHARS).trim()
    if (comment) reference.comment = comment
    // An over-long excerpt is cut by `capReviewExcerpt`, not dropped: only its first characters are read.
    const rawExcerpt = typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, REVIEW_EXCERPT_MAX_INPUT) : undefined
    const excerpt = cleanText(rawExcerpt, Infinity)?.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
    if (excerpt) reference.excerpt = capReviewExcerpt(excerpt)
    // Tested on the raw value: cleaning would turn "turn:a\nb" into a different, valid-looking scope.
    if (typeof raw.reviewScope === 'string' && REVIEW_SCOPE_RE.test(raw.reviewScope)) reference.reviewScope = raw.reviewScope
    const scopeLabel = cleanString(raw.scopeLabel, 128)
    if (scopeLabel) reference.scopeLabel = scopeLabel
    if (!reference.path || !reference.line || !reference.comment || !reference.reviewScope) return null
  }
  if (kind === 'file' && !reference.path) return null
  if (kind === 'project' && !reference.projectId) return null
  if (kind === 'thread' && !reference.threadId) return null
  if (kind === 'terminal' && !reference.tabId) return null
  if (kind === 'agent' && !reference.agentId) return null
  if (kind === 'browser') {
    if (!reference.url) return null
    if (!/^https?:\/\//i.test(reference.url) && reference.url !== 'about:blank') return null
  }
  return reference
}

export function parseReferenceDragData(dataTransfer: Pick<DataTransfer, 'getData'>): ChatReference | null {
  const encoded = dataTransfer.getData(MOUSSE_REFERENCE_MIME)
  if (!encoded || encoded.length > 64 * 1024) return null
  try { return parseChatReference(JSON.parse(encoded)) } catch { return null }
}

export function setReferenceDragData(dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>, reference: Omit<ChatReference, 'id'> & { id?: string }): void {
  const parsed = parseChatReference({ ...reference, id: reference.id ?? `${reference.kind}:${crypto.randomUUID()}` })
  if (!parsed) return
  dataTransfer.effectAllowed = 'copyMove'
  dataTransfer.setData(MOUSSE_REFERENCE_MIME, JSON.stringify(parsed))
  dataTransfer.setData('text/plain', parsed.title)
}

const BLOCK_RE = /\n?\[Mousse references data="([^"]+)"\]\n[\s\S]*?\n\[\/Mousse references\]\s*/g

function contextPath(reference: ChatReference): string | undefined {
  return reference.metadataPath ?? reference.path ?? reference.cwd
}

function fenceFor(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function reviewCommentLines(reference: ChatReference): string[] {
  const { line = 0, endLine, path, comment = '', excerpt } = reference
  const [first = '', ...rest] = comment.split('\n')
  const lines = [
    `- review-comment: ${JSON.stringify(reference.title)}`,
    path ? `  Path: ${path}` : '',
    endLine && endLine > line ? `  Lines: ${line}–${endLine}` : `  Line: ${line}`,
    reference.scopeLabel || reference.reviewScope ? `  Scope: ${reference.scopeLabel ?? reference.reviewScope}` : '',
    `  Comment: ${first}`,
    ...rest.map((text) => `    ${text}`)
  ]
  if (excerpt) {
    const fence = fenceFor(excerpt)
    const extension = path?.match(/\.([A-Za-z0-9+#_-]{1,16})$/)?.[1]?.toLowerCase() ?? ''
    lines.push(`  Selected code:`, `${fence}${extension}`, excerpt, fence)
  }
  return lines.filter(Boolean)
}

/**
 * Durable model-facing context. The encoded header lets the UI reconstruct rich pills.
 * It carries every field of every reference, so a review comment's text and excerpt appear twice
 * in the message: once readable in the body, once encoded in the header. The header copy is what
 * rebuilds the pill, so do not drop fields from it to save space.
 */
export function formatChatReferences(references: ChatReference[]): string {
  const valid = references.map(parseChatReference).filter((item): item is ChatReference => Boolean(item))
  if (!valid.length) return ''
  const data = encodeURIComponent(JSON.stringify(valid))
  const lines = valid.flatMap((reference) => {
    if (reference.kind === 'review-comment') return reviewCommentLines(reference)
    const details = [
      `- ${reference.kind}: ${JSON.stringify(reference.title)}`,
      contextPath(reference) ? `  Path: ${contextPath(reference)}` : '',
      reference.url ? `  URL: ${reference.url}` : '',
      reference.threadId ? `  Thread ID: ${reference.threadId}` : '',
      reference.projectId ? `  Project ID: ${reference.projectId}` : '',
      reference.sessionId ? `  Session ID: ${reference.sessionId}` : '',
      reference.agentId ? `  Agent ID: ${reference.agentId}` : '',
      reference.line ? `  Location: line ${reference.line}${reference.column ? `, column ${reference.column}` : ''}` : ''
    ]
    return details.filter(Boolean)
  })
  return `[Mousse references data="${data}"]\n${lines.join('\n')}\n[/Mousse references]`
}

export function extractChatReferences(content: string): { text: string; references: ChatReference[] } {
  const references: ChatReference[] = []
  const text = content.replace(BLOCK_RE, (_block, encoded: string) => {
    try {
      const values = JSON.parse(decodeURIComponent(encoded))
      if (Array.isArray(values)) {
        for (const value of values.slice(0, 100)) {
          const parsed = parseChatReference(value)
          if (parsed) references.push(parsed)
        }
      }
    } catch { /* malformed context remains hidden, never executable */ }
    return '\n'
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text, references }
}

/** Canonical agent-authored link format: mousse-file://open?path=<encoded>&line=12&column=3 */
export function formatMousseFileLink(path: string, line?: number, column?: number): string {
  const query = new URLSearchParams({ path })
  if (line && line > 0) query.set('line', String(Math.floor(line)))
  if (column && column > 0) query.set('column', String(Math.floor(column)))
  return `mousse-file://open?${query.toString()}`
}

export function parseMousseFileLink(href: string): { path: string; line?: number; column?: number } | null {
  if (!href.toLowerCase().startsWith('mousse-file://')) return null
  try {
    const url = new URL(href)
    if (url.hostname !== 'open') return null
    const path = cleanString(url.searchParams.get('path'))
    if (!path) return null
    return {
      path,
      line: positiveInteger(Number(url.searchParams.get('line'))),
      column: positiveInteger(Number(url.searchParams.get('column')))
    }
  } catch { return null }
}

function joinReviewPath(root: string, path: string): string {
  // The shared module has no `process`: the separator follows the shape of the daemon's root string.
  const windows = root.includes('\\') || /^[A-Za-z]:/.test(root)
  const separator = windows ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '').replace(/[\\/]/g, separator)
  const relative = path.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)
  return `${base}${separator}${relative}`
}

/** A review comment on lines of a changed file; `path` is relative to `root`, and the reference carries the absolute path. */
export function createReviewComment(input: {
  root: string
  path: string
  line: number
  endLine?: number
  comment: string
  excerpt?: string
  reviewScope: string
  scopeLabel?: string
}): ChatReference {
  const { root, path, line, endLine, reviewScope, scopeLabel } = input
  // The composer drops a reference that fails to parse without a trace, so a bad scope fails here instead.
  if (!REVIEW_SCOPE_RE.test(reviewScope)) throw new Error(`Invalid review scope: ${JSON.stringify(reviewScope)}`)
  const name = path.split(/[\\/]/).pop() || path
  const hasRange = endLine !== undefined && endLine > line
  return {
    id: `review-comment:${crypto.randomUUID()}`,
    kind: 'review-comment',
    title: `${name}:${line}${hasRange ? `-${endLine}` : ''}`,
    path: joinReviewPath(root, path),
    line,
    ...(hasRange ? { endLine } : {}),
    // Neutralise before cutting: the marker rewrite adds characters, and the parser checks the cleaned length.
    comment: neutralizeBlockMarkers(input.comment).slice(0, REVIEW_COMMENT_MAX_CHARS).trim(),
    ...(input.excerpt ? { excerpt: capReviewExcerpt(input.excerpt) } : {}),
    reviewScope,
    ...(scopeLabel ? { scopeLabel } : {})
  }
}

/** Whether two paths name the same file. `platform` is `appInfo.platform`; Windows paths compare case-insensitively. */
export function sameReviewFile(a: string, b: string, platform: string): boolean {
  const normalize = (value: string) => {
    const slashed = value.replace(/\\/g, '/')
    return platform === 'win32' ? slashed.toLowerCase() : slashed
  }
  return normalize(a) === normalize(b)
}
