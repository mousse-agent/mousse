import type { McpServerConfig } from '../../../shared/integrations'
import { revisionFromValue, sha256Bytes } from '../revision'

export interface McpConnectionKeyParts {
  profileId: string
  projectScope: string
  installationId: string
  configRevision: string
  authIdentity: string
}

export function mcpConnectionKey(parts: McpConnectionKeyParts): string {
  return [
    parts.profileId,
    parts.projectScope,
    parts.installationId,
    parts.configRevision,
    parts.authIdentity
  ].join('::')
}

export function connectionAffectingConfig(server: McpServerConfig): unknown {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd,
    url: server.url,
    envKeys: Object.keys(server.env ?? {}).sort(),
    headerKeys: Object.keys(server.headers ?? {}).sort(),
    authMode: server.authMode,
    authClientId: server.auth?.clientId,
    enabled: server.enabled !== false
  }
}

export function mcpConfigRevision(server: McpServerConfig, rawBytes?: string): string {
  if (rawBytes) return sha256Bytes(rawBytes)
  return server.configRevision ?? revisionFromValue(connectionAffectingConfig(server))
}

export function mcpAuthIdentity(server: McpServerConfig): string {
  if (server.authMode === 'oauth' || server.auth?.clientId) {
    return `oauth:${server.auth?.clientId ?? 'default'}`
  }
  if (server.authMode === 'static' || hasStaticAuthorization(server.headers)) {
    return `static:${Object.keys(server.headers ?? {})
      .map((key) => key.toLowerCase())
      .sort()
      .join(',')}`
  }
  return 'anonymous'
}

export function hasStaticAuthorization(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'Bearer') continue
    return true
  }
  return false
}

export function buildConnectionKey(
  server: McpServerConfig,
  profileId: string,
  projectPath?: string
): string {
  const installationId = server.installationId ?? server.id
  return mcpConnectionKey({
    profileId,
    projectScope: server.scope === 'project' ? projectPath ?? server.configPath ?? 'project' : 'profile',
    installationId,
    configRevision: mcpConfigRevision(server),
    authIdentity: mcpAuthIdentity(server)
  })
}

export function mcpInstallationId(server: Pick<McpServerConfig, 'id' | 'installationId' | 'source' | 'name'>): string {
  return server.installationId ?? server.id ?? `${server.source}:${server.name}`
}
