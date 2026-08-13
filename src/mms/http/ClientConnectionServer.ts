/**
 * OAuth-protected HTTP transport for the public Mousse client protocol.
 *
 * The OAuth repository intentionally owns opaque-token persistence while MMS
 * continues to own all business handlers. `REGEXP_CODE_VERIFIER` is provided
 * by @jmondi/oauth2-server 4.3.7, which is pinned in package.json; its PKCE
 * verifier grammar is used together with the server's S256-only policy.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, chmodSync, existsSync } from 'node:fs'
import { REGEXP_CODE_VERIFIER } from '@jmondi/oauth2-server'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { MousseMainService } from '../MousseMainService'
import { EventSequenceRing } from '../protocol/eventRing'
import { dispatchMethod } from '../protocol/handlers'
import { PROTOCOL_METHODS } from '../protocol/types'

const VERSION = '1.0'
const MAX_BYTES = 1024 * 1024
const RETENTION = 2048
const ACCESS_TTL = 15 * 60_000
const CODE_TTL = 60_000
const REFRESH_IDLE_TTL = 30 * 24 * 60 * 60_000
const REFRESH_ABSOLUTE_TTL = 90 * 24 * 60 * 60_000
const SCOPES = ['mousse:read', 'mousse:chat', 'mousse:write', 'mousse:terminal', 'mousse:settings', 'mousse:admin'] as const
type Scope = (typeof SCOPES)[number]

interface Client { id: string; name: string; redirectUris: string[]; createdAt: string; lastUsedAt: string; approvedAt?: string }
interface Code { hash: string; clientId: string; redirectUri: string; scopes: Scope[]; challenge: string; expiresAt: number; used?: boolean }
interface Grant { id: string; clientId: string; scopes: Scope[]; revoked?: boolean; createdAt: number }
interface Access { hash: string; grantId: string; expiresAt: number; revoked?: boolean }
interface Refresh { hash: string; grantId: string; familyId: string; issuedAt: number; lastUsedAt: number; expiresAt: number; revoked?: boolean }
interface Pending { id: string; clientId: string; redirectUri: string; scopes: Scope[]; state: string; challenge: string; createdAt: number; approvalCode?: string; approved?: boolean; denied?: boolean }
interface Idempotent { grantId: string; key: string; fingerprint: string; expiresAt: number; response: unknown }
interface Store { v: 1; key: string; clients: Client[]; codes: Code[]; grants: Grant[]; access: Access[]; refresh: Refresh[]; pending: Pending[]; idempotent: Idempotent[]; audit: Array<{ at: string; action: string; clientId?: string; grantId?: string }> }

export interface ClientConnectionOptions { host: string; port: number; serverName: string; tlsCertPath?: string; tlsKeyPath?: string; corsOrigins?: string[]; version?: string }
export interface PendingConnection { id: string; clientName: string; redirectUri: string; scopes: Scope[]; createdAt: string }

function token(): string { return randomBytes(32).toString('base64url') }
function now(): number { return Date.now() }
function loopback(host: string): boolean { return host === '::1' || host === '127.0.0.1' || /^127\./.test(host) || host === '::ffff:127.0.0.1' }
function hash(key: string, value: string): string { return createHmac('sha256', key).update(value).digest('base64url') }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
function isScope(v: string): v is Scope { return (SCOPES as readonly string[]).includes(v) }
function granted(scopes: Scope[], required: Scope): boolean { return scopes.includes('mousse:admin') || scopes.includes(required) || (required === 'mousse:read' && (scopes.includes('mousse:chat') || scopes.includes('mousse:write') || scopes.includes('mousse:terminal'))) }

class ConnectionRepository {
  private state: Store
  constructor(private readonly path: string) {
    this.state = this.load()
  }
  private load(): Store {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Store
      if (parsed?.v === 1 && typeof parsed.key === 'string') return parsed
    } catch { /* first use */ }
    return { v: 1, key: token(), clients: [], codes: [], grants: [], access: [], refresh: [], pending: [], idempotent: [], audit: [] }
  }
  /** CLI approval is a separate owner process, so refresh before consuming it. */
  private sync(): void { if (existsSync(this.path)) this.state = this.load() }
  private persist(): void {
    const cutoff = now() - 24 * 60 * 60_000
    this.state.codes = this.state.codes.filter(c => c.expiresAt > now() && !c.used)
    this.state.pending = this.state.pending.filter(p => p.createdAt > now() - 10 * 60_000 && !p.denied)
    this.state.idempotent = this.state.idempotent.filter(i => i.expiresAt > now())
    this.state.audit = this.state.audit.filter(a => Date.parse(a.at) >= cutoff).slice(-2048)
    atomicWriteJsonSync(this.path, this.state)
    try { chmodSync(this.path, 0o600) } catch { /* Windows */ }
  }
  private audit(action: string, clientId?: string, grantId?: string): void { this.state.audit.push({ at: new Date().toISOString(), action, clientId, grantId }) }
  register(name: string, redirectUris: string[]): Client { const c = { id: token(), name, redirectUris, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }; this.state.clients.push(c); this.audit('registration', c.id); this.persist(); return c }
  client(id: string): Client | undefined { return this.state.clients.find(c => c.id === id) }
  request(p: Omit<Pending, 'id' | 'createdAt'>): Pending { const v = { ...p, id: token(), createdAt: now() }; this.state.pending.push(v); this.audit('authorization-request', p.clientId); this.persist(); return v }
  pending(): PendingConnection[] { return this.state.pending.filter(p => !p.approved && !p.denied).map(p => ({ id: p.id, clientName: this.client(p.clientId)?.name ?? 'Unknown client', redirectUri: p.redirectUri, scopes: p.scopes, createdAt: new Date(p.createdAt).toISOString() })) }
  approve(id: string): string { const p = this.state.pending.find(x => x.id === id && !x.denied && x.createdAt > now() - 10 * 60_000); if (!p) throw new Error('Pending authorization request not found or expired'); const code = randomBytes(16).toString('hex'); p.approvalCode = hash(this.state.key, code); this.audit('owner-approval-issued', p.clientId); this.persist(); return code }
  finalize(id: string, code: string, approved: boolean): Pending | undefined { this.sync(); const p = this.state.pending.find(x => x.id === id); if (!p) return undefined; if (!approved) { p.denied = true; this.audit('authorization-denied', p.clientId); this.persist(); return p }
    if (!p.approvalCode || !equal(p.approvalCode, hash(this.state.key, code))) return undefined
    p.approved = true; this.client(p.clientId)!.approvedAt = new Date().toISOString(); this.audit('authorization-approved', p.clientId); this.persist(); return p }
  issueCode(p: Pending): string { const raw = token(); this.state.codes.push({ hash: hash(this.state.key, raw), clientId: p.clientId, redirectUri: p.redirectUri, scopes: p.scopes, challenge: p.challenge, expiresAt: now() + CODE_TTL }); this.persist(); return raw }
  exchangeCode(raw: string, clientId: string, redirectUri: string, verifier: string): { grant: Grant; access: string; refresh: string } | null { const code = this.state.codes.find(c => equal(c.hash, hash(this.state.key, raw))); if (!code || code.used || code.expiresAt <= now() || code.clientId !== clientId || code.redirectUri !== redirectUri || !verifyPkce(verifier, code.challenge)) return null; code.used = true; const grant: Grant = { id: token(), clientId, scopes: code.scopes, createdAt: now() }; this.state.grants.push(grant); const result = this.issueTokens(grant); this.audit('token-issued', clientId, grant.id); this.persist(); return { grant, ...result } }
  private issueTokens(grant: Grant): { access: string; refresh: string } { const a = token(); const r = token(); const time = now(); this.state.access.push({ hash: hash(this.state.key, a), grantId: grant.id, expiresAt: time + ACCESS_TTL }); this.state.refresh.push({ hash: hash(this.state.key, r), grantId: grant.id, familyId: token(), issuedAt: time, lastUsedAt: time, expiresAt: time + REFRESH_ABSOLUTE_TTL }); return { access: a, refresh: r } }
  authenticate(raw: string): Grant | undefined { const a = this.state.access.find(x => equal(x.hash, hash(this.state.key, raw))); if (!a || a.revoked || a.expiresAt <= now()) return undefined; const grant = this.state.grants.find(g => g.id === a.grantId); return grant && !grant.revoked ? grant : undefined }
  refreshToken(raw: string, clientId: string): { grant: Grant; access: string; refresh: string } | null { const r = this.state.refresh.find(x => equal(x.hash, hash(this.state.key, raw))); const grant = r && this.state.grants.find(g => g.id === r.grantId); if (!r || !grant || grant.revoked || grant.clientId !== clientId || r.revoked || r.expiresAt <= now() || r.lastUsedAt + REFRESH_IDLE_TTL <= now()) { if (r) this.revokeFamily(r.familyId); this.persist(); return null } r.revoked = true; const result = this.issueTokens(grant); const newest = this.state.refresh[this.state.refresh.length - 1]; newest.familyId = r.familyId; this.audit('refresh-rotated', clientId, grant.id); this.persist(); return { grant, ...result } }
  revoke(raw: string, clientId: string): void { const h = hash(this.state.key, raw); const a = this.state.access.find(x => equal(x.hash, h)); const r = this.state.refresh.find(x => equal(x.hash, h)); if (a) { const g = this.state.grants.find(x => x.id === a.grantId); if (g?.clientId === clientId) a.revoked = true } if (r) { const g = this.state.grants.find(x => x.id === r.grantId); if (g?.clientId === clientId) this.revokeFamily(r.familyId) } this.audit('revocation', clientId); this.persist() }
  private revokeFamily(id: string): void { for (const r of this.state.refresh) if (r.familyId === id) r.revoked = true; for (const r of this.state.refresh.filter(x => x.familyId === id)) { const g = this.state.grants.find(x => x.id === r.grantId); if (g) g.revoked = true } }
  cached(grantId: string, key: string, fingerprint: string): { hit?: unknown; conflict?: boolean } { const item = this.state.idempotent.find(i => i.grantId === grantId && i.key === key && i.expiresAt > now()); if (!item) return {}; return item.fingerprint === fingerprint ? { hit: item.response } : { conflict: true } }
  cache(grantId: string, key: string, fingerprint: string, response: unknown): void { this.state.idempotent.push({ grantId, key, fingerprint, response, expiresAt: now() + 24 * 60 * 60_000 }); this.persist() }
  revokeClient(clientId: string): void { for (const g of this.state.grants) if (g.clientId === clientId) g.revoked = true; this.audit('client-revoked', clientId); this.persist() }
}

function verifyPkce(verifier: string, challenge: string): boolean { if (!REGEXP_CODE_VERIFIER.test(verifier)) return false; return equal(createHash('sha256').update(verifier).digest('base64url'), challenge) }
function validateRedirect(uri: string): boolean { try { const u = new URL(uri); if (u.hash || u.username || u.password || u.hostname.includes('*')) return false; if (u.protocol === 'https:') return true; if (u.protocol === 'http:') return loopback(u.hostname); return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && u.protocol.includes('.') } catch { return false } }
function redirectMatches(registered: string[], incoming: string): boolean { try { const u = new URL(incoming); return registered.some(r => { const x = new URL(r); return (x.protocol === 'http:' && loopback(x.hostname) && x.protocol === u.protocol && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search) || r === incoming }) } catch { return false } }
function mutating(method: string): boolean { return /\.(create|update|delete|remove|rename|pin|reorder|send|enqueue|promote|abort|steer|retry|answer|dismiss|set|write|restart|authenticate|logout|login|restore|trash|purge|run|pause|resume|connect|disconnect|approve|reject|publish|undo|redo|revert|fork|activate|kill|resize)$/.test(method) || method === 'daemon.shutdown' }
function requiredScope(method: string): Scope { if (method.startsWith('pty.')) return 'mousse:terminal'; if (method.startsWith('settings.') || method.startsWith('providers.') || method.startsWith('mcp.') || method.startsWith('skills.')) return 'mousse:settings'; if (method.startsWith('channels.') || method === 'daemon.shutdown') return 'mousse:admin'; if (/^(orchestrator\.(send|abort|steer|retry|answerQuestions|dismissQuestions)|queue\.|mousseAgent\.(send|retry|abort))/.test(method)) return 'mousse:chat'; return mutating(method) ? 'mousse:write' : 'mousse:read' }
function redact(value: unknown, seen = new WeakSet<object>()): unknown { if (Array.isArray(value)) return value.map(x => redact(x, seen)); if (!value || typeof value !== 'object') return value; if (seen.has(value as object)) return '[Circular]'; seen.add(value as object); const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = /token|secret|api[_-]?key|authorization|password|cookie|credential|private.?key|\benv\b/i.test(k) ? '[REDACTED]' : redact(v, seen); return out }

export class ClientConnectionServer {
  private server: Server | null = null
  private readonly repo: ConnectionRepository
  private readonly ring = new EventSequenceRing(RETENTION)
  private readonly sse = new Map<string, ServerResponse>()
  private readonly instanceId = token()
  private draining = false
  private requestCounts = new Map<string, { minute: number; count: number; active: number }>()
  constructor(private readonly mms: MousseMainService, private readonly options: ClientConnectionOptions) { this.repo = repositoryForHome(mms.getHomeDir()); this.mms.events.onAny((channel, data) => this.broadcast(channel.replaceAll(':', '.'), data)) }
  get address(): string | null { const a = this.server?.address(); return a && typeof a !== 'string' ? `${this.secure ? 'https' : 'http'}://${this.options.host}:${a.port}` : null }
  get secure(): boolean { return Boolean(this.options.tlsCertPath && this.options.tlsKeyPath) }
  pending(): PendingConnection[] { return this.repo.pending() }
  approve(id: string): string { return this.repo.approve(id) }
  revokeClient(clientId: string): void { this.repo.revokeClient(clientId) }
  async start(): Promise<void> { if (this.server) return; if (!loopback(this.options.host) && !this.secure) throw new Error('Remote client connections require TLS certificate and key'); const handler = (req: IncomingMessage, res: ServerResponse) => { void this.handle(req, res) }; this.server = this.secure ? createHttpsServer({ cert: readFileSync(this.options.tlsCertPath!), key: readFileSync(this.options.tlsKeyPath!) }, handler) : createHttpServer(handler); await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.options.port, this.options.host, () => { this.server!.off('error', reject); resolve() }) }) }
  async stop(): Promise<void> { this.draining = true; for (const res of this.sse.values()) res.end(); this.sse.clear(); const server = this.server; this.server = null; if (server) await new Promise<void>((resolve) => server.close(() => resolve())) }
  private headers(res: ServerResponse): void { res.setHeader('Mousse-Protocol-Version', VERSION); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer') }
  private base(req: IncomingMessage): string { const host = req.headers.host ?? `${this.options.host}:${this.options.port}`; return `${this.secure ? 'https' : 'http'}://${host}` }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> { this.headers(res); const remote = req.socket.remoteAddress ?? ''; if (!this.secure && !loopback(remote)) return this.json(res, 400, { error: 'invalid_request', error_description: 'TLS is required for non-loopback requests' }); const length = Number(req.headers['content-length'] ?? 0); if (Number.isFinite(length) && length > MAX_BYTES) return this.json(res, 413, { error: 'request_too_large' }); const origin = req.headers.origin; if (origin) { if (!this.options.corsOrigins?.includes(origin)) return this.json(res, 403, { error: 'origin_forbidden' }); res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') } if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.statusCode = 204; res.end(); return }
    const url = new URL(req.url ?? '/', this.base(req)); try {
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return this.json(res, 200, this.oauthMetadata(this.base(req)))
      if (req.method === 'GET' && url.pathname === '/.well-known/mousse-configuration') return this.json(res, 200, this.mousseMetadata(this.base(req)))
      if (req.method === 'POST' && url.pathname === '/oauth/register') return this.register(req, res)
      if (url.pathname === '/oauth/authorize') return this.authorize(req, res, url)
      if (req.method === 'POST' && url.pathname === '/oauth/token') return this.token(req, res)
      if (req.method === 'POST' && url.pathname === '/oauth/revoke') return this.revoke(req, res)
      if (req.method === 'POST' && url.pathname === '/v1/rpc') return this.rpc(req, res)
      if (req.method === 'GET' && url.pathname === '/v1/events') return this.events(req, res)
      this.json(res, 404, { error: 'not_found' })
    } catch (error) { this.json(res, (error as { code?: string }).code === 'too_large' ? 413 : 400, { error: (error as { code?: string }).code === 'too_large' ? 'request_too_large' : 'invalid_request' }) } }
  private oauthMetadata(base: string): unknown { return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, revocation_endpoint: `${base}/oauth/revoke`, registration_endpoint: `${base}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES } }
  private mousseMetadata(base: string): unknown { return { protocol_version: VERSION, server_name: this.options.serverName, server_version: this.options.version ?? '0.1.0', api_endpoint: `${base}/v1/rpc`, events_endpoint: `${base}/v1/events`, max_request_bytes: MAX_BYTES, event_retention: RETENTION } }
  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> { const body = await this.body(req); const name = typeof body.client_name === 'string' && body.client_name.length <= 256 ? body.client_name : ''; const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((x): x is string => typeof x === 'string') : []; if (!name || !uris.length || !uris.every(validateRedirect) || body.token_endpoint_auth_method !== 'none' || !same(body.grant_types, ['authorization_code', 'refresh_token']) || !same(body.response_types, ['code'])) return this.json(res, 400, { error: 'invalid_client_metadata' }); const client = this.repo.register(name, uris); this.json(res, 201, { client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }
  private authorize(req: IncomingMessage, res: ServerResponse, url: URL): void { if (req.method === 'POST') { void this.authorizePost(req, res); return } const q = url.searchParams; const client = this.repo.client(q.get('client_id') ?? ''); const redirectUri = q.get('redirect_uri') ?? ''; const state = q.get('state') ?? ''; const scopeNames = (q.get('scope') ?? '').split(' ').filter(Boolean); if (!client || q.get('response_type') !== 'code' || !redirectMatches(client.redirectUris, redirectUri) || !state || state.length < 22 || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !scopeNames.length || !scopeNames.every(isScope)) return this.oauthError(res, 'invalid_request'); const pending = this.repo.request({ clientId: client.id, redirectUri, scopes: scopeNames as Scope[], state, challenge: q.get('code_challenge')! }); this.consentPage(res, pending, client.name) }
  private async authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> { const body = await this.body(req, true); const id = typeof body.request_id === 'string' ? body.request_id : ''; const p = this.repo.finalize(id, typeof body.approval_code === 'string' ? body.approval_code : '', body.decision === 'approve'); if (!p) return this.oauthError(res, 'access_denied'); if (p.denied) return this.oauthError(res, 'access_denied'); const code = this.repo.issueCode(p); const target = new URL(p.redirectUri); target.searchParams.set('code', code); target.searchParams.set('state', p.state); target.searchParams.set('iss', this.base(req)); res.statusCode = 302; res.setHeader('Location', target.toString()); res.end() }
  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> { const b = await this.body(req, true); const grantType = b.grant_type; const clientId = typeof b.client_id === 'string' ? b.client_id : ''; if (!this.repo.client(clientId)) return this.oauthError(res, 'invalid_client'); if (grantType === 'authorization_code') { const result = typeof b.code === 'string' && typeof b.redirect_uri === 'string' && typeof b.code_verifier === 'string' ? this.repo.exchangeCode(b.code, clientId, b.redirect_uri, b.code_verifier) : null; if (!result) return this.oauthError(res, 'invalid_grant'); return this.json(res, 200, tokens(result.access, result.refresh, result.grant.scopes)) } if (grantType === 'refresh_token') { const result = typeof b.refresh_token === 'string' ? this.repo.refreshToken(b.refresh_token, clientId) : null; if (!result) return this.oauthError(res, 'invalid_grant'); return this.json(res, 200, tokens(result.access, result.refresh, result.grant.scopes)) } this.oauthError(res, 'unsupported_grant_type') }
  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> { const b = await this.body(req, true); if (typeof b.token === 'string' && typeof b.client_id === 'string') this.repo.revoke(b.token, b.client_id); res.statusCode = 200; res.end() }
  private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.draining) return this.json(res, 503, { error: 'daemon_draining' })
    const grant = this.auth(req, res)
    if (!grant) return
    const limit = this.limit(grant.id)
    if (limit === 'rate') return this.rate(res)
    if (limit === 'concurrency') return this.json(res, 429, { error: 'too_many_concurrent_requests' })
    try {
      const body = await this.body(req)
      if (body.jsonrpc !== '2.0' || typeof body.id !== 'string' || body.id.length > 128 || typeof body.method !== 'string' || Array.isArray(body)) return this.json(res, 400, { error: 'invalid_request' })
      if (body.method === 'events.subscribe' || !(PROTOCOL_METHODS as readonly string[]).includes(body.method)) return this.rpcError(res, body.id, -32601, 'Method not found')
      const scope = requiredScope(body.method)
      if (!granted(grant.scopes, scope)) return this.rpcError(res, body.id, -32003, `Scope ${scope} is required`, 403, { required_scope: scope, retryable: false })
      const key = req.headers['idempotency-key']
      const isMutation = mutating(body.method)
      if (isMutation && (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))) return this.rpcError(res, body.id, -32602, 'Mutating requests require a UUID Idempotency-Key')
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      if (isMutation) {
        const cached = this.repo.cached(grant.id, key as string, fingerprint)
        if (cached.conflict) return this.json(res, 409, { error: 'idempotency_conflict' })
        if ('hit' in cached) return this.json(res, 200, cached.hit)
      }
      let payload: unknown
      try {
        const result = await dispatchMethod({
          mms: this.mms,
          ownerToken: this.mms.getOwnerLease()?.owner.token,
          globalSequence: () => this.ring.currentSequence,
          emitEvent: (type, data, threadId) => this.broadcast(type, data, threadId)
        }, body.method, body.params)
        payload = { jsonrpc: '2.0', id: body.id, result: redact(result) }
      } catch (error) {
        payload = { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: redact({ message: error instanceof Error ? error.message : 'Handler error' }) } }
      }
      if (isMutation) this.repo.cache(grant.id, key as string, fingerprint, payload)
      this.json(res, 200, payload)
    } finally {
      this.release(grant.id)
    }
  }
  private events(req: IncomingMessage, res: ServerResponse): void { const grant = this.auth(req, res); if (!grant) return; if (!granted(grant.scopes, 'mousse:read')) return this.json(res, 403, { error: 'insufficient_scope' }); if (this.sse.has(grant.id)) return this.json(res, 429, { error: 'sse_connection_limit' }); const afterText = req.headers['last-event-id']; const after = typeof afterText === 'string' && /^\d+$/.test(afterText) ? Number(afterText) : 0; const replay = this.ring.replayAfter(after); res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); if (replay.gap) { res.write(`event: stream.reset\ndata: ${JSON.stringify({ serverInstanceId: this.instanceId })}\n\n`); res.end(); return } for (const event of replay.events) this.writeEvent(res, event); this.sse.set(grant.id, res); const timer = setInterval(() => res.write(': heartbeat\n\n'), 15_000); req.on('close', () => { clearInterval(timer); this.sse.delete(grant.id) }) }
  private broadcast(type: string, data: unknown, threadId?: string): void { const event = this.ring.push(type, redact(data), threadId); for (const res of this.sse.values()) this.writeEvent(res, event) }
  private writeEvent(res: ServerResponse, event: { sequence: number; type: string; threadId?: string; data: unknown }): void { res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ seq: event.sequence, serverInstanceId: this.instanceId, ...(event.threadId ? { threadId: event.threadId } : {}), payload: event.data })}\n\n`) }
  private auth(req: IncomingMessage, res: ServerResponse): Grant | undefined { const raw = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]; const grant = raw ? this.repo.authenticate(raw) : undefined; if (!grant) { res.setHeader('WWW-Authenticate', 'Bearer realm="mousse"'); this.json(res, 401, { error: 'invalid_token' }) } return grant }
  private limit(grantId: string): 'rate' | 'concurrency' | null { const m = Math.floor(now() / 60_000); const x = this.requestCounts.get(grantId) ?? { minute: m, count: 0, active: 0 }; if (x.minute !== m) { x.minute = m; x.count = 0 } if (x.count >= 60) return 'rate'; if (x.active >= 10) return 'concurrency'; x.count++; x.active++; this.requestCounts.set(grantId, x); return null }
  private release(grantId: string): void { const x = this.requestCounts.get(grantId); if (x) x.active = Math.max(0, x.active - 1) }
  private rate(res: ServerResponse): void { res.setHeader('Retry-After', '60'); this.json(res, 429, { error: 'rate_limited' }) }
  private async body(req: IncomingMessage, form = false): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BYTES) { const e = new Error('too_large'); (e as Error & { code?: string }).code = 'too_large'; throw e } chunks.push(chunk as Buffer) } const raw = Buffer.concat(chunks).toString('utf8'); if (form) return Object.fromEntries(new URLSearchParams(raw)); if (!raw) return {}; if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('json_required'); const parsed: unknown = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} }
  private json(res: ServerResponse, status: number, value: unknown): void { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(redact(value))) }
  private oauthError(res: ServerResponse, error: string): void { this.json(res, 400, { error }) }
  private rpcError(res: ServerResponse, id: string, code: number, message: string, status = 200, data?: unknown): void { this.json(res, status, { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }) }
  private consentPage(res: ServerResponse, p: Pending, name: string): void { res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"); res.end(`<!doctype html><title>Mousse authorization</title><h1>Authorize ${escapeHtml(name)}</h1><p>Requested scopes: ${p.scopes.map(escapeHtml).join(', ')}</p><p>In a trusted Mousse owner terminal run <code>mousse-cli connections approve ${p.id}</code>, then enter the displayed approval code.</p><form method="post"><input type="hidden" name="request_id" value="${p.id}"><input name="approval_code" autocomplete="one-time-code"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`) }
}
/** Owner CLI administration only ever persists token hashes and audit metadata. */
function repositoryForHome(homeDir: string): ConnectionRepository {
  const separator = homeDir.endsWith('/') || homeDir.endsWith('\\') ? '' : process.platform === 'win32' ? '\\' : '/'
  return new ConnectionRepository(`${homeDir}${separator}client-connections.json`)
}
export function listPendingClientConnections(homeDir: string): PendingConnection[] {
  return repositoryForHome(homeDir).pending()
}
export function approveClientConnection(homeDir: string, requestId: string): string {
  return repositoryForHome(homeDir).approve(requestId)
}
export function revokeClientConnection(homeDir: string, clientId: string): void {
  repositoryForHome(homeDir).revokeClient(clientId)
}
function tokens(access: string, refresh: string, scopes: Scope[]): unknown { return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: scopes.join(' ') } }
function same(value: unknown, expected: string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((x, i) => x === expected[i]) }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[x]!) }
