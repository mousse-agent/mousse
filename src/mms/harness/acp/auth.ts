/**
 * Sign-in for ACP agents: what an agent's "authentication required" answer looks like, and the
 * sign-in methods it advertises in `initialize.authMethods`.
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

/**
 * The ACP 1.5 sign-in methods Mousse runs:
 * - `agent`: the agent signs in itself after `authenticate(methodId)` (a browser link it sends as a
 *   URL elicitation or prints).
 * - `terminal`: the agent's own command signs in, in a terminal (`command + args`); agents offer it
 *   only to a client that advertised `auth.terminal`.
 * Anything else (including drafts such as `env_var`) is not part of the protocol and is dropped.
 */
export type AcpAuthMethod =
  | { type: 'agent'; id: string; name: string; description?: string }
  | { type: 'terminal'; id: string; name: string; description?: string; args: string[]; env: Record<string, string> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** A variable name a terminal method may set: no Mousse, loader or home variables. */
function allowedVariable(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !/^(PATH|NODE_OPTIONS|LD_.*|DYLD_.*|ELECTRON_.*|MOUSSE_.*|HOME|USERPROFILE)$/i.test(name)
}

/** The methods of `initialize.authMethods`, decoded leniently: unknown types and malformed entries are dropped. */
export function decodeAuthMethods(raw: readonly unknown[] | undefined): AcpAuthMethod[] {
  const methods: AcpAuthMethod[] = []
  for (const entry of raw ?? []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) continue
    const name = typeof entry.name === 'string' && entry.name ? entry.name : entry.id
    const description = typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}
    const type = entry.type === undefined || entry.type === null ? 'agent' : entry.type
    if (type === 'agent') methods.push({ type: 'agent', id: entry.id, name, ...description })
    else if (type === 'terminal') {
      const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
      const env = isRecord(entry.env)
        ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && allowedVariable(pair[0])))
        : {}
      methods.push({ type: 'terminal', id: entry.id, name, ...description, args, env })
    }
  }
  return methods
}
