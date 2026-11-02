import type { McpToolDescriptor } from '../../../../shared/integrations'
import { sanitizeToolNamePart } from '../../../integrations/mcp/toolNames'
import { canonicalJson, shortHash } from '../../../integrations/revision'

/** Between the server part and the tool part of a relayed tool's name; never inside either part. */
export const RELAY_SEPARATOR = '__'
/** Longest relayed tool name: with Claude's `mcp__mousse-relay__` (19 chars) it stays within 64. */
export const RELAY_NAME_BUDGET = 45
/** The relay lists at most this many tools (sorted by server, then tool); the rest are dropped. */
export const RELAY_MAX_TOOLS = 128
export const RELAY_MAX_DESCRIPTION_CHARS = 1024
/** A tool whose input schema is larger than this (JSON, UTF-8) is not relayed. */
export const RELAY_MAX_SCHEMA_BYTES = 16 * 1024
/** A relayed call's text result is cut to this many characters. */
export const RELAY_MAX_RESULT_CHARS = 64_000

/** Longest server part; a longer one is cut and keeps a hash of its installation. */
const MAX_SERVER_PART = 24
const HASH_CHARS = 6
// C0 and C1 control characters, except tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** One tool the relay lists: its relayed name and what it resolves to on the user's server. */
export interface RelayTool {
  /** `<server>__<tool>`, unique in the listing; resolved through the listing, never split. */
  name: string
  /** `[MCP server "<server>"] ` and the server's own description, control characters stripped. */
  description: string
  inputSchema: Record<string, unknown>
  installationId: string
  serverName: string
  toolName: string
  /** The name `McpManager.callTool` takes. */
  providerName: string
  configRevision?: string
}

/**
 * The relay's tools from the user's enabled servers' descriptors: sorted by (server, tool), names
 * allocated deterministically within `RELAY_NAME_BUDGET`, at most `RELAY_MAX_TOOLS`. A tool with a
 * schema error or an oversized schema, a duplicate, or one past the cap is dropped, with the reason.
 */
export function allocateRelayTools(tools: readonly McpToolDescriptor[]): { tools: RelayTool[]; dropped: Array<{ id: string; reason: string }> } {
  const dropped: Array<{ id: string; reason: string }> = []
  const seen = new Set<string>()
  const eligible: Array<McpToolDescriptor & { installationId: string }> = []
  for (const tool of [...tools].sort(byServerThenTool)) {
    const installationId = tool.installationId ?? tool.serverId
    const key = `${installationId}\u0000${tool.toolName}`
    if (tool.schemaError) dropped.push({ id: tool.id, reason: `schema error: ${tool.schemaError}` })
    else if (schemaBytes(tool.inputSchema) > RELAY_MAX_SCHEMA_BYTES) dropped.push({ id: tool.id, reason: `input schema over ${RELAY_MAX_SCHEMA_BYTES} bytes` })
    else if (seen.has(key)) dropped.push({ id: tool.id, reason: 'duplicate tool' })
    else {
      seen.add(key)
      eligible.push({ ...tool, installationId })
    }
  }
  for (const tool of eligible.splice(RELAY_MAX_TOOLS)) dropped.push({ id: tool.id, reason: `over the ${RELAY_MAX_TOOLS}-tool limit` })

  // A server part two installations share gets each installation's hash.
  const installationsByPart = new Map<string, Set<string>>()
  for (const tool of eligible) {
    const part = sanitizeToolNamePart(tool.serverName)
    installationsByPart.set(part, (installationsByPart.get(part) ?? new Set()).add(tool.installationId))
  }
  const taken = new Set<string>()
  const relayed: RelayTool[] = []
  for (const tool of eligible) {
    const server = serverPart(tool.serverName, tool.installationId, installationsByPart)
    let name = relayName(server, tool.installationId, tool.toolName, false)
    // Two tool names of one server that sanitize alike: the later one takes its hashed form.
    if (taken.has(name)) name = relayName(server, tool.installationId, tool.toolName, true)
    if (taken.has(name)) {
      dropped.push({ id: tool.id, reason: 'name collision' })
      continue
    }
    taken.add(name)
    relayed.push({
      name,
      description: relayDescription(tool.serverName, tool.description),
      inputSchema: tool.inputSchema?.type === 'object' ? tool.inputSchema : { type: 'object', additionalProperties: true },
      installationId: tool.installationId,
      serverName: tool.serverName,
      toolName: tool.toolName,
      providerName: tool.providerName,
      ...(tool.configRevision ? { configRevision: tool.configRevision } : {})
    })
  }
  return { tools: relayed, dropped }
}

/** What a runtime caching the listing sees: names and input schemas (descriptions are left out). */
export function relayListingDigest(tools: readonly RelayTool[]): string {
  const entries = tools.map((tool) => [tool.name, shortHash(canonicalJson(tool.inputSchema))]).sort(([a], [b]) => compare(a, b))
  return shortHash(canonicalJson(entries), 12)
}

/** The approval permission key of a relayed server's tools ("allow always" would be per server). */
export function relayPermissionKey(installationId: string): string {
  return `relay:${installationId}`
}

function serverPart(serverName: string, installationId: string, installationsByPart: Map<string, Set<string>>): string {
  const part = sanitizeToolNamePart(serverName)
  const shared = (installationsByPart.get(part)?.size ?? 0) > 1
  if (part.length > MAX_SERVER_PART) return withHash(part.slice(0, MAX_SERVER_PART - HASH_CHARS - 1), shortHash(installationId, HASH_CHARS))
  return shared ? `${part}_${shortHash(installationId, HASH_CHARS)}` : part
}

function relayName(server: string, installationId: string, toolName: string, hashed: boolean): string {
  const tool = sanitizeToolNamePart(toolName)
  const plain = `${server}${RELAY_SEPARATOR}${tool}`
  if (!hashed && plain.length <= RELAY_NAME_BUDGET) return plain
  const room = RELAY_NAME_BUDGET - server.length - RELAY_SEPARATOR.length - HASH_CHARS - 1
  return `${server}${RELAY_SEPARATOR}${withHash(tool.slice(0, Math.max(0, room)), shortHash(`${installationId}:${toolName}`, HASH_CHARS))}`
}

/** `<prefix>_<hash>`, or the hash alone when the cut prefix is empty (a part never has `__` or edge `_`). */
function withHash(prefix: string, hash: string): string {
  const trimmed = prefix.replace(/_+$/, '')
  return trimmed ? `${trimmed}_${hash}` : hash
}

function relayDescription(serverName: string, description: string | undefined): string {
  const server = serverName.replace(CONTROL_CHARS, '').replace(/"/g, "'")
  return `[MCP server "${server}"] ${(description ?? '').replace(CONTROL_CHARS, '')}`.slice(0, RELAY_MAX_DESCRIPTION_CHARS)
}

function schemaBytes(schema: Record<string, unknown> | undefined): number {
  return schema ? Buffer.byteLength(JSON.stringify(schema), 'utf8') : 0
}

function byServerThenTool(a: McpToolDescriptor, b: McpToolDescriptor): number {
  return compare(a.serverName, b.serverName) || compare(a.toolName, b.toolName) || compare(a.installationId ?? a.serverId, b.installationId ?? b.serverId)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
