import { join } from 'path'
import type { IntegrationScope, McpConfigSource, SkillSource } from '../../shared/integrations'
import type { IntegrationRuntimeContext } from './profileContext'
import { assertOwnedPath, pathKey } from '../profiles/pathSafety'
import { sha256Bytes } from './revision'

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

/** Stable identity for a repository. It is deliberately path-derived and contains no profile data. */
export function getProjectIdentity(projectPath: string): string {
  return `project-${sha256Bytes(pathKey(projectPath)).slice(0, 24)}`
}

export function getManagedProjectRoot(profileRoot: string, projectPath: string): string {
  return join(getManagedIntegrationsRoot(profileRoot), 'projects', sanitizeFsSegment(getProjectIdentity(projectPath)))
}

export function getManagedProjectSkillRoot(profileRoot: string, projectPath: string): string {
  return join(getManagedProjectRoot(profileRoot, projectPath), MOUSSE_PROJECT_SKILLS_DIR)
}

export function getManagedProjectMcpConfigPath(profileRoot: string, projectPath: string): string {
  return join(getManagedProjectRoot(profileRoot, projectPath), MOUSSE_PROJECT_MCP_FILE)
}

export interface NativeSkillRootDescriptor {
  source: SkillSource
  scope: IntegrationScope
  path: string
  profileId?: string
  projectId?: string
  managed: boolean
}

export interface NativeMcpConfigDescriptor {
  source: McpConfigSource
  scope: IntegrationScope
  path: string
  format: 'mousse-json'
  profileId?: string
  projectId?: string
  managed: boolean
}

export function getNativeSkillRoots(
  context: IntegrationRuntimeContext,
  projectPath?: string
): NativeSkillRootDescriptor[] {
  const roots: NativeSkillRootDescriptor[] = [
    {
      source: 'mousse-profile',
      scope: 'global',
      path: assertOwnedPath(context.profileRoot, getManagedSkillRoot(context.profileRoot), 'profile skill root'),
      profileId: context.profileId,
      managed: true
    }
  ]
  const project = projectPath ?? context.projectPath
  if (project) {
    roots.push({
      source: 'mousse-project',
      scope: 'project',
      path: assertOwnedPath(context.profileRoot, getManagedProjectSkillRoot(context.profileRoot, project), 'managed project skill root'),
      profileId: context.profileId,
      projectId: getProjectIdentity(project),
      managed: true
    })
    roots.push({
      source: 'mousse-project',
      scope: 'project',
      path: assertOwnedPath(project, getProjectMousseSkillRoot(project), 'external project skill root'),
      profileId: context.profileId,
      projectId: getProjectIdentity(project),
      managed: false
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
      path: assertOwnedPath(context.profileRoot, getManagedMcpConfigPath(context.profileRoot), 'profile MCP config'),
      format: 'mousse-json',
      profileId: context.profileId,
      managed: true
    }
  ]
  const project = projectPath ?? context.projectPath
  if (project) {
    paths.push({
      source: 'generated-agent',
      scope: 'project',
      path: assertOwnedPath(context.profileRoot, getManagedProjectMcpConfigPath(context.profileRoot, project), 'managed project MCP config'),
      format: 'mousse-json',
      profileId: context.profileId,
      projectId: getProjectIdentity(project),
      managed: true
    })
    paths.push({
      source: 'generated-agent',
      scope: 'project',
      path: assertOwnedPath(project, getProjectMousseMcpConfigPath(project), 'external project MCP config'),
      format: 'mousse-json',
      profileId: context.profileId,
      projectId: getProjectIdentity(project),
      managed: false
    })
  }
  return paths
}
