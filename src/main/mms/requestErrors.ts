import { AppError, createErrorProvider, knownAppError, normalizeAppError } from '../../shared/errors'
import { MmsProtocolError } from '../../mms/protocol/client'

const connectionErrors = createErrorProvider({
  workspace_connection_lost: {
    category: 'unavailable', retryable: false,
    message: 'Connection to the workspace was lost. The turn may still be running. Reconnect to check its state before sending again.'
  }
})

/** A disconnected send has an unknown outcome; it must never invite blind replay. */
export function guiChatRequestError(error: unknown): AppError {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  if (['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTCONN', 'connection_closed'].includes(code)
      || message === 'Connection closed' || message === 'Connection closed before hello') {
    return connectionErrors.create('workspace_connection_lost', error)
  }
  return error instanceof MmsProtocolError
    ? knownAppError({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo })
    : normalizeAppError(error)
}
