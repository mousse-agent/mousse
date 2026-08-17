import { homedir } from 'os'
import { join } from 'path'
import type { IntegrationScope, McpConfigSource, SkillSource } from '../../shared/integrations'

export function getMousseHomeDir(): string {
  return process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
}

export function getMousseConfPath(): string {
  return join(getMousseHomeDir(), 'mousse.conf')
}

export function getScheduledJobsRuntimePath(): string {
  return join(getScheduledDir(), 'jobs-runtime.json')
}

export function getCursorSdkStoreDir(): string {
  return join(getMousseHomeDir(), 'cursor-sdk')
}

export function getProjectsIndexPath(): string {
  return join(getMousseHomeDir(), 'projects.json')
}

export function getThreadsIndexPath(): string {
  return join(getMousseHomeDir(), 'threads-index.json')
}

export function getActiveThreadPath(): string {
  return join(getMousseHomeDir(), 'active-thread.json')
}

export function getScheduledDir(): string {
  return join(getMousseHomeDir(), 'scheduled')
}

export function getScheduledJobsPath(): string {
  return join(getScheduledDir(), 'jobs.json')
}

export function getScheduledJobsLockPath(): string {
  return join(getScheduledDir(), '.jobs.lock')
}

export function getScheduledTickLockPath(): string {
  return join(getScheduledDir(), '.tick.lock')
}

export function getScheduledTickerHeartbeatPath(): string {
  return join(getScheduledDir(), 'ticker_heartbeat')
}

export function getScheduledTickerSuccessPath(): string {
  return join(getScheduledDir(), 'ticker_last_success')
}

export function getChannelsDir(): string {
  return join(getMousseHomeDir(), 'channels')
}

export function getChannelsConfigPath(): string {
  return join(getChannelsDir(), 'config.json')
}

export function getChannelsSessionsPath(): string {
  return join(getChannelsDir(), 'sessions.json')
}

export function getChannelsDirectoryPath(): string {
  return join(getChannelsDir(), 'directory.json')
}

export function getChannelsPairingDir(): string {
  return join(getChannelsDir(), 'pairing')
}

export function getChannelsLockPath(): string {
  return join(getChannelsDir(), '.channels.lock')
}

export function getMcpOAuthDir(): string {
  return join(getMousseHomeDir(), 'mcp-oauth')
}

export function getCursorGlobalStorageDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return join(appData, 'Cursor', 'User', 'globalStorage')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage')
}

export function getStandaloneDataDir(): string {
  return join(getMousseHomeDir(), '.data')
}

export function getProjectMousseDir(projectPath: string): string {
  return join(projectPath, '.mousse')
}

export function getProjectDataDir(projectPath: string): string {
  return join(getProjectMousseDir(projectPath), '.data')
}

export function getStandaloneThreadDir(threadId: string): string {
  return join(getStandaloneDataDir(), threadId)
}

export function getProjectThreadDir(projectPath: string, threadId: string): string {
  return join(getProjectDataDir(projectPath), threadId)
}

export function getCursorGlobalMcpConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

export function getCursorProjectMcpConfigPath(projectPath: string): string {
  return join(projectPath, '.cursor', 'mcp.json')
}

export function getClaudeProjectMcpConfigPath(projectPath: string): string {
  return join(projectPath, '.mcp.json')
}

export function getCodexProjectMcpConfigPath(projectPath: string): string {
  return join(projectPath, '.codex', 'config.toml')
}

export function getOpenCodeProjectConfigPaths(projectPath: string): string[] {
  return [join(projectPath, 'opencode.json'), join(projectPath, '.opencode', 'opencode.json')]
}

export function getGeneratedAgentConfigRoot(agentId: string): string {
  return join(getMousseHomeDir(), 'agent-configs', agentId)
}

export interface McpConfigPathDescriptor {
  source: McpConfigSource
  scope: IntegrationScope
  path: string
  format: 'cursor-json' | 'claude-json' | 'codex-toml' | 'opencode-json' | 'mousse-json'
}

export function getMcpConfigPaths(projectPath?: string): McpConfigPathDescriptor[] {
  const paths: McpConfigPathDescriptor[] = [
    {
      source: 'cursor-global',
      scope: 'global',
      path: getCursorGlobalMcpConfigPath(),
      format: 'cursor-json'
    }
  ]

  if (projectPath) {
    paths.push(
      {
        source: 'cursor-project',
        scope: 'project',
        path: getCursorProjectMcpConfigPath(projectPath),
        format: 'cursor-json'
      },
      {
        source: 'claude-project',
        scope: 'project',
        path: getClaudeProjectMcpConfigPath(projectPath),
        format: 'claude-json'
      },
      {
        source: 'codex-project',
        scope: 'project',
        path: getCodexProjectMcpConfigPath(projectPath),
        format: 'codex-toml'
      },
      ...getOpenCodeProjectConfigPaths(projectPath).map((path): McpConfigPathDescriptor => ({
        source: 'opencode-project',
        scope: 'project',
        path,
        format: 'opencode-json'
      }))
    )
  }

  return paths
}

export interface SkillRootPathDescriptor {
  source: SkillSource
  scope: IntegrationScope
  path: string
}

export function getGlobalSkillRootPaths(): SkillRootPathDescriptor[] {
  return [
    { source: 'cursor-global', scope: 'global', path: join(homedir(), '.cursor', 'skills') },
    { source: 'agents-global', scope: 'global', path: join(homedir(), '.agents', 'skills') },
    { source: 'claude-global', scope: 'global', path: join(homedir(), '.claude', 'skills') },
    { source: 'codex-global', scope: 'global', path: join(homedir(), '.codex', 'skills') },
    {
      source: 'opencode-global',
      scope: 'global',
      path: join(homedir(), '.config', 'opencode', 'skills')
    }
  ]
}

export function getProjectSkillRootPaths(projectPath: string): SkillRootPathDescriptor[] {
  return [
    { source: 'cursor-project', scope: 'project', path: join(projectPath, '.cursor', 'skills') },
    { source: 'agents-project', scope: 'project', path: join(projectPath, '.agents', 'skills') },
    { source: 'claude-project', scope: 'project', path: join(projectPath, '.claude', 'skills') },
    { source: 'codex-project', scope: 'project', path: join(projectPath, '.codex', 'skills') },
    { source: 'opencode-project', scope: 'project', path: join(projectPath, '.opencode', 'skills') }
  ]
}

export function getSkillRootPaths(projectPath?: string): SkillRootPathDescriptor[] {
  return projectPath
    ? [...getGlobalSkillRootPaths(), ...getProjectSkillRootPaths(projectPath)]
    : getGlobalSkillRootPaths()
}
