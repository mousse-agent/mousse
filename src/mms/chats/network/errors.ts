import { AppError } from '../../../shared/errors'
import { NetError, NET_ERRORS } from '../../../shared/net'

export function chatNetworkError(error: unknown): unknown {
  if (!(error instanceof NetError)) return error
  const entry = NET_ERRORS[error.code]
  return new AppError({ code: error.code, message: entry.message, errorInfo: { category: entry.category, retryable: entry.retryable } }, error)
}
