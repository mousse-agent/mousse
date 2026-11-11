import { AppError, createErrorProvider, knownAppError, normalizeAppError, serializeAppError } from '../../shared/errors'
import { MmsProtocolError } from '../../mms/protocol/client'

const connectionErrors = createErrorProvider({
  workspace_connection_lost: {
    category: 'unavailable', retryable: false,
    message: 'Connection to the workspace was lost. The turn may still be running. Reconnect to check its state before sending again.'
  },
  outcome_uncertain: {
    category: 'unavailable', retryable: true,
    message: 'No answer came in time, so the message may have arrived. Sending it again will not run it twice.'
  }
})

/** A disconnected send has an unknown outcome; it must never invite blind replay. */
export function guiChatRequestError(error: unknown): AppError {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  // `Client closed` is this app closing its own connection (quitting, restarting) with requests still waiting. The
  // service keeps them: a send waits for its whole turn, so the turn it started goes on without this window.
  if (['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTCONN', 'connection_closed'].includes(code)
      || message === 'Connection closed' || message === 'Connection closed before hello' || message === 'Client closed') {
    return connectionErrors.create('workspace_connection_lost', error)
  }
  // The request was written and no answer came before this client gave up: the service may have taken it.
  if (message.startsWith('Request timeout: ')) return connectionErrors.create('outcome_uncertain', error)
  return error instanceof MmsProtocolError
    ? knownAppError({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo })
    : normalizeAppError(error)
}

/**
 * What a window's send is answered when the request failed. Only a send the service did not take says so
 * (`requestAcknowledged: false`), and the composer then gives its text back. A lost connection does not: the turn may
 * be running, and its prompt must not come back as a draft.
 */
export function guiSendFailureAnswer(cause: unknown): { error: AppError; answer: { message: string; actions: never[]; requestAcknowledged?: false; error: ReturnType<typeof serializeAppError> } } {
  const error = guiChatRequestError(cause)
  const disconnected = error.code === 'workspace_connection_lost'
  return { error, answer: { message: '', actions: [], ...(disconnected ? {} : { requestAcknowledged: false as const }), error: serializeAppError(error) } }
}
