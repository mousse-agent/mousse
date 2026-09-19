export const MOUSSE_REFERENCE_MIME = 'application/x-mousse-reference'
export const MOUSSE_FILE_SCHEME = 'mousse-file:'

export type ChatReferenceKind = 'file' | 'project' | 'thread' | 'terminal' | 'browser' | 'agent'

export interface ChatReference {
  id: string
  kind: ChatReferenceKind
  title: string
  path?: string
  line?: number
  column?: number
  threadId?: string
  projectId?: string
  tabId?: string
  sessionId?: string
  url?: string
  agentId?: string
  metadataPath?: string
  cwd?: string
}

const KINDS = new Set<ChatReferenceKind>(['file', 'project', 'thread', 'terminal', 'browser', 'agent'])
const MAX_FIELD = 16_384

function cleanString(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean && clean.length <= max ? clean : undefined
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
  if (kind === 'file' && !reference.path) return null
  if (kind === 'browser' && reference.url && !/^https?:\/\//i.test(reference.url) && reference.url !== 'about:blank') return null
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

/** Durable model-facing context. The encoded header lets the UI reconstruct rich pills. */
export function formatChatReferences(references: ChatReference[]): string {
  const valid = references.map(parseChatReference).filter((item): item is ChatReference => Boolean(item))
  if (!valid.length) return ''
  const data = encodeURIComponent(JSON.stringify(valid))
  const lines = valid.flatMap((reference) => {
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
