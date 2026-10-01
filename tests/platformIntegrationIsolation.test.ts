import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { SkillLifecycleService } from '../src/mms/integrations/skills/SkillLifecycleService'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { McpLifecycleService } from '../src/mms/integrations/mcp/McpLifecycleService'
import { McpManager } from '../src/mms/integrations/mcp/McpManager'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import { getManagedProjectMcpConfigPath, getManagedProjectSkillRoot, getProjectIdentity } from '../src/mms/integrations/nativePaths'
import { buildConnectionKey } from '../src/mms/integrations/mcp/connectionKey'
import { resolveEffectiveMcpServers, resolveEffectiveSkills } from '../src/mms/integrations/catalog/EffectiveIntegrationResolver'
import type { McpServerConfig } from '../src/shared/integrations'
import { getDefaultSettings } from '../src/shared/settings'

function context(profileId: string, profileRoot: string, projectPath: string) {
  return createLegacySingleProfileContext({ profileId, profileRoot, projectPath, secrets: { resolveEnv: (value) => value } })
}

describe('I04 integration ownership and project identity', () => {
  it('isolates two profiles registering the same repository and never grants legacy project files by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-i04-isolation-'))
    const profileA = join(root, 'profile-a'), profileB = join(root, 'profile-b'), project = join(root, 'shared-repo')
    mkdirSync(profileA, { recursive: true }); mkdirSync(profileB, { recursive: true }); mkdirSync(project, { recursive: true })
    try {
      const contextA = context('profile-a', profileA, project), contextB = context('profile-b', profileB, project)
      const skillsA = new SkillsRegistry(contextA), skillsB = new SkillsRegistry(contextB)
      const skillA = await new SkillLifecycleService(skillsA, contextA).create({ name: 'same-name', description: 'A', scope: 'project', projectPath: project, instructions: 'A only' })
      const skillB = await new SkillLifecycleService(skillsB, contextB).create({ name: 'same-name', description: 'B', scope: 'project', projectPath: project, instructions: 'B only' })
      expect(skillA.installationId).toBe(skillB.installationId)
      expect(skillA.skill.rootPath).not.toBe(skillB.skill.rootPath)
      expect(readFileSync(skillA.skill.skillPath, 'utf8')).toContain('A only')
      expect(readFileSync(skillB.skill.skillPath, 'utf8')).toContain('B only')
      expect(existsSync(join(project, '.mousse', 'skills', 'same-name'))).toBe(false)
      expect(getProjectIdentity(project)).toContain('project-')

      const settingsA = new SettingsStore(MousseConfigStore.load(profileA))
      const settingsB = new SettingsStore(MousseConfigStore.load(profileB))
      settingsA.set({ integrations: { skills: { enabled: true, enableForMainAgent: true, enabledSkills: [skillA.installationId] } } })
      settingsB.set({ integrations: { skills: { enabled: true, enableForMainAgent: true, enabledSkills: [skillB.installationId] } } })
      const snapA = await skillsA.discover({ projectPath: project, refresh: true })
      const snapB = await skillsB.discover({ projectPath: project, refresh: true })
      expect(resolveEffectiveSkills({ snapshot: snapA, settings: settingsA.get().integrations.skills, actor: { kind: 'main' } }).map((entry) => entry.skillPath)).toEqual([skillA.skill.skillPath])
      expect(resolveEffectiveSkills({ snapshot: snapB, settings: settingsB.get().integrations.skills, actor: { kind: 'main' } }).map((entry) => entry.skillPath)).toEqual([skillB.skill.skillPath])

      const legacy = join(project, '.mousse', 'skills', 'same-name')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'SKILL.md'), '---\nname: same-name\ndescription: legacy\n---\nlegacy\n')
      const cursorSkill = join(project, '.cursor', 'skills', 'same-name')
      mkdirSync(cursorSkill, { recursive: true })
      writeFileSync(join(cursorSkill, 'SKILL.md'), '---\nname: same-name\ndescription: cursor\n---\ncursor\n')
      const withLegacy = await skillsA.refresh({ projectPath: project })
      const legacyEntry = withLegacy.skills.find((entry) => entry.rootPath === legacy)
      const cursorEntry = withLegacy.skills.find((entry) => entry.rootPath === cursorSkill)
      expect(legacyEntry?.managed).toBe(false)
      expect(cursorEntry?.managed).toBe(false)
      expect(legacyEntry?.installationId).not.toBe(cursorEntry?.installationId)
      expect(resolveEffectiveSkills({
        snapshot: withLegacy,
        settings: { ...settingsA.get().integrations.skills, enabledSkills: ['same-name'] },
        actor: { kind: 'main' }
      })).toEqual([])
      expect(resolveEffectiveSkills({
        snapshot: withLegacy,
        settings: settingsA.get().integrations.skills,
        actor: { kind: 'main', skillIds: [legacyEntry!.installationId!] }
      }).map((entry) => entry.installationId)).toEqual([legacyEntry!.installationId])

      const mcpA = new McpRegistry(contextA), mcpB = new McpRegistry(contextB)
      const managerA = new McpManager(mcpA, settingsA, async () => {}, { context: contextA })
      const managerB = new McpManager(mcpB, settingsB, async () => {}, { context: contextB })
      const mcpRecordA = await new McpLifecycleService(mcpA, managerA, contextA).create({ name: 'same-name', scope: 'project', projectPath: project, transport: 'stdio', command: 'node', enable: false })
      const mcpRecordB = await new McpLifecycleService(mcpB, managerB, contextB).create({ name: 'same-name', scope: 'project', projectPath: project, transport: 'stdio', command: 'node', enable: false })
      expect(mcpRecordA.installationId).not.toBe(mcpRecordB.installationId)
      expect(existsSync(getManagedProjectMcpConfigPath(profileA, project))).toBe(true)
      expect(existsSync(getManagedProjectMcpConfigPath(profileB, project))).toBe(true)
      expect(existsSync(join(project, '.mousse', 'mcp.json'))).toBe(false)
      mkdirSync(join(project, '.mousse'), { recursive: true })
      writeFileSync(join(project, '.mousse', 'mcp.json'), JSON.stringify({ mcpServers: { 'same-name': { command: 'node' } } }))
      mkdirSync(join(project, '.cursor'), { recursive: true })
      writeFileSync(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'same-name': { command: 'node' } } }))
      const discoveredExternal = await mcpA.discover({ projectPath: project, redactSecrets: false })
      const externalMcp = discoveredExternal.servers.find((entry) => entry.configPath?.includes(`${join('.mousse', 'mcp.json')}`))
      const cursorMcp = discoveredExternal.servers.find((entry) => entry.configPath?.includes(`${join('.cursor', 'mcp.json')}`))
      expect(externalMcp?.managed).toBe(false)
      expect(cursorMcp?.managed).toBe(false)
      expect(externalMcp?.installationId).not.toBe(cursorMcp?.installationId)
      expect(resolveEffectiveMcpServers({
        servers: [externalMcp!, cursorMcp!],
        settings: { ...settingsA.get().integrations.mcp, enabledServers: ['same-name'] },
        actor: { kind: 'main' }
      })).toEqual([])
      expect(resolveEffectiveMcpServers({
        servers: [externalMcp!, cursorMcp!],
        settings: settingsA.get().integrations.mcp,
        actor: { kind: 'main', mcpServerIds: [externalMcp!.installationId!] }
      }).map((entry) => entry.installationId)).toEqual([externalMcp!.installationId])
      expect(buildConnectionKey({ ...mcpRecordA.server, projectId: getProjectIdentity(project) }, 'profile-a', project)).not.toBe(
        buildConnectionKey({ ...mcpRecordA.server, projectId: getProjectIdentity(project) }, 'profile-b', project)
      )
      await managerA.shutdown(); await managerB.shutdown()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps same-name managed installations separate across two projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-i04-projects-'))
    const profile = join(root, 'profile'), first = join(root, 'one'), second = join(root, 'two')
    mkdirSync(profile, { recursive: true }); mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true })
    try {
      const ctx = context('profile', profile, first)
      const lifecycle = new SkillLifecycleService(new SkillsRegistry(ctx), ctx)
      const a = await lifecycle.create({ name: 'shared', description: 'first', scope: 'project', projectPath: first })
      const b = await lifecycle.create({ name: 'shared', description: 'second', scope: 'project', projectPath: second })
      expect(a.installationId).not.toBe(b.installationId)
      expect(a.skill.rootPath).toContain(getProjectIdentity(first))
      expect(b.skill.rootPath).toContain(getProjectIdentity(second))
      expect(existsSync(join(first, '.mousse'))).toBe(false)
      expect(existsSync(join(second, '.mousse'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
