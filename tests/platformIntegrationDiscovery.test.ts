import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { SkillLifecycleService } from '../src/mms/integrations/skills/SkillLifecycleService'
import { getMcpTarget, getSkillTargets } from '../src/mms/integrations/agents/AgentConfigManager'
import { getProjectMousseMcpConfigPath, getProjectMousseSkillRoot } from '../src/mms/integrations/nativePaths'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import { parseCodexMcpServersToml } from '../src/mms/integrations/mcp/McpRegistry'
import { tomlSubsetDiagnostics } from '../src/mms/integrations/mcp/tomlDiagnostics'
import { makeTempProfile, writeNativeMcp, writeNativeSkill } from './fixtures/agent-platform/integrations/helpers'

describe('I01 native discovery alignment', () => {
  it('discovers the same .mousse/skills and .mousse/mcp.json paths the native writer uses', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      expect(getSkillTargets('mousse', project)).toEqual([getProjectMousseSkillRoot(project)])
      expect(getMcpTarget('mousse', project)).toBe(getProjectMousseMcpConfigPath(project))

      await writeNativeSkill(project, 'native-review')
      await writeNativeMcp(project, 'native-echo')

      const skills = new SkillsRegistry(context)
      const mcp = new McpRegistry(context)
      const skillSnapshot = await skills.discover({ projectPath: project })
      const mcpSnapshot = await mcp.discover({ projectPath: project })

      const skill = skillSnapshot.skills.find((entry) => entry.name === 'native-review')
      expect(skill?.source).toBe('mousse-project')
      expect(skill?.profileId).toBe('test-profile')
      expect(skill?.skillPath.replace(/\\/g, '/')).toContain('.mousse/skills/native-review/SKILL.md')
      expect(skill?.revision).toMatch(/^[a-f0-9]{64}$/)

      const server = mcpSnapshot.servers.find((entry) => entry.name === 'native-echo')
      expect(server?.source).toBe('generated-agent')
      expect(server?.profileId).toBe('test-profile')
      expect(server?.configPath?.replace(/\\/g, '/')).toContain('.mousse/mcp.json')
      expect(server?.installationId).toBeTruthy()
      expect(server?.configRevision).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not crawl another profile’s managed skills', async () => {
    const a = await makeTempProfile()
    const b = await makeTempProfile()
    try {
      const other = new SkillLifecycleService(new SkillsRegistry(b.context), b.context)
      await other.create({
        name: 'secret-other-profile',
        description: 'Must stay isolated to profile B.',
        scope: 'global'
      })

      const snapshot = await new SkillsRegistry(a.context).discover({ projectPath: a.project })
      expect(snapshot.skills.some((skill) => skill.name === 'secret-other-profile')).toBe(false)
      expect(snapshot.sources.every((source) => !source.path.startsWith(b.root))).toBe(true)
    } finally {
      await rm(a.root, { recursive: true, force: true })
      await rm(b.root, { recursive: true, force: true })
    }
  })

  it('refresh bypasses the 30s discovery cache after create/edit/delete', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      const registry = new SkillsRegistry(context)
      const lifecycle = new SkillLifecycleService(registry, context)
      const before = await registry.discover({ projectPath: project })
      expect(before.skills.find((skill) => skill.name === 'cache-check')).toBeUndefined()

      await lifecycle.create({
        name: 'cache-check',
        description: 'Created after the first cached discover.',
        scope: 'global'
      })

      const staleIfCached = await registry.discover({ projectPath: project })
      expect(staleIfCached.skills.find((skill) => skill.name === 'cache-check')).toBeTruthy()

      await writeFile(
        join(root, 'integrations', 'skills', 'cache-check', 'SKILL.md'),
        `---
name: cache-check
description: Edited body must appear after refresh, not after the TTL.
---
Edited.
`,
        'utf-8'
      )
      const cached = await registry.discover({ projectPath: project })
      expect(cached.skills.find((skill) => skill.name === 'cache-check')?.description).toContain(
        'Created after'
      )
      const refreshed = await registry.refresh({ projectPath: project })
      expect(refreshed.skills.find((skill) => skill.name === 'cache-check')?.description).toContain(
        'Edited body'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parses nested YAML metadata with the standards parser', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      await writeNativeSkill(
        project,
        'yaml-nested',
        `metadata:
  author: fixture
  version: "2"
compatibility: Requires node
`
      )
      const snapshot = await new SkillsRegistry(context).discover({ projectPath: project })
      const skill = snapshot.skills.find((entry) => entry.name === 'yaml-nested')
      expect(skill?.metadata).toEqual({ author: 'fixture', version: '2' })
      expect(skill?.compatibility).toBe('Requires node')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports unsupported TOML instead of claiming a full parser', () => {
    const raw = `
[mcp_servers.echo]
command = """
node
"""
started = 2024-01-01T00:00:00Z
`
    const servers = parseCodexMcpServersToml(raw)
    expect(servers.echo).toBeTruthy()
    const diagnostics = tomlSubsetDiagnostics(raw, '/tmp/config.toml')
    expect(diagnostics[0]?.message).toMatch(/dedicated TOML parser dependency/)
    expect(diagnostics[0]?.message).not.toMatch(/full compliance without/i)
  })
})
