import { COMPUTER_ERROR_CODES } from '../../shared/bridge/computerErrors'
import { HARNESS_ERROR_CODES } from '../../shared/harness/types'
import { PROVIDER_INSTANCE_ERROR_CODES } from '../../shared/providerInstances'

/** The message of a thrown value, whatever its type. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  // Errors that crossed the preload bridge as plain `{ code, message }` objects.
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * A failure's own first line, without the IPC transport prefix or an `Error:` label.
 * Empty when the failure carries no message.
 */
export function ipcErrorLine(error: unknown): string {
  const stripped = errorText(error)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error|GitError|MmsProtocolError):\s*/i, '')
  return stripped.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
}

/** Whether a call failed because too many requests to the background service were in flight. */
export function isServiceBusy(error: unknown): boolean {
  return ipcErrorLine(error) === 'Too many pending requests'
}

/**
 * A failure as a person reads it: its own first line (see `ipcErrorLine`), plain words for an
 * overloaded background service, or `fallback` when the failure says nothing.
 */
export function readableError(error: unknown, fallback: string): string {
  if (isServiceBusy(error)) return 'Mousse is busy. Try again in a moment.'
  return ipcErrorLine(error) || fallback
}

/**
 * Whether a call failed because the computer that runs the thread cannot be reached. A poll of such a
 * thread fails every few seconds while it is away; the thread view already says so, with Retry.
 */
export function isComputerOffline(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'computer_offline') return true
  return /^(?:MmsProtocolError: )?.+ is offline\.$/.test(ipcErrorLine(error))
}

// A thread on another computer says why in words ("<computer> is offline."), also for the owner's limits.
const PLAIN_CODES = new Set<string>([
  ...HARNESS_ERROR_CODES,
  ...Object.values(PROVIDER_INSTANCE_ERROR_CODES),
  ...COMPUTER_ERROR_CODES,
  'permission_mode_above_ceiling',
  'workflow_not_available_remotely'
])

/**
 * A failed send as the composer shows it: the message, prefixed with its code (`[code] …`) except
 * for provider errors, whose messages already say what happened and what to do next.
 */
export function sendErrorLine(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') return 'The send failed. Please try again.'
  const code = 'code' in error && error.code !== undefined ? String(error.code) : ''
  return code && !PLAIN_CODES.has(code) ? `[${code}] ${error.message}` : error.message
}
