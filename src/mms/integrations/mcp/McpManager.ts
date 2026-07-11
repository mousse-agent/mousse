import { PassThrough } from 'stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpToolDescriptor } from '../../../shared/integrations'
import type { SettingsStore } from '../../settings/SettingsStore'
import { McpRegistry } from './McpRegistry'
import { toProviderSafeToolName } from './toolNames'
import {
  ensureMcpOAuthAuthorized,
  FileMcpOAuthProvider,
  type OpenExternalFn
} from './McpOAuthProvider'

const START_TIMEOUT_MS = 12_000
const LIST_TOOLS_TIMEOUT_MS = 8_000
const CALL_TOOL_TIMEOUT_MS = 20_000

interface ConnectedServer {
  client: Client
  transport: Transport
  config: McpServerConfig
  stderr: string[]
}

export class McpManager {
  private connections = new Map<string, ConnectedServer>()
  private toolMap = new Map<string, McpToolDescriptor>()
  private oauthProviders = new Map<string, FileMcpOAuthProvider>()
  private discoveryCache = new Map<string, { snapshot: Awaited<ReturnType<McpRegistry['discover']>>; fetchedAt: number }>()
  private static readonly DISCOVERY_TTL_MS = 30_000

  constructor(
    private registry: McpRegistry,
    private settingsStore: SettingsStore,
    private openExternal: OpenExternalFn = async (url) => {
      console.log(`[McpOAuth] Open this URL to authorize: ${url}`)
    }
  ) {}

  invalidateDiscoveryCache(): void {
    this.discoveryCache.clear()
  }

  private async getDiscoverySnapshot(
    projectPath: string | undefined,
    redactSecrets: boolean
  ): Promise<Awaited<ReturnType<McpRegistry['discover']>>> {
    const cacheKey = `${projectPath ?? ''}:${redactSecrets ? 'redacted' : 'raw'}`
    const cached = this.discoveryCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < McpManager.DISCOVERY_TTL_MS) {
      return cached.snapshot
    }

    const snapshot = await this.registry.discover({ projectPath, redactSecrets })
    this.discoveryCache.set(cacheKey, { snapshot, fetchedAt: Date.now() })
    return snapshot
  }

  async listConfiguredServers(projectPath?: string): Promise<McpServerConfig[]> {
    const snapshot = await this.getDiscoverySnapshot(projectPath, true)
    return snapshot.servers
  }

  async listTools(serverId: string, projectPath?: string): Promise<McpToolDescriptor[]> {
    const server = await this.resolveServer(serverId, projectPath)
    if (!server) return []
    return this.listToolsForServer(server)
  }

  async getEnabledTools(projectPath?: string): Promise<McpToolDescriptor[]> {
    const settings = this.settingsStore.get().integrations.mcp
    if (!settings.enabled || !settings.enableForMainAgent || settings.enabledServers.length === 0) {
      return []
    }

    const snapshot = await this.getDiscoverySnapshot(projectPath, false)
    const enabled = new Set(settings.enabledServers)
    const eligibleServers = snapshot.servers.filter((server) => {
      if (!enabled.has(server.id) && !enabled.has(server.name)) return false
      return server.status !== 'disabled' && server.status !== 'missing-env' && server.status !== 'failed'
    })

    const toolLists = await Promise.all(
      eligibleServers.map(async (server) => {
        try {
          return await this.listToolsForServer(server)
        } catch (err) {
          console.warn(`[McpManager] Skipping MCP server "${server.name}": ${formatError(err)}`)
          return []
        }
      })
    )

    return toolLists.flat()
  }

  async authenticateServer(
    serverId: string,
    projectPath?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const server = await this.resolveServer(serverId, projectPath)
      if (!server?.url) {
        return { success: false, error: 'Server not found or does not use remote HTTP transport.' }
      }

      await this.restartServer(server.id)
      const authConfig = resolveAuthConfig(server)
      const provider = await ensureMcpOAuthAuthorized(
        server.id,
        server.url,
        authConfig,
        this.openExternal
      )
      this.oauthProviders.set(server.id, provider)
      await this.listToolsForServer(server)
      return { success: true }
    } catch (err) {
      return { success: false, error: formatError(err) }
    }
  }

  async callTool(
    providerName: string,
    args: Record<string, unknown>,
    projectPath?: string
  ): Promise<{ text: string; isError: boolean }> {
    const descriptor = this.toolMap.get(providerName)
    if (!descriptor) {
      throw new Error(`Unknown MCP tool: ${providerName}`)
    }

    const server = await this.resolveServer(descriptor.serverId, projectPath)
    if (!server) {
      throw new Error(`MCP server is no longer configured: ${descriptor.serverId}`)
    }

    const connection = await this.connect(server)
    const result = await withTimeout(
      connection.client.callTool({
        name: descriptor.toolName,
        arguments: args
      }),
      CALL_TOOL_TIMEOUT_MS,
      `Timed out calling MCP tool ${descriptor.toolName}`
    )

    return {
      text: summarizeMcpToolResult(result),
      isError: 'isError' in result ? result.isError === true : false
    }
  }

  async testServer(serverId: string, projectPath?: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.listTools(serverId, projectPath)
      return { success: true }
    } catch (err) {
      if (!isUnauthorizedError(err)) {
        return { success: false, error: formatError(err) }
      }

      const authResult = await this.authenticateServer(serverId, projectPath)
      if (!authResult.success) {
        return authResult
      }

      try {
        await this.listTools(serverId, projectPath)
        return { success: true }
      } catch (retryErr) {
        return { success: false, error: formatError(retryErr) }
      }
    }
  }

  async restartServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId)
    if (connection) {
      await connection.transport.close().catch(() => {})
      this.connections.delete(serverId)
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.connections.values()).map((connection) =>
        connection.transport.close().catch(() => {})
      )
    )
    this.connections.clear()
    this.oauthProviders.clear()
  }

  private async listToolsForServer(server: McpServerConfig): Promise<McpToolDescriptor[]> {
    const connection = await this.connect(server)
    const result = await withTimeout(
      connection.client.listTools(),
      LIST_TOOLS_TIMEOUT_MS,
      `Timed out listing tools for ${server.name}`
    )

    const tools = result.tools.map((tool) => {
      const providerName = toProviderSafeToolName(server.name, tool.name)
      const descriptor: McpToolDescriptor = {
        id: `${server.id}:${tool.name}`,
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        providerName,
        description: tool.description,
        inputSchema: tool.inputSchema
      }
      this.toolMap.set(providerName, descriptor)
      return descriptor
    })

    return tools
  }

  private async connect(server: McpServerConfig): Promise<ConnectedServer> {
    const existing = this.connections.get(server.id)
    if (existing) return existing

    await this.prepareOAuthProvider(server)

    const client = new Client({ name: 'mousse', version: '0.1.0' })
    const stderrLines: string[] = []
    const transport = await createTransport(server, stderrLines, this.oauthProviders.get(server.id))
    const connection: ConnectedServer = { client, transport, config: server, stderr: stderrLines }
    await withTimeout(
      client.connect(transport),
      START_TIMEOUT_MS,
      `Timed out starting MCP server ${server.name}`
    )
    this.connections.set(server.id, connection)
    return connection
  }

  private async prepareOAuthProvider(server: McpServerConfig): Promise<void> {
    if (!server.url || !shouldUseMcpOAuth(server)) return

    let provider = this.oauthProviders.get(server.id)
    if (!provider) {
      provider = await FileMcpOAuthProvider.create(
        server.id,
        server.url,
        resolveAuthConfig(server),
        this.openExternal
      )
      this.oauthProviders.set(server.id, provider)
    }

    if (!provider.tokens()?.access_token) {
      throw new Error(
        `MCP server "${server.name}" requires OAuth. Use "Connect" in Settings to sign in.`
      )
    }
  }

  private async resolveServer(serverId: string, projectPath?: string): Promise<McpServerConfig | undefined> {
    const snapshot = await this.registry.discover({ projectPath, redactSecrets: false })
    return snapshot.servers.find((server) => server.id === serverId || server.name === serverId)
  }
}

async function createTransport(
  server: McpServerConfig,
  stderrLines: string[],
  authProvider?: FileMcpOAuthProvider
): Promise<Transport> {
  if (server.transport === 'stdio') {
    if (!server.command) {
      throw new Error(`MCP server ${server.name} is missing a command.`)
    }
    const stderr = new PassThrough()
    stderr.on('data', (chunk) => {
      stderrLines.push(String(chunk).slice(0, 4_000))
      if (stderrLines.length > 20) stderrLines.shift()
    })
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...resolveEnvironment(server.env) } as Record<string, string>,
      cwd: server.cwd,
      stderr
    })
  }

  if (!server.url) {
    throw new Error(`MCP server ${server.name} is missing a URL.`)
  }

  const headers = resolveEnvironment(server.headers)
  const requestInit = { headers: pruneEmptyHeaders(headers) }
  const transportOptions = {
    requestInit,
    ...(authProvider ? { authProvider } : {})
  }

  return server.transport === 'sse'
    ? new SSEClientTransport(new URL(server.url), transportOptions)
    : new StreamableHTTPClientTransport(new URL(server.url), transportOptions)
}

function shouldUseMcpOAuth(server: McpServerConfig): boolean {
  if (server.transport !== 'http' && server.transport !== 'sse') return false
  return !hasStaticAuthorization(server.headers)
}

function hasStaticAuthorization(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    const resolved = resolveEnvValue(value).trim()
    if (!resolved || resolved === 'Bearer') continue
    return true
  }
  return false
}

function resolveAuthConfig(server: McpServerConfig) {
  if (!server.auth) return undefined
  return {
    ...(server.auth.clientId ? { clientId: resolveEnvValue(server.auth.clientId) } : {}),
    ...(server.auth.clientSecret ? { clientSecret: resolveEnvValue(server.auth.clientSecret) } : {}),
    ...(server.auth.scopes?.length ? { scopes: server.auth.scopes } : {})
  }
}

function pruneEmptyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => resolveEnvValue(value).trim().length > 0)
  )
}

function resolveEnvironment(values: Record<string, string> | undefined): Record<string, string> {
  if (!values) return {}
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolveEnvValue(value)])
  )
}

function resolveEnvValue(value: string): string {
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)}/g, (_match, name) => process.env[name] ?? '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)}/g, (_match, name) => process.env[name] ?? '')
    .replace(/(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, prefix, name) => `${prefix}${process.env[name] ?? ''}`)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name) => process.env[name] ?? '')
}

function isUnauthorizedError(err: unknown): boolean {
  const message = formatError(err)
  return (
    message.includes('401') ||
    message.includes('Unauthorized') ||
    message.includes('Streamable HTTP error')
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function summarizeMcpToolResult(result: unknown): string {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
  if (record && Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return ''
        const item = entry as Record<string, unknown>
        if (item.type === 'text') return String(item.text ?? '')
        if (item.type === 'resource') return JSON.stringify(item.resource)
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('\n')
    if (text) return truncate(text)
  }
  return truncate(JSON.stringify(result))
}

function truncate(value: string): string {
  return value.length > 12_000 ? `${value.slice(0, 12_000)}\n...[truncated]` : value
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
