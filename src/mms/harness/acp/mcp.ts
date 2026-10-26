import type { McpServer } from '@agentclientprotocol/sdk'
import { acpMcpServers } from '../../run/mcp/attachment'

/**
 * The Mousse MCP server in an ACP session (SPEC §15.2): HTTP with a bearer header when the agent
 * advertised `mcpCapabilities.http`, else the `mousse-cli engine mcp-stdio` bridge.
 */
export function sessionMcpServers(mcp: { url: string; token: string } | null | undefined, options: { http: boolean }): McpServer[] {
  return acpMcpServers(mcp, { http: options.http }) as McpServer[]
}
