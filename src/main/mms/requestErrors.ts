import { AppError, SERVICE_ANSWERED_LATE, SERVICE_STOPPED_ANSWERING, createErrorProvider, knownAppError, normalizeAppError, serializeAppError } from '../../shared/errors'
import { MmsProtocolError } from '../../mms/protocol/client'

const connectionErrors = createErrorProvider({
  workspace_connection_lost: {
    category: 'unavailable', retryable: false,
    message: 'Connection to the workspace was lost. The turn may still be running. Reconnect to check its state before sending again.'
  },
  outcome_uncertain: {
    category: 'unavailable', retryable: true,
    message: 'No answer came in time, so the message may have arrived. Sending it again will not run it twice.'
  },
  service_connection_lost: { category: 'unavailable', retryable: true, message: SERVICE_STOPPED_ANSWERING },
  service_timeout: { category: 'timeout', retryable: true, message: SERVICE_ANSWERED_LATE },
  // A frame past the protocol's limit is refused before it is written, so nothing was sent.
  request_too_large: {
    category: 'invalid', retryable: false,
    message: 'This message is too large to send.'
  }
})

/**
 * Whether a request failed in transit rather than being refused: `lost` when the connection to the service dropped
 * (or this app closed it, `Client closed`), `timeout` when the request was written and no answer came in time.
 */
function transportFailure(error: unknown): 'lost' | 'timeout' | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  if (['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTCONN', 'connection_closed'].includes(code)
      || message === 'Connection closed' || message === 'Connection closed before hello' || message === 'Client closed') return 'lost'
  if (message.startsWith('Request timeout: ')) return 'timeout'
  return undefined
}

/** A disconnected send has an unknown outcome; it must never invite blind replay. */
export function guiChatRequestError(error: unknown): AppError {
  // `Client closed` is this app closing its own connection (quitting, restarting) with requests still waiting. The
  // service keeps them: a send waits for its whole turn, so the turn it started goes on without this window.
  const transport = transportFailure(error)
  if (transport === 'lost') return connectionErrors.create('workspace_connection_lost', error)
  // The request was written and no answer came before this client gave up: the service may have taken it.
  if (transport === 'timeout') return connectionErrors.create('outcome_uncertain', error)
  if (error instanceof Error && error.name === 'FrameTooLargeError') return connectionErrors.create('request_too_large', error)
  return error instanceof MmsProtocolError
    ? knownAppError({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo })
    : normalizeAppError(error)
}

/**
 * A window's platform request (sign-in, networking, connect links, settings) that failed, as the window is answered:
 * the service's own refusal as it said it; a dropped connection, a request the client could not send (`Not
 * connected`) or one that got no answer in time in plain words; anything else as the generic message with a
 * reference, whose cause goes to the error reference log under `method`.
 */
export function guiPlatformRequestError(error: unknown, method?: string): AppError {
  if (error instanceof MmsProtocolError) return knownAppError({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo })
  const transport = transportFailure(error)
  if (transport === 'lost' || (error instanceof Error && error.message === 'Not connected')) return connectionErrors.create('service_connection_lost', error)
  if (transport === 'timeout') return connectionErrors.create('service_timeout', error)
  return normalizeAppError(error, 'platform_request_failed', method)
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
