/** Plain, browser-safe errors shared by services, protocol clients and UI. */
export const ERROR_INFO_CAPABILITY = 'errors.v1'
export const ERROR_CATEGORIES = ['invalid', 'denied', 'unavailable', 'cancelled', 'timeout', 'conflict', 'unsupported', 'internal'] as const
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]
export interface ErrorInfo {
  category: ErrorCategory
  /** Classification only. The operation owner must also establish replay safety. */
  retryable: boolean
  retryAfterMs?: number
}
export interface AppErrorShape {
  code: string
  message: string
  details?: unknown
  errorInfo?: ErrorInfo
}
export interface ErrorDefinition extends ErrorInfo { message: string }

export function parseErrorInfo(value: unknown): ErrorInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const info = value as Record<string, unknown>
  if (!ERROR_CATEGORIES.includes(info.category as ErrorCategory) || typeof info.retryable !== 'boolean') return undefined
  if (info.retryAfterMs !== undefined && (typeof info.retryAfterMs !== 'number' || !Number.isFinite(info.retryAfterMs) || info.retryAfterMs < 0 || info.retryAfterMs > 10_000)) return undefined
  return { category: info.category as ErrorCategory, retryable: info.retryable, ...(info.retryAfterMs === undefined ? {} : { retryAfterMs: info.retryAfterMs as number }) }
}

export class AppError extends Error implements AppErrorShape {
  readonly code: string
  readonly details?: unknown
  readonly errorInfo: ErrorInfo
  constructor(shape: AppErrorShape & { errorInfo: ErrorInfo }, cause?: unknown) {
    super(shape.message, cause === undefined ? undefined : { cause })
    this.name = 'AppError'
    this.code = shape.code
    this.details = safeErrorDetails(shape.details)
    this.errorInfo = { ...shape.errorInfo }
  }
}

/** Each domain owns a closed catalog; there is no mutable global registry. */
export function createErrorProvider<const T extends Record<string, ErrorDefinition>>(definitions: T) {
  return {
    create(code: keyof T & string, cause?: unknown, details?: unknown): AppError {
      const definition = definitions[code]
      return new AppError({ code, message: definition.message, errorInfo: { category: definition.category, retryable: definition.retryable }, details }, cause)
    }
  }
}

const commonErrors = createErrorProvider({
  internal_error: { category: 'internal', retryable: false, message: 'Something went wrong. Please try again or report this error.' },
  cancelled: { category: 'cancelled', retryable: false, message: 'The operation was cancelled.' }
})

/** Unknown text is never made public merely because it has a code property. */
export function normalizeAppError(error: unknown, fallbackCode = 'internal_error'): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error && error.name === 'AbortError') return commonErrors.create('cancelled', error)
  const supportId = globalThis.crypto.randomUUID()
  const result = commonErrors.create('internal_error', error, { supportId })
  return new AppError({ ...serializeAppError(result), code: fallbackCode, message: `${result.message} Reference: ${supportId}`, errorInfo: result.errorInfo }, error)
}

/** Known domain errors retain their audited messages and legacy codes. */
export function knownAppError(error: AppErrorShape, info: ErrorInfo = { category: 'internal', retryable: false }): AppError {
  return new AppError({ code: error.code, message: redactErrorText(error.message), details: error.details, errorInfo: parseErrorInfo(error.errorInfo) ?? info })
}

export function serializeAppError(error: AppErrorShape): AppErrorShape {
  const details = safeErrorDetails(error.details)
  const errorInfo = parseErrorInfo(error.errorInfo)
  return { code: error.code.slice(0, 128), message: redactErrorText(error.message), ...(details === undefined ? {} : { details }), ...(errorInfo ? { errorInfo } : {}) }
}

/** Defence in depth for audited domain messages; unknown causes use static text. */
export function redactErrorText(text: string): string {
  return text.slice(0, 4096)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]+|gh[pousr]_[a-zA-Z0-9_]+)\b/g, '[redacted]')
    .replace(/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}

const ERROR_DETAIL_KEYS = new Set(['supportId', 'operation', 'operationId', 'requestId', 'provider', 'status', 'attempt', 'projectId', 'profileId', 'profileRef', 'taskId', 'threadId', 'runId', 'epoch', 'expectedEpoch', 'actualEpoch', 'expectedRevision', 'actualRevision', 'expectedGeneration', 'actualGeneration', 'capability', 'revision', 'expected', 'actual', 'state', 'path', 'label', 'reason', 'pointer', 'pointers', 'runtimeKind', 'hostBindings', 'workspace', 'projectBound', 'issues', 'diagnostics', 'code', 'severity', 'location', 'field', 'index', 'limit', 'count', 'retryAfterMs'])

/** Explicit safe detail vocabulary. New domain fields need an audited addition. */
export function safeErrorDetails(value: unknown): unknown {
  const seen = new Set<object>()
  let remaining = 64
  function visit(item: unknown, depth: number): unknown {
    if (remaining-- <= 0 || depth > 4) return undefined
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined
    if (typeof item === 'string') return redactErrorText(item).slice(0, 1024)
    if (!item || typeof item !== 'object' || seen.has(item)) return undefined
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 16).map((entry) => visit(entry, depth + 1)).filter((entry) => entry !== undefined)
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return undefined
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(item).slice(0, 32)) {
      if (!ERROR_DETAIL_KEYS.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !('value' in descriptor)) continue
      const next = visit(descriptor.value, depth + 1)
      if (next !== undefined) result[key.slice(0, 96)] = next
    }
    return result
  }
  return visit(value, 0)
}

/** Bounded diagnostic record: correlate public references without dumping causes. */
export function errorDiagnostic(error: AppErrorShape, operation: string): Record<string, unknown> {
  const details = safeErrorDetails(error.details) as Record<string, unknown> | undefined
  const cause = error instanceof Error ? error.cause : undefined
  const causeName = cause instanceof Error && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'APIConnectionError', 'AbortError'].includes(cause.name) ? cause.name : undefined
  const causeCode = cause && typeof cause === 'object' && 'code' in cause && ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(String(cause.code)) ? String(cause.code) : undefined
  return { ...(causeName ? { causeName } : {}), ...(causeCode ? { causeCode } : {}), code: error.code.slice(0, 128), operation: operation.slice(0, 96), category: parseErrorInfo(error.errorInfo)?.category ?? 'internal',
    ...(typeof details?.supportId === 'string' ? { supportId: details.supportId } : {}),
    ...(typeof details?.provider === 'string' ? { provider: details.provider } : {}),
    ...(typeof details?.status === 'number' ? { status: details.status } : {}) }
}
