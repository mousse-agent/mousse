import type { UsageProblem } from '../../shared/providerAuth'

/**
 * What a provider's usage or plan reply says about why there are no numbers: no subscription on the
 * account, an expired or rejected sign-in or key, or nothing certain. Only explicit signals count
 * (a 402, or an error code that names it); anything else is left undecided rather than guessed.
 */
export function planReplyProblem(status: number, body: unknown): UsageProblem | undefined {
  const codes = errorCodes(body)
  if (status === 402 || codes.some((code) => /^(no[_-]?(active[_-]?)?subscription|subscription[_-](required|not[_-]found|inactive|expired)|plan[_-](not[_-]found|required)|not[_-]subscribed|no[_-]plan)$/i.test(code)))
    return 'no_subscription'
  if (codes.some((code) => /^(api[_-]key[_-]expired|key[_-]expired)$/i.test(code))) return 'key_expired'
  if (status === 401) return codes.some((code) => /api[_-]?key|invalid[_-]key/i.test(code)) ? 'key_rejected' : 'session_expired'
  return undefined
}

/** The short error codes a JSON error reply carries (`code`, `type`, `error`, `error.code`, `error.type`). */
function errorCodes(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const root = body as Record<string, unknown>
  const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? (root.error as Record<string, unknown>) : undefined
  return [root.code, root.type, typeof root.error === 'string' ? root.error : undefined, error?.code, error?.type]
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z_.-]{1,64}$/.test(value))
}

/** A usage reader's failure that knows its kind, so the page can say it in a few words. */
export class UsageProblemError extends Error {
  constructor(readonly problem: UsageProblem, message: string) {
    super(message)
    this.name = 'UsageProblemError'
  }
}

/** The kind of a usage reader's failure: its own, an OAuth refresh that failed, or unknown. */
export function usageProblemOf(error: unknown): UsageProblem {
  if (error instanceof UsageProblemError) return error.problem
  return 'unavailable'
}
