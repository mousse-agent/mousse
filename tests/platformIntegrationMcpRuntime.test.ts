import { rm } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { McpManager, type InjectedMcpClient } from '../src/mms/integrations/mcp/McpManager'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { McpLifecycleService } from '../src/mms/integrations/mcp/McpLifecycleService'
import { allocateProviderToolName, toProviderSafeToolName } from '../src/mms/integrations/mcp/toolNames'
import { buildConnectionKey } from '../src/mms/integrations/mcp/connectionKey'
import { inferMcpAuthMode } from '../src/mms/integrations/mcp/authMode'
import {
  injectedFactory,
  makeTempProfile,
  settingsStore,
  testServerConfig
} from './fixtures/agent-platform/integrations/helpers'
import { defaultIntegrationActor } from '../src/shared/integrations/actor'
import { getManagedMcpConfigPath, getManagedMcpOAuthDir } from '../src/mms/integrations/nativePaths'
import { existsSync } from 'fs'
import { FileMcpOAuthProvider, hasMcpOAuthTokens } from '../src/mms/integrations/mcp/McpOAuthProvider'

function managerFor(
  servers: ReturnType<typeof testServerConfig>[],
  factory: ReturnType<typeof injectedFactory>,
  store = settingsStore((settings) => {
    settings.integrations.mcp.enabled = true
    settings.integrations.mcp.enableForMainAgent = true
    settings.integrations.mcp.enabledServers = servers.map((server) => server.installationId ?? server.id)
  }),
  context?: { profileId: string; profileRoot: string }
) {
  const registry = {
    discover: async () => ({
      servers,
      sources: [],
      diagnostics: []
    })
  } as unknown as McpRegistry
  return new McpManager(registry, store as never, async () => {}, {
    clientFactory: factory,
    context: context
      ? {
          profileId: context.profileId,
          profileRoot: context.profileRoot,
          secrets: { resolveEnv: (value) => value }
        }
      : undefined
  })
}

describe('I01 MCP runtime defects', () => {
  it('does not treat anonymous remotes as OAuth-required', () => {
    expect(
      inferMcpAuthMode(
        testServerConfig({
          url: 'https://example.test/mcp',
          headers: {},
          auth: undefined,
          authMode: undefined
        })
      )
    ).toBe('anonymous')
  })

  it('connects and lists anonymous remote tools without an OAuth login', async () => {
    let connected = false
    const manager = managerFor(
      [testServerConfig({ authMode: 'anonymous' })],
      injectedFactory({
        onConnect: () => {
          connected = true
        }
      })
    )
    const tools = await manager.listTools('inst-echo')
    expect(connected).toBe(true)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.toolName).toBe('echo')
  })

  it('rejects an ambiguous display-name alias', async () => {
    const manager = managerFor(
      [
        testServerConfig({ id: 'mousse:first', installationId: 'inst-first', name: 'duplicate' }),
        testServerConfig({ id: 'mousse:second', installationId: 'inst-second', name: 'duplicate' })
      ],
      injectedFactory()
    )
    await expect(manager.listTools('duplicate')).rejects.toThrow(/ambiguous.*installation id/i)
  })

  it('keys live connections by profile, project, installation, and revision', () => {
    const server = testServerConfig()
    const a = buildConnectionKey(server, 'profile-a', '/proj-a')
    const b = buildConnectionKey(server, 'profile-b', '/proj-a')
    const c = buildConnectionKey({ ...server, configRevision: 'rev2' }, 'profile-a', '/proj-a')
    const d = buildConnectionKey({ ...server, scope: 'project' }, 'profile-a', '/proj-b')
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('gives colliding display names distinct provider aliases and reverse mappings', async () => {
    const taken = new Set<string>()
    const first = allocateProviderToolName({
      serverName: 'github',
      toolName: 'search',
      installationId: 'inst-a',
      taken
    })
    taken.add(first)
    const second = allocateProviderToolName({
      serverName: 'github',
      toolName: 'search',
      installationId: 'inst-b',
      taken
    })
    expect(first).not.toBe(second)
    expect(first).not.toBe(toProviderSafeToolName('github', 'search'))

    const manager = managerFor(
      [
        testServerConfig({ id: 'mousse:one', installationId: 'inst-a', name: 'github' }),
        testServerConfig({
          id: 'mousse:two',
          installationId: 'inst-b',
          name: 'github',
          url: 'http://127.0.0.1:9/other'
        })
      ],
      {
        async connect(server) {
          return {
            async listTools() {
              return { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
            },
            async callTool(args) {
              return { content: [{ type: 'text', text: server.installationId }], isError: false }
            },
            async close() {}
          } satisfies InjectedMcpClient
        }
      },
      settingsStore((settings) => {
        settings.integrations.mcp.enabled = true
        settings.integrations.mcp.enableForMainAgent = true
        settings.integrations.mcp.enabledServers = ['inst-a', 'inst-b']
      })
    )

    const tools = await manager.getEnabledTools(undefined, defaultIntegrationActor(false))
    expect(tools).toHaveLength(2)
    expect(tools[0]?.providerName).not.toBe(tools[1]?.providerName)
    const firstResult = await manager.callTool(tools[0]!.providerName, {})
    const secondResult = await manager.callTool(tools[1]!.providerName, {})
    expect(firstResult.text).not.toBe(secondResult.text)
    expect(new Set([firstResult.text, secondResult.text])).toEqual(new Set(['inst-a', 'inst-b']))
  })

  it('reports missing, disabled, and unreachable testServer results as failures', async () => {
    const manager = managerFor(
      [
        testServerConfig({ installationId: 'inst-disabled', name: 'disabled', enabled: false, status: 'disabled' })
      ],
      injectedFactory()
    )
    const missing = await manager.testServer('does-not-exist')
    expect(missing.success).toBe(false)
    expect(missing.errorCategory).toBe('missing')

    const disabled = await manager.testServer('inst-disabled')
    expect(disabled.success).toBe(false)
    expect(disabled.errorCategory).toBe('disabled')

    const unreachable = managerFor(
      [testServerConfig({ installationId: 'inst-down' })],
      {
        async connect() {
          throw new Error('ECONNREFUSED 127.0.0.1')
        }
      }
    )
    const down = await unreachable.testServer('inst-down')
    expect(down.success).toBe(false)
    expect(down.errorCategory).toBe('unreachable')
  })

  it('treats a connected zero-tool server as success, distinct from missing', async () => {
    const manager = managerFor(
      [testServerConfig({ installationId: 'inst-empty' })],
      injectedFactory({
        async listTools() {
          return { tools: [] }
        }
      })
    )
    const result = await manager.testServer('inst-empty')
    expect(result.success).toBe(true)
    expect(result.toolCount).toBe(0)
    expect(result.connected).toBe(true)
  })

  it('propagates AbortSignal and does not leave the call hanging', async () => {
    const controller = new AbortController()
    const manager = managerFor(
      [testServerConfig()],
      injectedFactory({
        async callTool(_args, options) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 20_000)
            const onAbort = () => {
              clearTimeout(timer)
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            }
            if (options?.signal?.aborted) {
              onAbort()
              return
            }
            options?.signal?.addEventListener('abort', onAbort)
          })
          return { content: [{ type: 'text', text: 'late' }] }
        }
      })
    )
    const tools = await manager.listTools('inst-echo')
    const pending = manager.callTool(tools[0]!.providerName, {}, undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/abort|cancel/i) })
  })

  it('preserves structured content, images, resource links, and isError', async () => {
    const manager = managerFor(
      [testServerConfig()],
      injectedFactory({
        async listTools() {
          return {
            tools: [
              { name: 'picture', inputSchema: { type: 'object' } },
              { name: 'fail', inputSchema: { type: 'object' } }
            ]
          }
        },
        async callTool(args) {
          if (args.name === 'fail') {
            return { content: [{ type: 'text', text: 'nope' }], isError: true }
          }
          return {
            content: [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'aaa'
              },
              { type: 'resource_link', uri: 'fixture://pixel' }
            ],
            structuredContent: { kind: 'image' },
            isError: false
          }
        }
      })
    )
    const tools = await manager.listTools('inst-echo')
    const picture = tools.find((tool) => tool.toolName === 'picture')!
    const fail = tools.find((tool) => tool.toolName === 'fail')!
    const image = await manager.callTool(picture.providerName, {})
    expect(image.isError).toBe(false)
    expect(image.content.some((block) => block.type === 'image')).toBe(true)
    expect(image.content.some((block) => block.type === 'resource_link')).toBe(true)
    expect(image.structuredContent).toEqual({ kind: 'image' })
    expect(image.text).not.toContain('aaa')
    expect(image.text).toMatch(/\[image/)
    const failed = await manager.callTool(fail.providerName, {})
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('nope')
  })

  it('calls the stdio fixture server for list/call content and cancellation', { timeout: 20_000 }, async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/agent-platform/integrations/mcp-fixture-server.mjs', import.meta.url)
    )
    const { root, context } = await makeTempProfile()
    try {
      const registry = {
        discover: async () => ({
          servers: [
            testServerConfig({
              transport: 'stdio',
              command: process.execPath,
              args: [fixture],
              url: undefined,
              authMode: 'anonymous'
            })
          ],
          sources: [],
          diagnostics: []
        })
      } as unknown as McpRegistry
      const manager = new McpManager(
        registry,
        settingsStore((settings) => {
          settings.integrations.mcp.enabled = true
          settings.integrations.mcp.enableForMainAgent = true
          settings.integrations.mcp.enabledServers = ['inst-echo']
        }) as never,
        async () => {},
        { context }
      )
      const listed = await manager.listTools('inst-echo')
      expect(listed.map((tool) => tool.toolName).sort()).toEqual(['echo', 'fail', 'hang', 'picture'])
      const echo = listed.find((tool) => tool.toolName === 'echo')!
      const echoed = await manager.callTool(echo.providerName, { text: 'hello-fixture' })
      expect(echoed.text).toContain('hello-fixture')
      expect(echoed.structuredContent).toEqual({ echoed: 'hello-fixture' })
      const picture = listed.find((tool) => tool.toolName === 'picture')!
      const image = await manager.callTool(picture.providerName, {})
      expect(image.content.some((block) => block.type === 'image')).toBe(true)
      expect(image.content.some((block) => block.type === 'resource_link')).toBe(true)
      const fail = listed.find((tool) => tool.toolName === 'fail')!
      const failed = await manager.callTool(fail.providerName, { message: 'nope' })
      expect(failed.isError).toBe(true)
      const hang = listed.find((tool) => tool.toolName === 'hang')!
      const controller = new AbortController()
      const pending = manager.callTool(hang.providerName, { ms: 8000 }, undefined, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow()
      await manager.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses child actor grants instead of the main-agent gate', async () => {
    const store = settingsStore((settings) => {
      settings.integrations.mcp.enabled = true
      settings.integrations.mcp.enableForMainAgent = false
      settings.integrations.mcp.enableForAgents.mousse = true
      settings.integrations.mcp.enabledServers = ['inst-echo']
    })
    const manager = managerFor([testServerConfig()], injectedFactory(), store)
    const main = await manager.getEnabledTools(undefined, 'main')
    const child = await manager.getEnabledTools(undefined, 'mousse')
    expect(main).toEqual([])
    expect(child).toHaveLength(1)
  })

  it('revokes persisted OAuth tokens even after the in-memory provider is gone', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const oauthDir = getManagedMcpOAuthDir(root)
      const provider = await FileMcpOAuthProvider.create(
        'removed-installation',
        'https://example.invalid/mcp',
        undefined,
        async () => {},
        { oauthDir, profileId: context.profileId }
      )
      await provider.saveTokens({ access_token: 'fixture-token', token_type: 'bearer' })
      expect(hasMcpOAuthTokens('removed-installation', oauthDir, context.profileId)).toBe(true)

      const manager = new McpManager(
        { discover: async () => ({ servers: [], sources: [], diagnostics: [] }) } as never,
        settingsStore() as never,
        async () => {},
        { context }
      )
      await manager.revokeServer('removed-installation')
      expect(hasMcpOAuthTokens('removed-installation', oauthDir, context.profileId)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('I03 managed MCP lifecycle', () => {
  it('writes profile-owned mcp.json rather than Cursor config', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      const registry = new McpRegistry(context)
      const manager = new McpManager(registry, settingsStore() as never, async () => {}, {
        context,
        clientFactory: injectedFactory()
      })
      const lifecycle = new McpLifecycleService(registry, manager, context)
      const created = await lifecycle.create({
        name: 'managed-echo',
        scope: 'global',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        authMode: 'anonymous'
      })
      expect(existsSync(getManagedMcpConfigPath(root))).toBe(true)
      expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(false)
      expect(created.server.name).toBe('managed-echo')
      expect(created.server.installationId).toBeTruthy()
      const redacted = await registry.discover({ redactSecrets: true })
      const listed = redacted.servers.find((server) => server.name === 'managed-echo')
      expect(listed?.command).toBe('node')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects credentialed and non-http remote URLs', async () => {
    const { root, context } = await makeTempProfile()
    try {
      const registry = new McpRegistry(context)
      const manager = new McpManager(registry, settingsStore() as never, async () => {}, { context })
      const lifecycle = new McpLifecycleService(registry, manager, context)
      await expect(
        lifecycle.create({
          name: 'bad-url',
          scope: 'global',
          transport: 'http',
          url: 'file:///tmp/mcp'
        })
      ).rejects.toThrow(/http\(s\)/)
      await expect(
        lifecycle.create({
          name: 'cred-url',
          scope: 'global',
          transport: 'http',
          url: 'https://user:pass@example.test/mcp'
        })
      ).rejects.toThrow(/credentials/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires an installation id when global and project servers share a name', async () => {
    const { root, project, context } = await makeTempProfile()
    try {
      const registry = new McpRegistry(context)
      const manager = new McpManager(registry, settingsStore() as never, async () => {}, {
        context,
        clientFactory: injectedFactory()
      })
      const lifecycle = new McpLifecycleService(registry, manager, context)
      const global = await lifecycle.create({
        name: 'same-name', scope: 'global', transport: 'stdio', command: 'node'
      })
      const local = await lifecycle.create({
        name: 'same-name', scope: 'project', projectPath: project, transport: 'stdio', command: 'node'
      })
      await expect(lifecycle.read('same-name', project)).rejects.toThrow(/ambiguous.*installation id/i)
      await expect(lifecycle.read(global.installationId, project)).resolves.toMatchObject({
        installationId: global.installationId
      })
      await expect(lifecycle.read(local.installationId, project)).resolves.toMatchObject({
        installationId: local.installationId
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
