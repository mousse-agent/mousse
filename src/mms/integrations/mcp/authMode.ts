import type { McpAuthMode, McpServerConfig } from '../../../shared/integrations'
import { hasStaticAuthorization } from './connectionKey'

export function inferMcpAuthMode(server: McpServerConfig): McpAuthMode {
  if (server.authMode) return server.authMode
  if (server.auth?.clientId || server.auth?.clientSecret || server.auth?.scopes?.length) {
    return 'oauth'
  }
  if (hasStaticAuthorization(server.headers)) return 'static'
  return 'anonymous'
}

export function shouldAttachOAuthProvider(server: McpServerConfig): boolean {
  if (server.transport !== 'http' && server.transport !== 'sse') return false
  return inferMcpAuthMode(server) === 'oauth'
}

export function isUnauthorizedStatus(status: number | undefined): boolean {
  return status === 401 || status === 403
}

export function classifyTransportError(err: unknown): {
  category:
    | 'auth-required'
    | 'unauthorized'
    | 'cancelled'
    | 'timeout'
    | 'dns'
    | 'tls'
    | 'http'
    | 'protocol'
    | 'missing-executable'
    | 'unreachable'
    | 'unknown'
  message: string
} {
  const message = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''
  if (name === 'AbortError' || /aborted|cancelled/i.test(message)) {
    return { category: 'cancelled', message }
  }
  if (/timeout/i.test(message)) return { category: 'timeout', message }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return { category: 'dns', message }
  if (/CERT_|TLS|UNABLE_TO_VERIFY/i.test(message)) return { category: 'tls', message }
  if (/ENOENT|not found|spawn/i.test(message)) return { category: 'missing-executable', message }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|fetch failed/i.test(message)) {
    return { category: 'unreachable', message }
  }
  if (/\b401\b|Unauthorized|invalid_token|invalid_grant/i.test(message)) {
    return { category: 'auth-required', message }
  }
  if (/\b403\b/.test(message)) return { category: 'unauthorized', message }
  if (/\bHTTP\b|\b50\d\b|\b404\b/.test(message)) return { category: 'http', message }
  if (/JSON-RPC|protocol|parse/i.test(message)) return { category: 'protocol', message }
  return { category: 'unknown', message }
}
