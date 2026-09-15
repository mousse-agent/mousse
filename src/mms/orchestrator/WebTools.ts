import { Type, type Tool } from '@earendil-works/pi-ai'
import type { CredentialStore } from '@earendil-works/pi-ai'

export type WebProvider = 'exa' | 'parallel'
export interface WebToolResult { text: string; isError?: boolean }

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const ENDPOINTS = {
  exa: 'https://api.exa.ai/search',
  parallel: 'https://api.parallel.ai/v1beta/search'
} as const

function credentialKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const field of ['key', 'apiKey', 'api_key']) {
    if (typeof record[field] === 'string' && record[field].trim()) return record[field].trim()
  }
  return undefined
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    }
    return entities[entity.toLowerCase()] ?? match
  })
}

export function htmlToText(html: string): string {
  return decodeEntities(html)
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class WebTools {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the public web using Exa or Parallel. Uses a securely stored provider key when available.',
        parameters: Type.Object({
          query: Type.String({ minLength: 1 }),
          provider: Type.Optional(Type.Union([Type.Literal('exa'), Type.Literal('parallel')])),
          numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 }))
        })
      },
      {
        name: 'web_fetch',
        description: 'Fetch an HTTP(S) URL and return bounded readable text (HTML is converted to plain text).',
        parameters: Type.Object({ url: Type.String({ minLength: 1 }) })
      }
    ]
  }

  isWebTool(name: string): boolean { return name === 'web_search' || name === 'web_fetch' }

  async execute(name: string, args: Record<string, unknown>): Promise<WebToolResult> {
    try {
      if (name === 'web_fetch') return await this.webFetch(String(args.url ?? ''))
      if (name === 'web_search') return await this.webSearch(args)
      return { text: `Unknown web tool: ${name}`, isError: true }
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
  }

  private async resolveProvider(requested: unknown): Promise<{ provider: WebProvider; key?: string }> {
    if (requested === 'exa' || requested === 'parallel') {
      return { provider: requested, key: credentialKey(await this.credentials.read(requested)) }
    }
    for (const provider of ['exa', 'parallel'] as const) {
      const key = credentialKey(await this.credentials.read(provider))
      if (key) return { provider, key }
    }
    return { provider: 'exa' }
  }

  private async webSearch(args: Record<string, unknown>): Promise<WebToolResult> {
    const query = String(args.query ?? '').trim()
    if (!query) return { text: 'query is required', isError: true }
    const { provider, key } = await this.resolveProvider(args.provider)
    const numResults = Math.max(1, Math.min(20, Number(args.numResults) || 10))
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (key) headers[provider === 'exa' ? 'x-api-key' : 'x-api-key'] = key
    const body = provider === 'exa'
      ? { query, numResults, contents: { text: true } }
      : { objective: query, search_queries: [query], max_results: numResults }
    const response = await this.fetchImpl(ENDPOINTS[provider], {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    })
    const text = await this.readBounded(response)
    if (!response.ok) return { text: `${provider} search failed (${response.status}): ${text}`, isError: true }
    return { text }
  }

  private async webFetch(rawUrl: string): Promise<WebToolResult> {
    let url: URL
    try { url = new URL(rawUrl) } catch { return { text: 'A valid URL is required.', isError: true } }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { text: 'Only http: and https: URLs are supported.', isError: true }
    }
    const response = await this.fetchImpl(url, { headers: { accept: 'text/html,text/plain,application/json' }, signal: AbortSignal.timeout(30_000) })
    const contentType = response.headers.get('content-type') ?? ''
    const body = await this.readBounded(response)
    if (!response.ok) return { text: `Fetch failed (${response.status}): ${body}`, isError: true }
    return { text: /text\/html|application\/xhtml\+xml/i.test(contentType) ? htmlToText(body) : body }
  }

  private async readBounded(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 2 MiB limit.')
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response exceeds the 2 MiB limit.') }
      chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(joined)
  }
}
