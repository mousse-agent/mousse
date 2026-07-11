import { createServer } from 'http'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpAuthConfig } from '../../../shared/integrations'
import { getMcpOAuthDir } from '../../data/paths'
import { loadCursorMcpClientInformation } from './CursorMcpOAuthHints'

const MOUSSE_MCP_OAUTH_REDIRECT_PORT = 8791
const MOUSSE_MCP_OAUTH_REDIRECT_PATH = '/callback'

interface StoredMcpOAuthSession {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180)
}

function getSessionPath(serverId: string): string {
  return join(getMcpOAuthDir(), `${sanitizeFileName(serverId)}.json`)
}

async function readSession(serverId: string): Promise<StoredMcpOAuthSession> {
  const path = getSessionPath(serverId)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as StoredMcpOAuthSession
  } catch {
    return {}
  }
}

async function writeSession(serverId: string, session: StoredMcpOAuthSession): Promise<void> {
  await mkdir(getMcpOAuthDir(), { recursive: true })
  await writeFile(getSessionPath(serverId), `${JSON.stringify(session, null, 2)}\n`, 'utf-8')
}

function waitForOAuthCallback(port: number): Promise<URL> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith(MOUSSE_MCP_OAUTH_REDIRECT_PATH)) {
        res.writeHead(404)
        res.end()
        return
      }

      const callbackUrl = new URL(req.url, `http://127.0.0.1:${port}`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body><p>Authentication complete. You can close this window and return to Mousse.</p></body></html>'
      )
      server.close()
      resolve(callbackUrl)
    })

    server.on('error', reject)
    server.listen(port, '127.0.0.1')
  })
}

export type OpenExternalFn = (url: string) => Promise<void>

export class FileMcpOAuthProvider implements OAuthClientProvider {
  private session: StoredMcpOAuthSession
  private readonly redirectUri: string

  private constructor(
    readonly serverId: string,
    readonly serverUrl: string,
    private readonly authConfig: McpAuthConfig | undefined,
    session: StoredMcpOAuthSession,
    private readonly openExternal: OpenExternalFn
  ) {
    this.session = session
    this.redirectUri = `http://127.0.0.1:${MOUSSE_MCP_OAUTH_REDIRECT_PORT}${MOUSSE_MCP_OAUTH_REDIRECT_PATH}`
  }

  static async create(
    serverId: string,
    serverUrl: string,
    authConfig?: McpAuthConfig,
    openExternal: OpenExternalFn = defaultOpenExternal
  ): Promise<FileMcpOAuthProvider> {
    const session = await readSession(serverId)

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

    return new FileMcpOAuthProvider(serverId, serverUrl, authConfig, session, openExternal)
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
    await writeSession(this.serverId, this.session)
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.session.tokens = tokens
    await writeSession(this.serverId, this.session)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openExternal(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.session.codeVerifier = codeVerifier
    await writeSession(this.serverId, this.session)
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
    await writeSession(this.serverId, this.session)
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
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
    await writeSession(this.serverId, this.session)
  }
}

async function defaultOpenExternal(url: string): Promise<void> {
  console.log(`[McpOAuth] Open this URL to authorize: ${url}`)
}

export async function ensureMcpOAuthAuthorized(
  serverId: string,
  serverUrl: string,
  authConfig?: McpAuthConfig,
  openExternal: OpenExternalFn = defaultOpenExternal
): Promise<FileMcpOAuthProvider> {
  const provider = await FileMcpOAuthProvider.create(serverId, serverUrl, authConfig, openExternal)
  const existing = provider.tokens()
  if (existing?.access_token) {
    return provider
  }

  const callbackPromise = waitForOAuthCallback(MOUSSE_MCP_OAUTH_REDIRECT_PORT)
  const result = await auth(provider, { serverUrl })
  if (result === 'AUTHORIZED') {
    return provider
  }

  if (result === 'REDIRECT') {
    const callbackUrl = await callbackPromise
    const code = callbackUrl.searchParams.get('code')
    if (!code) {
      throw new Error('OAuth callback did not include an authorization code.')
    }
    const finalized = await auth(provider, {
      serverUrl,
      authorizationCode: code
    })
    if (finalized !== 'AUTHORIZED') {
      throw new Error('OAuth authorization did not complete successfully.')
    }
    return provider
  }

  throw new Error('OAuth authorization failed.')
}

export function hasMcpOAuthTokens(serverId: string): boolean {
  const path = getSessionPath(serverId)
  if (!existsSync(path)) return false
  try {
    const session = JSON.parse(readFileSync(path, 'utf-8')) as StoredMcpOAuthSession
    return Boolean(session.tokens?.access_token)
  } catch {
    return false
  }
}
