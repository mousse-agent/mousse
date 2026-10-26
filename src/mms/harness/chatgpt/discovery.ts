import { createRemoteJWKSet } from 'jose'
import { ChatGptAuthError, MESSAGES } from './errors'
import { abortable, getJson, isRecord } from './http'

export const OPENAI_ISSUER = 'https://auth.openai.com'
export const OPENAI_DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

/** Where Sign in with ChatGPT and the model list live. Production always uses `OPENAI_ENDPOINTS`. */
export interface ChatGptEndpoints {
  discoveryUrl: string
  /** Base of `GET /models`. */
  apiBaseUrl: string
  /**
   * Tests only: trust an injected local issuer, skipping the auth.openai.com origin check. It has
   * no effect on the real discovery URL.
   */
  trustInjectedIssuer?: boolean
}

export const OPENAI_ENDPOINTS: ChatGptEndpoints = { discoveryUrl: OPENAI_DISCOVERY_URL, apiBaseUrl: OPENAI_API_BASE_URL }

export interface Discovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  revocationEndpoint: string
  jwks: ReturnType<typeof createRemoteJWKSet>
}

const DISCOVERY_TIMEOUT_MS = 10_000

/** Per process: the first successful discovery of each URL. A failure is not cached. */
const cache = new Map<string, Promise<Discovery>>()

function urlOn(value: unknown, origin: string | null): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (origin !== null && url.origin !== origin) return null
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

async function load(endpoints: ChatGptEndpoints): Promise<Discovery> {
  let response
  try {
    response = await getJson(endpoints.discoveryUrl, { timeoutMs: DISCOVERY_TIMEOUT_MS })
  } catch {
    throw new ChatGptAuthError('timeout', 'discovery', MESSAGES.discovery)
  }
  if (!response.ok || !isRecord(response.body)) throw new ChatGptAuthError('protocol', 'discovery', MESSAGES.discovery)
  const body = response.body
  const trusted = endpoints.trustInjectedIssuer === true && endpoints.discoveryUrl !== OPENAI_DISCOVERY_URL
  if (!trusted && body.issuer !== OPENAI_ISSUER) throw new ChatGptAuthError('protocol', 'discovery', MESSAGES.discoveryUnverified)
  if (typeof body.issuer !== 'string') throw new ChatGptAuthError('protocol', 'discovery', MESSAGES.discoveryUnverified)
  // Every endpoint must live on the issuer's origin.
  const origin = trusted ? null : OPENAI_ISSUER
  const authorizationEndpoint = urlOn(body.authorization_endpoint, origin)
  const tokenEndpoint = urlOn(body.token_endpoint, origin)
  const jwksUri = urlOn(body.jwks_uri, origin)
  const revocationEndpoint = urlOn(body.revocation_endpoint, origin)
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri || !revocationEndpoint) {
    throw new ChatGptAuthError('protocol', 'discovery', MESSAGES.discoveryUnverified)
  }
  return {
    issuer: body.issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    revocationEndpoint,
    jwks: createRemoteJWKSet(new URL(jwksUri))
  }
}

/** The issuer's OpenID configuration, fetched once per process. */
export function discover(endpoints: ChatGptEndpoints, signal?: AbortSignal): Promise<Discovery> {
  const key = `${endpoints.trustInjectedIssuer === true}:${endpoints.discoveryUrl}`
  let pending = cache.get(key)
  if (!pending) {
    pending = load(endpoints)
    cache.set(key, pending)
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
    })
  }
  return abortable(pending, signal)
}

/** Tests: forget cached discoveries. */
export function resetDiscoveryCacheForTests(): void {
  cache.clear()
}
