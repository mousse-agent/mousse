import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { AgentConfigManager, getMcpTarget } from '../src/mms/integrations/agents/AgentConfigManager'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import type { McpRegistrySnapshot, SkillDescriptor, SkillsRegistrySnapshot, McpServerConfig } from '../src/shared/integrations'
import type { AgentTypeId } from '../src/shared/settings'

const cliTypes: AgentTypeId[] = ['mousse', 'claude-code', 'codex', 'opencode', 'cursor-agents-cli']

describe('I04 exact agent integration materialization', () => {
  it.each(cliTypes)('materializes the resolved actor set for %s without overwriting unrelated config', async (cliType) => {
    const root = mkdtempSync(join(tmpdir(), `mousse-i04-materialize-${cliType}-`))
    const profileRoot = join(root, 'profile'), projectPath = join(root, 'project'), worktreePath = join(root, 'worktree'), sourceRoot = join(root, 'source-skill')
    mkdirSync(profileRoot, { recursive: true }); mkdirSync(projectPath, { recursive: true }); mkdirSync(worktreePath, { recursive: true }); mkdirSync(join(sourceRoot, 'references'), { recursive: true })
    writeFileSync(join(sourceRoot, 'SKILL.md'), '---\nname: selected-skill\ndescription: selected\n---\nSelected instructions.\n')
    const context = createLegacySingleProfileContext({ profileId: 'material-profile', profileRoot, projectPath, secrets: { resolveEnv: (value) => value } })
    const skill: SkillDescriptor = {
      id: 'mousse-profile:selected-skill', installationId: 'skill-selected', name: 'selected-skill', description: 'selected',
      rootPath: sourceRoot, skillPath: join(sourceRoot, 'SKILL.md'), scope: 'global', source: 'mousse-profile', managed: true, enabled: true, isActive: true
    }
    const servers: McpServerConfig[] = [
      { id: 'mousse:echo', installationId: 'server-echo', name: 'echo', source: 'mousse', scope: 'global', transport: 'stdio', status: 'configured', command: 'node', args: ['echo.js'], env: { TOKEN: 'material-secret' }, enabled: true, managed: true },
      { id: 'mousse:oauth', installationId: 'server-oauth', name: 'oauth', source: 'mousse', scope: 'global', transport: 'http', status: 'configured', url: 'https://example.invalid/mcp', authMode: 'oauth', enabled: true, managed: true }
    ]
    const skillsSnapshot: SkillsRegistrySnapshot = { skills: [skill], sources: [], diagnostics: [] }
    const mcpSnapshot: McpRegistrySnapshot = { servers, sources: [], diagnostics: [] }
    const settings = new SettingsStore(MousseConfigStore.load(profileRoot))
    settings.set({ integrations: {
      skills: { enabled: true, enableForAgents: { [cliType]: true }, enabledSkills: ['skill-selected'] },
      mcp: { enabled: true, enableForAgents: { [cliType]: true }, enabledServers: ['server-echo', 'server-oauth'] }
    } })
    const manager = new AgentConfigManager(
      { discover: async () => mcpSnapshot } as unknown as McpRegistry,
      { discover: async () => skillsSnapshot } as unknown as SkillsRegistry,
      settings
    )
    const target = getMcpTarget(cliType, worktreePath)
    await seedUnrelatedConfig(cliType, worktreePath)
    const result = await manager.prepare(`agent-${cliType}`, cliType, worktreePath, projectPath)
    expect(result.generatedFiles).toContain(target)
    expect(result.env.TOKEN).toBe('material-secret')
    expect(result.unsupportedCapabilities.some((item) => item.targetId === 'server-oauth')).toBe(cliType !== 'mousse')
    expect(existsSync(join(worktreePath, '.claude', 'skills', 'unrelated')) || cliType !== 'claude-code').toBe(true)
    const rendered = readFileSync(target, 'utf8')
    expect(rendered).toContain('unrelated')
    expect(rendered).toContain('echo')
    expect(rendered).toContain('oauth')
    expect(rendered).not.toContain('material-secret')
    const selectedSkillRoot = join(worktreePath, cliType === 'opencode' ? '.opencode' : cliType === 'mousse' ? '.mousse' : cliType === 'codex' ? '.codex' : cliType === 'cursor-agents-cli' ? '.cursor' : '.claude', 'skills', 'selected-skill')
    expect(existsSync(selectedSkillRoot)).toBe(true)
    await manager.cleanup(`agent-${cliType}`)
    expect(readFileSync(target, 'utf8')).toContain('unrelated')
    expect(readFileSync(target, 'utf8')).not.toContain('server-echo')
    expect(existsSync(selectedSkillRoot)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  }, 20_000)

  it('preserves malformed fields and configs changed after materialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-i04-owned-cleanup-'))
    const profileRoot = join(root, 'profile'), projectPath = join(root, 'project'), worktreePath = join(root, 'worktree')
    mkdirSync(profileRoot, { recursive: true }); mkdirSync(projectPath, { recursive: true }); mkdirSync(join(worktreePath, '.cursor'), { recursive: true })
    const context = createLegacySingleProfileContext({ profileId: 'cleanup-profile', profileRoot, projectPath, secrets: { resolveEnv: (value) => value } })
    const server: McpServerConfig = { id: 'mousse:echo', installationId: 'server-echo', name: 'echo', source: 'mousse', scope: 'global', transport: 'stdio', status: 'configured', command: 'node', enabled: true, managed: true }
    const settings = new SettingsStore(MousseConfigStore.load(profileRoot))
    settings.set({ integrations: { mcp: { enabled: true, enableForAgents: { 'cursor-agents-cli': true }, enabledServers: ['server-echo'] } } })
    const manager = new AgentConfigManager(
      { discover: async () => ({ servers: [server], sources: [], diagnostics: [] }) } as unknown as McpRegistry,
      { discover: async () => ({ skills: [], sources: [], diagnostics: [] }) } as unknown as SkillsRegistry,
      settings
    )
    const target = getMcpTarget('cursor-agents-cli', worktreePath)
    writeFileSync(target, JSON.stringify({ mcpServers: 'user-owned-shape', custom: true }, null, 2))
    const refused = await manager.prepare('malformed-agent', 'cursor-agents-cli', worktreePath, projectPath)
    expect(refused.unsupportedCapabilities.some((item) => item.message.includes('mcpServers is not an object'))).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).mcpServers).toBe('user-owned-shape')

    writeFileSync(target, JSON.stringify({ mcpServers: {}, custom: true }, null, 2))
    await manager.prepare('changed-agent', 'cursor-agents-cli', worktreePath, projectPath)
    const changed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
    changed.changedAfterMaterialization = true
    writeFileSync(target, JSON.stringify(changed, null, 2))
    const logs = await manager.cleanup('changed-agent')
    expect(logs.some((entry) => entry.includes('Preserved config changed after materialization'))).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).changedAfterMaterialization).toBe(true)
    expect(JSON.stringify(JSON.parse(readFileSync(target, 'utf8')).mcpServers)).toContain('echo')
    rmSync(root, { recursive: true, force: true })
  })
})

async function seedUnrelatedConfig(cliType: AgentTypeId, worktreePath: string): Promise<void> {
  const target = getMcpTarget(cliType, worktreePath)
  mkdirSync(join(target, '..'), { recursive: true })
  if (cliType === 'codex') {
    writeFileSync(target, '# user setting\n\n[mcp_servers.unrelated]\ncommand = "user-server"\ncustom = "preserve-me"\n')
  } else if (cliType === 'opencode') {
    writeFileSync(target, JSON.stringify({ custom: 'preserve-me', mcp: { unrelated: { type: 'local', command: ['user-server'] } } }, null, 2))
  } else {
    writeFileSync(target, JSON.stringify({ unrelated: { command: 'user-server' }, mcpServers: { unrelated: { command: 'user-server' } }, custom: 'preserve-me' }, null, 2))
  }
  const skillRoot = cliType === 'opencode' ? '.opencode' : cliType === 'mousse' ? '.mousse' : cliType === 'codex' ? '.codex' : cliType === 'cursor-agents-cli' ? '.cursor' : '.claude'
  mkdirSync(join(worktreePath, skillRoot, 'skills', 'unrelated'), { recursive: true })
  writeFileSync(join(worktreePath, skillRoot, 'skills', 'unrelated', 'SKILL.md'), '---\nname: unrelated\ndescription: user-owned\n---\nuser\n')
}
