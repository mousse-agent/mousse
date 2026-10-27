import type { OAuthCredential, Provider } from '@earendil-works/pi-ai'
import { CREDENTIAL_UNAVAILABLE } from './messages'
import type { PiCredentialRequest, PiCredentialResponse, PiOAuthCredential } from './protocol'

/**
 * The OAuth broker's extension side (PR 2 §5 "OAuth broker"). An OAuth provider keeps pi-ai's stock
 * `auth.oauth` (`name`, `isSubscription`, `toAuth`, so Copilot's token-derived `baseUrl` and Kimi's
 * Bearer header stay); only `refresh` is replaced. Pi calls it inside `credentials.modify` when its
 * stored access token is about to expire, and it asks Mousse over `/pi/credential` with the opaque
 * handle Pi holds: Mousse is the only refresher, and Pi never sees a real refresh token. Sign-in
 * stays refused by `guardProvider`.
 */

/** Posts a `/pi/credential` request on the bridge. */
export type PiCredentialPost = (request: PiCredentialRequest, signal?: AbortSignal) => Promise<PiCredentialResponse>

/** Whether `value` is a credential Pi may store for the handle it asked with. */
function usable(value: unknown, handle: string): value is PiOAuthCredential {
  const credential = value as Partial<PiOAuthCredential> | undefined
  return (
    typeof credential === 'object' && credential !== null &&
    credential.type === 'oauth' &&
    typeof credential.access === 'string' && credential.access.length > 0 &&
    credential.refresh === handle &&
    typeof credential.expires === 'number' && Number.isFinite(credential.expires)
  )
}

/** A copy of `value` (own fields and prototype, so class methods survive) with `patch` over it. */
function override<T extends object>(value: T, patch: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(value) as object) as T, value, patch)
}

/**
 * `provider` with its OAuth `refresh` brokered by Mousse; a provider without OAuth is returned as is.
 * Any failure, transport included, throws `CREDENTIAL_UNAVAILABLE` and never the upstream text.
 */
export function brokerOAuth(provider: Provider, post: PiCredentialPost): Provider {
  const oauth = provider.auth.oauth
  if (!oauth) return provider
  const refresh = async (credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> => {
    const handle = typeof credential?.refresh === 'string' ? credential.refresh : ''
    let answer: PiCredentialResponse | undefined
    try {
      answer = await post({ providerId: provider.id, handle }, signal)
    } catch {
      throw new Error(CREDENTIAL_UNAVAILABLE)
    }
    if (!handle || !usable(answer?.credential, handle)) throw new Error(CREDENTIAL_UNAVAILABLE)
    return answer.credential
  }
  return override(provider, { auth: { ...provider.auth, oauth: override(oauth, { refresh }) } })
}
