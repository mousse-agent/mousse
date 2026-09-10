import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { IntegrationScope, McpServerConfig } from '../../../shared/integrations'
import type { McpCreateInput, McpUpdateInput, ManagedMcpRecord } from '../../../shared/integrations/lifecycle'
import { atomicWriteFile } from '../atomicWrite'
import { getManagedMcpArchivePath, getManagedMcpConfigPath, getProjectMousseMcpConfigPath } from '../nativePaths'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from '../profileContext'
import { revisionFromValue } from '../revision'
import { isAllowedRemoteUrl, McpRegistry } from './McpRegistry'
import { McpManager } from './McpManager'
import { inferMcpAuthMode } from './authMode'

interface ManagedMcpDocument {
  version: 1
  servers: Record<string, ManagedMcpEntry>
}

interface ManagedMcpEntry {
  id: string
  name: string
  transport: McpServerConfig['transport']
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  authMode?: McpServerConfig['authMode']
  auth?: McpServerConfig['auth']
  enabled?: boolean
  enabledTools?: string[]
  deniedTools?: string[]
  archived?: boolean
}

export class McpLifecycleService {
  private readonly context: IntegrationRuntimeContext

  constructor(
    private readonly registry: McpRegistry,
    private readonly manager: McpManager,
    context?: IntegrationRuntimeContext
  ) {
    this.context = context ?? createLegacySingleProfileContext()
  }

  async create(input: McpCreateInput): Promise<ManagedMcpRecord> {
    this.validateInput(input)
    const document = await this.readDocument(input.scope, input.projectPath)
    const installationId = randomUUID()
    const entry: ManagedMcpEntry = {
      id: installationId,
      name: input.name.trim(),
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      authMode: input.authMode ?? inferMcpAuthMode(input as McpServerConfig),
      auth: input.auth,
      enabled: input.enable !== false,
      enabledTools: input.enabledTools,
      deniedTools: input.deniedTools
    }
    document.servers[installationId] = entry
    await this.writeDocument(input.scope, input.projectPath, document)
    this.manager.invalidateDiscoveryCache()
    return this.loadRecord(installationId, input.projectPath)
  }

  async update(input: McpUpdateInput): Promise<ManagedMcpRecord> {
    const document = await this.readDocument('global', input.projectPath)
    const projectDocument = input.projectPath
      ? await this.readDocument('project', input.projectPath)
      : { version: 1 as const, servers: {} }
    const found =
      locateEntry(document, input.installationId, 'global') ??
      locateEntry(projectDocument, input.installationId, 'project')
    if (!found) throw new Error(`MCP installation not found: ${input.installationId}`)
    const currentRevision = revisionFromValue(found.entry)
    if (input.expectedRevision && input.expectedRevision !== currentRevision) {
      throw new Error('MCP configuration revision conflict. Reload before saving.')
    }
    const next = { ...found.entry, ...sanitizePatch(input), id: found.entry.id, name: input.name?.trim() ?? found.entry.name }
    this.validateInput(next)
    found.document.servers[found.entry.id] = next
    await this.writeDocument(found.scope, input.projectPath, found.document)
    await this.manager.restartServer(found.entry.id)
    this.manager.invalidateDiscoveryCache()
    return this.loadRecord(found.entry.id, input.projectPath)
  }

  async enable(installationId: string, enabled: boolean, projectPath?: string): Promise<ManagedMcpRecord> {
    return this.update({ installationId, enable: enabled, projectPath })
  }

  async delete(installationId: string, projectPath?: string): Promise<void> {
    const document = await this.readDocument('global', projectPath)
    const projectDocument = projectPath
      ? await this.readDocument('project', projectPath)
      : { version: 1 as const, servers: {} }
    const found =
      locateEntry(document, installationId, 'global') ??
      locateEntry(projectDocument, installationId, 'project')
    if (!found) throw new Error(`MCP installation not found: ${installationId}`)
    found.entry.enabled = false
    found.entry.archived = true
    const archive = await this.readArchive()
    archive.servers[installationId] = found.entry
    await atomicWriteFile(getManagedMcpArchivePath(this.context.profileRoot), `${JSON.stringify(archive, null, 2)}\n`)
    delete found.document.servers[installationId]
    await this.writeDocument(found.scope, projectPath, found.document)
    await this.manager.restartServer(installationId)
    await this.manager.revokeServer(installationId, projectPath).catch(() => {})
    this.manager.invalidateDiscoveryCache()
  }

  async read(installationId: string, projectPath?: string): Promise<ManagedMcpRecord> {
    return this.loadRecord(installationId, projectPath)
  }

  private async loadRecord(installationId: string, projectPath?: string): Promise<ManagedMcpRecord> {
    const snapshot = await this.registry.discover({ projectPath, redactSecrets: true })
    const server = snapshot.servers.find(
      (entry) => entry.installationId === installationId || entry.id === installationId || entry.name === installationId
    )
    if (!server) throw new Error(`MCP installation is not readable: ${installationId}`)
    return {
      installationId: server.installationId ?? server.id,
      server,
      enabled: server.enabled !== false,
      archived: false,
      revision: server.configRevision ?? revisionFromValue(server),
      diagnostics: server.diagnostics ?? []
    }
  }

  private validateInput(input: Partial<McpCreateInput & ManagedMcpEntry>): void {
    if (!input.name?.trim()) throw new Error('MCP server name is required.')
    if (input.transport === 'stdio' && !input.command?.trim()) {
      throw new Error('stdio MCP servers require a command.')
    }
    if ((input.transport === 'http' || input.transport === 'sse') && !input.url) {
      throw new Error('Remote MCP servers require a URL.')
    }
    if (input.url && !isAllowedRemoteUrl(input.url)) {
      throw new Error('MCP remote URL must be http(s) without embedded credentials.')
    }
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        if (key.toLowerCase() === 'authorization' && value && !value.includes('${')) {
          // Stored, but must not be logged. Presence is enough for validation.
        }
        if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
          throw new Error('MCP headers cannot contain CR/LF characters.')
        }
      }
    }
  }

  private async readDocument(scope: IntegrationScope, projectPath?: string): Promise<ManagedMcpDocument> {
    const path = this.configPath(scope, projectPath)
    if (!existsSync(path)) return { version: 1, servers: {} }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as ManagedMcpDocument
      if (parsed.version === 1 && parsed.servers) return parsed
      if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
        return { version: 1, servers: {} }
      }
      return { version: 1, servers: {} }
    } catch {
      return { version: 1, servers: {} }
    }
  }

  private async writeDocument(
    scope: IntegrationScope,
    projectPath: string | undefined,
    document: ManagedMcpDocument
  ): Promise<void> {
    await this.registry.writeManagedMcpConfig(
      this.configPath(scope, projectPath),
      document as unknown as Record<string, unknown>
    )
  }

  private configPath(scope: IntegrationScope, projectPath?: string): string {
    if (scope === 'project') {
      if (!projectPath) throw new Error('Project path is required for project-scoped MCP config.')
      return getProjectMousseMcpConfigPath(projectPath)
    }
    return getManagedMcpConfigPath(this.context.profileRoot)
  }

  private async readArchive(): Promise<ManagedMcpDocument> {
    const path = getManagedMcpArchivePath(this.context.profileRoot)
    if (!existsSync(path)) return { version: 1, servers: {} }
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as ManagedMcpDocument
    } catch {
      return { version: 1, servers: {} }
    }
  }
}

function locateEntry(
  document: ManagedMcpDocument,
  installationId: string,
  scope: IntegrationScope
): { document: ManagedMcpDocument; entry: ManagedMcpEntry; scope: IntegrationScope } | undefined {
  const entry =
    document.servers[installationId] ??
    Object.values(document.servers).find((server) => server.name === installationId)
  if (!entry) return undefined
  return { document, entry, scope }
}

function sanitizePatch(input: McpUpdateInput): Partial<ManagedMcpEntry> {
  const patch: Partial<ManagedMcpEntry> = {}
  if (input.transport) patch.transport = input.transport
  if (input.command !== undefined) patch.command = input.command
  if (input.args) patch.args = input.args
  if (input.env) patch.env = input.env
  if (input.cwd !== undefined) patch.cwd = input.cwd
  if (input.url !== undefined) patch.url = input.url
  if (input.headers) patch.headers = input.headers
  if (input.authMode) patch.authMode = input.authMode
  if (input.auth) patch.auth = input.auth
  if (typeof input.enable === 'boolean') patch.enabled = input.enable
  if (input.enabledTools) patch.enabledTools = input.enabledTools
  if (input.deniedTools) patch.deniedTools = input.deniedTools
  return patch
}
