import { createHash, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { ProviderAuthService } from '../../providers/ProviderAuthService'
import type { PiCredentialRequest, PiCredentialResponse, PiOAuthCredential } from './extension/protocol'

/**
 * The OAuth broker's Mousse side (PR 2 §5 "OAuth broker"). Mousse keeps the real refresh token in its
 * own vault (`ProviderAuthService`) and is the only refresher. Pi's private `auth.json` holds the
 * access token, its expiry, the fields pi-ai's stock `toAuth`/`filterModels` read, and an opaque
 * handle in place of the refresh token; Pi's `refresh` sends that handle to `/pi/credential`, and
 * the engine answers with the vault's copy (`extension/oauth.ts` is the other side).
 */

/** The pi-ai OAuth providers that run on Pi's agent (`openai-codex` stays legacy; Anthropic never). */
export const PI_OAUTH_PROVIDERS: readonly string[] = Object.freeze(['github-copilot', 'kimi-coding', 'radius', 'xai', 'openrouter'])

/** What pi-ai's stock `toAuth`/`filterModels` read besides `access`, per provider. */
const PROVIDER_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'github-copilot': ['enterpriseUrl', 'availableModelIds'],
  radius: ['scope']
})

/** What Pi may see of a Mousse OAuth credential: never the refresh token. */
export interface PiOAuthGrant {
  access: string
  expires: number
  /** The provider's extra fields (`PROVIDER_FIELDS`). */
  fields: Record<string, unknown>
  /** The account claim (`oauthSubject`), when the credential has one: a refresh never changes it. */
  subject?: string
}

/** The engine's OAuth option (`PiRpcEngineOptions.oauth`). */
export interface PiOAuthSource {
  /** The vault's current credential for the provider, without a network call; undefined: none. */
  credential(providerId: string): Promise<PiOAuthGrant | undefined>
  /** Refreshes when due (one refresh in flight per provider) and returns the vault's copy. */
  refresh(providerId: string): Promise<PiOAuthGrant | undefined>
}

/** The part of `ProviderAuthService` the broker reads. */
export interface PiOAuthVault {
  credentials: Pick<ProviderAuthService['credentials'], 'get'>
  models: Pick<ProviderAuthService['models'], 'getAuth'>
}

/** The grant of a stored credential, or undefined when it is not a usable pi-ai OAuth one. */
export function oauthGrant(providerId: string, credential: unknown): PiOAuthGrant | undefined {
  if (!PI_OAUTH_PROVIDERS.includes(providerId)) return undefined
  const stored = credential as Record<string, unknown> | undefined
  if (!stored || typeof stored !== 'object' || stored.type !== 'oauth') return undefined
  const { access, expires } = stored
  if (typeof access !== 'string' || !access || typeof expires !== 'number' || !Number.isFinite(expires)) return undefined
  const fields: Record<string, unknown> = {}
  for (const name of PROVIDER_FIELDS[providerId] ?? []) if (stored[name] !== undefined) fields[name] = structuredClone(stored[name])
  const subject = oauthSubject(stored, providerId)
  return { access, expires, fields, ...(subject ? { subject } : {}) }
}

/** `ProviderAuthService` as the engine's OAuth source; the profile passes one to every `pi:*` instance. */
export function piOAuthBroker(vault: PiOAuthVault): PiOAuthSource {
  const inFlight = new Map<string, Promise<PiOAuthGrant | undefined>>()
  const current = (providerId: string) => oauthGrant(providerId, vault.credentials.get(providerId))
  return {
    credential: async (providerId) => current(providerId),
    refresh: (providerId) => {
      if (!PI_OAUTH_PROVIDERS.includes(providerId)) return Promise.resolve(undefined)
      let pending = inFlight.get(providerId)
      if (!pending) {
        // pi-ai's `getAuth` refreshes when the vault copy is due and persists it (under the store's lock).
        pending = vault.models.getAuth(providerId).then(() => current(providerId)).finally(() => inFlight.delete(providerId))
        inFlight.set(providerId, pending)
      }
      return pending
    }
  }
}

/**
 * A new opaque handle for one engine of `instanceId`. Every process of the instance shares its agent
 * dir (and so `auth.json`), so the handle is per engine: one from another instance or an earlier
 * run of Mousse is refused.
 */
export function piOAuthHandle(instanceId: string): string {
  return `mousse:${instanceId}:${randomBytes(18).toString('base64url')}`
}

/**
 * The engine's `/pi/credential` handler: only the instance's provider with the engine's handle is
 * answered, with the vault's copy after Mousse's refresh. Any refusal throws (the bridge answers
 * with no detail).
 */
export function piCredentialHandler(input: {
  provider: string
  /** The handle now valid for the asking process; undefined once its credential epoch ended. */
  handle: () => string | undefined
  source: PiOAuthSource
  /** Whether the refreshed credential may go to the asking process (still its account and epoch). */
  accept?: (next: PiOAuthGrant) => boolean
}): (request: PiCredentialRequest) => Promise<PiCredentialResponse> {
  return async (request) => {
    const handle = input.handle()
    if (!handle || request?.providerId !== input.provider || typeof request.handle !== 'string' || request.handle !== handle) throw new Error('refused')
    const next = await input.source.refresh(input.provider)
    // Checked again after the wait: a sign-out or another account meanwhile refuses the answer.
    if (input.handle() !== handle) throw new Error('refused')
    if (!next) throw new Error('signed out')
    if (input.accept && !input.accept(next)) throw new Error('refused')
    return { credential: piOAuthCredential(next, handle) }
  }
}

/** The credential Pi stores for `grant`: the handle in place of the refresh token. */
export function piOAuthCredential(grant: PiOAuthGrant, handle: string): PiOAuthCredential {
  return { ...structuredClone(grant.fields), type: 'oauth', access: grant.access, refresh: handle, expires: grant.expires }
}

/**
 * Writes Pi's private `auth.json` (0600) with the instance provider's credential, or removes it when
 * the provider has none (an earlier sign-in must not outlive a sign-out).
 */
export function writePiAuth(home: string, providerId: string, credential: PiOAuthCredential | undefined): void {
  const path = join(home, 'auth.json')
  if (credential) atomicWriteJsonSync(path, { [providerId]: credential }, { mode: 0o600 })
  else rmSync(path, { force: true })
}

function jwtSubject(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown }
    return typeof payload?.sub === 'string' && payload.sub ? payload.sub : undefined
  } catch {
    return undefined
  }
}

/**
 * The stable identity claim of a stored OAuth credential (PR 2 §5 "Identity"), unchanged by a
 * refresh: the access token's JWT `sub`, else the account id pi-ai stores (`accountId`), else a
 * `credentialId` field; for GitHub Copilot, whose tokens are not JWTs and carry no account id, a
 * hash of its stored GitHub token, which a Copilot refresh keeps (`refresh: refreshToken`). Undefined
 * when the credential has none.
 */
export function oauthSubject(credential: unknown, provider?: string): string | undefined {
  const stored = credential as Record<string, unknown> | undefined
  if (!stored || typeof stored !== 'object' || stored.type !== 'oauth') return undefined
  const sub = jwtSubject(stored.access)
  if (sub) return `sub:${sub}`
  if (typeof stored.accountId === 'string' && stored.accountId) return `account:${stored.accountId}`
  if (typeof stored.credentialId === 'string' && stored.credentialId) return `credential:${stored.credentialId}`
  if (provider === 'github-copilot' && typeof stored.refresh === 'string' && stored.refresh)
    return `github:${createHash('sha256').update(stored.refresh).digest('hex')}`
  return undefined
}
