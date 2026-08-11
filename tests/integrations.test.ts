import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  parseCodexMcpServersToml,
  parseMcpServersObject,
  redactMcpServerConfig
} from '../src/mms/integrations/mcp/McpRegistry'
import { toProviderSafeToolName } from '../src/mms/integrations/mcp/toolNames'
import { prepareGeneratedMcpConfig, renderMcpConfig } from '../src/mms/integrations/agents/AgentConfigManager'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import type { McpConfigPathDescriptor } from '../src/mms/data/paths'
import type { McpServerConfig } from '../src/shared/integrations'

describe('MCP config parsing', () => {
  it('parses and redacts Cursor-compatible stdio config', () => {
    const descriptor = testDescriptor('cursor-project', 'cursor-json')
    const [server] = parseMcpServersObject(
      {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_TOKEN: 'secret',
              SAFE_REF: '${env:GITHUB_TOKEN}'
            }
          }
        }
      },
      descriptor
    )

    expect(server.name).toBe('github')
    expect(server.status).toBe('missing-env')
    expect(server.missingEnvVars).toContain('GITHUB_TOKEN')
    expect(redactMcpServerConfig(server).env).toEqual({
      GITHUB_TOKEN: '[redacted]',
      SAFE_REF: '${env:GITHUB_TOKEN}'
    })
  })

  it('parses Codex TOML MCP server tables', () => {
    const servers = parseCodexMcpServersToml(`
[mcp_servers.echo]
command = "node"
args = ["server.js"]
env = { TOKEN = "\${MOUSSE_TEST_MISSING_ENV}" }
`)

    expect(servers.echo.command).toBe('node')
    expect(servers.echo.args).toEqual(['server.js'])
    expect(servers.echo.env).toEqual({ TOKEN: '${MOUSSE_TEST_MISSING_ENV}' })
  })

  it('normalizes provider-safe MCP tool names', () => {
    expect(toProviderSafeToolName('github.local', 'search/repos')).toBe('mcp__github_local__search_repos')
  })

  it('splits combined stdio commands into command and args', () => {
    const descriptor = testDescriptor('cursor-global', 'cursor-json')
    const [server] = parseMcpServersObject(
      {
        mcpServers: {
          convex: {
            command: 'npx -y convex@latest mcp start',
            args: []
          }
        }
      },
      descriptor
    )

    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', 'convex@latest', 'mcp', 'start'])
  })

  it('parses static OAuth auth blocks from remote MCP servers', () => {
    const descriptor = testDescriptor('cursor-global', 'cursor-json')
    const [server] = parseMcpServersObject(
      {
        mcpServers: {
          supabase: {
            url: 'https://mcp.supabase.com/mcp?project_ref=abc',
            auth: {
              CLIENT_ID: 'client-id',
              scopes: ['read', 'write']
            }
          }
        }
      },
      descriptor
    )

    expect(server.auth).toEqual({
      clientId: 'client-id',
      scopes: ['read', 'write']
    })
  })
})

describe('Skills discovery', () => {
  it('discovers valid project Skills and skips invalid frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-skills-'))
    try {
      const skillRoot = join(root, '.cursor', 'skills', 'reviewer')
      await mkdir(skillRoot, { recursive: true })
      await writeFile(
        join(skillRoot, 'SKILL.md'),
        `---
name: reviewer
description: Review code changes
paths:
  - src/**
disable-model-invocation: true
---
Use this skill for reviews.
`,
        'utf-8'
      )

      const registry = new SkillsRegistry()
      const snapshot = await registry.discover({ projectPath: root })
      const skill = snapshot.skills.find((entry) => entry.name === 'reviewer')

      expect(skill?.description).toBe('Review code changes')
      expect(skill?.paths).toEqual(['src/**'])
      expect(skill?.['disable-model-invocation']).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Agent config rendering', () => {
  it('extracts generated secrets into stable, collision-safe environment variables', () => {
    const server = (id: string, name: string, token: string): McpServerConfig => ({
      id,
      name,
      source: 'cursor-project',
      scope: 'project',
      transport: 'stdio',
      status: 'configured',
      command: 'node',
      env: { TOKEN: token }
    })
    const generated = prepareGeneratedMcpConfig([
      server('cursor-project:second', 'second', 'second-secret'),
      server('cursor-project:first', 'first', 'first-secret')
    ])

    expect(Object.values(generated.env)).toEqual(expect.arrayContaining(['first-secret', 'second-secret']))
    expect(generated.servers.flatMap((entry) => Object.values(entry.env ?? {}))).toEqual(
      expect.arrayContaining([
        '${env:TOKEN_CURSOR_PROJECT_FIRST}',
        '${env:TOKEN_CURSOR_PROJECT_SECOND}'
      ])
    )
    expect(JSON.stringify(generated.servers)).not.toContain('secret')
  })

  it('renders selected servers for each supported CLI standard', () => {
    const servers: McpServerConfig[] = [
      {
        id: 'cursor-project:echo',
        name: 'echo',
        source: 'cursor-project',
        scope: 'project',
        transport: 'stdio',
        status: 'configured',
        command: 'node',
        args: ['echo.js'],
        env: { TOKEN: 'literal-secret' }
      }
    ]

    const claudeConfig = renderMcpConfig('claude-code', servers)
    expect(claudeConfig).toContain('"mcpServers"')
    expect(claudeConfig).toContain('${env:TOKEN}')
    expect(claudeConfig).not.toContain('literal-secret')
    expect(renderMcpConfig('cursor-agents-cli', servers)).toContain('"mcpServers"')
    expect(renderMcpConfig('codex', servers)).toContain('[mcp_servers.echo]')
    expect(renderMcpConfig('opencode', servers)).toContain('"mcp"')
  })
})

function testDescriptor(
  source: McpConfigPathDescriptor['source'],
  format: McpConfigPathDescriptor['format']
): McpConfigPathDescriptor {
  return {
    source,
    scope: source.endsWith('global') ? 'global' : 'project',
    path: join(tmpdir(), 'mcp.json'),
    format
  }
}

