import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import {
  auth,
  type OAuthClientProvider
} from '@modelcontextprotocol/sdk/client/auth.js'

type OAuthDiscoveryState = NonNullable<
  Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>
>
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpAuthConfig } from '../../../shared/integrations'
import { getMcpOAuthDir } from '../../data/paths'
import { loadCursorMcpClientInformation } from './CursorMcpOAuthHints'
import { logWarn } from '../../log/diag'

export interface McpOAuthProviderOptions {
  oauthDir?: string
  profileId?: string
  signal?: AbortSignal
  /** The local port the sign-in redirect returns to. Tests use a free port; the product always uses 8791. */
  callbackPort?: number
}

const MOUSSE_MCP_OAUTH_REDIRECT_PORT = 8791
const MOUSSE_MCP_OAUTH_REDIRECT_PATH = '/callback'

interface StoredMcpOAuthSession {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

function oauthCancelled(): Error {
  return Object.assign(new Error('OAuth authorization was cancelled.'), { name: 'AbortError' })
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180)
}

function getSessionPath(serverId: string, oauthDir = getMcpOAuthDir(), profileId?: string): string {
  const prefix = profileId ? `${sanitizeFileName(profileId)}__` : ''
  return join(oauthDir, `${prefix}${sanitizeFileName(serverId)}.json`)
}

async function readSession(
  serverId: string,
  oauthDir?: string,
  profileId?: string
): Promise<StoredMcpOAuthSession> {
  const path = getSessionPath(serverId, oauthDir, profileId)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as StoredMcpOAuthSession
  } catch {
    return {}
  }
}

async function writeSession(
  serverId: string,
  session: StoredMcpOAuthSession,
  oauthDir?: string,
  profileId?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw oauthCancelled()
  const dir = oauthDir ?? getMcpOAuthDir()
  await mkdir(dir, { recursive: true })
  if (signal?.aborted) throw oauthCancelled()
  const path = getSessionPath(serverId, dir, profileId)
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, 'utf-8')
  if (signal?.aborted) {
    await unlink(path).catch(() => {})
    throw oauthCancelled()
  }
}

const callbackPage = (text: string): string =>
  `<html><body><p>${text}</p></body></html>`

/**
 * Listens for the sign-in redirect. Only a request to the exact callback path that `accept` takes settles the
 * attempt; anything else (a stale tab, another app's redirect) gets an error page and the attempt keeps waiting.
 */
function waitForOAuthCallback(
  port: number,
  accept: (callbackUrl: URL) => boolean,
  signal?: AbortSignal
): { ready: Promise<void>; result: Promise<URL>; close(): Promise<void> } {
  let removeAbort = () => {}
  let callbackServer: ReturnType<typeof createServer> | undefined
  let closePromise: Promise<void> | undefined
  let closed = false
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  let readySettled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return
      readySettled = true
      resolve()
    }
    rejectReady = (error) => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
  })
  void ready.catch(() => {})
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    removeAbort()
    const server = callbackServer
    callbackServer = undefined
    if (!server) {
      closePromise = Promise.resolve()
      return closePromise
    }
    closePromise = new Promise<void>((resolve) => {
      try {
        server.closeAllConnections?.()
      } catch {
        /* ignore */
      }
      server.close(() => resolve())
    })
    return closePromise
  }
  const result = new Promise<URL>((resolve, reject) => {
    const server = createServer((req, res) => {
      const callbackUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (callbackUrl.pathname !== MOUSSE_MCP_OAUTH_REDIRECT_PATH) {
        res.writeHead(404)
        res.end()
        return
      }
      if (!accept(callbackUrl)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(callbackPage('This sign-in link is out of date. Return to Mousse and start the sign-in again if it is still waiting.'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        callbackPage(callbackUrl.searchParams.has('error')
          ? 'Sign-in was not completed. You can close this window and return to Mousse.'
          : 'Authentication complete. You can close this window and return to Mousse.')
      )
      void close().then(() => resolve(callbackUrl), reject)
    })

    const onAbort = () => {
      rejectReady(oauthCancelled())
      void close().finally(() => {
        reject(oauthCancelled())
      })
    }
    callbackServer = server
    if (signal?.aborted || closed) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    removeAbort = () => signal?.removeEventListener('abort', onAbort)
    server.on('error', (error) => {
      removeAbort()
      rejectReady(error)
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      if (closed) void close()
      else resolveReady()
    })
  })
  // Authentication can complete without a redirect. Avoid an unhandled rejection
  // if the callback listener fails while the SDK is still resolving that result.
  void result.catch(() => {})
  return { ready, result, close }
}

export type OpenExternalFn = (url: string) => Promise<void>

export class FileMcpOAuthProvider implements OAuthClientProvider {
  private session: StoredMcpOAuthSession
  private readonly redirectUri: string

  private readonly oauthDir: string
  private readonly profileId?: string
  private readonly signal?: AbortSignal
  private closed = false
  private authorizationState: string | undefined

  private constructor(
    readonly serverId: string,
    readonly serverUrl: string,
    private readonly authConfig: McpAuthConfig | undefined,
    session: StoredMcpOAuthSession,
    private readonly openExternal: OpenExternalFn,
    oauthDir: string,
    profileId?: string,
    signal?: AbortSignal,
    callbackPort = MOUSSE_MCP_OAUTH_REDIRECT_PORT
  ) {
    this.session = session
    this.oauthDir = oauthDir
    this.profileId = profileId
    this.signal = signal
    this.redirectUri = `http://127.0.0.1:${callbackPort}${MOUSSE_MCP_OAUTH_REDIRECT_PATH}`
  }

  static async create(
    serverId: string,
    serverUrl: string,
    authConfig?: McpAuthConfig,
    openExternal: OpenExternalFn = defaultOpenExternal,
    options: McpOAuthProviderOptions = {}
  ): Promise<FileMcpOAuthProvider> {
    const oauthDir = options.oauthDir ?? getMcpOAuthDir()
    const session = await readSession(serverId, oauthDir, options.profileId)

    if (!session.clientInformation?.client_id) {
      if (authConfig?.clientId) {
        session.clientInformation = {
          client_id: authConfig.clientId,
          ...(authConfig.clientSecret ? { client_secret: authConfig.clientSecret } : {})
        }
      } else {
        const cursorClient = await loadCursorMcpClientInformation(serverUrl)
        if (cursorClient?.client_id) {
          session.clientInformation = cursorClient
        }
      }
    }

    return new FileMcpOAuthProvider(
      serverId,
      serverUrl,
      authConfig,
      session,
      openExternal,
      oauthDir,
      options.profileId,
      options.signal,
      options.callbackPort
    )
  }

  private async persist(): Promise<void> {
    if (this.closed || this.signal?.aborted) throw oauthCancelled()
    await writeSession(this.serverId, this.session, this.oauthDir, this.profileId, this.signal)
    if (this.closed || this.signal?.aborted) {
      await unlink(getSessionPath(this.serverId, this.oauthDir, this.profileId)).catch(() => {})
      throw oauthCancelled()
    }
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      client_name: 'Mousse',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(this.authConfig?.scopes?.length ? { scope: this.authConfig.scopes.join(' ') } : {})
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.session.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.session.clientInformation = clientInformation
    await this.persist()
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.session.tokens = tokens
    await this.persist()
  }

  /** A new random value for each sign-in; the SDK puts it in the authorization URL and the callback must return it. */
  state(): string {
    this.authorizationState = randomBytes(32).toString('base64url')
    return this.authorizationState
  }

  /** True when a callback carries the state of the sign-in this provider started. */
  isOwnCallback(callbackUrl: URL): boolean {
    return this.authorizationState !== undefined && callbackUrl.searchParams.get('state') === this.authorizationState
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.closed || this.signal?.aborted) throw oauthCancelled()
    await this.openExternal(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.session.codeVerifier = codeVerifier
    await this.persist()
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) {
      throw new Error('OAuth code verifier is missing.')
    }
    return this.session.codeVerifier
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.session.discoveryState
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.session.discoveryState = state
    await this.persist()
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (this.closed || this.signal?.aborted) throw oauthCancelled()
    if (scope === 'all') {
      this.session = {}
    } else if (scope === 'client') {
      delete this.session.clientInformation
    } else if (scope === 'tokens') {
      delete this.session.tokens
    } else if (scope === 'verifier') {
      delete this.session.codeVerifier
    } else if (scope === 'discovery') {
      delete this.session.discoveryState
    }
    await this.persist()
  }

  async revoke(): Promise<void> {
    this.closed = true
    this.session = {}
    await unlink(getSessionPath(this.serverId, this.oauthDir, this.profileId)).catch(() => {})
  }
}

async function defaultOpenExternal(url: string): Promise<void> {
  logWarn('McpOAuth', `Open this URL to authorize: ${url}`)
}

export async function ensureMcpOAuthAuthorized(
  serverId: string,
  serverUrl: string,
  authConfig?: McpAuthConfig,
  openExternal: OpenExternalFn = defaultOpenExternal,
  options: McpOAuthProviderOptions = {}
): Promise<FileMcpOAuthProvider> {
  const provider = await FileMcpOAuthProvider.create(
    serverId,
    serverUrl,
    authConfig,
    openExternal,
    options
  )
  const existing = provider.tokens()
  if (existing?.access_token) {
    if (options.signal?.aborted) {
      await provider.revoke()
      throw oauthCancelled()
    }
    return provider
  }

  const callback = waitForOAuthCallback(
    options.callbackPort ?? MOUSSE_MCP_OAUTH_REDIRECT_PORT,
    (callbackUrl) => provider.isOwnCallback(callbackUrl),
    options.signal
  )
  const fetchFn: typeof fetch | undefined = options.signal
    ? (url, init) => fetch(url, { ...init, signal: combineAbort(init?.signal, options.signal) })
    : undefined
  try {
    // Own port 8791 before discovery/auth can redirect or open a browser. A
    // simultaneous profile authorization fails here without ambiguous callback
    // ownership or credential writes.
    await callback.ready
    const result = await auth(provider, { serverUrl, ...(fetchFn ? { fetchFn } : {}) })
    if (options.signal?.aborted) throw oauthCancelled()

    if (result === 'AUTHORIZED') return provider

    if (result === 'REDIRECT') {
      const callbackUrl = await callback.result
      const error = callbackUrl.searchParams.get('error')
      if (error) {
        const description = callbackUrl.searchParams.get('error_description')
        throw new Error(`OAuth sign-in was not completed: ${error}${description ? ` (${description})` : ''}`)
      }
      const code = callbackUrl.searchParams.get('code')
      if (!code) throw new Error('OAuth callback did not include an authorization code.')
      const finalized = await auth(provider, {
        serverUrl,
        authorizationCode: code,
        ...(fetchFn ? { fetchFn } : {})
      })
      if (options.signal?.aborted) throw oauthCancelled()
      if (finalized !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete successfully.')
      return provider
    }

    throw new Error('OAuth authorization failed.')
  } finally {
    await callback.close()
    if (options.signal?.aborted) await provider.revoke()
  }
}

function combineAbort(left?: AbortSignal | null, right?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  for (const signal of [left, right]) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export function hasMcpOAuthTokens(
  serverId: string,
  oauthDir?: string,
  profileId?: string
): boolean {
  const path = getSessionPath(serverId, oauthDir, profileId)
  if (!existsSync(path)) return false
  try {
    const session = JSON.parse(readFileSync(path, 'utf-8')) as StoredMcpOAuthSession
    return Boolean(session.tokens?.access_token)
  } catch {
    return false
  }
}

export async function revokeStoredMcpOAuthSession(
  serverId: string,
  oauthDir?: string,
  profileId?: string
): Promise<void> {
  await unlink(getSessionPath(serverId, oauthDir, profileId)).catch(() => {})
}
