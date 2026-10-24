import type { CodexConnection } from './CodexAppServerClient'

/**
 * What the user's own Codex setup has switched on, as Codex itself resolves it. Nothing is ever
 * written to the user's config.
 */
export interface CodexUserSetup {
  /** Names of every enabled MCP server in the effective config; null when it cannot be read. */
  mcpServers: string[] | null
}

type ServerEntry = { enabled?: boolean | null } | null | undefined

function enabledServers(servers: Record<string, ServerEntry> | null | undefined): string[] {
  return Object.entries(servers ?? {}).filter(([, server]) => server?.enabled !== false).map(([name]) => name)
}

/**
 * Reads the user's effective Codex setup through the app-server, which resolves the layers itself:
 * the home config under the `codexHome` its `initialize` answer names, the system config, the
 * project's `.codex/config.toml` for `cwd` (only when the user trusts the project, as for Codex),
 * and the active profile. MCP servers are the union of the effective config and every layer that
 * applies. Every enabled server counts as external, a Mousse-managed one included: the only
 * Mousse server a child gets is the one Mousse adds to its own thread. Profiles declare no MCP
 * servers of their own in Codex's config schema, so nothing more is scanned.
 */
export async function readCodexUserSetup(conn: CodexConnection, cwd: string | null): Promise<CodexUserSetup> {
  try {
    const response = await conn.request('config/read', { ...(cwd ? { cwd } : {}), includeLayers: true }, { timeoutMs: 15_000 })
    const names = new Set(enabledServers(response.config.mcp_servers))
    for (const layer of response.layers ?? [])
      if (!layer.disabledReason) for (const name of enabledServers(layer.config?.mcp_servers)) names.add(name)
    return { mcpServers: [...names] }
  } catch {
    return { mcpServers: null }
  }
}
