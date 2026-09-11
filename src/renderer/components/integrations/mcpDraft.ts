import type { CreateMcpParams, IntegrationProfileParams, UpdateMcpParams } from '../../../shared/integrationPlatform'
import type { McpAuthMode, McpServerConfig, McpTransport } from '../../../shared/integrations'
import { parseLines, parseMap } from './integrationUi'

export interface McpDraft {
  name: string; transport: McpTransport; command: string; args: string; cwd: string; url: string
  authMode: McpAuthMode; env: string; headers: string; clientId: string; clientSecret: string; scopes: string
  enabledTools: string; deniedTools: string; replaceEnv: boolean; replaceHeaders: boolean; replaceAuth: boolean; enabled: boolean
}

export function draftFromMcp(server?: McpServerConfig): McpDraft {
  return {
    name: server?.name ?? '', transport: server?.transport ?? 'stdio', command: server?.command ?? '',
    args: server?.args?.length ? JSON.stringify(server.args, null, 2) : '', cwd: server?.cwd ?? '', url: server?.url ?? '',
    authMode: server?.authMode ?? 'anonymous', env: '{}', headers: '{}',
    clientId: server?.auth?.clientId ?? '', clientSecret: '', scopes: server?.auth?.scopes?.join(' ') ?? '',
    enabledTools: server?.enabledTools?.join('\n') ?? '', deniedTools: server?.deniedTools?.join('\n') ?? '',
    replaceEnv: false, replaceHeaders: false, replaceAuth: !server, enabled: server?.enabled !== false
  }
}

/** JSON supports empty/space-containing argv; line mode preserves each line exactly. */
export function parseMcpArguments(value: string): string[] {
  if (!value.trim()) return []
  if (value.trimStart().startsWith('[')) {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('Arguments must be an array of strings.')
    return parsed
  }
  return value.split(/\r?\n/).filter((line) => line.length > 0)
}

function connectionFields(draft: McpDraft): Omit<CreateMcpParams, 'profileId' | 'projectId' | 'scope'> {
  if (!draft.name.trim()) throw new Error('Name is required.')
  if (draft.transport === 'stdio' && !draft.command.trim()) throw new Error('Executable is required for stdio.')
  if (draft.transport !== 'stdio') {
    let url: URL
    try { url = new URL(draft.url) } catch { throw new Error('Enter a valid HTTP or HTTPS endpoint.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTP or HTTPS without credentials in the URL.')
  }
  return {
    name: draft.name.trim(), transport: draft.transport, enable: draft.enabled,
    ...(draft.transport === 'stdio'
      ? { command: draft.command.trim(), args: parseMcpArguments(draft.args), ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}) }
      : { url: draft.url.trim() }),
    authMode: draft.authMode,
    enabledTools: parseLines(draft.enabledTools), deniedTools: parseLines(draft.deniedTools),
    ...(draft.replaceEnv ? { env: parseMap(draft.env) } : {}),
    ...(draft.replaceHeaders ? { headers: parseMap(draft.headers) } : {}),
    ...(draft.replaceAuth ? { auth: {
      ...(draft.clientId.trim() ? { clientId: draft.clientId.trim() } : {}),
      ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
      scopes: draft.scopes.split(/\s+/).filter(Boolean)
    } } : {})
  }
}

export function createMcpPayload(draft: McpDraft, identity: IntegrationProfileParams, scope: 'global' | 'project'): CreateMcpParams {
  return { ...identity, scope, ...connectionFields(draft) }
}

export function updateMcpPayload(draft: McpDraft, identity: IntegrationProfileParams, installationId: string, expectedRevision: string): UpdateMcpParams {
  if (!expectedRevision) throw new Error('Reload the saved connection before editing it.')
  // Scope is a create-only field. Never spread a create payload into update.
  return { ...identity, installationId, expectedRevision, ...connectionFields(draft), ...(draft.transport === 'stdio' ? { cwd: draft.cwd.trim() } : {}) }
}
