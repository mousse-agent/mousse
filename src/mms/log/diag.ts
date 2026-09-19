/**
 * Lightweight leveled diagnostics for src/mms.
 *
 * Convention: messages are prefixed `[module]` and rendered to the console,
 * matching the existing ad-hoc style. Debug output is gated behind
 * MOUSSE_LOG=debug so routine best-effort failures stay quiet in production.
 *
 * Never log secrets: values whose key looks credential-shaped are redacted
 * when passed through logFields (details argument).
 */

export type DiagLevel = 'debug' | 'warn' | 'error'

const REDACT_KEY_PATTERN = /token|secret|password|credential|apikey|api_key|authorization/i

let debugEnabled: boolean | undefined

export function isDiagDebugEnabled(): boolean {
  debugEnabled ??=
    process.env.MOUSSE_LOG === 'debug' ||
    process.env.MOUSSE_LOG === 'trace' ||
    process.env.NODE_ENV === 'test'
  return debugEnabled
}

/** Test/daemon hook to reset cached env evaluation. */
export function resetDiagDebugCache(): void {
  debugEnabled = undefined
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Redact long hex/base64-ish blobs that look like raw secrets even unkeyed.
    return value.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(value) ? '<redacted>' : value
  }
  return value
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEY_PATTERN.test(key) ? '<redacted>' : redactValue(value)
  }
  return out
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.message} (${code})` : error.message
  }
  return String(error)
}

export function logDebug(module: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
  if (!isDiagDebugEnabled()) return
  const extra = fields ? ` ${JSON.stringify(redactFields(fields))}` : ''
  console.error(`[diag:${module}] ${message}${extra}${error ? ` :: ${formatError(error)}` : ''}`)
}

export function logWarn(module: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
  const extra = fields ? ` ${JSON.stringify(redactFields(fields))}` : ''
  console.error(`[warn:${module}] ${message}${extra}${error ? ` :: ${formatError(error)}` : ''}`)
}

export function logError(module: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
  const extra = fields ? ` ${JSON.stringify(redactFields(fields))}` : ''
  console.error(`[error:${module}] ${message}${extra}${error ? ` :: ${formatError(error)}` : ''}`)
}
