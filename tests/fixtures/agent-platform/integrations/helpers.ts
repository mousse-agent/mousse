import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDefaultSettings } from '../../../../src/shared/settings'
import type { MousseSettings } from '../../../../src/shared/settings'
import { createLegacySingleProfileContext } from '../../../../src/mms/integrations/profileContext'
import type { IntegrationRuntimeContext } from '../../../../src/mms/integrations/profileContext'
import type { McpServerConfig } from '../../../../src/shared/integrations'
import type { InjectedMcpClient, McpClientFactory } from '../../../../src/mms/integrations/mcp/McpManager'

export async function makeTempProfile(): Promise<{
  root: string
  project: string
  context: IntegrationRuntimeContext
}> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-int-profile-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  return {
    root,
    project,
    context: createLegacySingleProfileContext({
      profileId: 'test-profile',
      profileRoot: root,
      projectPath: project
    })
  }
}

export function settingsStore(patch?: (settings: MousseSettings) => void) {
  const settings = getDefaultSettings()
  patch?.(settings)
  return { get: () => settings }
}

export function testServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'mousse:echo',
    installationId: 'inst-echo',
    name: 'echo',
    source: 'mousse',
    scope: 'global',
    transport: 'http',
    status: 'configured',
    url: 'http://127.0.0.1:9/mcp',
    authMode: 'anonymous',
    configRevision: 'rev1',
    enabled: true,
    ...overrides
  }
}

export function injectedFactory(
  impl: Partial<InjectedMcpClient> & {
    onConnect?: (server: McpServerConfig) => void
  } = {}
): McpClientFactory {
  return {
    async connect(server) {
      impl.onConnect?.(server)
      return {
        async listTools() {
          return impl.listTools
            ? impl.listTools()
            : { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
        },
        async callTool(args, options) {
          if (impl.callTool) return impl.callTool(args, options)
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
        async close() {
          await impl.close?.()
        }
      }
    }
  }
}

export async function writeNativeSkill(project: string, name: string, extra = ''): Promise<string> {
  const dir = join(project, '.mousse', 'skills', name)
  await mkdir(dir, { recursive: true })
  const content = `---
name: ${name}
description: Native ${name} skill for discovery alignment tests.
${extra}---
Body for ${name}.
`
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
  return dir
}

export async function writeNativeMcp(project: string, name = 'native-echo'): Promise<string> {
  const path = join(project, '.mousse', 'mcp.json')
  await mkdir(join(project, '.mousse'), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command: 'node',
            args: ['-e', 'process.exit(0)']
          }
        }
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
  return path
}
