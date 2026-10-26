// Refresh, revocation and sign-out rules follow T3 Code `apps/server/src/provider/CodexChatGptAuth.ts`
// (MIT, Copyright (c) 2026 T3 Tools Inc.). See THIRD_PARTY_NOTICES.md.

import { FileLockBusyError, withAsyncFileLock } from '../../platform/asyncFileLock'
import type { SecretCodec } from '../../providers/secretCodec'
import { discover, OPENAI_ENDPOINTS, type ChatGptEndpoints } from './discovery'
import { cancelled, ChatGptAuthError, MESSAGES } from './errors'
import { delay, oauthErrorCode, postForm } from './http'
import {
  activeSession,
  chatgptLockPath,
  chatgptStorePath,
  ChatGptStore,
  DIRECT_SCOPE,
  profileKeyOf,
  registrationOf,
  type ChatGptRegistration,
  type ChatGptSession,
  type ChatGptStoreData
} from './store'
import { isBearer, OPENAI_RESOURCE, parseTokenResponse, TERMINAL_REFRESH_ERRORS } from './tokens'

/**
 * Every change to an instance's ChatGPT connections runs here, under one cross-process lock
 * (`<profileHome>/harness/<instanceId>/chatgpt.lock`), and re-reads the store inside it: access
 * (refresh), the sign-in commit, activating a saved connection, sign-out and instance deletion.
 *
 * A refresh that has sent its POST finishes and saves its result even when its caller aborts,
 * because the old refresh token is spent. Holding the lock throughout means a sign-out or an
 * activation waits for that save and then sees the rotated tokens; a refresh can never write
 * over them.
 */

/** Refresh when less than this much life is left. */
export const REFRESH_MARGIN_MS = 3 * 60_000
export const LOCK_WAIT_MS = 40_000
const TOKEN_TIMEOUT_MS = 20_000
const REVOKE_TIMEOUT_MS = 10_000
const REVOKE_BACKOFF_MS = [250, 1_000]

export interface ChatGptLifecycleOptions {
  instanceId: string
  profileHome: string
  endpoints?: ChatGptEndpoints
  codec?: SecretCodec
  lockWaitMs?: number
}

/** A usable access token and the connection it belongs to. */
export interface ChatGptAccess {
  accessToken: string
  expiresAt: number
  clientId: string
  profileKey: string
}

/** A verified sign-in, ready to save. */
export interface SignInCommit {
  clientId: string
  subject: string
  email: string | null
  redirectPath: string
  idToken: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  earliestRefreshAt: number | null
  scopes: string[]
  /** The saved registration this sign-in renewed; its subject must not change. */
  reauthOf?: string
  /** False once the attempt was cancelled or a newer one started: nothing is saved. */
  stillCurrent: () => boolean
}

export interface SignInCommitResult {
  /** Whether this connection is now the active one. */
  activated: boolean
  /** Whether the grant allows ChatGPT plan use. */
  sharing: boolean
  /** The connection that was active before, when it was another one and stays active. */
  keptClientId?: string
  profileKey: string | undefined
}

/** A refresh token to revoke at OpenAI once the local change is saved. */
export interface RevocableToken {
  clientId: string
  refreshToken: string
}

type StoreReader = (options?: { discardUnreadable?: boolean }) => ChatGptStoreData

const failure = {
  signedOut: () => new ChatGptAuthError('signed_out', 'signed_out', MESSAGES.signedOut),
  expired: () => new ChatGptAuthError('auth_expired', 'expired', MESSAGES.expired),
  sharingDisabled: () => new ChatGptAuthError('signed_out', 'sharing_disabled', MESSAGES.sharingDisabled),
  accountChanged: () => new ChatGptAuthError('auth_expired', 'account_changed', MESSAGES.accountChanged),
  invalidClient: () => new ChatGptAuthError('wont_run', 'invalid_client', MESSAGES.invalidClient),
  network: () => new ChatGptAuthError('timeout', 'transient', MESSAGES.transient),
  unavailable: () => new ChatGptAuthError('protocol', 'transient', MESSAGES.transient),
  invalidRenewal: () => new ChatGptAuthError('protocol', 'invalid_response', MESSAGES.invalidRenewal)
}

function grant(session: ChatGptSession, profileKey: string): ChatGptAccess {
  return { accessToken: session.accessToken, expiresAt: session.expiresAt, clientId: session.clientId, profileKey }
}

/** Puts `registration` first (most recently used), replacing an older copy. */
function promote(data: ChatGptStoreData, registration: ChatGptRegistration): void {
  data.registrations = [registration, ...data.registrations.filter((entry) => entry.clientId !== registration.clientId)]
}

function nextLabel(data: ChatGptStoreData): string {
  const used = new Set(data.registrations.map((registration) => registration.label))
  for (let n = data.registrations.length + 1; ; n++) if (!used.has(`Connection ${n}`)) return `Connection ${n}`
}

export class ChatGptLifecycle {
  readonly store: ChatGptStore
  readonly lockPath: string
  readonly endpoints: ChatGptEndpoints
  private readonly lockWaitMs: number

  constructor(options: ChatGptLifecycleOptions) {
    this.store = new ChatGptStore(chatgptStorePath(options.profileHome, options.instanceId), options.codec)
    this.lockPath = chatgptLockPath(options.profileHome, options.instanceId)
    this.endpoints = options.endpoints ?? OPENAI_ENDPOINTS
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
  }

  /** Runs `fn` on a fresh read of the store, holding the instance's lock. */
  private async locked<T>(fn: (read: StoreReader) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    try {
      return await withAsyncFileLock(this.lockPath, async () => fn((options) => this.store.read(options)), { waitMs: this.lockWaitMs, signal })
    } catch (error) {
      if (error instanceof FileLockBusyError) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.busy)
      if (signal?.aborted && !(error instanceof ChatGptAuthError)) throw cancelled()
      throw error
    }
  }

  /** The store as saved now, without the lock. For status and display; never for a change. */
  read(): ChatGptStoreData {
    return this.store.read()
  }

  /**
   * A usable access token, refreshed when less than 3 minutes are left. With `expectedProfileKey`,
   * fails `auth_expired` when the active connection is no longer the one the caller started on.
   */
  access(expectedProfileKey?: string, signal?: AbortSignal): Promise<ChatGptAccess> {
    return this.locked(async (read) => {
      const data = read()
      const session = activeSession(data)
      if (!session) throw data.active === null ? failure.signedOut() : failure.expired()
      const profileKey = profileKeyOf(data)!
      if (expectedProfileKey !== undefined && profileKey !== expectedProfileKey) throw failure.accountChanged()
      if (!session.scopes.includes(DIRECT_SCOPE)) throw failure.sharingDisabled()
      const now = Date.now()
      if (session.expiresAt - now > REFRESH_MARGIN_MS) return grant(session, profileKey)
      if (session.earliestRefreshAt !== null && session.earliestRefreshAt > now) {
        if (session.expiresAt > now) return grant(session, profileKey)
        throw new ChatGptAuthError('rate_limited', 'refresh_not_yet', MESSAGES.refreshNotYet, new Date(session.earliestRefreshAt).toISOString())
      }
      if (!session.refreshToken) {
        this.endSession(data, session.clientId)
        throw failure.expired()
      }
      const discovery = await discover(this.endpoints, signal)
      signal?.throwIfAborted()
      // The POST spends the refresh token. From here the outcome is saved whatever the caller does.
      let response
      try {
        response = await postForm(
          discovery.tokenEndpoint,
          { grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource: OPENAI_RESOURCE },
          { timeoutMs: TOKEN_TIMEOUT_MS }
        )
      } catch {
        // No answer: the token may or may not be spent. Keep it; the next attempt finds out.
        throw failure.network()
      }
      if (!response.ok) {
        const code = oauthErrorCode(response.body)
        if (code !== undefined && TERMINAL_REFRESH_ERRORS.has(code)) {
          this.endSession(data, session.clientId)
          throw failure.expired()
        }
        if (code === 'invalid_client') throw failure.invalidClient()
        if (response.status >= 500) throw failure.unavailable()
        throw failure.invalidRenewal()
      }
      const tokens = parseTokenResponse(response.body, MESSAGES.invalidRenewal)
      if (!tokens.refreshToken || !isBearer(tokens)) throw failure.invalidRenewal()
      const refreshed: ChatGptSession = {
        ...session,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        // The sign-in's ID token stays, so a refresh never changes the profile key.
        idToken: session.idToken,
        expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
        earliestRefreshAt: tokens.earliestRefreshAt,
        scopes: tokens.scopes,
        savedAt: Date.now()
      }
      data.sessions = data.sessions.map((entry) => (entry.clientId === session.clientId ? refreshed : entry))
      const sharing = refreshed.scopes.includes(DIRECT_SCOPE)
      const registration = registrationOf(data, session.clientId)
      if (registration && registration.sharing !== sharing) {
        data.registrations = data.registrations.map((entry) => (entry.clientId === session.clientId ? { ...entry, sharing } : entry))
      }
      this.store.write(data)
      if (signal?.aborted) throw cancelled()
      if (!sharing) throw failure.sharingDisabled()
      return grant(refreshed, profileKey)
    }, signal)
  }

  /** A terminal refresh error: drops the tokens, keeps the registration and the active choice. */
  private endSession(data: ChatGptStoreData, clientId: string): void {
    data.sessions = data.sessions.filter((entry) => entry.clientId !== clientId)
    data.credentialEpoch++
    this.store.write(data)
  }

  /**
   * Saves a verified sign-in. Its connection becomes active when it allows plan use, or when no
   * other connection is usable. Fails without saving when the attempt is no longer current or the
   * account conflicts with the saved registration.
   */
  commitSignIn(commit: SignInCommit, signal?: AbortSignal): Promise<SignInCommitResult> {
    return this.locked((read) => {
      const data = read({ discardUnreadable: true })
      if (!commit.stillCurrent() || signal?.aborted) throw cancelled()
      const known = registrationOf(data, commit.clientId)
      if (commit.reauthOf !== undefined && known?.subject && known.subject !== commit.subject) {
        throw new ChatGptAuthError('signed_out', 'subject_mismatch', MESSAGES.differentAccount)
      }
      if (known && ((known.subject && known.subject !== commit.subject) || known.redirectPath !== commit.redirectPath)) {
        throw new ChatGptAuthError('signed_out', 'registration', MESSAGES.conflictingRegistration)
      }
      const sharing = commit.scopes.includes(DIRECT_SCOPE)
      promote(data, {
        clientId: commit.clientId,
        subject: commit.subject,
        email: commit.email,
        label: known?.label ?? nextLabel(data),
        redirectPath: commit.redirectPath,
        sharing
      })
      const session: ChatGptSession = {
        clientId: commit.clientId,
        accessToken: commit.accessToken,
        refreshToken: commit.refreshToken,
        idToken: commit.idToken,
        expiresAt: commit.expiresAt,
        earliestRefreshAt: commit.earliestRefreshAt,
        scopes: commit.scopes,
        savedAt: Date.now()
      }
      data.sessions = [...data.sessions.filter((entry) => entry.clientId !== commit.clientId), session]
      const current = activeSession(data)
      const currentUsable = current !== undefined && current.clientId !== commit.clientId && current.scopes.includes(DIRECT_SCOPE)
      const activated = sharing || !currentUsable
      const keptClientId = activated ? undefined : current?.clientId
      if (activated) data.active = commit.clientId
      data.credentialEpoch++
      this.store.write(data)
      return { activated, sharing, ...(keptClientId ? { keptClientId } : {}), profileKey: profileKeyOf(data) }
    }, signal)
  }

  /**
   * Remembers a registration whose first sign-in did not finish (the code expired), so the next
   * attempt reuses it instead of registering again. Does not touch the active connection.
   */
  saveRegistration(clientId: string, redirectPath: string): Promise<void> {
    return this.locked((read) => {
      const data = read({ discardUnreadable: true })
      if (registrationOf(data, clientId)) return
      data.registrations = [...data.registrations, { clientId, subject: null, email: null, label: nextLabel(data), redirectPath, sharing: true }]
      this.store.write(data)
    })
  }

  /** Makes another saved connection with tokens the active one. Returns the new profile key. */
  activate(clientId: string, signal?: AbortSignal): Promise<string> {
    return this.locked((read) => {
      const data = read()
      const registration = registrationOf(data, clientId)
      const session = data.sessions.find((entry) => entry.clientId === clientId)
      if (!registration || !session) throw new ChatGptAuthError('signed_out', 'signed_out', MESSAGES.unknownRegistration)
      if (!session.scopes.includes(DIRECT_SCOPE)) throw failure.sharingDisabled()
      data.active = clientId
      promote(data, registration)
      data.credentialEpoch++
      this.store.write(data)
      return profileKeyOf(data)!
    }, signal)
  }

  /**
   * Signs the active connection out in Mousse: drops its tokens and keeps the registration. Returns
   * the refresh token to revoke at OpenAI once the instance's processes are stopped.
   */
  signOut(signal?: AbortSignal): Promise<RevocableToken | null> {
    return this.locked((read) => {
      const data = read()
      if (data.active === null) return null
      const session = activeSession(data)
      data.sessions = data.sessions.filter((entry) => entry.clientId !== data.active)
      data.active = null
      data.credentialEpoch++
      this.store.write(data)
      return session?.refreshToken ? { clientId: session.clientId, refreshToken: session.refreshToken } : null
    }, signal)
  }

  /** Deletes the instance's connections. Returns every refresh token to revoke. */
  deleteInstance(signal?: AbortSignal): Promise<RevocableToken[]> {
    return this.locked((read) => {
      let tokens: RevocableToken[] = []
      try {
        tokens = read().sessions.flatMap((session) => (session.refreshToken ? [{ clientId: session.clientId, refreshToken: session.refreshToken }] : []))
      } catch {
        // An unreadable store has nothing to revoke; delete it anyway.
      }
      this.store.remove()
      return tokens
    }, signal)
  }
}

/**
 * Revokes a refresh token at the issuer's revocation endpoint: up to 3 tries, 10 s each, with
 * 250 ms and 1 s between them. An empty 200 confirms it; 5xx and network errors are retried.
 */
export async function revokeRefreshToken(endpoints: ChatGptEndpoints, token: RevocableToken): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let retry = true
    try {
      const discovery = await discover(endpoints)
      const response = await postForm(
        discovery.revocationEndpoint,
        { token: token.refreshToken, token_type_hint: 'refresh_token', client_id: token.clientId },
        { timeoutMs: REVOKE_TIMEOUT_MS }
      )
      if (response.status === 200) return true
      retry = response.status >= 500
    } catch {
      retry = true
    }
    if (!retry || attempt === 2) break
    await delay(REVOKE_BACKOFF_MS[attempt])
  }
  return false
}
