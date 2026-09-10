import { join } from 'path'
import type { IntegrationScope, McpConfigSource, SkillSource } from '../../shared/integrations'
import type { IntegrationRuntimeContext } from './profileContext'

export const MOUSSE_PROJECT_DIR = '.mousse'
export const MOUSSE_PROJECT_SKILLS_DIR = 'skills'
export const MOUSSE_PROJECT_MCP_FILE = 'mcp.json'

export function getManagedIntegrationsRoot(profileRoot: string): string {
  return join(profileRoot, 'integrations')
}

export function getManagedSkillRoot(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'skills')
}

export function getManagedSkillArchiveRoot(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'skills-archive')
}

export function getManagedSkillStatePath(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'state', 'skills.json')
}

export function sanitizeFsSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
}

export function getManagedSkillRevisionRoot(profileRoot: string, installationId: string): string {
  return join(
    getManagedIntegrationsRoot(profileRoot),
    'revisions',
    'skills',
    sanitizeFsSegment(installationId)
  )
}

export function getManagedMcpConfigPath(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'mcp.json')
}

export function getManagedMcpArchivePath(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'state', 'mcp-archive.json')
}

export function getManagedMcpStateDir(profileRoot: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'state')
}

export function getManagedMcpOAuthDir(profileRoot: string): string {
  return join(profileRoot, 'secrets', 'mcp-oauth')
}

export function getProjectMousseDir(projectPath: string): string {
  return join(projectPath, MOUSSE_PROJECT_DIR)
}

export function getProjectMousseSkillRoot(projectPath: string): string {
  return join(getProjectMousseDir(projectPath), MOUSSE_PROJECT_SKILLS_DIR)
}

export function getProjectMousseMcpConfigPath(projectPath: string): string {
  return join(getProjectMousseDir(projectPath), MOUSSE_PROJECT_MCP_FILE)
}

export interface NativeSkillRootDescriptor {
  source: SkillSource
  scope: IntegrationScope
  path: string
  profileId: string
}

export interface NativeMcpConfigDescriptor {
  source: McpConfigSource
  scope: IntegrationScope
  path: string
  format: 'mousse-json'
  profileId: string
}

export function getNativeSkillRoots(
  context: IntegrationRuntimeContext,
  projectPath?: string
): NativeSkillRootDescriptor[] {
  const roots: NativeSkillRootDescriptor[] = [
    {
      source: 'mousse-profile',
      scope: 'global',
      path: getManagedSkillRoot(context.profileRoot),
      profileId: context.profileId
    }
  ]
  const project = projectPath ?? context.projectPath
  if (project) {
    roots.push({
      source: 'mousse-project',
      scope: 'project',
      path: getProjectMousseSkillRoot(project),
      profileId: context.profileId
    })
  }
  return roots
}

export function getNativeMcpConfigPaths(
  context: IntegrationRuntimeContext,
  projectPath?: string
): NativeMcpConfigDescriptor[] {
  const paths: NativeMcpConfigDescriptor[] = [
    {
      source: 'mousse',
      scope: 'global',
      path: getManagedMcpConfigPath(context.profileRoot),
      format: 'mousse-json',
      profileId: context.profileId
    }
  ]
  const project = projectPath ?? context.projectPath
  if (project) {
    paths.push({
      source: 'generated-agent',
      scope: 'project',
      path: getProjectMousseMcpConfigPath(project),
      format: 'mousse-json',
      profileId: context.profileId
    })
  }
  return paths
}
