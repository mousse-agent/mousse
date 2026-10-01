import { shortHash } from '../revision'

const SAFE_TOOL_NAME_PATTERN = /[^A-Za-z0-9_]/g

export interface McpToolNameRef {
  serverId: string
  serverName: string
  toolName: string
  installationId?: string
  providerName: string
}

export function toProviderSafeToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`
}

export function allocateProviderToolName(args: {
  serverName: string
  toolName: string
  installationId: string
  taken: Set<string>
}): string {
  const base = toProviderSafeToolName(args.serverName, args.toolName)
  const suffix = shortHash(args.installationId, 8)
  let candidate = `${base}__${suffix}`
  if (!args.taken.has(candidate)) return candidate
  let n = 2
  while (args.taken.has(`${candidate}_${n}`)) n += 1
  return `${candidate}_${n}`
}

export function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(SAFE_TOOL_NAME_PATTERN, '_').replace(/_+/g, '_')
  return sanitized.replace(/^_+|_+$/g, '') || 'unnamed'
}

