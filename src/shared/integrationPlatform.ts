import type { McpRegistrySnapshot, SkillsRegistrySnapshot } from './integrations'
import type { ManagedMcpRecord, ManagedSkillRecord, McpCreateInput, McpUpdateInput, SkillCreateInput, SkillEditorDto, SkillUpdateInput } from './integrations/lifecycle'
import type { McpServerTestResult } from './integrations/results'

export const INTEGRATION_CAPABILITY = 'integrations.lifecycle.v1'
export const INTEGRATION_METHODS = [
  'integrations.snapshot', 'skills.create', 'skills.update', 'skills.editor',
  'skills.enable', 'skills.archive', 'skills.importPackage', 'skills.exportPackage',
  'mcp.create', 'mcp.update', 'mcp.read', 'mcp.enable', 'mcp.delete',
  'mcp.testConnection', 'mcp.beginAuth', 'mcp.cancelAuth', 'mcp.revokeAuth'
] as const
export type IntegrationMethod = (typeof INTEGRATION_METHODS)[number]
export interface IntegrationPlatformSnapshot {
  skills: SkillsRegistrySnapshot
  mcp: McpRegistrySnapshot
}
export interface IntegrationPackageDownload { fileName: string; base64: string; contentType: string }
export interface IntegrationPlatformRequester {
  request<T>(method: IntegrationMethod, params: unknown): Promise<T>
}
export interface IntegrationProfileParams { profileId: string; projectId?: string }
export interface IntegrationIdentityParams extends IntegrationProfileParams { installationId: string }
export type CreateSkillParams = IntegrationProfileParams & Omit<SkillCreateInput, 'projectPath' | 'scope'> & { scope: 'global' | 'project' }
export type UpdateSkillParams = IntegrationProfileParams & Omit<SkillUpdateInput, 'projectPath'> & { expectedRevision: string }
export type CreateMcpParams = IntegrationProfileParams & Omit<McpCreateInput, 'projectPath' | 'scope'> & { scope: 'global' | 'project' }
export type UpdateMcpParams = IntegrationProfileParams & Omit<McpUpdateInput, 'projectPath'> & { expectedRevision: string }
export interface ImportSkillParams extends IntegrationProfileParams {
  scope: 'global' | 'project'
  zipBase64: string
  zipName?: string
  replaceInstallationId?: string
  enable?: boolean
}
/** All project paths are resolved by the daemon from a profile-owned project ID. */
export interface IntegrationPlatformClient {
  snapshot(params: IntegrationProfileParams & { refresh?: boolean }): Promise<IntegrationPlatformSnapshot>
  createSkill(params: CreateSkillParams): Promise<ManagedSkillRecord>
  updateSkill(params: UpdateSkillParams): Promise<ManagedSkillRecord>
  skillEditor(params: IntegrationIdentityParams & { revision?: string }): Promise<SkillEditorDto>
  enableSkill(params: IntegrationIdentityParams & { enabled: boolean }): Promise<ManagedSkillRecord>
  archiveSkill(params: IntegrationIdentityParams): Promise<{ archived: true }>
  importSkill(params: ImportSkillParams): Promise<ManagedSkillRecord>
  exportSkill(params: IntegrationIdentityParams & { format?: 'zip' | 'markdown' }): Promise<IntegrationPackageDownload>
  createMcp(params: CreateMcpParams): Promise<ManagedMcpRecord>
  updateMcp(params: UpdateMcpParams): Promise<ManagedMcpRecord>
  readMcp(params: IntegrationIdentityParams): Promise<ManagedMcpRecord>
  enableMcp(params: IntegrationIdentityParams & { enabled: boolean }): Promise<ManagedMcpRecord>
  deleteMcp(params: IntegrationIdentityParams): Promise<{ archived: true }>
  testMcp(params: IntegrationIdentityParams): Promise<McpServerTestResult>
  beginMcpAuth(params: IntegrationIdentityParams): Promise<{ success: boolean; error?: string }>
  cancelMcpAuth(params: IntegrationIdentityParams): Promise<{ cancelled: true }>
  revokeMcpAuth(params: IntegrationIdentityParams): Promise<{ revoked: true }>
}
