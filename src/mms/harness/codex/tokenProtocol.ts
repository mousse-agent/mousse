/**
 * The wire format between Codex's token helper (`mousse-cli engine chatgpt-token`) and the token
 * broker. One request and one response per connection, each a single newline-terminated JSON line:
 *
 *   request   {"version":1,"leaseId":"<32 hex>"}      at most 1 KiB, no other keys
 *   response  {"token":"<access token>"}              at most 64 KiB
 *             {"error":"<one line>"}
 *
 * The helper (`src/cli/fastpath/chatgptToken.ts`) keeps its own copy of the request side, because
 * it must load nothing from the app; `codexBroker.test.ts` checks that both agree.
 */

export const TOKEN_PROTOCOL_VERSION = 1
export const MAX_REQUEST_BYTES = 1024
export const MAX_RESPONSE_BYTES = 64 * 1024
/** 128 random bits, hex. */
export const LEASE_ID = /^[0-9a-f]{32}$/

export interface TokenRequest {
  version: typeof TOKEN_PROTOCOL_VERSION
  leaseId: string
}

export type TokenResponse = { token: string } | { error: string }

/** The request in one line (without its newline), or undefined when it is not exactly a valid request. */
export function parseTokenRequest(line: string): TokenRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || record.version !== TOKEN_PROTOCOL_VERSION || typeof record.leaseId !== 'string' || !LEASE_ID.test(record.leaseId)) return undefined
  return { version: TOKEN_PROTOCOL_VERSION, leaseId: record.leaseId }
}

export function encodeTokenRequest(leaseId: string): string {
  return `${JSON.stringify({ version: TOKEN_PROTOCOL_VERSION, leaseId })}\n`
}

/** One response line; an error is cut to one short line. */
export function encodeTokenResponse(response: TokenResponse): string {
  if ('token' in response) return `${JSON.stringify({ token: response.token })}\n`
  return `${JSON.stringify({ error: oneLine(response.error) })}\n`
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || 'The ChatGPT sign-in could not give Codex a token.'
}
