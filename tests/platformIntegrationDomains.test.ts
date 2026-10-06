import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { SkillLifecycleService } from '../src/mms/integrations/skills/SkillLifecycleService'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { McpManager } from '../src/mms/integrations/mcp/McpManager'
import { McpLifecycleService } from '../src/mms/integrations/mcp/McpLifecycleService'
import { IntegrationCatalog } from '../src/mms/integrations/catalog/IntegrationCatalog'
import { registerIntegrationMethods, type IntegrationDomainServices } from '../src/mms/integrations/registerMethods'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { INTEGRATION_CAPABILITY } from '../src/shared/integrationPlatform'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import type { ManagedMcpRecord, ManagedSkillRecord, SkillEditorDto } from '../src/shared/integrations/lifecycle'
import { getManagedMcpConfigPath, getManagedSkillRoot, getManagedSkillStatePath } from '../src/mms/integrations/nativePaths'

const roots: string[] = [], managers: McpManager[] = []
function service(profileId: string): IntegrationDomainServices {
  const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-integration-domain-'))
  roots.push(profileRoot)
  const context = { profileId, profileRoot, secrets: { resolveEnv: (text: string) => text } }
  const settings = new SettingsStore(MousseConfigStore.load(profileRoot))
  const projects = new ProjectManager(profileRoot)
  const skills = new SkillsRegistry(context), mcp = new McpRegistry(context)
  const manager = new McpManager(mcp, settings, async () => {}, { context })
  managers.push(manager)
  const catalog = new IntegrationCatalog(skills, mcp, manager, settings, new SkillLifecycleService(skills, context), new McpLifecycleService(mcp, manager, context))
  return { profileId, settings, projects, catalog, mcpManager: manager }
}
function fixture() {
  const a = service('profile-a'), b = service('profile-b'), domains = new DomainHandlerRegistry()
  const registration = registerIntegrationMethods(domains, (id) => id === 'profile-a' ? a : b)
  const context = (profileId: string): HandlerContext => ({ mms: {} as HandlerContext['mms'], globalSequence: () => 0, connection: { id: 'fixture', binding: { profileId, epoch: 1 }, capabilities: new Set([INTEGRATION_CAPABILITY]) } })
  const call = <T>(method: string, params: unknown, id = 'profile-a') => domains.dispatch(context(id), method, params) as Promise<T>
  return { a, b, call, registration }
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-integration-domain-') || path.includes('..')) throw new Error('Unexpected integration fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('managed integration domain methods', () => {
  it('creates/selects skills for the owning profile, preserves concurrent creates and updates source', async () => {
    const { a, b, call } = fixture()
    const records = await Promise.all(['first-fixture', 'second-fixture'].map((name) => call<ManagedSkillRecord>('skills.create', { name, description: 'Fixture description', instructions: '# Task\nRead this.', scope: 'global' })))
    expect(a.settings.get().integrations.skills.enabledSkills.sort()).toEqual(records.map((record) => record.installationId).sort())
    expect(a.settings.get().integrations.skills.enabled).toBe(true)
    expect(b.settings.get().integrations.skills.enabledSkills).toEqual([])
    const record = records[0]
    const editor = await call<SkillEditorDto>('skills.editor', { installationId: record.installationId })
    expect(editor.source).toContain('# Task')
    const updated = await call<ManagedSkillRecord>('skills.update', { installationId: record.installationId, expectedRevision: record.revision, content: editor.source.replace('Read this.', 'Updated instructions.') })
    expect(updated.revision).not.toBe(record.revision)
    await expect(call('skills.update', { installationId: record.installationId, expectedRevision: record.revision, content: editor.source })).rejects.toMatchObject({ code: 'revision_conflict' })
    await call('skills.enable', { installationId: record.installationId, enabled: false })
    expect(a.settings.get().integrations.skills.enabledSkills).not.toContain(record.installationId)
  })

  it('refuses raw filesystem paths and foreign project IDs before import or mutation', async () => {
    const { a, call } = fixture()
    const project = a.projects.openProject(roots[0])
    await expect(call('skills.create', { name: 'fixture', description: 'Fixture', scope: 'project', projectId: project.id }, 'profile-b')).rejects.toMatchObject({ code: 'project_not_found' })
    await expect(call('skills.importPackage', { scope: 'global', sourcePath: roots[0] })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(call('skills.create', { name: 'fixture', description: 'Fixture', scope: 'global', profileId: 'profile-b' })).rejects.toMatchObject({ code: 'profile_mismatch' })
  })

  it('imports and exports uploaded package bytes without executing bundled code', async () => {
    const { call } = fixture()
    const bytes = zipSync({ 'SKILL.md': strToU8('---\nname: upload-fixture\ndescription: Upload fixture\n---\n# Instructions\nRead me.\n'), 'scripts/example.mjs': strToU8('throw new Error("must not execute during import")') })
    const record = await call<ManagedSkillRecord>('skills.importPackage', { scope: 'global', zipBase64: Buffer.from(bytes).toString('base64') })
    expect(record.skill.name).toBe('upload-fixture')
    const exported = await call<{ base64: string; contentType: string }>('skills.exportPackage', { installationId: record.installationId })
    expect(exported.contentType).toBe('application/zip')
    expect(Buffer.from(exported.base64, 'base64').byteLength).toBeGreaterThan(0)
    await call('skills.archive', { installationId: record.installationId })
  })

  it('never saves masked secrets from a read response back into a live configuration', async () => {
    const { call } = fixture()
    const record = await call<ManagedMcpRecord>('mcp.create', { name: 'secret-fixture', scope: 'global', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer fixture-only-value' }, enable: false })
    expect(record.server.headers?.Authorization).toBe('[redacted]')
    await expect(call('mcp.update', { installationId: record.installationId, expectedRevision: record.revision, headers: record.server.headers })).rejects.toMatchObject({ code: 'redacted_secret' })
    const unchanged = await call<ManagedMcpRecord>('mcp.read', { installationId: record.installationId })
    expect(unchanged.revision).toBe(record.revision)
  })

  it('uses the unredacted entry revision consistently across MCP read, rename, and conflict checks', async () => {
    const { call } = fixture()
    const created = await call<ManagedMcpRecord>('mcp.create', {
      name: 'revision-fixture', scope: 'global', transport: 'http', url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer fixture-only-value' }, enable: false
    })
    const read = await call<ManagedMcpRecord>('mcp.read', { installationId: created.installationId })
    expect(read.revision).toBe(created.revision)
    const updated = await call<ManagedMcpRecord>('mcp.update', {
      installationId: created.installationId,
      expectedRevision: read.revision,
      name: 'renamed-fixture',
      enabledTools: []
    })
    expect(updated.server.name).toBe('renamed-fixture')
    expect(updated.revision).not.toBe(read.revision)
    await expect(call('mcp.update', {
      installationId: created.installationId,
      expectedRevision: read.revision,
      name: 'stale-rename'
    })).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('refuses to overwrite malformed managed documents', async () => {
    const { call } = fixture()
    const profileRoot = roots[0]
    const mcpPath = getManagedMcpConfigPath(profileRoot)
    mkdirSync(dirname(mcpPath), { recursive: true })
    writeFileSync(mcpPath, '{ malformed')
    await expect(call('mcp.create', { name: 'must-not-write', scope: 'global', transport: 'http', url: 'https://example.invalid/mcp' })).rejects.toThrow(/cannot be read without risking data loss/)
    expect(readFileSync(mcpPath, 'utf8')).toBe('{ malformed')

    const skillState = getManagedSkillStatePath(profileRoot)
    mkdirSync(dirname(skillState), { recursive: true })
    writeFileSync(skillState, '{ malformed')
    await expect(call('skills.create', { name: 'must-not-write', description: 'Must preserve corrupt state.', scope: 'global' })).rejects.toThrow(/cannot be read without risking data loss/)
    expect(existsSync(join(getManagedSkillRoot(profileRoot), 'must-not-write'))).toBe(false)
  })

  it('cancels profile authentication on disposal without cancelling another profile', async () => {
    const { a, b, call, registration } = fixture()
    const begin = (_id: string, _project?: string, signal?: AbortSignal) => new Promise<{ success: boolean; error: string }>((resolve) => {
      signal!.addEventListener('abort', () => resolve({ success: false, error: 'Cancelled' }), { once: true })
    })
    const first = vi.spyOn(a.mcpManager, 'authenticateServer').mockImplementation(begin)
    const second = vi.spyOn(b.mcpManager, 'authenticateServer').mockImplementation(begin)
    const taskA = call('mcp.beginAuth', { installationId: 'fixture' })
    const taskB = call('mcp.beginAuth', { installationId: 'fixture' }, 'profile-b')
    await vi.waitFor(() => { expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce() })
    registration.disposeProfile('profile-a')
    await expect(taskA).resolves.toMatchObject({ success: false })
    expect(second.mock.calls[0][2]?.aborted).toBe(false)
    registration.disconnect('fixture')
    await expect(taskB).resolves.toMatchObject({ success: false })
    registration.dispose()
    await expect(call('integrations.snapshot', {})).rejects.toMatchObject({ code: 'service_unavailable' })
  })

  it('opens authorization only through its owning GUI connection and requires a truthful browser result', async () => {
    const a = service('profile-a'), domains = new DomainHandlerRegistry()
    const registration = registerIntegrationMethods(domains, () => a)
    const context = (connectionId = 'owner', epoch = 1): HandlerContext => ({
      mms: {} as HandlerContext['mms'], globalSequence: () => 0,
      connection: { id: connectionId, clientType: 'gui', binding: { profileId: 'profile-a', epoch }, capabilities: new Set([INTEGRATION_CAPABILITY]), emitConnectionEvent: vi.fn(async () => {}) }
    })
    const owner = context()
    vi.spyOn(a.mcpManager, 'authenticateServer').mockImplementation(async (_id, _path, _signal, open) => {
      try { await open!('https://login.example.test/authorize?state=fixture'); return { success: true } }
      catch (error) { return { success: false, error: (error as Error).message } }
    })
    const pending = domains.dispatch(owner, 'mcp.beginAuth', { installationId: 'fixture' })
    const emit = vi.mocked(owner.connection!.emitConnectionEvent!)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    const data = emit.mock.calls[0][1] as { attemptId: string; url: string }
    expect(emit.mock.calls[0][0]).toBe('mcp.auth-url')
    expect(data.url).toContain('https://login.example.test/authorize')
    await expect(domains.dispatch(context('other'), 'mcp.authBrowserResult', { attemptId: data.attemptId, opened: true })).rejects.toMatchObject({ code: 'auth_attempt_unavailable' })
    await expect(domains.dispatch(context('owner', 2), 'mcp.authBrowserResult', { attemptId: data.attemptId, opened: true })).rejects.toMatchObject({ code: 'auth_attempt_unavailable' })
    await domains.dispatch(owner, 'mcp.authBrowserResult', { attemptId: data.attemptId, opened: false })
    await expect(pending).resolves.toMatchObject({ success: false, error: expect.stringContaining('Could not open your browser') })
    await expect(domains.dispatch(owner, 'mcp.authBrowserResult', { attemptId: data.attemptId, opened: true })).rejects.toMatchObject({ code: 'auth_attempt_unavailable' })
    const retry = domains.dispatch(owner, 'mcp.beginAuth', { installationId: 'fixture' })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2))
    const next = emit.mock.calls[1][1] as { attemptId: string }
    await domains.dispatch(owner, 'mcp.authBrowserResult', { attemptId: next.attemptId, opened: true })
    await expect(retry).resolves.toMatchObject({ success: true })
    registration.dispose()
  })

  it('cancels an outstanding browser dispatch and refuses unsafe authorization URLs', async () => {
    const a = service('profile-a'), domains = new DomainHandlerRegistry()
    const registration = registerIntegrationMethods(domains, () => a)
    const emit = vi.fn(async () => {})
    const owner: HandlerContext = { mms: {} as HandlerContext['mms'], globalSequence: () => 0, connection: { id: 'owner', clientType: 'gui', binding: { profileId: 'profile-a', epoch: 1 }, capabilities: new Set([INTEGRATION_CAPABILITY]), emitConnectionEvent: emit } }
    const authenticate = vi.spyOn(a.mcpManager, 'authenticateServer').mockImplementation(async (_id, _path, _signal, open) => {
      try { await open!('https://login.example.test/authorize'); return { success: true } }
      catch (error) { return { success: false, error: (error as Error).message } }
    })
    const pending = domains.dispatch(owner, 'mcp.beginAuth', { installationId: 'fixture' })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    registration.disconnect('owner')
    await expect(pending).resolves.toMatchObject({ success: false, error: 'Authorization cancelled' })
    authenticate.mockImplementation(async (_id, _path, _signal, open) => {
      try { await open!('file:///tmp/unsafe'); return { success: true } }
      catch (error) { return { success: false, error: (error as Error).message } }
    })
    await expect(domains.dispatch(owner, 'mcp.beginAuth', { installationId: 'fixture' })).resolves.toMatchObject({ success: false, error: 'Invalid authorization URL' })
    expect(emit).toHaveBeenCalledOnce()
    registration.dispose()
  })

  it('connects a real fixture MCP server and returns truthful missing-server results', async () => {
    const { a, call } = fixture()
    const created = await call<ManagedMcpRecord>('mcp.create', {
      name: 'fixture-stdio', transport: 'stdio', command: process.execPath,
      args: [resolve('tests/fixtures/agent-platform/integrations/mcp-fixture-server.mjs')], scope: 'global', authMode: 'anonymous'
    })
    expect(a.settings.get().integrations.mcp.enabledServers).toContain(created.installationId)
    const result = await call<{ success: boolean; toolCount: number }>('mcp.testConnection', { installationId: created.installationId })
    expect(result.success).toBe(true)
    expect(result.toolCount).toBeGreaterThan(0)
    expect(await call('mcp.testConnection', { installationId: 'missing-fixture' })).toMatchObject({ success: false, errorCategory: 'missing' })
    await call('mcp.delete', { installationId: created.installationId })
    expect(a.settings.get().integrations.mcp.enabledServers).not.toContain(created.installationId)
  }, 20_000)
})
