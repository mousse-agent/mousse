import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose'
import { afterEach, beforeEach, vi } from 'vitest'
import type { ChatGptEndpoints } from '../../../src/mms/harness/chatgpt/discovery'
import { resetDiscoveryCacheForTests } from '../../../src/mms/harness/chatgpt/discovery'
import type { SecretCodec } from '../../../src/mms/providers/secretCodec'

/**
 * A local stand-in for auth.openai.com and api.openai.com on 127.0.0.1: discovery, JWKS, token,
 * revocation and models endpoints. Nothing in these tests reaches a real OpenAI endpoint; the
 * guard below fails any request to another host.
 */

export interface Reply {
  /** 0 drops the connection. */
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface Account {
  subject: string
  email?: string
}

interface PendingGrant extends Account {
  clientId: string
  nonce: string
  scope: string
}

export const FULL_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

export class FakeIssuer {
  base = ''
  readonly tokenRequests: Array<Record<string, string>> = []
  readonly revokeRequests: Array<Record<string, string>> = []
  readonly modelRequests: Array<{ authorization?: string }> = []
  /** Replaces the default token endpoint behaviour. */
  onToken?: (form: Record<string, string>) => Reply | Promise<Reply>
  onRevoke?: (form: Record<string, string>) => Reply | Promise<Reply>
  onModels?: () => Reply
  /** Signs ID tokens; tests swap it for a key the JWKS does not publish. */
  signingKey!: CryptoKey
  private grants = new Map<string, PendingGrant>()
  private refreshTokens = new Map<string, { clientId: string; scope: string }>()
  private server!: Server
  private counter = 0

  async start(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    this.signingKey = privateKey
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
    this.server = createServer((request, response) => {
      void this.route(request, jwk).then(({ status, body, headers }) => {
        // Status 0: drop the connection without an answer.
        if (status === 0) {
          request.socket.destroy()
          return
        }
        response.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers })
        response.end(body === undefined ? '' : JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get endpoints(): ChatGptEndpoints {
    return { discoveryUrl: `${this.base}/.well-known/openid-configuration`, apiBaseUrl: `${this.base}/v1`, trustInjectedIssuer: true }
  }

  private async route(request: IncomingMessage, jwk: object): Promise<Reply> {
    const url = new URL(request.url ?? '/', this.base)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /.well-known/openid-configuration':
        return {
          status: 200,
          body: {
            issuer: this.base,
            authorization_endpoint: `${this.base}/oauth/authorize`,
            token_endpoint: `${this.base}/oauth/token`,
            jwks_uri: `${this.base}/jwks`,
            revocation_endpoint: `${this.base}/oauth/revoke`
          }
        }
      case 'GET /jwks':
        return { status: 200, body: { keys: [jwk] } }
      case 'POST /oauth/token':
        this.tokenRequests.push(form)
        return this.onToken ? this.onToken(form) : this.defaultToken(form)
      case 'POST /oauth/revoke':
        this.revokeRequests.push(form)
        return this.onRevoke ? this.onRevoke(form) : { status: 200 }
      case 'GET /v1/models':
        this.modelRequests.push({ authorization: request.headers.authorization })
        return this.onModels ? this.onModels() : { status: 200, body: { models: [] } }
      default:
        return { status: 404 }
    }
  }

  /** Signs an ID token for `clientId`, with any claim overridden. */
  idToken(clientId: string, claims: JWTPayload & { nonce?: string; email?: string }, options: { alg?: 'RS256'; key?: CryptoKey; expiresIn?: string } = {}): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'k1' })
      .setIssuer(typeof claims.iss === 'string' ? claims.iss : this.base)
      .setAudience(claims.aud ?? clientId)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(options.key ?? this.signingKey)
  }

  /** Approves an authorization: the next exchange of `code` returns tokens for `account`. */
  grant(code: string, grant: PendingGrant): void {
    this.grants.set(code, grant)
  }

  /** Lets the default endpoint accept `refreshToken` once. */
  allowRefresh(refreshToken: string, clientId: string, scope = FULL_SCOPE): void {
    this.refreshTokens.set(refreshToken, { clientId, scope })
  }

  /** Tokens the default endpoint issues; refresh tokens rotate on every use. */
  async tokens(clientId: string, scope: string, idToken?: string): Promise<Record<string, unknown>> {
    const refresh = `rt-${++this.counter}-${randomBytes(4).toString('hex')}`
    this.refreshTokens.set(refresh, { clientId, scope })
    return {
      access_token: `at-${this.counter}`,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
      ...(idToken ? { id_token: idToken } : {})
    }
  }

  /** The default token endpoint: the approved grants, and refresh tokens that rotate. */
  async defaultToken(form: Record<string, string>): Promise<Reply> {
    if (form.grant_type === 'authorization_code') {
      const pending = this.grants.get(form.code)
      if (!pending || pending.clientId !== form.client_id) return { status: 400, body: { error: 'invalid_grant' } }
      this.grants.delete(form.code)
      const idToken = await this.idToken(pending.clientId, { sub: pending.subject, nonce: pending.nonce, ...(pending.email ? { email: pending.email } : {}) })
      return { status: 200, body: await this.tokens(pending.clientId, pending.scope, idToken) }
    }
    if (form.grant_type === 'refresh_token') {
      const known = this.refreshTokens.get(form.refresh_token)
      if (!known || known.clientId !== form.client_id) return { status: 400, body: { error: 'refresh_token_reused' } }
      this.refreshTokens.delete(form.refresh_token)
      // A renewal may carry a new ID token; the saved one must stay.
      const idToken = await this.idToken(known.clientId, { sub: 'renewed', nonce: 'renewed' })
      return { status: 200, body: await this.tokens(known.clientId, known.scope, idToken) }
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } }
  }
}

/** Fails any fetch that is not to 127.0.0.1, so a test can never reach OpenAI. */
export function guardNetwork(): void {
  let original: typeof fetch
  beforeEach(() => {
    original = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname !== '127.0.0.1') throw new Error(`Test tried to reach ${url.host}`)
      return original(input, init)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetDiscoveryCacheForTests()
  })
}

/** Temporary profile and installation homes, removed after each test. */
export function tempHomes(): () => { profileHome: string; installationHome: string } {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  return () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-chatgpt-'))
    dirs.push(root)
    return { profileHome: join(root, 'profile'), installationHome: join(root, 'installation') }
  }
}

/** A plain codec: the daemon without an OS vault. */
export const plainCodec: SecretCodec = { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }

/** A reversible fake vault, marked as required like Electron's. */
export function fakeVault(options: { available?: boolean } = {}): SecretCodec & { available: boolean } {
  const codec = {
    available: options.available ?? true,
    encryptionRequired: true,
    canEncrypt: () => codec.available,
    encrypt: (plain: string) => (codec.available ? Buffer.from(`vault:${Buffer.from(plain).toString('base64')}`) : null),
    decrypt: (stored: Buffer) => {
      if (!codec.available) return null
      const text = stored.toString()
      return text.startsWith('vault:') ? Buffer.from(text.slice(6), 'base64').toString() : null
    }
  }
  return codec
}
