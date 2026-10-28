/**
 * The codes of a call to a thread on another computer that a window tells apart: it shows the offline
 * state (`computer_offline`), says why an action is refused (`computer_forbidden`), offers to update the
 * other computer (`computer_outdated`) and says an action "may have happened" (`outcome_uncertain`).
 * A refusal of the owner keeps the owner's own code and message.
 */
export const COMPUTER_ERROR_CODES = [
  'computer_offline',
  'computer_forbidden',
  'computer_outdated',
  'mixed_computers',
  'not_available_remotely',
  'outcome_uncertain'
] as const

export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number]

export function isComputerErrorCode(value: unknown): value is ComputerErrorCode {
  return typeof value === 'string' && (COMPUTER_ERROR_CODES as readonly string[]).includes(value)
}

/** "Update Mousse on <computer> to do this." as the router words `computer_outdated`. */
const OUTDATED_MESSAGE = /^Update Mousse on (.+) to do this\.$/

/**
 * The computer a `computer_outdated` message names. The message is all that survives a call that crossed
 * the window's process boundary, so it is read when the error carries no details.
 */
export function outdatedComputerName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown }
  const named = details && typeof details === 'object' ? (details as { name?: unknown }).name : undefined
  if (code === 'computer_outdated' && typeof named === 'string' && named) return named
  if (typeof message !== 'string') return undefined
  const line = message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|GitError):\s*/i, '').trim()
  return OUTDATED_MESSAGE.exec(line)?.[1]
}
