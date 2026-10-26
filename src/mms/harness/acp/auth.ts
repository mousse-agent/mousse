/**
 * Sign-in for ACP agents: what an agent's "authentication required" answer looks like.
 */

/**
 * ACP `authRequired` is JSON-RPC -32000 "Authentication required", but agents not built on the
 * TypeScript SDK may word it "Not logged in" or "Please sign in". Other -32000 errors are not sign-in.
 */
export function isAuthRequired(error: unknown): boolean {
  const { code, message, data } = (error ?? {}) as { code?: unknown; message?: unknown; data?: { type?: unknown } | null }
  if (code !== -32000) return false
  return data?.type === 'auth_required' || (typeof message === 'string' && /auth|sign.?in|log(ged)?.?in/i.test(message))
}
