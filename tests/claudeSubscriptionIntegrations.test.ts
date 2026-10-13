import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerConfig, MousseIntegrationsSettings, SkillDescriptor } from '../src/shared/integrations'
import {
  ClaudeIntegrationResolver,
  claudeMcpToolBlocked
} from '../src/mms/providers/claudeSubscription/integrations'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-claude-integrations-'))
  roots.push(root)
  return root
}

const server = (overrides: Partial<McpServerConfig>): McpServerConfig => ({
  id: overrides.name ?? 'server', name: 'server', source: 'mousse', scope: 'global', transport: 'stdio',
  status: 'configured', enabled: true, managed: true, ...overrides
})
function skill(root: string, name: string, body = 'Do the thing.'): SkillDescriptor {
  const rootPath = join(root, 'library', name)
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`)
  return { id: name, name, description: `${name} skill`, rootPath, skillPath: join(rootPath, 'SKILL.md'), scope: 'global', source: 'mousse-profile', managed: true }
}
function resolver(options: {
  servers?: McpServerConfig[]
  skills?: SkillDescriptor[]
  mainAgent?: boolean
  pluginRoot?: string
}) {
  const agents = { mousse: true, 'claude-code': true, codex: true, opencode: true, 'cursor-agents-cli': true }
  const integrations = {
    tools: { enabled: true, enabledTools: [] },
    mcp: { enabled: true, enableForMainAgent: options.mainAgent ?? true, enableForAgents: agents, enabledServers: (options.servers ?? []).map((entry) => entry.id) },
    skills: { enabled: true, enableForMainAgent: options.mainAgent ?? true, enableForAgents: agents, enabledSkills: (options.skills ?? []).map((entry) => entry.id), model: {} }
  } satisfies MousseIntegrationsSettings
  const seen: Array<string | undefined> = []
  const pluginRoot = options.pluginRoot ?? join(temp(), 'skill-plugins')
  return {
    seen,
    pluginRoot,
    resolver: new ClaudeIntegrationResolver({
      mcpRegistry: { discover: async ({ projectPath } = {}) => { seen.push(projectPath); return { servers: options.servers ?? [], sources: [], diagnostics: [] } } },
      skillsRegistry: { discover: async () => ({ skills: options.skills ?? [], sources: [], diagnostics: [] }) },
      settings: { get: () => ({ integrations }) },
      secrets: { resolveEnv: (value) => value.replace('${secret:KEY}', 'resolved-key').replace('${env:MISSING}', '') },
      pluginRoot
    })
  }
}

describe('Claude Subscription integrations', () => {
  it('attaches enabled MCP servers with their secrets moved into the environment', async () => {
    const { resolver: claude, seen } = resolver({ servers: [
      server({ name: 'files', command: 'files-mcp', args: ['--root', '.'], env: { API_KEY: '${secret:KEY}', EMPTY: '${env:MISSING}' } }),
      server({ name: 'web search', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer literal-token' } }),
      server({ name: 'legacy', transport: 'sse', url: 'https://example.test/sse' })
    ] })
    const result = await claude.resolve('/project')
    expect(seen).toEqual(['/project'])
    expect(result.mcpServers).toEqual({
      files: { type: 'stdio', command: 'files-mcp', args: ['--root', '.'], env: { API_KEY: '${MOUSSE_MCP_VALUE_0}' } },
      web_search: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '${MOUSSE_MCP_VALUE_1}' } },
      legacy: { type: 'sse', url: 'https://example.test/sse' }
    })
    expect(result.env).toEqual({ MOUSSE_MCP_VALUE_0: 'resolved-key', MOUSSE_MCP_VALUE_1: 'Bearer literal-token' })
    expect(JSON.stringify(result.mcpServers)).not.toMatch(/resolved-key|literal-token/)
    expect(result.warnings).toEqual([])
    expect(result.pluginPath).toBeUndefined()
  })

  it('leaves out servers Claude cannot run and never takes the Mousse server name', async () => {
    const { resolver: claude } = resolver({ servers: [
      server({ id: 'user-mousse', name: 'mousse', command: 'other' }),
      server({ name: 'oauth', transport: 'http', url: 'https://example.test/oauth', authMode: 'oauth' }),
      server({ name: 'unset', command: 'x', status: 'missing-env', missingEnvVars: ['TOKEN'] }),
      server({ name: 'broken', transport: 'http' }),
      server({ name: 'off', command: 'x', enabled: false })
    ] })
    const result = await claude.resolve()
    expect(Object.keys(result.mcpServers)).toEqual([expect.stringMatching(/^mousse_[0-9a-f]{8}$/)])
    expect(result.warnings).toEqual([
      expect.stringContaining('oauth signs in with OAuth'),
      expect.stringContaining('unset is missing environment: TOKEN'),
      expect.stringContaining('broken has no URL')
    ])
  })

  it('carries per-server tool limits', async () => {
    const { resolver: claude } = resolver({ servers: [
      server({ name: 'files', command: 'x', enabledTools: ['read'] }),
      server({ name: 'db', command: 'x', deniedTools: ['drop'] }),
      server({ name: 'open', command: 'x' })
    ] })
    const { toolRules } = await claude.resolve()
    expect(toolRules).toEqual({ mcp__files__: { enabled: ['read'] }, mcp__db__: { denied: ['drop'] } })
    expect(claudeMcpToolBlocked(toolRules, 'mcp__files__read')).toBe(false)
    expect(claudeMcpToolBlocked(toolRules, 'mcp__files__write')).toBe(true)
    expect(claudeMcpToolBlocked(toolRules, 'mcp__db__query')).toBe(false)
    expect(claudeMcpToolBlocked(toolRules, 'mcp__db__drop')).toBe(true)
    expect(claudeMcpToolBlocked(toolRules, 'mcp__open__anything')).toBe(false)
    expect(claudeMcpToolBlocked(toolRules, 'Bash')).toBe(false)
    expect(claudeMcpToolBlocked(undefined, 'mcp__files__write')).toBe(false)
  })

  it('attaches nothing when integrations are off for the main agent', async () => {
    const root = temp()
    const { resolver: claude } = resolver({ mainAgent: false, servers: [server({ name: 'files', command: 'x' })], skills: [skill(root, 'review')] })
    expect(await claude.resolve()).toEqual({ mcpServers: {}, env: {}, toolRules: {}, warnings: [] })
  })

  it('packages enabled skills as a Claude plugin and reuses it until a skill changes', async () => {
    const root = temp()
    const review = skill(root, 'review')
    mkdirSync(join(review.rootPath, 'scripts'))
    writeFileSync(join(review.rootPath, 'scripts', 'run.sh'), 'echo hi\n')
    const { resolver: claude, pluginRoot } = resolver({ skills: [review, skill(root, 'deploy notes')] })
    const first = await claude.resolve()
    expect(first.pluginPath?.startsWith(pluginRoot)).toBe(true)
    expect(JSON.parse(readFileSync(join(first.pluginPath!, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'mousse' })
    expect(readdirSync(join(first.pluginPath!, 'skills')).sort()).toEqual(['deploy-notes', 'review'])
    expect(readFileSync(join(first.pluginPath!, 'skills', 'review', 'SKILL.md'), 'utf8')).toContain('Do the thing.')
    expect(readFileSync(join(first.pluginPath!, 'skills', 'review', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    expect((await claude.resolve()).pluginPath).toBe(first.pluginPath)

    writeFileSync(join(review.rootPath, 'SKILL.md'), '---\nname: review\ndescription: review skill\n---\nA longer, edited body.\n')
    const second = await claude.resolve()
    expect(second.pluginPath).not.toBe(first.pluginPath)
    expect(readFileSync(join(second.pluginPath!, 'skills', 'review', 'SKILL.md'), 'utf8')).toContain('edited body')
    // The earlier plugin stays for a turn that may still be running, until it has gone unused for a week.
    expect(readdirSync(pluginRoot)).toHaveLength(2)
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(first.pluginPath!, old, old)
    await claude.resolve()
    expect(readdirSync(pluginRoot)).toEqual([second.pluginPath!.slice(pluginRoot.length + 1)])
  })

  it('skips a skill that contains a symlink and keeps the rest', async () => {
    const root = temp()
    const unsafe = skill(root, 'unsafe')
    symlinkSync('/etc/hostname', join(unsafe.rootPath, 'link'))
    const { resolver: claude } = resolver({ skills: [unsafe, skill(root, 'safe')] })
    const result = await claude.resolve()
    expect(readdirSync(join(result.pluginPath!, 'skills'))).toEqual(['safe'])
    expect(result.warnings).toEqual([expect.stringContaining('Skill unsafe was not attached: it contains a symlink')])
  })
})
