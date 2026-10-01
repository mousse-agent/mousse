import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { McpManager, type InjectedMcpClient } from '../src/mms/integrations/mcp/McpManager'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { createLegacySingleProfileContext } from '../src/mms/integrations/profileContext'
import { getManagedMcpOAuthDir } from '../src/mms/integrations/nativePaths'
import { assertOwnedPath } from '../src/mms/profiles/pathSafety'
import {
  isOwnedIdentityAlive,
  readOwnedStartKey,
  supportsOwnedMcpTree,
  type OwnedProcessIdentity
} from '../src/mms/integrations/mcp/ownedProcessTree'
import { OwnedStdioClientTransport } from '../src/mms/integrations/mcp/ownedStdioTransport'
import { injectedFactory, settingsStore, testServerConfig } from './fixtures/agent-platform/integrations/helpers'

const FIXTURE_PREFIX = 'mousse-mcp-lifecycle-'
const TREE_SERVER = fileURLToPath(new URL('./fixtures/agent-platform/mcp-lifecycle/tree-server.mjs', import.meta.url))
const roots: string[] = []
const servers: Server[] = []
const managers: McpManager[] = []

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX))
  const tmp = realpathSync.native(tmpdir())
  const resolved = realpathSync.native(root)
  const rel = relative(tmp, resolved)
  if (isAbsolute(rel) || !rel.startsWith(FIXTURE_PREFIX) || rel.includes('..')) {
    throw new Error(`Unexpected fixture root: ${resolved}`)
  }
  roots.push(resolved)
  return resolved
}

function ownedFile(root: string, name: string): string {
  return assertOwnedPath(root, join(root, name), name)
}

function contextFor(root: string) {
  return createLegacySingleProfileContext({
    profileId: 'mcp-lifecycle',
    profileRoot: root,
    secrets: { resolveEnv: (value) => value }
  })
}

function registryFor(serversConfig: ReturnType<typeof testServerConfig>[]) {
  return {
    discover: async () => ({
      servers: serversConfig,
      sources: [],
      diagnostics: []
    })
  } as unknown as McpRegistry
}

function managerFor(
  serversConfig: ReturnType<typeof testServerConfig>[],
  factory?: ReturnType<typeof injectedFactory>,
  root?: string
) {
  const profileRoot = root ?? ownedRoot()
  const manager = new McpManager(
    registryFor(serversConfig),
    settingsStore((settings) => {
      settings.integrations.mcp.enabled = true
      settings.integrations.mcp.enableForMainAgent = true
      settings.integrations.mcp.enabledServers = serversConfig.map((server) => server.installationId ?? server.id)
    }) as never,
    async () => {},
    {
      context: contextFor(profileRoot),
      ...(factory ? { clientFactory: factory } : {})
    }
  )
  managers.push(manager)
  return { manager, root: profileRoot }
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP listen address'))
        return
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` })
    })
    server.once('error', reject)
  })
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function waitUntil(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.shutdown({ timeoutMs: 5_000 })
    } catch {
      /* fixture cleanup */
    }
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      try {
        server.closeAllConnections?.()
      } catch {
        /* ignore */
      }
      server.close(() => resolve())
    })
  }
  for (const root of roots.splice(0)) {
    const tmp = realpathSync.native(tmpdir())
    const resolved = realpathSync.native(root)
    const rel = relative(tmp, resolved)
    if (isAbsolute(rel) || !rel.startsWith(FIXTURE_PREFIX) || rel.includes('..')) {
      throw new Error(`Refusing to clean unexpected fixture root: ${resolved}`)
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('MCP manager shutdown admission', () => {
  it('closes admission synchronously and keeps the legacy no-args shutdown signature', async () => {
    const { manager } = managerFor([testServerConfig()], injectedFactory())
    await manager.listTools('inst-echo')
    manager.beginShutdown()
    await expect(manager.listTools('inst-echo')).rejects.toThrow(/shutting down/)
    await expect(manager.listConfiguredServers()).rejects.toThrow(/shutting down/)
    await manager.shutdown()
    await manager.shutdown()
    expect(manager.getActiveCount()).toBe(0)
  })

  it('does not spawn a new process after discovery admission is closed', async () => {
    let spawns = 0
    const { manager } = managerFor(
      [testServerConfig()],
      injectedFactory({
        onConnect: () => {
          spawns += 1
        }
      })
    )
    await manager.listTools('inst-echo')
    expect(spawns).toBe(1)
    await manager.shutdown()
    await expect(manager.listTools('inst-echo')).rejects.toThrow(/shutting down/)
    await expect(manager.getEnabledTools()).rejects.toThrow(/shutting down/)
    expect(spawns).toBe(1)
  })
})

describe('injected deterministic timeout races', () => {
  it('retains a raw discovery that settles after shutdown and never connects it', async () => {
    const entered = deferred()
    const release = deferred()
    let connects = 0
    const config = testServerConfig()
    const root = ownedRoot()
    const manager = new McpManager({
      async discover() {
        entered.resolve()
        await release.promise
        return { servers: [config], sources: [], diagnostics: [] }
      }
    } as unknown as McpRegistry, settingsStore() as never, async () => {}, {
      context: contextFor(root),
      clientFactory: injectedFactory({ onConnect: () => { connects += 1 } })
    })
    managers.push(manager)
    const pending = manager.listTools('inst-echo')
    void pending.catch(() => {})
    await entered.promise
    await expect(manager.shutdown({ timeoutMs: 40 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(manager.snapshotOwnedWork()).toMatchObject({ 'mcp-discover': 1 })
    release.resolve()
    await expect(pending).rejects.toThrow(/shutdown/i)
    await manager.shutdown()
    expect(connects).toBe(0)
    expect(manager.getActiveCount()).toBe(0)
  })

  it('closes a deferred connect that finishes after shutdown without caching it', async () => {
    const entered = deferred()
    const release = deferred()
    let closed = 0
    let cachedCalls = 0
    const factory = {
      async connect(): Promise<InjectedMcpClient> {
        entered.resolve()
        await release.promise
        return {
          async listTools() {
            cachedCalls += 1
            return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          },
          async callTool() {
            return { content: [{ type: 'text', text: 'late' }] }
          },
          async close() {
            closed += 1
          }
        }
      }
    }
    const { manager } = managerFor([testServerConfig()], factory)
    const pending = manager.listTools('inst-echo')
    void pending.then(() => {}, () => {})
    await entered.promise
    manager.beginShutdown()
    expect(manager.getActiveCount()).toBeGreaterThan(0)
    await expect(manager.shutdown({ timeoutMs: 40 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(manager.getActiveCount()).toBeGreaterThan(0)
    release.resolve()
    await expect(pending).rejects.toThrow()
    await manager.shutdown()
    expect(closed).toBeGreaterThan(0)
    expect(cachedCalls).toBe(0)
    expect(manager.getActiveCount()).toBe(0)
    await expect(manager.listTools('inst-echo')).rejects.toThrow(/shutting down/)
  })

  it('tracks a raw connect that ignores abort and still closes the late client', async () => {
    const entered = deferred()
    const release = deferred()
    let closed = 0
    let sawAbort = false
    const factory = {
      async connect(_server: unknown, _key: string, signal?: AbortSignal): Promise<InjectedMcpClient> {
        entered.resolve()
        await release.promise
        sawAbort = Boolean(signal?.aborted)
        return {
          async listTools() {
            return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          },
          async callTool() {
            return { content: [{ type: 'text', text: 'ignored-abort' }] }
          },
          async close() {
            closed += 1
          }
        }
      }
    }
    const { manager } = managerFor([testServerConfig()], factory)
    const pending = manager.listTools('inst-echo')
    void pending.then(() => {}, () => {})
    await entered.promise
    const first = manager.shutdown({ timeoutMs: 40 })
    const second = manager.shutdown({ timeoutMs: 40 })
    await expect(first).rejects.toMatchObject({ code: 'profile_busy' })
    await expect(second).rejects.toMatchObject({ code: 'profile_busy' })
    release.resolve()
    await expect(pending).rejects.toThrow()
    await manager.shutdown()
    expect(sawAbort).toBe(true)
    expect(closed).toBeGreaterThan(0)
    expect(manager.getActiveCount()).toBe(0)
  })

  it('retains ownership after a close failure and drains on retry', async () => {
    let failClose = true
    let closes = 0
    const factory = injectedFactory({
      async close() {
        closes += 1
        if (failClose) throw new Error('injected close failure')
      }
    })
    const { manager } = managerFor([testServerConfig()], factory)
    await manager.listTools('inst-echo')
    expect(manager.getActiveCount()).toBeGreaterThan(0)
    const result = manager.shutdown({ timeoutMs: 5_000 }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error })
    )
    const prompt = await Promise.race([
      result,
      new Promise<{ kind: 'waiting' }>((resolve) => setTimeout(() => resolve({ kind: 'waiting' }), 250))
    ])
    expect(prompt).toMatchObject({ kind: 'failed', error: { message: 'injected close failure' } })
    expect(manager.getActiveCount()).toBeGreaterThan(0)
    expect(closes).toBeGreaterThan(0)
    failClose = false
    await manager.shutdown()
    expect(manager.getActiveCount()).toBe(0)
  })

  it('retains ownership while close hangs past the deadline, then completes on retry', async () => {
    const holdClose = deferred()
    let closed = false
    const factory = injectedFactory({
      async close() {
        await holdClose.promise
        closed = true
      }
    })
    const { manager } = managerFor([testServerConfig()], factory)
    await manager.listTools('inst-echo')
    const first = manager.shutdown({ timeoutMs: 40 })
    const second = manager.shutdown({ timeoutMs: 40 })
    await expect(first).rejects.toMatchObject({ code: 'profile_busy' })
    await expect(second).rejects.toMatchObject({ code: 'profile_busy' })
    expect(manager.getActiveCount()).toBeGreaterThan(0)
    expect(closed).toBe(false)
    holdClose.resolve()
    await manager.shutdown()
    expect(closed).toBe(true)
    expect(manager.getActiveCount()).toBe(0)
  })
})

describe('OAuth callback and local HTTP I/O during shutdown', () => {
  it('closes the local callback listener and does not leave a session write after drain', async () => {
    const redirected = deferred()
    const { server, url } = await listen((req, res) => {
      const path = req.url ?? ''
      if (path.includes('oauth-protected-resource')) {
        res.writeHead(404)
        res.end()
        return
      }
      if (path.includes('oauth-authorization-server')) {
        const issuer = new URL('/', url).toString()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}authorize`,
            token_endpoint: `${issuer}token`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token']
          })
        )
        return
      }
      res.writeHead(204)
      res.end()
    })
    void server
    const root = ownedRoot()
    const manager = new McpManager(
      registryFor([
        testServerConfig({
          transport: 'http',
          url,
          authMode: 'oauth',
          auth: { clientId: 'fixture-client' }
        })
      ]),
      settingsStore() as never,
      async () => {
        redirected.resolve()
      },
      { context: contextFor(root) }
    )
    managers.push(manager)
    const pending = manager.authenticateServer('inst-echo')
    await redirected.promise
    await waitUntil('oauth callback port', () => isPortOpen(8791))
    const oauthDir = getManagedMcpOAuthDir(root)
    await waitUntil('oauth session write', () => {
      if (!existsSync(oauthDir)) return false
      const dir = assertOwnedPath(root, oauthDir, 'MCP OAuth directory')
      return readdirSync(dir).some((name) => name.endsWith('.json'))
    })
    await manager.shutdown()
    const result = await pending
    expect(result.success).toBe(false)
    expect(await isPortOpen(8791)).toBe(false)
    if (existsSync(oauthDir)) {
      const dir = assertOwnedPath(root, oauthDir, 'MCP OAuth directory')
      const leftover = readdirSync(dir).filter((name) => name.endsWith('.json'))
      expect(leftover).toEqual([])
    }
    expect(manager.getActiveCount()).toBe(0)
  })

  it('cancels local HTTP I/O on remote transport close without claiming external server effects', async () => {
    let requests = 0
    const sawRequest = deferred()
    const { url } = await listen((_req, _res) => {
      requests += 1
      if (requests === 1) sawRequest.resolve()
      // Intentionally never respond. Close must cancel local fetch; the fixture
      // HTTP server is test-owned and is not an MCP child process.
    })
    const { manager } = managerFor([
      testServerConfig({
        transport: 'http',
        url,
        authMode: 'anonymous'
      })
    ])
    const pending = manager.listTools('inst-echo')
    void pending.then(() => {}, () => {})
    await sawRequest.promise
    await manager.shutdown()
    await expect(pending).rejects.toThrow()
    expect(manager.getActiveCount()).toBe(0)
    expect(requests).toBeGreaterThan(0)
  })

  it('owns callback port 8791 before auth and rejects a colliding profile without opening its redirect', async () => {
    const firstRedirect = deferred()
    let secondRedirects = 0
    const { url } = await listen((req, res) => {
      const path = req.url ?? ''
      if (path.includes('oauth-protected-resource')) {
        res.writeHead(404); res.end(); return
      }
      if (path.includes('oauth-authorization-server')) {
        const issuer = new URL('/', url).toString()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token']
        }))
        return
      }
      res.writeHead(204); res.end()
    })
    const config = testServerConfig({
      transport: 'http', url, authMode: 'oauth', auth: { clientId: 'fixture-client' }
    })
    const firstRoot = ownedRoot(), secondRoot = ownedRoot()
    const first = new McpManager(registryFor([config]), settingsStore() as never, async () => {
      firstRedirect.resolve()
    }, { context: contextFor(firstRoot) })
    const second = new McpManager(registryFor([config]), settingsStore() as never, async () => {
      secondRedirects += 1
    }, { context: createLegacySingleProfileContext({
      profileId: 'mcp-lifecycle-second', profileRoot: secondRoot, secrets: { resolveEnv: (value) => value }
    }) })
    managers.push(first, second)

    const firstPending = first.authenticateServer('inst-echo')
    await firstRedirect.promise
    expect(await isPortOpen(8791)).toBe(true)
    const collided = await second.authenticateServer('inst-echo')
    expect(collided.success).toBe(false)
    expect(collided.error).toMatch(/EADDRINUSE|address already in use/i)
    expect(secondRedirects).toBe(0)
    await first.shutdown()
    await expect(firstPending).resolves.toMatchObject({ success: false })
    expect(await isPortOpen(8791)).toBe(false)
  })
})

describe('owned stdio framing settlement', () => {
  it('rejects a backpressured send when stdin closes without a drain event', async () => {
    class ClosingStdin extends EventEmitter {
      write(_value: string, _callback: (error?: Error | null) => void): boolean { return false }
    }
    const stdin = new ClosingStdin()
    const transport = new OwnedStdioClientTransport({ command: process.execPath })
    ;(transport as unknown as { child: { stdin: ClosingStdin } }).child = { stdin }
    const pending = transport.send({ jsonrpc: '2.0', id: 1, method: 'fixture' })
    stdin.emit('close')
    await expect(pending).rejects.toThrow('closed before the message was written')
  })
})

describe('real stdio child and grandchild drain', () => {
  it('documents unsupported platforms as fail-closed rather than a false drain', () => {
    expect(supportsOwnedMcpTree('win32')).toBe(true)
    expect(supportsOwnedMcpTree('linux')).toBe(true)
    expect(supportsOwnedMcpTree('darwin')).toBe(false)
    expect(supportsOwnedMcpTree('aix')).toBe(false)
  })

  it('kills the exact spawned stdio tree and stops heartbeat writes', { timeout: 20_000 }, async () => {
    const root = ownedRoot()
    const heartbeat = ownedFile(root, 'heartbeat.log')
    const profile = ownedFile(root, 'profile.bin')
    const pidsPath = ownedFile(root, 'pids.json')
    const startLog = ownedFile(root, 'start.log')
    writeFileSync(heartbeat, '')
    writeFileSync(profile, '')
    const { manager } = managerFor(
      [
        testServerConfig({
          transport: 'stdio',
          command: process.execPath,
          args: [TREE_SERVER],
          url: undefined,
          authMode: 'anonymous',
          env: {
            MCP_LIFECYCLE_HEARTBEAT: heartbeat,
            MCP_LIFECYCLE_PROFILE: profile,
            MCP_LIFECYCLE_PIDS: pidsPath,
            MCP_LIFECYCLE_START_LOG: startLog
          }
        })
      ],
      undefined,
      root
    )
    const tools = await manager.listTools('inst-echo')
    expect(tools.map((tool) => tool.toolName)).toEqual(['echo'])
    await waitUntil('pid snapshot', () => existsSync(pidsPath) && readFileSync(pidsPath, 'utf8').includes('grandchild'))
    const pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as { parent: number; grandchild: number }
    const parentKey = await readOwnedStartKey(pids.parent)
    const grandchildKey = await readOwnedStartKey(pids.grandchild)
    expect(parentKey).toBeTruthy()
    expect(grandchildKey).toBeTruthy()
    const parent: OwnedProcessIdentity = { pid: pids.parent, startKey: parentKey! }
    const grandchild: OwnedProcessIdentity = { pid: pids.grandchild, startKey: grandchildKey! }
    const before = statSync(heartbeat).size
    await waitUntil('grandchild heartbeat', () => statSync(heartbeat).size > before)
    expect(await isOwnedIdentityAlive(parent)).toBe(true)
    expect(await isOwnedIdentityAlive(grandchild)).toBe(true)

    await manager.shutdown()
    expect(manager.getActiveCount()).toBe(0)
    expect(await isOwnedIdentityAlive(parent)).toBe(false)
    expect(await isOwnedIdentityAlive(grandchild)).toBe(false)
    const drainedSize = statSync(heartbeat).size
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(statSync(heartbeat).size).toBe(drainedSize)

    const spawnedBefore = readFileSync(startLog, 'utf8')
    await expect(manager.listTools('inst-echo')).rejects.toThrow(/shutting down/)
    expect(readFileSync(startLog, 'utf8')).toBe(spawnedBefore)
  })
})
