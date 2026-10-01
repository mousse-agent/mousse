import { INTEGRATION_CAPABILITY, INTEGRATION_METHODS, type IntegrationMethod } from '../../shared/integrationPlatform'
import type { McpCreateInput, McpUpdateInput, SkillCreateInput, SkillUpdateInput } from '../../shared/integrations/lifecycle'
import type { ProjectManager } from '../data/ProjectManager'
import type { SettingsStore } from '../settings/SettingsStore'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { IntegrationCatalog } from './catalog/IntegrationCatalog'
import type { McpManager } from './mcp/McpManager'

export interface IntegrationDomainServices {
  profileId: string
  catalog: IntegrationCatalog
  mcpManager: McpManager
  projects: ProjectManager
  settings: SettingsStore
}
export interface IntegrationDomainRegistration {
  disconnect(connectionId: string): void
  disposeProfile(profileId: string): void
  dispose(): void
}
interface AuthAttempt {
  controller: AbortController
  profileId: string
  connectionId: string
  projectPath?: string
  installationId: string
}
type Params = Record<string, unknown>
const CREATE_SKILL = ['name', 'description', 'scope', 'instructions', 'license', 'compatibility', 'enable']
const MCP_CONFIG = ['name', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'authMode', 'auth', 'enabledTools', 'deniedTools', 'enable']
const fields: Record<IntegrationMethod, readonly string[]> = {
  'integrations.snapshot': ['refresh'],
  'skills.create': CREATE_SKILL,
  'skills.update': ['installationId', 'expectedRevision', 'content', 'description', 'enable'],
  'skills.editor': ['installationId', 'revision'],
  'skills.enable': ['installationId', 'enabled'],
  'skills.archive': ['installationId'],
  'skills.importPackage': ['scope', 'zipBase64', 'zipName', 'replaceInstallationId', 'enable'],
  'skills.exportPackage': ['installationId', 'format'],
  'mcp.create': ['scope', ...MCP_CONFIG],
  'mcp.update': ['installationId', 'expectedRevision', ...MCP_CONFIG],
  'mcp.read': ['installationId'],
  'mcp.enable': ['installationId', 'enabled'],
  'mcp.delete': ['installationId'],
  'mcp.testConnection': ['installationId'],
  'mcp.beginAuth': ['installationId'],
  'mcp.cancelAuth': ['installationId'],
  'mcp.revokeAuth': ['installationId']
}

function validate(method: IntegrationMethod, value: unknown): Params {
  const p = domainObject(value ?? {}, ['profileId', 'projectId', ...fields[method]])
  for (const key of ['installationId', 'replaceInstallationId', 'projectId', 'name', 'zipName', 'license', 'compatibility', 'command', 'url']) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || !(p[key] as string).trim() || (p[key] as string).length > 4096 || /\0/.test(p[key] as string))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  // Empty cwd deliberately clears an optional override; omitted cwd preserves it.
  if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length > 4096 || p.cwd.includes('\0'))) throw new DomainRpcError('invalid_params', 'Invalid cwd')
  for (const key of ['refresh', 'enabled', 'enable']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new DomainRpcError('invalid_params', key + ' must be boolean')
  for (const key of ['description', 'content', 'instructions']) if (p[key] !== undefined && (typeof p[key] !== 'string' || (p[key] as string).length > 256 * 1024)) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  if (fields[method].includes('installationId') && p.installationId === undefined) throw new DomainRpcError('invalid_params', 'Installation identity is required')
  if (method.endsWith('.enable') && p.enabled === undefined) throw new DomainRpcError('invalid_params', 'enabled is required')
  if (p.scope !== undefined && p.scope !== 'global' && p.scope !== 'project') throw new DomainRpcError('invalid_params', 'Invalid integration scope')
  if (['skills.create', 'skills.importPackage', 'mcp.create'].includes(method) && p.scope === undefined) throw new DomainRpcError('invalid_params', 'Integration scope is required')
  if (p.scope === 'project' && p.projectId === undefined) throw new DomainRpcError('invalid_params', 'Project scope requires an owned project')
  if (method === 'skills.create' && (typeof p.name !== 'string' || typeof p.description !== 'string')) throw new DomainRpcError('invalid_params', 'Skill name and description are required')
  if (method === 'mcp.create' && (typeof p.name !== 'string' || p.transport === undefined)) throw new DomainRpcError('invalid_params', 'MCP name and transport are required')
  if (p.transport !== undefined && !['stdio', 'http', 'sse'].includes(p.transport as string)) throw new DomainRpcError('invalid_params', 'Unsupported MCP transport')
  if (p.authMode !== undefined && !['anonymous', 'static', 'oauth'].includes(p.authMode as string)) throw new DomainRpcError('invalid_params', 'Invalid authentication mode')
  for (const key of ['expectedRevision', 'revision']) if (p[key] !== undefined && (typeof p[key] !== 'string' || !/^[a-f0-9]{64}$/.test(p[key] as string))) throw new DomainRpcError('invalid_params', 'Invalid revision hash')
  if (['skills.update', 'mcp.update'].includes(method) && p.expectedRevision === undefined) throw new DomainRpcError('invalid_params', 'Expected revision is required')
  for (const key of ['args', 'enabledTools', 'deniedTools']) if (p[key] !== undefined && (!Array.isArray(p[key]) || (p[key] as unknown[]).length > 256 || (p[key] as unknown[]).some((entry) => typeof entry !== 'string' || entry.length > 8192 || entry.includes('\0')))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  for (const key of ['env', 'headers']) if (p[key] !== undefined) {
    const value = p[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainRpcError('invalid_params', 'Expected string map')
    const record = domainObject(value, Object.keys(value))
    if (Object.keys(record).length > 100 || Object.entries(record).some(([name, entry]) => name.length > 256 || typeof entry !== 'string' || entry.length > 16_384 || /[\0\r\n]/.test(name))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
    if (Object.values(record).includes('[redacted]')) throw new DomainRpcError('redacted_secret', 'Omit unchanged secret fields, or supply replacement values')
  }
  if (p.auth !== undefined) {
    const auth = domainObject(p.auth, ['clientId', 'clientSecret', 'scopes'])
    for (const key of ['clientId', 'clientSecret']) if (auth[key] !== undefined && (typeof auth[key] !== 'string' || (auth[key] as string).length > 16_384)) throw new DomainRpcError('invalid_params', 'Invalid OAuth configuration')
    if (auth.scopes !== undefined && (!Array.isArray(auth.scopes) || auth.scopes.length > 100 || auth.scopes.some((scope) => typeof scope !== 'string' || scope.length > 1024))) throw new DomainRpcError('invalid_params', 'Invalid OAuth scopes')
    if (auth.clientSecret === '[redacted]') throw new DomainRpcError('redacted_secret', 'Omit unchanged authentication settings, or supply replacement values')
  }
  if (p.format !== undefined && p.format !== 'zip' && p.format !== 'markdown') throw new DomainRpcError('invalid_params', 'Invalid export format')
  if (method === 'skills.importPackage' && (typeof p.zipBase64 !== 'string' || !p.zipBase64 || p.zipBase64.length > 480 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.zipBase64))) throw new DomainRpcError('invalid_params', 'Expected a ZIP package encoded as base64 (maximum 360 KiB)')
  return p
}

function ownedProject(service: IntegrationDomainServices, id: unknown): string | undefined {
  if (id === undefined) return undefined
  const project = service.projects.getProject(id as string)
  if (!project) throw new DomainRpcError('project_not_found', 'Project does not belong to the bound profile')
  return project.path
}

function select(service: IntegrationDomainServices, kind: 'skills' | 'mcp', id: string, enabled: boolean): void {
  const integrations = service.settings.get().integrations
  if (kind === 'skills') {
    const ids = new Set(integrations.skills.enabledSkills)
    if (enabled) ids.add(id); else ids.delete(id)
    service.settings.set({ integrations: { ...integrations, skills: { ...integrations.skills, enabled: enabled || integrations.skills.enabled, enabledSkills: [...ids] } } })
  } else {
    const ids = new Set(integrations.mcp.enabledServers)
    if (enabled) ids.add(id); else ids.delete(id)
    service.settings.set({ integrations: { ...integrations, mcp: { ...integrations.mcp, enabled: enabled || integrations.mcp.enabled, enabledServers: [...ids] } } })
  }
}

/** New lifecycle methods use bound profiles and registered project identities, never renderer file paths. */
export function registerIntegrationMethods(domains: DomainHandlerRegistry, servicesForProfile: (id: string) => IntegrationDomainServices | Promise<IntegrationDomainServices>): IntegrationDomainRegistration {
  const mutations = new Map<string, Promise<unknown>>()
  const auth = new Map<string, AuthAttempt>()
  let disposed = false
  const abortMatching = (matches: (attempt: AuthAttempt) => boolean): void => {
    for (const [key, attempt] of auth) if (matches(attempt)) {
      attempt.controller.abort()
      auth.delete(key)
    }
  }
  for (const method of INTEGRATION_METHODS) domains.register({
    method, scope: 'profile', capability: INTEGRATION_CAPABILITY, requiredCapabilities: [INTEGRATION_CAPABILITY],
    validate: (value) => validate(method, value),
    async handle(context, p, binding) {
      if (disposed) throw new DomainRpcError('service_unavailable', 'Integration services are shutting down')
      const service = await servicesForProfile(binding!.profileId)
      if (disposed) throw new DomainRpcError('service_unavailable', 'Integration services are shutting down')
      if (service.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Integration catalog does not belong to the admitted profile')
      const projectPath = ownedProject(service, p.projectId)
      const id = p.installationId as string
      const authKey = JSON.stringify([binding!.profileId, context.connection!.id, binding!.epoch, projectPath, id])
      if (method === 'mcp.cancelAuth') { auth.get(authKey)?.controller.abort(); auth.delete(authKey); return { cancelled: true } }
      if (method === 'mcp.beginAuth') {
        auth.get(authKey)?.controller.abort()
        const controller = new AbortController()
        const attempt: AuthAttempt = { controller, profileId: binding!.profileId, connectionId: context.connection!.id, projectPath, installationId: id }
        auth.set(authKey, attempt)
        const timer = setTimeout(() => controller.abort(), 300_000)
        try { return await service.mcpManager.authenticateServer(id, projectPath, controller.signal) }
        finally { clearTimeout(timer); if (auth.get(authKey) === attempt) auth.delete(authKey) }
      }
      if (['mcp.revokeAuth', 'mcp.delete', 'mcp.update'].includes(method) || (method === 'mcp.enable' && p.enabled === false)) abortMatching((attempt) => attempt.profileId === binding!.profileId && attempt.projectPath === projectPath && attempt.installationId === id)
      const execute = async (): Promise<unknown> => {
        if (disposed) throw new DomainRpcError('service_unavailable', 'Integration services are shutting down')
        const { catalog } = service
        switch (method) {
          case 'integrations.snapshot': { const [skills, mcp] = await Promise.all([catalog.skillsSnapshot(projectPath, p.refresh === true), catalog.mcpSnapshot(projectPath, p.refresh === true)]); return { skills, mcp } }
          case 'skills.create': { const record = await catalog.skills.create({ ...p, projectPath } as unknown as SkillCreateInput); select(service, 'skills', record.installationId, record.enabled); return record }
          case 'skills.update': { const record = await catalog.skills.update({ ...p, projectPath } as unknown as SkillUpdateInput); if (p.enable !== undefined) select(service, 'skills', record.installationId, record.enabled); return record }
          case 'skills.editor': return catalog.skills.read(id, projectPath, p.revision as string | undefined)
          case 'skills.enable': { const record = await catalog.skills.enable(id, p.enabled as boolean, projectPath); select(service, 'skills', record.installationId, record.enabled); return record }
          case 'skills.archive': await catalog.skills.archive(id, projectPath); select(service, 'skills', id, false); return { archived: true }
          case 'skills.importPackage': { const record = await catalog.skills.importPackage({ scope: p.scope as 'global' | 'project', projectPath, zipBytes: Buffer.from(p.zipBase64 as string, 'base64'), zipName: p.zipName as string | undefined, replaceInstallationId: p.replaceInstallationId as string | undefined, enable: p.enable as boolean | undefined }); select(service, 'skills', record.installationId, record.enabled); return record }
          case 'skills.exportPackage': { const result = p.format === 'markdown' ? await catalog.skills.exportMarkdown(id, projectPath) : await catalog.skills.exportPackage(id, projectPath); if (result.bytes.byteLength > 2 * 1024 * 1024) throw new DomainRpcError('export_too_large', 'Package exceeds the desktop transfer limit'); return { fileName: result.fileName, base64: Buffer.from(result.bytes).toString('base64'), contentType: result.contentType } }
          case 'mcp.create': { const record = await catalog.mcp.create({ ...p, projectPath } as unknown as McpCreateInput); select(service, 'mcp', record.installationId, record.enabled); return record }
          case 'mcp.update': { const record = await catalog.mcp.update({ ...p, projectPath } as unknown as McpUpdateInput); if (p.enable !== undefined) select(service, 'mcp', record.installationId, record.enabled); return record }
          case 'mcp.read': return catalog.mcp.read(id, projectPath)
          case 'mcp.enable': { const record = await catalog.mcp.enable(id, p.enabled as boolean, projectPath); select(service, 'mcp', record.installationId, record.enabled); return record }
          case 'mcp.delete': await catalog.mcp.delete(id, projectPath); select(service, 'mcp', id, false); return { archived: true }
          case 'mcp.testConnection': return service.mcpManager.testServer(id, projectPath)
          case 'mcp.revokeAuth': await service.mcpManager.revokeServer(id, projectPath); return { revoked: true }
        }
      }
      const checkedExecute = async (): Promise<unknown> => {
        try { return await execute() }
        catch (error) {
          if (error instanceof DomainRpcError) throw error
          if (error instanceof Error && /revision conflict/i.test(error.message)) throw new DomainRpcError('revision_conflict', error.message)
          throw error
        }
      }
      const mutation = !['integrations.snapshot', 'skills.editor', 'skills.exportPackage', 'mcp.read', 'mcp.testConnection'].includes(method)
      if (!mutation) return checkedExecute()
      const key = binding!.profileId
      const previous = mutations.get(key) ?? Promise.resolve()
      const result = previous.catch(() => {}).then(checkedExecute)
      mutations.set(key, result)
      try { return await result }
      finally { if (mutations.get(key) === result) mutations.delete(key) }
    }
  })
  return {
    disconnect: (connectionId) => abortMatching((attempt) => attempt.connectionId === connectionId),
    disposeProfile: (profileId) => abortMatching((attempt) => attempt.profileId === profileId),
    dispose: () => { disposed = true; abortMatching(() => true) }
  }
}
