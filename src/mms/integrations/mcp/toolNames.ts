const SAFE_TOOL_NAME_PATTERN = /[^A-Za-z0-9_]/g

export interface McpToolNameRef {
  serverId: string
  serverName: string
  toolName: string
}

export function toProviderSafeToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`
}

export function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(SAFE_TOOL_NAME_PATTERN, '_').replace(/_+/g, '_')
  return sanitized.replace(/^_+|_+$/g, '') || 'unnamed'
}

