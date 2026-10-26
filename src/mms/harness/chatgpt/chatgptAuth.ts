import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { SecretCodec } from '../../providers/secretCodec'
import { discover, OPENAI_ENDPOINTS, type ChatGptEndpoints, type Discovery } from './discovery'
import { ChatGptAuthError, MESSAGES, type ChatGptFailure } from './errors'
import { ensureChatGptHostId } from './hostId'
import { verifyIdToken } from './idToken'
import { ChatGptLifecycle, revokeRefreshToken, type ChatGptAccess, type SignInCommitResult } from './lifecycle'
import { fetchChatGptModels, type ChatGptModel } from './models'
import { authorize, CALLBACK_PATH, exchangeCode, type AuthorizationGrant, type SignInInteraction } from './oauth'
import { activeSession, DIRECT_SCOPE, profileKeyOf, registrationOf, type ChatGptRegistration, type ChatGptStoreData } from './store'
import { isBearer } from './tokens'

/**
 * Sign in with ChatGPT for one instance: the facade a driver uses. It never logs or returns a
 * token except through `access()`, whose caller hands it to Codex's token helper.
 */

/** Why the active connection changed, for `onCredentialChange`. */
export type ChatGptCredentialChange = 'sign_in' | 'activation' | 'sign_out' | 'deletion'

export interface ChatGptAuthOptions {
  instanceId: string
  profileHome: string
  /** Holds the installation's host id, shared by its profiles. */
  installationHome: string
  endpoints?: ChatGptEndpoints
  codec?: SecretCodec
  lockWaitMs?: number
  /**
   * Runs after a change of the active connection is saved and before any remote revocation. The
   * managed runtime revokes the instance's broker leases and stops its app-servers here, so nothing
   * keeps using a token issued before the change.
   */
  onCredentialChange?: (change: ChatGptCredentialChange) => Promise<void>
}

/** `chatgpt` reconnects the last account, `chatgpt-new-account` registers another one. */
export type ChatGptSignInMethod = 'chatgpt' | 'chatgpt-new-account' | `chatgpt-profile:${string}`

export interface ChatGptSignInOption {
  id: ChatGptSignInMethod
  label: string
  description?: string
}

export interface ChatGptStatus {
  state: 'signed_in' | 'signed_out' | 'expired' | 'sharing_disabled' | 'unreadable'
  message?: string
  email?: string | null
  /** The connection's label ("Connection 2"). */
  label?: string
  /** A signed-out or replaced sign-in still waits for revocation at OpenAI. */
  revocationPending?: boolean
}

export interface ChatGptSignOutResult {
  /** Whether OpenAI confirmed the revocation (or there was nothing to revoke). */
  confirmed: boolean
  message?: string
}

/** The sign-in session part the flow needs; `LoginSession` provides it. */
export interface ChatGptLoginSession {
  createAuthCallbacks(options: { usesCallbackServer?: boolean }): SignInInteraction
}

const PROFILE_PREFIX = 'chatgpt-profile:'
const MAX_SAVED_OPTIONS = 30

/**
 * Sign-in attempts per store file in this process. Every new attempt, sign-out, activation and
 * deletion bumps it, so an attempt that finishes late saves nothing. Other processes are fenced by
 * the store's `signInFence`.
 */
const attempts = new Map<string, number>()

function nextAttempt(storePath: string): number {
  const next = (attempts.get(storePath) ?? 0) + 1
  attempts.set(storePath, next)
  return next
}

export class ChatGptAuth {
  readonly lifecycle: ChatGptLifecycle
  private readonly endpoints: ChatGptEndpoints

  constructor(private readonly options: ChatGptAuthOptions) {
    this.endpoints = options.endpoints ?? OPENAI_ENDPOINTS
    this.lifecycle = new ChatGptLifecycle({
      instanceId: options.instanceId,
      profileHome: options.profileHome,
      endpoints: this.endpoints,
      codec: options.codec,
      lockWaitMs: options.lockWaitMs
    })
  }

  private readQuietly(): ChatGptStoreData | null {
    try {
      return this.lifecycle.read()
    } catch {
      return null
    }
  }

  /** The sign-in choices: reconnect, a different account, and up to 30 saved connections. */
  signInOptions(): ChatGptSignInOption[] {
    const data = this.readQuietly()
    const last = data ? lastRegistration(data) : undefined
    return [
      { id: 'chatgpt', label: 'Continue with ChatGPT', ...(last?.email ? { description: `Reconnect ${last.email}` } : {}) },
      { id: 'chatgpt-new-account', label: 'Different account', description: 'Connect another ChatGPT account.' },
      ...(data?.registrations ?? []).slice(0, MAX_SAVED_OPTIONS).map((registration) => ({
        id: `${PROFILE_PREFIX}${registration.clientId}` as const,
        label: `${registration.email ?? 'ChatGPT account'} · ${registration.label}`
      }))
    ]
  }

  /** The connection's state from the store alone; no network. */
  status(): ChatGptStatus {
    let data: ChatGptStoreData
    try {
      data = this.lifecycle.read()
    } catch (error) {
      return { state: 'unreadable', message: error instanceof ChatGptAuthError ? error.message : MESSAGES.storageUnreadable }
    }
    const pending = data.pendingRevocations.length > 0 ? { revocationPending: true } : {}
    if (data.active === null) return { state: 'signed_out', message: MESSAGES.signedOut, ...pending }
    const registration = registrationOf(data, data.active)
    const who = { email: registration?.email ?? null, ...(registration ? { label: registration.label } : {}), ...pending }
    const session = activeSession(data)
    if (!session) return { state: 'expired', message: MESSAGES.expired, ...who }
    if (!session.scopes.includes(DIRECT_SCOPE)) return { state: 'sharing_disabled', message: MESSAGES.sharingDisabled, ...who }
    return { state: 'signed_in', ...who }
  }

  /** `chatgpt:<clientId>:<subject>` of the active connection, from the store. */
  identity(): string | undefined {
    const data = this.readQuietly()
    const session = data ? activeSession(data) : undefined
    const subject = session && data ? registrationOf(data, session.clientId)?.subject : undefined
    return session && subject ? `chatgpt:${session.clientId}:${subject}` : undefined
  }

  /** The active connection's profile key (see `profileKeyOf`). */
  profileKey(): string | undefined {
    const data = this.readQuietly()
    return data ? profileKeyOf(data) : undefined
  }

  access(expectedProfileKey?: string, signal?: AbortSignal): Promise<ChatGptAccess> {
    return this.lifecycle.access(expectedProfileKey, signal)
  }

  /** The plan's models, with a fresh token. */
  async listModels(signal?: AbortSignal): Promise<ChatGptModel[]> {
    const { accessToken } = await this.access(undefined, signal)
    return fetchChatGptModels(this.endpoints.apiBaseUrl, accessToken, signal)
  }

  /** Runs a sign-in in `session`. A cancelled, superseded or failed attempt saves nothing. */
  async signIn(session: ChatGptLoginSession, method: string = 'chatgpt'): Promise<ProviderLoginResult & { failure?: ChatGptFailure }> {
    const interaction = session.createAuthCallbacks({ usesCallbackServer: true })
    const storePath = this.lifecycle.store.path
    const attempt = nextAttempt(storePath)
    try {
      await this.runSignIn(interaction, method, () => attempts.get(storePath) === attempt && !interaction.signal.aborted)
      return { success: true }
    } catch (error) {
      if (interaction.signal.aborted) return { success: false, error: MESSAGES.cancelled, failure: 'cancelled' }
      if (error instanceof ChatGptAuthError) return { success: false, error: error.message, failure: error.failure }
      // Unknown errors may quote a response; never echo them.
      return { success: false, error: MESSAGES.callbackFailed }
    }
  }

  private async runSignIn(interaction: SignInInteraction, method: string, stillCurrent: () => boolean): Promise<void> {
    const signal = interaction.signal
    // Before the browser opens: a connection that could not be saved fails here, not after it.
    const start = this.lifecycle.prepareSignIn()
    const hostId = ensureChatGptHostId(this.options.installationHome)
    const discovery = await discover(this.endpoints, signal)
    const registration = start.data ? target(start.data, method) : undefined
    const saved = registration && start.data ? start.data.sessions.find((entry) => entry.clientId === registration.clientId) : undefined
    const consent = registration !== undefined && (!registration.sharing || (saved !== undefined && !saved.scopes.includes(DIRECT_SCOPE)))
    const grant = await authorize({ discovery, hostId, registration, consent, interaction })
    try {
      await this.finishSignIn(interaction, grant, discovery, registration, start.fence, stillCurrent)
    } finally {
      grant.close()
    }
  }

  private async finishSignIn(
    interaction: SignInInteraction,
    grant: AuthorizationGrant,
    discovery: Discovery,
    registration: ChatGptRegistration | undefined,
    fence: number | null,
    stillCurrent: () => boolean
  ): Promise<void> {
    const signal = interaction.signal
    interaction.notify({ type: 'progress', message: 'Verifying your ChatGPT sign-in…' })
    let tokens
    try {
      tokens = await exchangeCode(discovery, grant, signal)
    } catch (error) {
      // The code expired before it was used: keep the new registration so a retry reuses it.
      if (error instanceof ChatGptAuthError && error.failure === 'code_expired' && !registration && stillCurrent()) {
        await this.lifecycle.saveRegistration(grant.clientId, CALLBACK_PATH, fence)
      }
      throw error
    }
    let result: SignInCommitResult
    try {
      if (!tokens.idToken) throw new ChatGptAuthError('signed_out', 'verify', MESSAGES.noIdentity)
      if (!isBearer(tokens)) throw new ChatGptAuthError('signed_out', 'invalid_response', MESSAGES.unsupportedToken)
      const identity = await verifyIdToken(tokens.idToken, { keys: discovery.jwks, issuer: discovery.issuer, clientId: grant.clientId, nonce: grant.nonce })
      if (registration?.subject && identity.subject !== registration.subject) {
        throw new ChatGptAuthError('signed_out', 'subject_mismatch', MESSAGES.differentAccount)
      }
      result = await this.lifecycle.commitSignIn(
        {
          clientId: grant.clientId,
          subject: identity.subject,
          email: identity.email,
          redirectPath: CALLBACK_PATH,
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
          earliestRefreshAt: tokens.earliestRefreshAt,
          scopes: tokens.scopes,
          ...(registration ? { reauthOf: registration.clientId } : {}),
          fence,
          stillCurrent
        },
        signal
      )
    } catch (error) {
      // OpenAI issued a grant that is not kept (refused, cancelled or superseded). Nothing used
      // it, so it is revoked at once (best effort).
      if (tokens.refreshToken) await revokeRefreshToken(this.endpoints, { clientId: grant.clientId, refreshToken: tokens.refreshToken })
      throw error
    }
    // Every commit moves the credential epoch on, so whatever ran on the old key must stop
    // before a session this sign-in replaced is revoked.
    await this.afterChange('sign_in')
    if (!result.sharing) {
      throw new ChatGptAuthError(
        'signed_out',
        'sharing_disabled',
        result.keptClientId
          ? "ChatGPT plan use wasn't enabled for this account. Your current connection is unchanged."
          : MESSAGES.sharingDisabled
      )
    }
  }

  /**
   * Runs the stop hook, then revokes every pending refresh token and settles them. If the hook
   * throws, the tokens stay pending (encrypted in the store) and the error propagates; the next
   * change or sign-out retries both. Returns whether every revocation was confirmed.
   */
  private async afterChange(change: ChatGptCredentialChange): Promise<boolean> {
    await this.options.onCredentialChange?.(change)
    const pending = this.lifecycle.pendingRevocations()
    if (!pending.length) return true
    const results = await Promise.all(pending.map((token) => revokeRefreshToken(this.endpoints, token)))
    await this.lifecycle.settleRevocations(pending)
    return results.every(Boolean)
  }

  /** Switches to another saved connection that still has tokens. */
  async activate(clientId: string, signal?: AbortSignal): Promise<string> {
    nextAttempt(this.lifecycle.store.path)
    const profileKey = await this.lifecycle.activate(clientId, signal)
    await this.afterChange('activation')
    return profileKey
  }

  /**
   * Signs out in Mousse, then stops what used the connection, then revokes the refresh token at
   * OpenAI. The registration and the host id are kept for a later reconnect. If stopping fails,
   * the revocation stays pending and this rejects; signing out again retries it.
   */
  async signOut(signal?: AbortSignal): Promise<ChatGptSignOutResult> {
    nextAttempt(this.lifecycle.store.path)
    await this.lifecycle.signOut(signal)
    return (await this.afterChange('sign_out')) ? { confirmed: true } : { confirmed: false, message: MESSAGES.revocationUnconfirmed }
  }

  /** Deletes the instance's connections, then stops what used them, then revokes every refresh token. */
  async deleteInstance(signal?: AbortSignal): Promise<ChatGptSignOutResult> {
    nextAttempt(this.lifecycle.store.path)
    await this.lifecycle.deleteInstance(signal)
    return (await this.afterChange('deletion')) ? { confirmed: true } : { confirmed: false, message: MESSAGES.revocationUnconfirmed }
  }
}

function lastRegistration(data: ChatGptStoreData): ChatGptRegistration | undefined {
  return (data.active !== null ? registrationOf(data, data.active) : undefined) ?? data.registrations[0]
}

/** The saved registration a method signs in again, or undefined to register a new client. */
function target(data: ChatGptStoreData, method: string): ChatGptRegistration | undefined {
  if (method === 'chatgpt-new-account') return undefined
  if (method.startsWith(PROFILE_PREFIX)) {
    const registration = registrationOf(data, method.slice(PROFILE_PREFIX.length))
    if (!registration) throw new ChatGptAuthError('signed_out', 'signed_out', MESSAGES.unknownRegistration)
    return registration
  }
  return lastRegistration(data)
}
