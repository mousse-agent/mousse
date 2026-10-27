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
    .replace(/^(?:Error|GitError):\s*/i, '')
  return stripped.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
}

const PLAIN_CODES = new Set<string>([...HARNESS_ERROR_CODES, ...Object.values(PROVIDER_INSTANCE_ERROR_CODES)])

/**
 * A failed send as the composer shows it: the message, prefixed with its code (`[code] …`) except
 * for provider errors, whose messages already say what happened and what to do next.
 */
export function sendErrorLine(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') return 'The send failed. Please try again.'
  const code = 'code' in error && error.code !== undefined ? String(error.code) : ''
  return code && !PLAIN_CODES.has(code) ? `[${code}] ${error.message}` : error.message
}
