import type { McpServer } from '@agentclientprotocol/sdk'
import { acpMcpServers } from '../../run/mcp/attachment'
import type { McpAttachment } from '../../run/mcp/MousseMcpServer'

/**
 * The Mousse MCP server in an ACP session (SPEC §15.2): HTTP with a bearer header when the agent
 * advertised `mcpCapabilities.http`, else the `mousse-cli engine mcp-stdio` bridge; and the MCP relay
 * beside it when the turn attaches it.
 */
export function sessionMcpServers(mcp: McpAttachment | null | undefined, options: { http: boolean }): McpServer[] {
  return acpMcpServers(mcp, { http: options.http }) as McpServer[]
}
