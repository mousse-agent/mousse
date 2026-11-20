import { COMPUTER_ERROR_CODES } from '../../shared/bridge/computerErrors'
import { HARNESS_ERROR_CODES } from '../../shared/harness/types'
import { PROVIDER_INSTANCE_ERROR_CODES } from '../../shared/providerInstances'
import { SERVICE_ANSWERED_LATE, SERVICE_STOPPED_ANSWERING } from '../../shared/errors'

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

// What the main process says when a window's connection to the background service is shut down
// (app quit or restart, an update install) while the window still asks for something.
const SESSION_CLOSING_LINES = new Set([
  'Window MMS session is closing',
  'Window MMS session closed while opening',
  'GuiMmsController is stopped',
  'Mousse is installing an update'
])

/**
 * Whether a call failed only because this window's connection to the background service is closing.
 * The window is about to quit or reload, so such a failure is never shown.
 */
export function isSessionClosing(error: unknown): boolean {
  return SESSION_CLOSING_LINES.has(ipcErrorLine(error))
}

/** Whether a call failed because too many requests to the background service were in flight. */
export function isServiceBusy(error: unknown): boolean {
  return ipcErrorLine(error) === 'Too many pending requests'
}

// What the connection to the background service says when it dropped before the call was answered.
const CONNECTION_LOST_LINES = new Set(['Connection closed', 'Connection closed before hello', 'Not connected'])

/**
 * Plain words for a call that failed in transit, not because the service refused it: the connection to the
 * background service dropped (`service_connection_lost`, `Connection closed`) or no answer came in time
 * (`service_timeout`, `Request timeout: <method>`). Undefined for any other failure.
 */
export function serviceFailureLine(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'service_connection_lost') return SERVICE_STOPPED_ANSWERING
  if (code === 'service_timeout') return SERVICE_ANSWERED_LATE
  const line = ipcErrorLine(error)
  if (CONNECTION_LOST_LINES.has(line)) return SERVICE_STOPPED_ANSWERING
  if (line.startsWith('Request timeout: ')) return SERVICE_ANSWERED_LATE
  return undefined
}

/**
 * A failure as a person reads it: its own first line (see `ipcErrorLine`), plain words for an
 * overloaded or unreachable background service, or `fallback` when the failure says nothing.
 */
export function readableError(error: unknown, fallback: string): string {
  if (isServiceBusy(error)) return 'Mousse is busy. Try again in a moment.'
  return serviceFailureLine(error) ?? (ipcErrorLine(error) || fallback)
}

/**
 * Whether a call to the background service got no answer in time (`Request timeout: <method>`). The work it asked for
 * may still be running there, so this says nothing about how it ended.
 */
export function isRequestTimeout(error: unknown): boolean {
  return serviceFailureLine(error) === SERVICE_ANSWERED_LATE
}

/** The reference an error was logged under, at the end of its message: `… Reference: 1ecec6b5-…`. */
const REFERENCE = /\s*Reference:\s*(\S+)\s*$/

/** A message and the reference at its end, apart. */
export function splitErrorReference(message: string): { text: string; reference?: string } {
  const match = REFERENCE.exec(message)
  if (!match) return { text: message.trim() }
  return { text: message.slice(0, match.index).trim(), reference: match[1] }
}

/**
 * What the composer says when Compact now failed, or null to say nothing. A compaction that started reports how it
 * ended in its own row in the conversation, so a call that got no answer in time (the compaction may still be running)
 * or a window that is closing says nothing here; a refusal says why in plain words.
 */
export function compactNowFailureLine(error: unknown): string | null {
  if (isRequestTimeout(error) || isSessionClosing(error)) return null
  return readableError(error, "This thread couldn't be compacted. Try again.")
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
