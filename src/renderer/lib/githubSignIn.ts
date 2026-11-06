import { errorText } from './errorText'

/** What a person runs, on the computer that reads pull requests, to sign GitHub CLI in. Holds no secret. */
export const GITHUB_SIGN_IN_COMMAND = 'gh auth login'

/**
 * Whether a failed GitHub CLI read says it is signed out. The daemon's reason decides when it sent one; without it,
 * only the CLI's own sign-in wording (or the daemon's "not signed in") counts, so any other failure keeps its message.
 */
export function isGitHubSignedOut(input: { reason?: string | null; message?: string | null }): boolean {
  if (input.reason) return input.reason === 'unauthenticated'
  const text = (input.message ?? '').toLowerCase()
  // A rate-limit message can suggest signing in; waiting is what fixes it.
  if (!text || text.includes('rate limit')) return false
  return text.includes('gh auth login') || text.includes('not logged in') || /\bnot signed in\b/.test(text)
}

/** The reason a daemon refusal carries in its details (`unauthenticated`, `not-found`, …), when it carries one. */
export function failureReason(error: unknown): string | null {
  const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
  return typeof reason === 'string' && reason ? reason : null
}

/** `isGitHubSignedOut` for a thrown failure that crossed the preload bridge. */
export function isGitHubSignedOutError(error: unknown): boolean {
  return isGitHubSignedOut({ reason: failureReason(error), message: errorText(error) })
}
