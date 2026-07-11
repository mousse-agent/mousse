import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type {
  IntegrationDiagnostic,
  McpAuthConfig,
  McpConfigSource,
  McpConfigSourceDescriptor,
  McpRegistrySnapshot,
  McpServerConfig,
  McpServerStatus,
  McpTransport
} from '../../../shared/integrations'
import { getMcpConfigPaths, type McpConfigPathDescriptor } from '../../data/paths'

type UnknownRecord = Record<string, unknown>

const REDACTED_VALUE = '[redacted]'

export interface McpDiscoveryOptions {
  projectPath?: string
  redactSecrets?: boolean
}

export type CursorMcpConfigPatch = Record<string, unknown>

export class McpRegistry {
  async discover(options: McpDiscoveryOptions = {}): Promise<McpRegistrySnapshot> {
    const sources = getMcpConfigPaths(options.projectPath).map(
      (descriptor): McpConfigSourceDescriptor => ({
        ...descriptor,
        exists: existsSync(descriptor.path)
      })
    )

    const servers: McpServerConfig[] = []
    const diagnostics: IntegrationDiagnostic[] = []

    for (const source of sources) {
      if (!source.exists) continue

      try {
        const raw = await readFile(source.path, 'utf-8')
        servers.push(...this.parseSource(raw, source))
      } catch (err) {
        diagnostics.push({
          level: 'error',
          source: source.source,
          path: source.path,
          message: `Failed to read MCP config: ${formatError(err)}`
        })
      }
    }

    const sortedServers = servers.sort(compareMcpServers)
    const serverDiagnostics = sortedServers.flatMap((server) => server.diagnostics ?? [])
    return {
      sources,
      servers:
        options.redactSecrets === false
          ? sortedServers
          : sortedServers.map((server) => redactMcpServerConfig(server)),
      diagnostics: [...diagnostics, ...serverDiagnostics, ...findDuplicateDiagnostics(sortedServers)]
    }
  }

  private parseSource(raw: string, source: McpConfigPathDescriptor): McpServerConfig[] {
    try {
      switch (source.format) {
        case 'cursor-json':
        case 'claude-json':
          return parseMcpServersObject(JSON.parse(raw), source)
        case 'codex-toml':
          return parseMcpServersObject(
            { mcpServers: parseCodexMcpServersToml(raw) },
            source
          )
        case 'opencode-json':
          return parseOpenCodeMcpServers(JSON.parse(raw), source)
        case 'mousse-json':
          return parseMcpServersObject(JSON.parse(raw), source)
        default:
          return []
      }
    } catch (err) {
      return [
        createInvalidSourceServer(source, {
          level: 'error',
          source: source.source,
          path: source.path,
          message: `Failed to parse MCP config: ${formatError(err)}`
        })
      ]
    }
  }

  async writeCursorMcpConfig(
    scope: 'global' | 'project',
    patch: CursorMcpConfigPatch,
    projectPath?: string
  ): Promise<void> {
    const descriptor = getMcpConfigPaths(projectPath).find((candidate) =>
      scope === 'global'
        ? candidate.source === 'cursor-global'
        : candidate.source === 'cursor-project'
    )
    if (!descriptor) {
      throw new Error('Project path is required to write project Cursor MCP config.')
    }

    const existing = await readJsonObject(descriptor.path)
    const merged = deepMergeObjects(existing, patch)
    await mkdir(dirname(descriptor.path), { recursive: true })
    await writeFile(descriptor.path, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')
  }
}

export function redactMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    env: redactRecord(server.env),
    headers: redactRecord(server.headers)
  }
}

export function parseMcpServersObject(
  parsed: unknown,
  source: McpConfigPathDescriptor
): McpServerConfig[] {
  const root = asRecord(parsed)
  const mcpServers = asRecord(root?.mcpServers)
  if (!mcpServers) {
    return [
      createInvalidSourceServer(source, {
        level: 'warning',
        source: source.source,
        path: source.path,
        message: 'MCP config does not contain a top-level mcpServers object.'
      })
    ]
  }

  return Object.entries(mcpServers).map(([name, value]) =>
    normalizeMcpServer(name, value, source)
  )
}

export function parseOpenCodeMcpServers(
  parsed: unknown,
  source: McpConfigPathDescriptor
): McpServerConfig[] {
  const root = asRecord(parsed)
  const mcp = asRecord(root?.mcp)
  if (!mcp) {
    return [
      createInvalidSourceServer(source, {
        level: 'warning',
        source: source.source,
        path: source.path,
        message: 'OpenCode config does not contain a top-level mcp object.'
      })
    ]
  }

  return Object.entries(mcp).map(([name, value]) => {
    const entry = { ...(asRecord(value) ?? {}) }
    const command = entry.command
    if (Array.isArray(command)) {
      const [executable, ...args] = command.map(String)
      entry.command = executable
      entry.args = args
    }
    if (entry.environment && !entry.env) {
      entry.env = entry.environment
    }
    return normalizeMcpServer(name, entry, source)
  })
}

export function normalizeMcpServer(
  name: string,
  value: unknown,
  source: McpConfigPathDescriptor
): McpServerConfig {
  const record = asRecord(value)
  const diagnostics: IntegrationDiagnostic[] = []

  if (!record) {
    diagnostics.push({
      level: 'error',
      source: source.source,
      path: source.path,
      targetId: name,
      message: 'MCP server entry must be an object.'
    })
  }

  const commandParts = splitCommand(record)
  const command = commandParts.command
  const args = commandParts.args
  const env = stringRecordValue(record?.env)
  const cwd = stringValue(record?.cwd)
  const url = stringValue(record?.url)
  const headers = stringRecordValue(record?.headers ?? record?.http_headers)
  const auth = parseAuthConfig(record?.auth)
  const enabled = booleanValue(record?.enabled)
  const transport = resolveTransport(record, url)

  if (!command && !url) {
    diagnostics.push({
      level: 'error',
      source: source.source,
      path: source.path,
      targetId: name,
      message: 'MCP server is missing command or url.'
    })
  }

  const missingEnvVars = unique([
    ...extractMissingEnvVars(env),
    ...extractMissingEnvVars(headers),
    ...extractMissingEnvVars(authToStringRecord(auth))
  ])
  const status = resolveStatus(enabled, missingEnvVars, diagnostics)

  return {
    id: `${source.source}:${name}`,
    name,
    source: source.source,
    scope: source.scope,
    configPath: source.path,
    transport,
    status,
    enabled,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    auth,
    missingEnvVars,
    diagnostics
  }
}

function createInvalidSourceServer(
  source: McpConfigPathDescriptor,
  diagnostic: IntegrationDiagnostic
): McpServerConfig {
  return {
    id: `${source.source}:__invalid__:${source.path}`,
    name: '(invalid config)',
    source: source.source,
    scope: source.scope,
    configPath: source.path,
    transport: 'stdio',
    status: 'failed',
    diagnostics: [diagnostic]
  }
}

function splitCommand(record: UnknownRecord | null): { command?: string; args?: string[] } {
  const command = stringValue(record?.command)
  const args = stringArrayValue(record?.args)
  if (command && (!args || args.length === 0) && command.includes(' ')) {
    const parts = command.split(/\s+/).filter(Boolean)
    return { command: parts[0], args: parts.slice(1) }
  }
  return { command, args }
}

function parseAuthConfig(value: unknown): McpAuthConfig | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  const clientId = stringValue(record.CLIENT_ID ?? record.client_id ?? record.clientId)
  const clientSecret = stringValue(record.CLIENT_SECRET ?? record.client_secret ?? record.clientSecret)
  const scopes = stringArrayValue(record.scopes)

  if (!clientId && !clientSecret && !scopes?.length) return undefined

  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(scopes?.length ? { scopes } : {})
  }
}

function authToStringRecord(auth: McpAuthConfig | undefined): Record<string, string> | undefined {
  if (!auth) return undefined
  const record: Record<string, string> = {}
  if (auth.clientId) record.clientId = auth.clientId
  if (auth.clientSecret) record.clientSecret = auth.clientSecret
  if (auth.scopes?.length) record.scopes = auth.scopes.join(' ')
  return record
}

function resolveTransport(record: UnknownRecord | null, url: string | undefined): McpTransport {
  const transport = stringValue(record?.transport ?? record?.type)
  if (transport === 'sse') return 'sse'
  if (transport === 'http' || transport === 'remote') return 'http'
  return url ? 'http' : 'stdio'
}

function resolveStatus(
  enabled: boolean | undefined,
  missingEnvVars: string[],
  diagnostics: IntegrationDiagnostic[]
): McpServerStatus {
  if (enabled === false) return 'disabled'
  if (missingEnvVars.length > 0) return 'missing-env'
  if (diagnostics.some((diagnostic) => diagnostic.level === 'error')) return 'failed'
  return 'configured'
}

export function parseCodexMcpServersToml(raw: string): Record<string, UnknownRecord> {
  const servers: Record<string, UnknownRecord> = {}
  let currentServer: UnknownRecord | null = null
  let currentTarget: UnknownRecord | null = null

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue

    const tableMatch = line.match(/^\[(.+)]$/)
    if (tableMatch) {
      const path = splitTomlPath(tableMatch[1])
      if (path[0] !== 'mcp_servers' || !path[1]) {
        currentServer = null
        currentTarget = null
        continue
      }

      currentServer = servers[path[1]] ?? {}
      servers[path[1]] = currentServer
      currentTarget = currentServer

      for (const segment of path.slice(2)) {
        const existing = asRecord(currentTarget[segment])
        const next = existing ?? {}
        currentTarget[segment] = next
        currentTarget = next
      }
      continue
    }

    if (!currentTarget) continue

    const assignmentIndex = findUnquoted(line, '=')
    if (assignmentIndex === -1) continue

    const key = unquoteTomlString(line.slice(0, assignmentIndex).trim())
    currentTarget[key] = parseTomlValue(line.slice(assignmentIndex + 1).trim())
  }

  return servers
}

function parseTomlValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^["']/.test(value)) return unquoteTomlString(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner ? splitDelimited(inner).map((part) => parseTomlValue(part.trim())) : []
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const record: UnknownRecord = {}
    for (const entry of splitDelimited(value.slice(1, -1))) {
      const assignmentIndex = findUnquoted(entry, '=')
      if (assignmentIndex === -1) continue
      const key = unquoteTomlString(entry.slice(0, assignmentIndex).trim())
      record[key] = parseTomlValue(entry.slice(assignmentIndex + 1).trim())
    }
    return record
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function splitTomlPath(path: string): string[] {
  return splitDelimited(path, '.').map((segment) => unquoteTomlString(segment.trim()))
}

function splitDelimited(value: string, delimiter = ','): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let depth = 0

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      current += char
      if (char === quote && value[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === delimiter && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (current) parts.push(current)
  return parts
}

function stripTomlComment(line: string): string {
  const index = findUnquoted(line, '#')
  return index === -1 ? line : line.slice(0, index)
}

function findUnquoted(value: string, target: string): number {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === target) return index
  }
  return -1
}

function unquoteTomlString(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"')
  }
  return trimmed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(String)
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
      .map(([key, entryValue]) => [key, String(entryValue)])
  )
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function extractMissingEnvVars(record: Record<string, string> | undefined): string[] {
  if (!record) return []
  return Object.values(record).flatMap((value) =>
    extractEnvVariableReferences(value).filter((name) => !process.env[name])
  )
}

function extractEnvVariableReferences(value: string): string[] {
  const names = new Set<string>()
  for (const match of value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)}/g)) {
    names.add(match[1])
  }
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)}/g)) {
    names.add(match[1])
  }
  for (const match of value.matchAll(/(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[2])
  }
  for (const match of value.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    names.add(match[1])
  }
  return Array.from(names)
}

function redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      extractEnvVariableReferences(value).length > 0 ? value : REDACTED_VALUE
    ])
  )
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function compareMcpServers(a: McpServerConfig, b: McpServerConfig): number {
  return sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name)
}

function sourceRank(source: McpConfigSource): number {
  const ranks: Record<McpConfigSource, number> = {
    'cursor-project': 0,
    'claude-project': 1,
    'codex-project': 2,
    'opencode-project': 3,
    'cursor-global': 4,
    mousse: 5,
    'generated-agent': 6
  }
  return ranks[source]
}

function findDuplicateDiagnostics(servers: McpServerConfig[]): IntegrationDiagnostic[] {
  const seen = new Map<string, McpServerConfig>()
  const diagnostics: IntegrationDiagnostic[] = []

  for (const server of servers) {
    if (server.name === '(invalid config)') continue
    const existing = seen.get(server.name)
    if (existing) {
      diagnostics.push({
        level: 'info',
        source: server.source,
        path: server.configPath,
        targetId: server.id,
        message: `MCP server name also appears in ${existing.source}; project-scoped sources are listed first.`
      })
      continue
    }
    seen.set(server.name, server)
  }

  return diagnostics
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readJsonObject(path: string): Promise<UnknownRecord> {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return asRecord(parsed) ?? {}
  } catch (err) {
    throw new Error(`Failed to read existing Cursor MCP config: ${formatError(err)}`)
  }
}

function deepMergeObjects(base: UnknownRecord, patch: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key]
    if (asRecord(current) && asRecord(value)) {
      result[key] = deepMergeObjects(current as UnknownRecord, value as UnknownRecord)
    } else {
      result[key] = value
    }
  }
  return result
}
