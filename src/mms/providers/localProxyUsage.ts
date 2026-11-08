import { isIP } from 'node:net'
import type { ProviderUsage, ProviderUsageWindow } from '../../shared/providerAuth'
import { claudeLimitWindows } from '../harness/vendors/claude/usage'

/**
 * Plan limits of a Claude sign-in that runs through a local CLI-to-API proxy (CLIProxyAPI): when
 * Claude Code's base URL points at one on this computer or the private network, its management API
 * lists the proxy's Claude sign-ins and reads each one's account usage with the proxy's own
 * credential (`api-call` with `$TOKEN$`). Mousse never sees those credentials; it needs only the
 * management key the user set in Claude's environment. Nothing here runs for any other address.
 */

export const LOCAL_PROXY_SOURCE = 'via local proxy'
export const PROXY_LIMITS_UNAVAILABLE = 'Limits unavailable (proxy)'
/** Where the management key is read from: Claude's environment and settings, first one set wins. */
export const PROXY_KEY_VARIABLES = ['CLIPROXY_MANAGEMENT_KEY', 'CLI_PROXY_API_MANAGEMENT_KEY', 'MANAGEMENT_PASSWORD'] as const
/** What CLIProxyAPI answers on `GET /`. */
const PROXY_ROOT_MESSAGE = 'CLI Proxy API Server'
/** The account usage the proxy reads for a Claude sign-in (the request its own control panel sends). */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const PROXY_DETECT_TIMEOUT_MS = 1_500
export const PROXY_READ_TIMEOUT_MS = 5_000
/** The longest a whole read may take, every sign-in included, whether or not the caller set a limit. */
export const PROXY_TOTAL_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_ACCOUNTS = 4
const DETECT_CACHE_MS = 60_000

export type ProxyFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; text(): Promise<string> }>

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * A literal loopback, private, link-local or unique-local address, or exactly `localhost` (which the
 * system resolves from its hosts file). No other name counts, not even `*.localhost`: a name a DNS
 * server answers could point anywhere, and could change between the check and the request.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost') return true
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (kind === 6) {
    if (host === '::1') return true
    // An IPv4 address mapped into IPv6, dotted (`::ffff:127.0.0.1`) or in hex as a URL writes it (`::ffff:7f00:1`).
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    if (dotted) return isLocalHost(dotted[1]!)
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (hex) {
      const high = parseInt(hex[1]!, 16)
      const low = parseInt(hex[2]!, 16)
      return isLocalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  return false
}

/** The origin of `baseUrl` when it is an http(s) address on this computer or the private network. */
export function localProxyOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  return isLocalHost(url.hostname) ? url.origin : undefined
}

/**
 * The platform's fetch, reading at most {@link MAX_BODY_BYTES} of a reply: a longer one is dropped
 * without being read to its end, so a local server cannot fill the daemon's memory.
 */
export const cappedFetch: ProxyFetch = async (url, init) => {
  const response = await fetch(url, init)
  return {
    status: response.status,
    async text() {
      const reader = response.body?.getReader()
      if (!reader) return ''
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new Error('Reply too large')
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
  }
}

async function request(fetchImpl: ProxyFetch, url: string, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  // A caller that already gave up sends nothing.
  signal?.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    // Never follows a redirect: the key goes to the checked address only.
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' })
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) return { status: response.status, body: undefined }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch {
      return { status: response.status, body: undefined }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** Whether CLIProxyAPI answers at `origin` (its root says so); any failure or other answer is no. */
export async function detectCliProxy(origin: string, fetchImpl: ProxyFetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    const { status, body } = await request(fetchImpl, `${origin}/`, { method: 'GET', headers: { Accept: 'application/json' } }, options.timeoutMs ?? PROXY_DETECT_TIMEOUT_MS, options.signal)
    return status === 200 && isRecord(body) && body.message === PROXY_ROOT_MESSAGE
  } catch {
    return false
  }
}

export interface ProxyClaudeAccount {
  authIndex: string
  label?: string
}

/** The proxy's enabled Claude sign-ins from its credential list (`{ files: [...] }`, or a bare list). */
export function claudeProxyAccounts(value: unknown): ProxyClaudeAccount[] {
  const list = Array.isArray(value) ? value : isRecord(value) ? (value.files ?? value.credentials) : undefined
  if (!Array.isArray(list)) return []
  const accounts: ProxyClaudeAccount[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const provider = [item.provider, item.type].find((entry): entry is string => typeof entry === 'string')
    if (!provider || !/^(claude|anthropic)$/i.test(provider.trim())) continue
    if (item.disabled === true || item.unavailable === true) continue
    const index = item.auth_index ?? item.authIndex
    const authIndex = typeof index === 'number' && Number.isFinite(index) ? String(index) : typeof index === 'string' ? index.trim() : ''
    if (!authIndex || authIndex.length > 128) continue
    const label = [item.email, item.label, item.account].find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 128)
    accounts.push({ authIndex, ...(label ? { label: label.trim() } : {}) })
    if (accounts.length >= MAX_ACCOUNTS) break
  }
  return accounts
}

/** The upstream answer inside an `api-call` reply (`{ status_code, body }`, the body as text or JSON). */
export function proxyApiCallBody(value: unknown): { status: number; body: unknown } | undefined {
  if (!isRecord(value) || typeof value.status_code !== 'number') return undefined
  let body: unknown = value.body
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES) return { status: value.status_code, body: undefined }
    try {
      body = JSON.parse(body) as unknown
    } catch {
      body = undefined
    }
  }
  return { status: value.status_code, body }
}

/** The windows of one account's Claude usage reply; several accounts are told apart by their label. */
export function proxyClaudeWindows(body: unknown, account: ProxyClaudeAccount, index: number, several: boolean): ProviderUsageWindow[] {
  if (!isRecord(body)) return []
  const name = account.label ?? `account ${index + 1}`
  return claudeLimitWindows(body).map((window) => several ? { ...window, id: `${index}:${window.id}`, label: `${window.label} · ${name}` } : window)
}

export type ProxyUsage = Pick<ProviderUsage, 'status' | 'windows' | 'message' | 'source'>

export interface ProxyUsageOptions {
  /** Claude Code's base URL as it runs (environment and settings). */
  baseUrl: string | undefined
  /** The management key from Claude's environment, if the user set one. */
  managementKey: string | undefined
  fetch?: ProxyFetch
  signal?: AbortSignal
  timeouts?: { detectMs?: number; readMs?: number; totalMs?: number }
  now?: () => number
}

const detected = new Map<string, { at: number; proxy: boolean }>()

/** Forgets earlier detections (tests). */
export function resetLocalProxyDetection(): void {
  detected.clear()
}

async function isProxy(origin: string, options: ProxyUsageOptions, fetchImpl: ProxyFetch): Promise<boolean> {
  const now = options.now?.() ?? Date.now()
  const cached = detected.get(origin)
  if (cached && now - cached.at < DETECT_CACHE_MS) return cached.proxy
  const proxy = await detectCliProxy(origin, fetchImpl, { timeoutMs: options.timeouts?.detectMs, signal: options.signal })
  // A read the caller gave up on found nothing out: the next one asks again.
  if (!options.signal?.aborted) detected.set(origin, { at: now, proxy })
  return proxy
}

/** Tries the current management API's path and, when that one is not there, the older one. */
async function management(fetchImpl: ProxyFetch, origin: string, key: string, paths: [v8: string, v0: string], init: { method: string; body?: string }, options: ProxyUsageOptions) {
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
  const timeoutMs = options.timeouts?.readMs ?? PROXY_READ_TIMEOUT_MS
  const first = await request(fetchImpl, `${origin}/v8/management${paths[0]}`, { ...init, headers }, timeoutMs, options.signal)
  if (first.status !== 404) return first
  return request(fetchImpl, `${origin}/v0/management${paths[1]}`, { ...init, headers }, timeoutMs, options.signal)
}

/**
 * The Claude limits a local proxy reads for its sign-ins, or undefined when the base URL is not a
 * CLIProxyAPI on this computer or the private network (the caller keeps its own answer then).
 * A proxy that cannot tell (no key, refused, no Claude sign-in, no numbers) is "Limits unavailable".
 */
export async function readLocalProxyClaudeUsage(options: ProxyUsageOptions): Promise<ProxyUsage | undefined> {
  const origin = localProxyOrigin(options.baseUrl)
  if (!origin) return undefined
  const fetchImpl = options.fetch ?? cappedFetch
  if (!(await isProxy(origin, options, fetchImpl))) return undefined
  const unavailable = (message: string = PROXY_LIMITS_UNAVAILABLE): ProxyUsage => ({ status: 'unavailable', windows: [], message, source: LOCAL_PROXY_SOURCE })
  const key = options.managementKey?.trim()
  if (!key) return unavailable(`${PROXY_LIMITS_UNAVAILABLE}. Set ${PROXY_KEY_VARIABLES[0]} to show them.`)
  const deadline = AbortSignal.timeout(options.timeouts?.totalMs ?? PROXY_TOTAL_TIMEOUT_MS)
  const reads: ProxyUsageOptions = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline }
  try {
    const listed = await management(fetchImpl, origin, key, ['/credentials', '/auth-files'], { method: 'GET' }, reads)
    if (listed.status !== 200) return unavailable()
    const accounts = claudeProxyAccounts(listed.body)
    if (!accounts.length) return unavailable()
    const several = accounts.length > 1
    const windows: ProviderUsageWindow[] = []
    for (const [index, account] of accounts.entries()) {
      const call = {
        auth_index: account.authIndex,
        method: 'GET',
        url: CLAUDE_USAGE_URL,
        header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }
      }
      const reply = await management(fetchImpl, origin, key, ['/requests/api-call', '/api-call'], { method: 'POST', body: JSON.stringify(call) }, reads)
      const upstream = reply.status === 200 ? proxyApiCallBody(reply.body) : undefined
      if (upstream?.status === 200) windows.push(...proxyClaudeWindows(upstream.body, account, index, several))
    }
    return windows.length ? { status: 'available', windows, source: LOCAL_PROXY_SOURCE } : unavailable()
  } catch {
    // A timeout or a dropped connection: the proxy is there but said nothing usable.
    return unavailable()
  }
}
