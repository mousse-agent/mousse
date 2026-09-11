import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { createIntegrationPlatformClient } from '../src/renderer/services/integrationPlatformClient'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'
import type { IntegrationActor } from '../src/shared/integrations/actor'
import { FileMcpOAuthProvider } from '../src/mms/integrations/mcp/McpOAuthProvider'
import { getManagedMcpOAuthDir } from '../src/mms/integrations/nativePaths'

it('E2E08 adds Skill and real anonymous, OAuth and stdio MCP installations for main and child actors with live revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-integration-cross-feature-'))
  const homeDir = join(root, 'home'), stdioLog = join(root, 'stdio.jsonl')
  const authInit = vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const calls: { path: string; text: string; authorization?: string }[] = []
  const http = createServer(async (req, res) => {
    const path = req.url ?? ''
    if (path === '/oauth' && req.headers.authorization !== 'Bearer fixture-oauth-token') {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    for await (const chunk of req) { body += String(chunk); if (body.length > 65536) { res.writeHead(413); res.end(); return } }
    const message = JSON.parse(body)
    if (message.id === undefined) { res.writeHead(202); res.end(); return }
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Local echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
    else if (message.method === 'tools/call') {
      calls.push({ path, text: message.params.arguments.text, authorization: req.headers.authorization })
      result = { content: [{ type: 'text', text: message.params.arguments.text }], structuredContent: { echoed: message.params.arguments.text } }
    } else result = {}
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  let main: MousseMainService | undefined, server: MmsProtocolServer | undefined, rpc: LocalMmsClient | undefined
  try {
    main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
    const profile = main.getInstallationHost()!.manager.create({ displayName: 'Integration owner', slug: 'integration-owner' })
    const services = await main.getProfileServices(profile.id)
    server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
    rpc = new LocalMmsClient({ homeDir, endpoint: await server.start(), ownerToken: 'fixture-owner', clientType: 'gui', requestedCapabilities: ['profiles-v1', INTEGRATION_CAPABILITY] })
    await rpc.connect(); await rpc.request('profiles.bind', { profile: profile.id })
    const api = createIntegrationPlatformClient(rpc)
    const skill = await api.createSkill({ profileId: profile.id, scope: 'global', name: 'compound-guide', description: 'Fixture instructions', instructions: 'Exact compound instructions.', enable: true })
    const anonymous = await api.createMcp({ profileId: profile.id, scope: 'global', name: 'Anonymous', transport: 'http', url: origin + '/anonymous', authMode: 'anonymous', enable: true })
    const oauth = await api.createMcp({ profileId: profile.id, scope: 'global', name: 'OAuth', transport: 'http', url: origin + '/oauth', authMode: 'oauth', auth: { clientId: 'fixture-client' }, enable: true })
    const stdio = await api.createMcp({ profileId: profile.id, scope: 'global', name: 'Stdio', transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/agent-platform/integrations/mcp-fixture-server.mjs')], env: { MCP_FIXTURE_CALL_LOG: stdioLog }, enable: true })
    // Supply only the fixture credential, using the real profile-owned OAuth store.
    const provider = await FileMcpOAuthProvider.create(oauth.installationId, origin + '/oauth', { clientId: 'fixture-client' }, async () => { throw new Error('Unexpected external OAuth redirect') }, { oauthDir: getManagedMcpOAuthDir(services.getProfileHomeDir()), profileId: profile.id })
    await provider.saveTokens({ access_token: 'fixture-oauth-token', token_type: 'bearer', expires_in: 3600 })
    const ids = [anonymous, oauth, stdio].map((item) => item.installationId)
    const settings = services.settings.get().integrations
    services.settings.set({ integrations: { ...settings,
      skills: { ...settings.skills, enabled: true, enableForMainAgent: true, enableForAgents: { ...settings.skills.enableForAgents, mousse: true }, enabledSkills: [skill.installationId] },
      mcp: { ...settings.mcp, enabled: true, enableForMainAgent: true, enableForAgents: { ...settings.mcp.enableForAgents, mousse: true }, enabledServers: ids }
    } })
    const actors: IntegrationActor[] = [{ kind: 'main' }, { kind: 'agent', agentType: 'mousse', agentId: randomUUID(), skillIds: [skill.installationId], mcpServerIds: ids }]
    let cachedName = ''
    for (const actor of actors) {
      const catalog = await services.platform.integrations.effectiveForActor(actor)
      expect(catalog.skills.map((item) => item.installationId)).toEqual([skill.installationId])
      const instructions = await services.skillsRegistry.readSkill(catalog.skills[0].id)
      expect(instructions.body).toContain('Exact compound instructions.')
      const schemas = (await services.mcpManager.getEnabledTools(undefined, actor)).filter((tool) => tool.toolName === 'echo')
      expect(new Set(schemas.map((tool) => tool.installationId))).toEqual(new Set(ids))
      for (const tool of schemas) {
        const text = actor.kind + ':' + instructions.body.trim()
        const result = await services.mcpManager.callTool(tool.providerName, { text }, undefined, undefined, actor)
        expect(result.structuredContent).toEqual({ echoed: text })
        if (tool.installationId === anonymous.installationId) cachedName = tool.providerName
      }
    }
    expect(calls).toHaveLength(4)
    expect(calls.filter((call) => call.path === '/anonymous').every((call) => call.authorization === undefined)).toBe(true)
    expect(calls.filter((call) => call.path === '/oauth').every((call) => call.authorization === 'Bearer fixture-oauth-token')).toBe(true)
    expect(existsSync(stdioLog)).toBe(true)
    expect(readFileSync(stdioLog, 'utf8').trim().split('\n')).toHaveLength(2)
    const restricted = { ...actors[1], mcpServerIds: [stdio.installationId] }
    expect((await services.mcpManager.getEnabledTools(undefined, restricted)).every((tool) => tool.installationId === stdio.installationId)).toBe(true)
    await expect(services.mcpManager.callTool(cachedName, { text: 'denied' }, undefined, undefined, restricted)).rejects.toThrow()
    await api.enableMcp({ profileId: profile.id, installationId: anonymous.installationId, enabled: false })
    await api.enableSkill({ profileId: profile.id, installationId: skill.installationId, enabled: false })
    for (const actor of actors) {
      expect((await services.platform.integrations.effectiveForActor(actor)).skills).toEqual([])
      await expect(services.mcpManager.callTool(cachedName, { text: 'late-denied' }, undefined, undefined, actor)).rejects.toThrow()
      expect((await services.mcpManager.getEnabledTools(undefined, actor)).some((tool) => tool.installationId === anonymous.installationId)).toBe(false)
    }
    expect(calls).toHaveLength(4)
  } finally {
    await rpc?.close(); await server?.stop(); await main?.stop(); authInit.mockRestore()
    http.closeAllConnections(); await new Promise<void>((done) => http.close(() => done()))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 60000)
