import type { HarnessError, HarnessErrorCode } from '../../../shared/harness/types'

/** What went wrong, finer than the harness code. Callers branch on this, never on the message. */
export type ChatGptFailure =
  /** No ChatGPT account is connected. */
  | 'signed_out'
  /** The connection expired or was revoked; the registration is kept for a reconnect. */
  | 'expired'
  /** The grant lacks `chatgpt.tokens.use.direct`. */
  | 'sharing_disabled'
  /** The connection changed since the caller's profile key was issued. */
  | 'account_changed'
  /** OpenAI asked to wait before the next renewal, and the token has run out. */
  | 'refresh_not_yet'
  /** OpenAI rejected the app's client registration. */
  | 'invalid_client'
  /** A network error, a timeout or a 5xx; the saved tokens are kept. */
  | 'transient'
  /** OpenAI answered with something Mousse cannot use. */
  | 'invalid_response'
  | 'discovery'
  | 'callback'
  | 'declined'
  | 'registration'
  | 'verify'
  | 'subject_mismatch'
  | 'code_expired'
  /** The connection cannot be saved or read safely. */
  | 'storage'
  /** The saved connection is encrypted and this host cannot decrypt it now. It is kept. */
  | 'storage_locked'
  /** A newer Mousse saved the connection. It is kept. */
  | 'storage_newer'
  | 'unauthorized'
  | 'cancelled'
  | 'busy'

/** A typed failure of the ChatGPT sign-in module. The message is Mousse's own text, never vendor output. */
export class ChatGptAuthError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    readonly failure: ChatGptFailure,
    message: string,
    /** `refresh_not_yet`: when renewal is allowed again (ISO time). */
    readonly resetAt?: string
  ) {
    super(message)
    this.name = 'ChatGptAuthError'
  }

  toHarnessError(instanceId?: string): HarnessError {
    return {
      code: this.code,
      message: this.message,
      ...(instanceId ? { instanceId } : {}),
      ...(this.resetAt ? { resetAt: this.resetAt } : {})
    }
  }
}

export const MESSAGES = {
  signedOut: 'Sign in with ChatGPT to use your ChatGPT plan.',
  expired: 'Your ChatGPT connection expired or was disconnected. Sign in again.',
  sharingDisabled: "ChatGPT plan use isn't enabled. Sign in again and allow it, or use another provider.",
  accountChanged: 'The ChatGPT connection changed. Start a new session.',
  refreshNotYet: "ChatGPT can't renew this connection yet. Try again shortly.",
  invalidClient: "OpenAI no longer accepts this connection's registration. Sign in with 'Different account' to register again.",
  transient: "Couldn't renew the ChatGPT connection. Check your connection and try again.",
  invalidRenewal: 'ChatGPT returned an invalid renewal. Try again, or sign in again.',
  discovery: "Couldn't reach ChatGPT sign-in. Check your connection and try again.",
  discoveryUnverified: "ChatGPT sign-in configuration couldn't be verified.",
  callbackServer: "Couldn't start the local sign-in listener. Try again.",
  declined: 'ChatGPT sign-in was declined. Sign in again when you are ready.',
  callbackFailed: "ChatGPT sign-in couldn't be completed. Start again.",
  stateMismatch: "This sign-in couldn't be verified. Start again.",
  registrationIncomplete: 'ChatGPT registration is incomplete. Start sign-in again.',
  pasteInvalid: "That address doesn't belong to this sign-in. Paste the full address your browser ended on.",
  verify: "ChatGPT sign-in couldn't be verified. Start again.",
  noIdentity: "ChatGPT didn't return a verified identity. Sign in again.",
  unsupportedToken: 'ChatGPT returned an unsupported connection. Sign in again.',
  invalidTokenResponse: 'ChatGPT returned an invalid sign-in response. Sign in again.',
  differentAccount: "This sign-in returned a different ChatGPT account. Use 'Different account'. Your saved connection is unchanged.",
  conflictingRegistration: 'ChatGPT returned a conflicting account registration. Start again.',
  codeExpired: 'This sign-in code expired. Start again.',
  exchangeFailed: "ChatGPT couldn't complete sign-in. Try again.",
  unknownRegistration: 'This saved ChatGPT account is no longer available.',
  storageUnreadable: "The saved ChatGPT connection can't be read. Sign in again.",
  storageEncryption: "Mousse can't save the ChatGPT connection securely because the system keychain is unavailable.",
  storageWrite: "Couldn't save the ChatGPT connection. Try again.",
  storageLocked: "Mousse can't open the saved ChatGPT connection because the system keychain is unavailable. The connection is kept; try again once the keychain is unlocked.",
  storageNewer: 'A newer version of Mousse saved this ChatGPT connection. Update Mousse to use it.',
  cancelled: 'Sign-in cancelled',
  busy: 'Another ChatGPT sign-in change is still running. Try again shortly.',
  superseded: 'The ChatGPT connection changed while you were signing in. Sign in again.',
  revocationPending: 'Signed out in Mousse. Revoking the old sign-in at OpenAI is still pending; sign out again to retry.',
  modelsUnauthorized: 'ChatGPT rejected the connection while listing models. Checking the sign-in again.',
  modelsFailed: "Couldn't load ChatGPT models. Try Refresh models.",
  revocationUnconfirmed: 'Signed out in Mousse. Remote revocation could not be confirmed; disconnect Mousse in ChatGPT Settings.'
} as const

/**
 * A temporary answer from OpenAI: 429 reads `rate_limited` (with the `Retry-After` time when
 * given), anything else (5xx, no answer) `timeout`. Both are retryable, and the saved tokens stay.
 * Managed Codex maps `timeout`/`transient` to its `service_unavailable` code.
 */
export function transient(message: string, status?: number, resetAt?: string): ChatGptAuthError {
  return status === 429
    ? new ChatGptAuthError('rate_limited', 'transient', message, resetAt)
    : new ChatGptAuthError('timeout', 'transient', message)
}

export function cancelled(): ChatGptAuthError {
  return new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
}
