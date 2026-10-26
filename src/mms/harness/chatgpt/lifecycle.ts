// Refresh, revocation and sign-out rules follow T3 Code `apps/server/src/provider/CodexChatGptAuth.ts`
// (MIT, Copyright (c) 2026 T3 Tools Inc.). See THIRD_PARTY_NOTICES.md.

import { FileLockBusyError, withAsyncFileLock } from '../../platform/asyncFileLock'
import type { SecretCodec } from '../../providers/secretCodec'
import { discover, OPENAI_ENDPOINTS, type ChatGptEndpoints } from './discovery'
import { cancelled, ChatGptAuthError, MESSAGES, transient } from './errors'
import { delay, oauthErrorCode, postForm, retryAt } from './http'
import {
  activeSession,
  chatgptLockPath,
  chatgptStorePath,
  ChatGptStore,
  DIRECT_SCOPE,
  emptyStore,
  profileKeyOf,
  registrationOf,
  type ChatGptRegistration,
  type ChatGptSession,
  type ChatGptStoreData,
  type RevocableToken
} from './store'
import { isBearer, OPENAI_RESOURCE, parseTokenResponse, TERMINAL_REFRESH_ERRORS } from './tokens'

export type { RevocableToken } from './store'

/**
 * Every change to an instance's ChatGPT connections runs here, under one cross-process lock
 * (`<profileHome>/harness/<instanceId>/chatgpt.lock`), and re-reads the store inside it: access
 * (refresh), the sign-in commit, activating a saved connection, sign-out and instance deletion.
 *
 * A refresh that has sent its POST finishes and saves its result even when its caller aborts,
 * because the old refresh token is spent. Holding the lock throughout means a sign-out or an
 * activation waits for that save and then sees the rotated tokens; a refresh can never write
 * over them.
 *
 * Sign-out, activation and deletion move `signInFence` on. A sign-in records the fence when it
 * starts and its commit saves nothing if the fence moved, so a sign-in that finishes late (in this
 * process or another) never undoes them.
 *
 * Refresh tokens taken out of use go to `pendingRevocations` in the same write. The caller revokes
 * them only after it stopped what used them, then settles them here.
 *
 * The lock gives mutual exclusion, but a lease cannot stop a suspended process from resuming after
 * the lock was reclaimed from it. Correctness therefore rests on the store's revision: every write
 * must find the revision its critical section read, or it is refused (`operation_busy`).
 */

/** Refresh when less than this much life is left. */
export const REFRESH_MARGIN_MS = 3 * 60_000
export const LOCK_WAIT_MS = 40_000
/**
 * A lock owner older than this is stale even if its pid runs (pid reuse after a crash). Every
 * operation under the lock is bounded far below it: discovery 10 s, the token request 20 s.
 */
export const LOCK_MAX_HOLD_MS = 5 * 60_000
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

/** What a sign-in reads before it opens the browser. */
export interface SignInStart {
  /** The saved connections. */
  data: ChatGptStoreData
  /** The fence the commit must still find. */
  fence: number
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
  /** The `signInFence` when the attempt started; the commit fails if it moved. */
  fence: number
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

type StoreReader = () => ChatGptStoreData

const failure = {
  signedOut: () => new ChatGptAuthError('signed_out', 'signed_out', MESSAGES.signedOut),
  expired: () => new ChatGptAuthError('auth_expired', 'expired', MESSAGES.expired),
  sharingDisabled: () => new ChatGptAuthError('signed_out', 'sharing_disabled', MESSAGES.sharingDisabled),
  accountChanged: () => new ChatGptAuthError('auth_expired', 'account_changed', MESSAGES.accountChanged),
  invalidClient: () => new ChatGptAuthError('wont_run', 'invalid_client', MESSAGES.invalidClient),
  invalidRenewal: () => new ChatGptAuthError('protocol', 'invalid_response', MESSAGES.invalidRenewal),
  superseded: () => new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.superseded)
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

function sameToken(a: RevocableToken, b: RevocableToken): boolean {
  return a.clientId === b.clientId && a.refreshToken === b.refreshToken
}

/** Adds tokens to the pending revocations, once each. */
function retire(data: ChatGptStoreData, tokens: RevocableToken[]): void {
  for (const token of tokens) if (!data.pendingRevocations.some((entry) => sameToken(entry, token))) data.pendingRevocations.push(token)
}

function tokenOf(session: ChatGptSession | undefined): RevocableToken[] {
  return session?.refreshToken ? [{ clientId: session.clientId, refreshToken: session.refreshToken }] : []
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
      return await withAsyncFileLock(this.lockPath, async () => fn(() => this.store.read()), {
        waitMs: this.lockWaitMs,
        maxHoldMs: LOCK_MAX_HOLD_MS,
        signal
      })
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
   * Runs under the lock before the browser opens. It checks that a sign-in could be saved (the vault
   * can seal the store), and fails typed for a file this host cannot decrypt or a newer Mousse
   * wrote, never touching it. A corrupt file is set aside here and replaced by an empty store with
   * a fresh fence, so every attempt holds a durable fence its commit compares.
   */
  prepareSignIn(signal?: AbortSignal): Promise<SignInStart> {
    return this.locked((read) => {
      let data: ChatGptStoreData
      try {
        data = read()
      } catch (error) {
        if (!(error instanceof ChatGptAuthError) || error.failure !== 'storage') throw error
        // Corrupt: check the vault could seal a replacement, then set it aside with a new fence.
        this.store.assertWritable()
        data = this.store.recover()
      }
      this.store.assertWritable()
      return { data, fence: data.signInFence }
    }, signal)
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
        throw transient(MESSAGES.transient)
      }
      if (!response.ok) {
        const code = oauthErrorCode(response.body)
        if (code !== undefined && TERMINAL_REFRESH_ERRORS.has(code)) {
          this.endSession(data, session.clientId)
          throw failure.expired()
        }
        if (code === 'invalid_client') throw failure.invalidClient()
        if (response.status === 429 || response.status >= 500) throw transient(MESSAGES.transient, response.status, retryAt(response.retryAfter))
        throw failure.invalidRenewal()
      }
      const tokens = parseTokenResponse(response.body, { message: MESSAGES.invalidRenewal, fallbackScopes: session.scopes })
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
      try {
        this.store.write(data)
      } catch (error) {
        // Another process changed the store while the request was out, so this renewal is not
        // kept. Its new refresh token is valid at OpenAI and unused: retire it for revocation.
        if (error instanceof ChatGptAuthError && error.code === 'operation_busy') this.retireUnkept({ clientId: session.clientId, refreshToken: tokens.refreshToken })
        throw error
      }
      if (signal?.aborted) throw cancelled()
      if (!sharing) throw failure.sharingDisabled()
      return grant(refreshed, profileKey)
    }, signal)
  }

  /** Adds a token nothing keeps to the pending revocations of the current state (one try). */
  private retireUnkept(token: RevocableToken): void {
    try {
      const latest = this.store.read()
      retire(latest, [token])
      this.store.write(latest)
    } catch {
      // The state keeps changing or cannot be read; the token expires unused.
    }
  }

  /** A terminal refresh error: drops the tokens, keeps the registration and the active choice. */
  private endSession(data: ChatGptStoreData, clientId: string): void {
    data.sessions = data.sessions.filter((entry) => entry.clientId !== clientId)
    data.credentialEpoch++
    this.store.write(data)
  }

  /**
   * Saves a verified sign-in. Its connection becomes active when it allows plan use, or when no
   * other connection is usable. Fails without saving when the attempt is no longer current (the
   * fence moved, or it was cancelled or superseded) or the account conflicts with the saved
   * registration. A session it replaces goes to the pending revocations.
   */
  commitSignIn(commit: SignInCommit, signal?: AbortSignal): Promise<SignInCommitResult> {
    return this.locked((read) => {
      const data = read()
      if (!commit.stillCurrent() || signal?.aborted) throw cancelled()
      if (data.signInFence !== commit.fence) throw failure.superseded()
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
      retire(data, tokenOf(data.sessions.find((entry) => entry.clientId === commit.clientId)))
      data.sessions = [...data.sessions.filter((entry) => entry.clientId !== commit.clientId), session]
      const current = activeSession(data)
      const currentUsable = current !== undefined && current.clientId !== commit.clientId && current.scopes.includes(DIRECT_SCOPE)
      const activated = sharing || !currentUsable
      const keptClientId = activated ? undefined : current?.clientId
      if (activated) data.active = commit.clientId
      data.credentialEpoch++
      data.signInFence++
      this.store.write(data)
      return { activated, sharing, ...(keptClientId ? { keptClientId } : {}), profileKey: profileKeyOf(data) }
    }, signal)
  }

  /**
   * Remembers a registration whose first sign-in did not finish (the code expired), so the next
   * attempt reuses it instead of registering again. Does not touch the active connection, and does
   * nothing if the fence moved since the attempt started.
   */
  saveRegistration(clientId: string, redirectPath: string, fence: number): Promise<void> {
    return this.locked((read) => {
      const data = read()
      if (data.signInFence !== fence) return
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
      data.signInFence++
      this.store.write(data)
      return profileKeyOf(data)!
    }, signal)
  }

  /**
   * Signs the active connection out in Mousse: drops its tokens, keeps the registration, and moves
   * its refresh token to the pending revocations. It also ends any sign-in still in progress, even
   * when nothing was signed in.
   */
  signOut(signal?: AbortSignal): Promise<void> {
    return this.locked((read) => {
      const data = read()
      retire(data, tokenOf(activeSession(data)))
      if (data.active !== null) {
        data.sessions = data.sessions.filter((entry) => entry.clientId !== data.active)
        data.active = null
        data.credentialEpoch++
      }
      data.signInFence++
      this.store.write(data)
    }, signal)
  }

  /**
   * Deletes the instance's connections. What stays is an empty store that keeps the fence (so a
   * sign-in still in progress cannot recreate the connection) and every refresh token, pending
   * revocation. A corrupt file is replaced; one this host cannot read fails typed and stays.
   */
  deleteInstance(signal?: AbortSignal): Promise<void> {
    return this.locked((read) => {
      let data: ChatGptStoreData
      try {
        data = read()
      } catch (error) {
        if (!(error instanceof ChatGptAuthError) || error.failure !== 'storage') throw error
        // Corrupt: set it aside (the fence moves on); nothing readable to revoke.
        data = this.store.recover()
      }
      const tombstone: ChatGptStoreData = {
        ...emptyStore(),
        revision: data.revision,
        incarnation: data.incarnation,
        credentialEpoch: data.credentialEpoch + 1,
        signInFence: data.signInFence + 1,
        pendingRevocations: [...data.pendingRevocations]
      }
      retire(tombstone, data.sessions.flatMap((session) => tokenOf(session)))
      this.store.write(tombstone)
    }, signal)
  }

  /** The refresh tokens still waiting for revocation. Fails typed when the store cannot be read. */
  pendingRevocations(): RevocableToken[] {
    return this.store.read().pendingRevocations
  }

  /** Drops tokens whose revocation was attempted. */
  settleRevocations(tokens: RevocableToken[]): Promise<void> {
    return this.locked((read) => {
      const data = read()
      const before = data.pendingRevocations.length
      data.pendingRevocations = data.pendingRevocations.filter((entry) => !tokens.some((token) => sameToken(entry, token)))
      if (data.pendingRevocations.length !== before) this.store.write(data)
    })
  }
}

/**
 * Revokes a refresh token at the issuer's revocation endpoint: up to 3 tries, 10 s each, with
 * 250 ms and 1 s between them. An empty 200 confirms it; 5xx and network errors are retried.
 */
export async function revokeRefreshToken(
  endpoints: ChatGptEndpoints,
  token: RevocableToken,
  options: { attempts?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const attempts = options.attempts ?? 3
  const timeoutMs = options.timeoutMs ?? REVOKE_TIMEOUT_MS
  for (let attempt = 0; attempt < attempts; attempt++) {
    let retry = true
    try {
      const discovery = await discover(endpoints)
      const response = await postForm(
        discovery.revocationEndpoint,
        { token: token.refreshToken, token_type_hint: 'refresh_token', client_id: token.clientId },
        { timeoutMs }
      )
      if (response.status === 200) return true
      retry = response.status >= 500 || response.status === 429
    } catch {
      retry = true
    }
    if (!retry || attempt === attempts - 1) break
    await delay(REVOKE_BACKOFF_MS[attempt])
  }
  return false
}
