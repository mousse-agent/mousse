import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpToolDescriptor } from '../../../shared/integrations'
import type { IntegrationActor } from '../../../shared/integrations/actor'
import type { McpServerTestResult, McpToolCallResult } from '../../../shared/integrations/results'
import type { SettingsStore } from '../../settings/SettingsStore'
import { McpRegistry } from './McpRegistry'
import { allocateProviderToolName } from './toolNames'
import {
  ensureMcpOAuthAuthorized,
  FileMcpOAuthProvider,
  revokeStoredMcpOAuthSession,
  type OpenExternalFn
} from './McpOAuthProvider'
import { TimeoutError, combineSignals, withAbortTimeout } from './abortTimeout'
import { inferMcpAuthMode, classifyTransportError, shouldAttachOAuthProvider } from './authMode'
import { buildConnectionKey, mcpInstallationId } from './connectionKey'
import { mapMcpToolResult } from './mcpResults'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from '../profileContext'
import { getManagedMcpOAuthDir } from '../nativePaths'
import { missingReferences, redactSensitiveText, resolveRecord } from '../secrets'
import {
  isMcpToolAllowedForActor,
  resolveEffectiveMcpServers
} from '../catalog/EffectiveIntegrationResolver'
import { defaultIntegrationActor } from '../../../shared/integrations/actor'
import { assertOwnedPath } from '../../profiles/pathSafety'
import {
  abortFrom,
  abortableDelay,
  DEFAULT_MCP_SHUTDOWN_TIMEOUT_MS,
  mcpBusyError,
  McpOwnedWork,
  normalizeMcpShutdownTimeout,
  observePromise
} from './mcpOwnedWork'
import { OwnedStdioClientTransport } from './ownedStdioTransport'
import { logWarn } from '../../log/diag'

const START_TIMEOUT_MS = 12_000
const LIST_TOOLS_TIMEOUT_MS = 8_000
const CALL_TOOL_TIMEOUT_MS = 20_000

export interface InjectedMcpClient {
  listTools(options?: { signal?: AbortSignal; cursor?: string }): Promise<{
    tools: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
      outputSchema?: Record<string, unknown>
    }>
    nextCursor?: string
  }>
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<unknown>
  close(): Promise<void>
}

export interface McpClientFactory {
  connect(server: McpServerConfig, key: string, signal?: AbortSignal): Promise<InjectedMcpClient>
}

/** Internal dispatch fence for an already admitted workflow or agent grant. */
export interface McpToolExecutionPin {
  installationId: string
  configRevision: string
  toolName: string
  /** Workflow defaults must remain selected even though dispatch narrows to one tool. */
  requireProfileSelection?: boolean
  assertExecutionActive?: () => Promise<void>
}

export interface McpShutdownOptions {
  timeoutMs?: number
}

export interface McpManagerDependencies {
  context?: IntegrationRuntimeContext
  clientFactory?: McpClientFactory
  now?: () => number
}

interface ConnectedServer {
  client: InjectedMcpClient
  transport?: Transport
  config: McpServerConfig
  stderr: string[]
  key: string
  ownedStdio: boolean
  closing?: Promise<void>
  releaseLifetime?: () => void
}

export class McpManager {
  private connections = new Map<string, ConnectedServer>()
  private connecting = new Map<string, Promise<ConnectedServer>>()
  private toolMap = new Map<string, McpToolDescriptor>()
  private oauthProviders = new Map<string, FileMcpOAuthProvider>()
  private discoveryCache = new Map<string, { snapshot: Awaited<ReturnType<McpRegistry['discover']>>; fetchedAt: number }>()
  private static readonly DISCOVERY_TTL_MS = 30_000
  private readonly context: IntegrationRuntimeContext
  private readonly clientFactory?: McpClientFactory
  private readonly owned = new McpOwnedWork()
  private drain: Promise<void> | null = null
  private drainFinished = false

  constructor(
    private registry: McpRegistry,
    private settingsStore: SettingsStore,
    private openExternal: OpenExternalFn = async (url) => {
      logWarn('McpOAuth', `Open this URL to authorize: ${url}`)
    },
    deps: McpManagerDependencies = {}
  ) {
    this.context = deps.context ?? createLegacySingleProfileContext()
    this.clientFactory = deps.clientFactory
  }

  beginShutdown(): void {
    if (!this.owned.stopping) this.owned.beginShutdown()
    this.startDrain()
  }

  getActiveCount(): number {
    return this.owned.count
  }

  snapshotOwnedWork(): Record<string, number> {
    return this.owned.snapshot()
  }

  /**
   * Await owned MCP connect/list/call/auth/stdio teardown. `shutdown()` keeps the
   * legacy no-args signature. A timeout or close error retains ownership for retry.
   * Concurrent callers share the same underlying drain.
   */
  async shutdown(options?: McpShutdownOptions): Promise<void> {
    this.beginShutdown()
    if (this.drainFinished && this.owned.count === 0) return
    const timeoutMs = normalizeMcpShutdownTimeout(options?.timeoutMs ?? DEFAULT_MCP_SHUTDOWN_TIMEOUT_MS)
    this.startDrain()
    const drain = this.drain
    await this.owned.waitForIdle(timeoutMs, drain ?? undefined)
    if (drain) await drain
    if (this.owned.count !== 0 || this.connections.size !== 0 || this.connecting.size !== 0) {
      throw mcpBusyError(this.snapshotOwnedWork())
    }
    this.drainFinished = true
  }

  invalidateDiscoveryCache(): void {
    this.discoveryCache.clear()
  }

  async refresh(projectPath?: string): Promise<McpServerConfig[]> {
    this.invalidateDiscoveryCache()
    return this.listConfiguredServers(projectPath)
  }

  private async getDiscoverySnapshot(
    projectPath: string | undefined,
    redactSecrets: boolean
  ): Promise<Awaited<ReturnType<McpRegistry['discover']>>> {
    this.owned.assertAccepting()
    const cacheKey = `${this.context.profileId}:${projectPath ?? ''}:${redactSecrets ? 'redacted' : 'raw'}`
    const cached = this.discoveryCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < McpManager.DISCOVERY_TTL_MS) {
      return cached.snapshot
    }

    return this.owned.run('mcp-discover', async () => {
      const snapshot = await this.registry.discover({ projectPath, redactSecrets })
      if (!this.owned.stopping) {
        this.discoveryCache.set(cacheKey, { snapshot, fetchedAt: Date.now() })
      }
      return snapshot
    })
  }

  async listConfiguredServers(projectPath?: string): Promise<McpServerConfig[]> {
    const snapshot = await this.getDiscoverySnapshot(projectPath, true)
    return snapshot.servers
  }

  async listTools(serverId: string, projectPath?: string, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    this.owned.assertAccepting()
    const server = await this.resolveServer(serverId, projectPath)
    if (!server) {
      throw Object.assign(new Error(`MCP server not found: ${serverId}`), { category: 'missing' })
    }
    return this.listToolsForServer(server, projectPath, signal)
  }

  async getEnabledTools(
    projectPath?: string,
    principal: 'main' | 'mousse' | IntegrationActor = 'main'
  ): Promise<McpToolDescriptor[]> {
    this.owned.assertAccepting()
    const actor: IntegrationActor =
      principal === 'main' || principal === 'mousse'
        ? principal === 'main'
          ? defaultIntegrationActor(false)
          : defaultIntegrationActor(true)
        : principal
    const settings = this.settingsStore.get().integrations.mcp
    const snapshot = await this.getDiscoverySnapshot(projectPath, false)
    const eligibleServers = resolveEffectiveMcpServers({
      servers: snapshot.servers,
      settings,
      actor
    }).filter((server) => server.status !== 'missing-env' && server.status !== 'failed')

    const toolLists = await Promise.all(
      eligibleServers.map(async (server) => {
        try {
          const tools = await this.listToolsForServer(server, projectPath)
          return tools.filter((tool) => isMcpToolAllowedForActor(tool, server, actor) && !tool.schemaError)
        } catch (err) {
          console.warn(`[McpManager] Skipping MCP server "${server.name}": ${redactSensitiveText(formatError(err))}`)
          return []
        }
      })
    )

    return toolLists.flat()
  }

  /** Resolve and connect only the named enabled installation. Used by pinned execution preparation. */
  async getEnabledToolsForServer(
    serverId: string,
    projectPath: string | undefined,
    actor: IntegrationActor
  ): Promise<McpToolDescriptor[]> {
    this.owned.assertAccepting()
    const settings = this.settingsStore.get().integrations.mcp
    const snapshot = await this.getDiscoverySnapshot(projectPath, false)
    const matches = snapshot.servers.filter(
      (server) => server.id === serverId || mcpInstallationId(server) === serverId
    )
    if (matches.length !== 1) return []
    const eligible = resolveEffectiveMcpServers({ servers: matches, settings, actor })
      .filter((server) => server.status !== 'missing-env' && server.status !== 'failed')
    if (eligible.length !== 1) return []
    const server = eligible[0]!
    const tools = await this.listToolsForServer(server, projectPath)
    return tools.filter((tool) => isMcpToolAllowedForActor(tool, server, actor) && !tool.schemaError)
  }

  async isToolCallAllowed(
    providerName: string,
    projectPath: string | undefined,
    actor: IntegrationActor
  ): Promise<{ allowed: boolean; reason?: string; descriptor?: McpToolDescriptor; server?: McpServerConfig }> {
    const descriptor = this.toolMap.get(providerName)
    if (!descriptor) return { allowed: false, reason: `Unknown MCP tool: ${providerName}` }
    const server = await this.resolveServer(descriptor.installationId ?? descriptor.serverId, projectPath)
    if (!server) return { allowed: false, reason: 'MCP server is no longer configured.', descriptor }
    if (
      descriptor.configRevision &&
      server.configRevision &&
      descriptor.configRevision !== server.configRevision
    ) {
      return {
        allowed: false,
        reason: 'MCP server configuration changed. Refresh tools before calling it.',
        descriptor,
        server
      }
    }
    const settings = this.settingsStore.get().integrations.mcp
    const eligible = resolveEffectiveMcpServers({
      servers: [server],
      settings,
      actor
    })
    if (eligible.length === 0 || !isMcpToolAllowedForActor(descriptor, server, actor)) {
      return { allowed: false, reason: 'MCP tool is not enabled for this actor.', descriptor, server }
    }
    return { allowed: true, descriptor, server }
  }

  async authenticateServer(
    serverId: string,
    projectPath?: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; error?: string }> {
    try {
      return await this.owned.run('mcp-authenticate', () =>
        this.authenticateServerOwned(serverId, projectPath, signal)
      )
    } catch (err) {
      return { success: false, error: redactSensitiveText(formatError(err)) }
    }
  }

  private async authenticateServerOwned(
    serverId: string,
    projectPath?: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; error?: string }> {
    const combined = this.operationSignal(signal)
    const server = await this.resolveServer(serverId, projectPath)
    if (!server?.url) {
      return { success: false, error: 'Server not found or does not use remote HTTP transport.' }
    }
    const serverUrl = server.url

    await this.restartServer(server.installationId ?? server.id)
    const authConfig = resolveAuthConfig(server)
    const provider = await this.owned.run('mcp-oauth', () =>
      this.awaitRaw(
        'mcp-oauth-raw',
        ensureMcpOAuthAuthorized(
          mcpInstallationId(server),
          serverUrl,
          authConfig,
          this.openExternal,
          {
            oauthDir: this.oauthDir(),
            profileId: this.context.profileId,
            signal: combined
          }
        )
      )
    )
    if (this.owned.stopping) {
      await provider.revoke().catch(() => {})
      throw abortFrom(this.owned.signal.reason)
    }
    this.oauthProviders.set(mcpInstallationId(server), provider)
    await this.listToolsForServer({ ...server, authMode: 'oauth' }, projectPath, combined)
    return { success: true }
  }

  async revokeServer(serverId: string, projectPath?: string): Promise<void> {
    return this.owned.run('mcp-oauth-revoke', () => this.revokeServerOwned(serverId, projectPath))
  }

  private async revokeServerOwned(serverId: string, projectPath?: string): Promise<void> {
    const server = await this.resolveServer(serverId, projectPath)
    const installationId = server ? mcpInstallationId(server) : serverId
    const provider = this.oauthProviders.get(installationId)
    if (provider) {
      await provider.revoke()
      this.oauthProviders.delete(installationId)
    } else {
      await revokeStoredMcpOAuthSession(
        installationId,
        this.oauthDir(),
        this.context.profileId
      )
    }
    await this.restartServer(installationId)
  }

  async callTool(
    providerName: string,
    args: Record<string, unknown>,
    projectPath?: string,
    signal?: AbortSignal,
    actor: IntegrationActor = defaultIntegrationActor(false),
    expected?: McpToolExecutionPin
  ): Promise<McpToolCallResult> {
    this.owned.assertAccepting()
    const descriptor = this.toolMap.get(providerName)
    if (!descriptor) {
      throw new Error(`Unknown MCP tool: ${providerName}`)
    }
    const assertPin = (tool: McpToolDescriptor | undefined): void => {
      if (expected && (!tool || (tool.installationId ?? tool.serverId) !== expected.installationId || tool.configRevision !== expected.configRevision || tool.toolName !== expected.toolName)) throw Object.assign(new Error('MCP dependency changed since admission.'), { category: 'disabled', code: 'stale_revision' })
    }
    assertPin(descriptor)

    const authorization = await this.isToolCallAllowed(providerName, projectPath, actor)
    assertPin(authorization.descriptor)
    if (!authorization.allowed) throw new Error(authorization.reason ?? 'MCP tool is not enabled for this actor.')
    const server = authorization.server
    if (!server) {
      throw new Error(`MCP server is no longer configured: ${descriptor.serverId}`)
    }

    const connection = await this.connect(server, projectPath, signal)
    if (expected && (mcpInstallationId(connection.config) !== expected.installationId || connection.config.configRevision !== expected.configRevision)) throw Object.assign(new Error('MCP connection does not match the admitted revision.'), { category: 'disabled', code: 'stale_revision' })
    if (expected) {
      // Connection/auth setup may have yielded while the installation or run was revoked.
      await expected.assertExecutionActive?.()
      this.invalidateDiscoveryCache()
      const currentActor = expected.requireProfileSelection ? { ...actor, mcpServerIds: undefined, mcpToolIds: undefined } : actor
      const current = await this.isToolCallAllowed(providerName, projectPath, currentActor)
      assertPin(current.descriptor)
      assertPin(this.toolMap.get(providerName))
      if (!current.allowed || current.server?.configRevision !== expected.configRevision) throw Object.assign(new Error(current.reason ?? 'MCP dependency is no longer admitted.'), { category: 'disabled', code: 'stale_revision' })
      if (signal?.aborted) throw Object.assign(new Error('MCP call cancelled before dispatch.'), { category: 'cancelled' })
    }
    try {
      const result = await this.runTimed(
        'mcp-call',
        CALL_TOOL_TIMEOUT_MS,
        `Timed out calling MCP tool ${descriptor.toolName}`,
        signal,
        (callSignal) =>
          connection.client.callTool(
            { name: descriptor.toolName, arguments: args },
            { signal: callSignal, timeout: CALL_TOOL_TIMEOUT_MS }
          )
      )
      return mapMcpToolResult({
        result,
        provenance: {
          profileId: this.context.profileId,
          projectScope: projectPath,
          serverId: server.id,
          installationId: mcpInstallationId(server),
          configRevision: server.configRevision ?? '',
          toolName: descriptor.toolName,
          providerName: descriptor.providerName
        },
        artifacts: this.context.artifacts
      })
    } catch (err) {
      if (err instanceof TimeoutError && connection.ownedStdio) {
        await this.restartServer(mcpInstallationId(server))
      }
      const classified = classifyTransportError(err)
      throw Object.assign(new Error(classified.message), { category: classified.category })
    }
  }

  async testServer(
    serverId: string,
    projectPath?: string,
    signal?: AbortSignal
  ): Promise<McpServerTestResult> {
    this.owned.assertAccepting()
    const server = await this.resolveServer(serverId, projectPath)
    if (!server) {
      return {
        success: false,
        error: `MCP server not found: ${serverId}`,
        errorCategory: 'missing',
        toolCount: 0,
        connected: false
      }
    }
    if (server.enabled === false || server.status === 'disabled') {
      return {
        success: false,
        error: `MCP server "${server.name}" is disabled.`,
        errorCategory: 'disabled',
        toolCount: 0,
        connected: false,
        status: 'disabled'
      }
    }
    if (server.status === 'missing-env' || (server.missingEnvVars?.length ?? 0) > 0) {
      return {
        success: false,
        error: `MCP server is missing environment: ${(server.missingEnvVars ?? []).join(', ')}`,
        errorCategory: 'missing-env',
        toolCount: 0,
        connected: false,
        status: 'missing-env'
      }
    }
    if (server.transport === 'stdio' && !server.command) {
      return {
        success: false,
        error: `MCP server "${server.name}" is missing a command.`,
        errorCategory: 'missing-executable',
        toolCount: 0,
        connected: false
      }
    }
    if ((server.transport === 'http' || server.transport === 'sse') && !server.url) {
      return {
        success: false,
        error: `MCP server "${server.name}" is missing a URL.`,
        errorCategory: 'unreachable',
        toolCount: 0,
        connected: false
      }
    }

    try {
      const tools = await this.listToolsForServer(server, projectPath, signal)
      const incompatible = tools.filter((tool) => tool.schemaError)
      if (tools.length > 0 && incompatible.length === tools.length) {
        return {
          success: false,
          error: 'MCP server advertised tools with incompatible schemas.',
          errorCategory: 'schema-incompatible',
          toolCount: tools.length,
          connected: true,
          diagnostics: incompatible.map((tool) => tool.schemaError!).filter(Boolean)
        }
      }
      return {
        success: true,
        toolCount: tools.length,
        connected: true,
        status: 'connected',
        diagnostics: incompatible.map((tool) => tool.schemaError!).filter(Boolean)
      }
    } catch (err) {
      const classified = classifyTransportError(err)
      if (classified.category === 'auth-required' || isUnauthorizedError(err)) {
        return {
          success: false,
          error: classified.message,
          errorCategory: 'auth-required',
          toolCount: 0,
          connected: false,
          status: 'auth-required'
        }
      }
      return {
        success: false,
        error: classified.message,
        errorCategory: classified.category,
        toolCount: 0,
        connected: false
      }
    }
  }

  async restartServer(serverId: string): Promise<void> {
    const keys = [...this.connections.entries()]
      .filter(([, connection]) => mcpInstallationId(connection.config) === serverId)
      .map(([key]) => key)
    const exact = this.connections.get(serverId)
    const targets = exact ? [serverId] : keys.length > 0 ? keys : []
    await Promise.all(
      targets.map(async (key) => {
        const connection = this.connections.get(key)
        if (!connection) return
        await this.closeConnected(connection)
      })
    )
  }

  lookupTool(providerName: string): McpToolDescriptor | undefined {
    return this.toolMap.get(providerName)
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    return combineSignals([this.owned.signal, external])
  }

  private awaitRaw<T>(label: string, work: Promise<T>): Promise<T> {
    return this.owned.observe(label, work)
  }

  private startDrain(): void {
    if (this.drain) return
    const work = this.drainOwned().catch((error) => {
      if (this.drain === work) this.drain = null
      throw error
    })
    this.drain = work
    this.awaitRaw('mcp-drain', work)
  }

  private async drainOwned(): Promise<void> {
    this.invalidateDiscoveryCache()
    const errors: unknown[] = []
    const closeKnown = async (): Promise<void> => {
      const pending: Promise<void>[] = []
      for (const connection of [...this.connections.values()]) {
        pending.push(this.closeConnected(connection))
      }
      for (const attempt of [...this.connecting.values()]) {
        pending.push(
          attempt.then(
            (connection) => this.closeConnected(connection),
            () => undefined
          )
        )
      }
      const results = await Promise.allSettled(pending)
      for (const result of results) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
    }
    await closeKnown()
    if (this.connecting.size > 0 || this.connections.size > 0) {
      await closeKnown()
    }
    if (errors.length > 0) {
      throw errors[0]
    }
  }

  private retainConnection(connection: ConnectedServer): void {
    if (connection.releaseLifetime) return
    let release!: () => void
    const lifetime = new Promise<void>((resolve) => {
      release = resolve
    })
    connection.releaseLifetime = release
    this.awaitRaw('mcp-connection', lifetime)
  }

  private closeConnected(connection: ConnectedServer): Promise<void> {
    if (connection.closing) return connection.closing
    const work = this.performClose(connection).catch((error) => {
      if (connection.closing === work) connection.closing = undefined
      throw error
    })
    connection.closing = work
    this.awaitRaw('mcp-close', work)
    return work
  }

  private async performClose(connection: ConnectedServer): Promise<void> {
    let closeError: unknown
    try {
      await connection.client.close()
    } catch (error) {
      closeError = error
    }
    if (connection.transport) {
      try {
        await connection.transport.close()
      } catch (error) {
        closeError ??= error
      }
    }
    if (closeError) throw closeError
    if (this.connections.get(connection.key) === connection) {
      this.connections.delete(connection.key)
    }
    connection.releaseLifetime?.()
    connection.releaseLifetime = undefined
  }

  private async runTimed<T>(
    label: string,
    timeoutMs: number,
    message: string,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const combined = this.operationSignal(signal)
    return this.owned.run(label, async () => {
      return withAbortTimeout(
        (callSignal) => {
          const raw = run(callSignal)
          this.awaitRaw(`${label}-raw`, raw)
          return raw
        },
        timeoutMs,
        message,
        combined
      )
    })
  }

  private async listToolsForServer(
    server: McpServerConfig,
    projectPath?: string,
    signal?: AbortSignal
  ): Promise<McpToolDescriptor[]> {
    const connection = await this.connect(server, projectPath, signal)
    const tools: McpToolDescriptor[] = []
    const taken = new Set(this.toolMap.keys())
    let cursor: string | undefined
    do {
      const result = await this.runTimed(
        'mcp-list',
        LIST_TOOLS_TIMEOUT_MS,
        `Timed out listing tools for ${server.name}`,
        signal,
        (callSignal) => connection.client.listTools({ signal: callSignal, cursor })
      )
      const installationId = mcpInstallationId(server)
      for (const tool of result.tools) {
        const schemaError = describeSchemaError(tool.inputSchema)
        const providerName = allocateProviderToolName({
          serverName: server.name,
          toolName: tool.name,
          installationId,
          taken
        })
        taken.add(providerName)
        const descriptor: McpToolDescriptor = {
          id: `${installationId}:${tool.name}`,
          serverId: server.id,
          serverName: server.name,
          toolName: tool.name,
          providerName,
          description: redactSensitiveText(tool.description ?? ''),
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          installationId,
          configRevision: server.configRevision,
          profileId: this.context.profileId,
          schemaError
        }
        if (!this.owned.stopping) this.toolMap.set(providerName, descriptor)
        tools.push(descriptor)
      }
      cursor = result.nextCursor
    } while (cursor)
    return tools
  }

  private async connect(
    server: McpServerConfig,
    projectPath?: string,
    signal?: AbortSignal
  ): Promise<ConnectedServer> {
    const key = buildConnectionKey(server, this.context.profileId, projectPath)
    const existing = this.connections.get(key)
    if (existing && !existing.closing) return existing
    if (existing?.closing) {
      await existing.closing.catch(() => undefined)
      const current = this.connections.get(key)
      if (current && !current.closing) return current
    }
    if (this.owned.stopping) throw abortFrom(this.owned.signal.reason)
    this.owned.assertAccepting()
    const inflight = this.connecting.get(key)
    if (inflight) return inflight

    const attempt = observePromise(
      this.owned.run('mcp-connect', () => this.connectWithBackoff(server, key, signal))
    )
    this.connecting.set(key, attempt)
    try {
      const connection = await attempt
      if (this.owned.stopping) {
        await this.closeConnected(connection)
        throw abortFrom(this.owned.signal.reason)
      }
      this.connections.set(key, connection)
      this.retainConnection(connection)
      return connection
    } finally {
      if (this.connecting.get(key) === attempt) this.connecting.delete(key)
    }
  }

  private async connectWithBackoff(
    server: McpServerConfig,
    key: string,
    signal?: AbortSignal
  ): Promise<ConnectedServer> {
    const combined = this.operationSignal(signal)
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (combined.aborted) throw abortFrom(combined.reason)
      try {
        return await this.connectOnce(server, key, combined)
      } catch (err) {
        if (err instanceof TypeError) throw err
        const classified = classifyTransportError(err)
        if (
          isUnauthorizedError(err) ||
          classified.category === 'cancelled' ||
          classified.category === 'missing-executable' ||
          classified.category === 'unreachable' ||
          classified.category === 'dns'
        ) {
          throw err
        }
        lastError = err
        const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 100)
        await abortableDelay(delayMs, combined)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(formatError(lastError))
  }

  private async connectOnce(
    server: McpServerConfig,
    key: string,
    signal?: AbortSignal
  ): Promise<ConnectedServer> {
    if (this.clientFactory) {
      let raw: Promise<InjectedMcpClient> | undefined
      try {
        const client = await withAbortTimeout(
          (callSignal) => {
            raw = this.clientFactory!.connect(server, key, callSignal)
            this.awaitRaw('mcp-connect-raw', raw)
            return raw
          },
          START_TIMEOUT_MS,
          `Timed out starting MCP server ${server.name}`,
          signal
        )
        return { client, config: server, stderr: [], key, ownedStdio: false }
      } catch (error) {
        if (raw) {
          this.awaitRaw(
            'mcp-connect-late-close',
            raw.then(
              (client) => client.close(),
              () => undefined
            )
          )
        }
        throw error
      }
    }

    const authMode = inferMcpAuthMode(server)
    if (authMode === 'oauth') {
      await this.prepareOAuthProvider(server)
    }

    const client = new Client({ name: 'mousse', version: '0.1.0' }, { capabilities: {} })
    const stderrLines: string[] = []
    const oauth =
      authMode === 'oauth' ? this.oauthProviders.get(mcpInstallationId(server)) : undefined
    const transport = await this.createTransport(server, stderrLines, oauth, signal)
    try {
      await withAbortTimeout(
        (callSignal) => {
          if (callSignal.aborted) throw abortFrom(callSignal.reason)
          const raw = client.connect(transport)
          this.awaitRaw('mcp-connect-raw', raw)
          return raw
        },
        START_TIMEOUT_MS,
        `Timed out starting MCP server ${server.name}`,
        signal
      )
    } catch (error) {
      this.awaitRaw('mcp-connect-late-close', transport.close().catch(() => undefined))
      throw error
    }

    const wrapped: InjectedMcpClient = {
      listTools: async (options) => {
        const result = await requestWithSignal(
          client,
          'listTools',
          options?.cursor ? { cursor: options.cursor } : undefined,
          options
        )
        return {
          tools: result.tools ?? [],
          nextCursor: result.nextCursor
        }
      },
      callTool: async (args, options) => requestWithSignal(client, 'callTool', args, options),
      close: async () => {
        await client.close()
      }
    }

    return {
      client: wrapped,
      transport,
      config: server,
      stderr: stderrLines,
      key,
      ownedStdio: transport instanceof OwnedStdioClientTransport
    }
  }

  private async prepareOAuthProvider(server: McpServerConfig): Promise<void> {
    if (!server.url || !shouldAttachOAuthProvider(server)) return

    let provider = this.oauthProviders.get(mcpInstallationId(server))
    if (!provider) {
      provider = await FileMcpOAuthProvider.create(
        mcpInstallationId(server),
        server.url,
        resolveAuthConfig(server),
        this.openExternal,
        {
          oauthDir: this.oauthDir(),
          profileId: this.context.profileId,
          signal: this.owned.signal
        }
      )
      this.oauthProviders.set(mcpInstallationId(server), provider)
    }

    if (!provider.tokens()?.access_token) {
      throw Object.assign(
        new Error(`MCP server "${server.name}" requires OAuth. Use "Connect" in Settings to sign in.`),
        { category: 'auth-required' }
      )
    }
  }

  private async createTransport(
    server: McpServerConfig,
    stderrLines: string[],
    authProvider: FileMcpOAuthProvider | undefined,
    signal?: AbortSignal
  ): Promise<Transport> {
    const abort = this.operationSignal(signal)
    if (server.transport === 'stdio') {
      if (!server.command) {
        throw new Error(`MCP server ${server.name} is missing a command.`)
      }
      const env = {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(
          Object.entries(resolveRecord(server.env, this.context.secrets)).filter(([, value]) => value.length > 0)
        )
      }
      const transport = new OwnedStdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env,
        cwd: server.cwd,
        signal: abort
      })
      transport.stderr.on('data', (chunk) => {
        stderrLines.push(redactSensitiveText(String(chunk).slice(0, 4_000)))
        if (stderrLines.length > 20) stderrLines.shift()
      })
      return transport
    }

    if (!server.url) {
      throw new Error(`MCP server ${server.name} is missing a URL.`)
    }

    const headers = resolveRecord(server.headers, this.context.secrets)
    const requestInit = { headers: pruneEmptyHeaders(headers), signal: abort }
    const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, { ...init, signal: combineSignals([init?.signal ?? undefined, abort]) })) as typeof fetch
    const transportOptions = {
      requestInit,
      fetch: fetchFn,
      ...(authProvider ? { authProvider } : {})
    }

    return server.transport === 'sse'
      ? new SSEClientTransport(new URL(server.url), transportOptions)
      : new StreamableHTTPClientTransport(new URL(server.url), transportOptions)
  }

  private async resolveServer(serverId: string, projectPath?: string): Promise<McpServerConfig | undefined> {
    const snapshot = await this.owned.run('mcp-discover', () =>
      this.registry.discover({ projectPath, redactSecrets: false })
    )
    const exact = snapshot.servers.find(
      (server) => server.id === serverId || server.installationId === serverId
    )
    if (exact) return exact
    const named = snapshot.servers.filter((server) => server.name === serverId)
    if (named.length > 1) {
      throw new Error(`MCP server name is ambiguous; use an installation id: ${serverId}`)
    }
    return named[0]
  }

  private oauthDir(): string {
    return assertOwnedPath(
      this.context.profileRoot,
      getManagedMcpOAuthDir(this.context.profileRoot),
      'MCP OAuth directory'
    )
  }
}

async function requestWithSignal(
  client: Client,
  method: 'listTools' | 'callTool',
  params: unknown,
  options?: { signal?: AbortSignal; timeout?: number }
): Promise<any> {
  const requestOptions = { signal: options?.signal, timeout: options?.timeout }
  if (method === 'listTools') {
    return client.listTools((params ?? {}) as { cursor?: string }, requestOptions)
  }
  return client.callTool(
    params as { name: string; arguments?: Record<string, unknown> },
    undefined,
    requestOptions
  )
}

function resolveAuthConfig(server: McpServerConfig) {
  if (!server.auth) return undefined
  return {
    ...(server.auth.clientId ? { clientId: contextSafe(server.auth.clientId) } : {}),
    ...(server.auth.clientSecret ? { clientSecret: contextSafe(server.auth.clientSecret) } : {}),
    ...(server.auth.scopes?.length ? { scopes: server.auth.scopes } : {})
  }
}

function contextSafe(value: string): string {
  return value
}

function pruneEmptyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value.trim().length > 0))
}

function isUnauthorizedError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  if (name === 'UnauthorizedError') return true
  const classified = classifyTransportError(err)
  return classified.category === 'auth-required' || classified.category === 'unauthorized'
}

function describeSchemaError(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema) return undefined
  if (schema.type && schema.type !== 'object' && schema.type !== 'null') {
    return `Unsupported tool input schema type: ${String(schema.type)}`
  }
  return undefined
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { missingReferences }
