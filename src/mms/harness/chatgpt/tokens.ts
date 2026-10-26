// Token response rules from pi-ai 1.4.0 `openai-chatgpt.js` (MIT, Copyright (c) Mario Zechner) and
// T3 Code `CodexChatGptAuth.ts` (MIT, Copyright (c) 2026 T3 Tools Inc.). See THIRD_PARTY_NOTICES.md.

import { ChatGptAuthError, MESSAGES } from './errors'
import { isRecord } from './http'

/** The API resource every grant and refresh names. An identifier, not an address Mousse calls. */
export const OPENAI_RESOURCE = 'https://api.openai.com/v1'

/** OAuth refresh errors after which the refresh token is gone for good (errors-and-recovery). */
export const TERMINAL_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
])

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  tokenType: string
  expiresInSeconds: number
  scopes: string[]
  /** Epoch ms before which OpenAI asks not to refresh, when it says so. */
  earliestRefreshAt: number | null
}

/** `earliest_refresh_at` is either epoch seconds or an ISO time. */
export function earliestRefreshAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }
  return null
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** A successful token response, checked field by field. Unusable responses fail typed. */
export function parseTokenResponse(body: unknown, message: string = MESSAGES.invalidTokenResponse): TokenSet {
  const invalid = () => new ChatGptAuthError('protocol', 'invalid_response', message)
  if (!isRecord(body)) throw invalid()
  if (!nonEmpty(body.access_token) || !nonEmpty(body.token_type) || typeof body.scope !== 'string') throw invalid()
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw invalid()
  if (body.refresh_token !== undefined && body.refresh_token !== null && !nonEmpty(body.refresh_token)) throw invalid()
  if (body.id_token !== undefined && body.id_token !== null && typeof body.id_token !== 'string') throw invalid()
  return {
    accessToken: body.access_token,
    refreshToken: nonEmpty(body.refresh_token) ? body.refresh_token : null,
    idToken: nonEmpty(body.id_token) ? body.id_token : null,
    tokenType: body.token_type,
    expiresInSeconds: body.expires_in,
    scopes: body.scope.split(/\s+/).filter(Boolean),
    earliestRefreshAt: earliestRefreshAt(body.earliest_refresh_at)
  }
}

export function isBearer(tokens: TokenSet): boolean {
  return tokens.tokenType.toLowerCase() === 'bearer'
}
