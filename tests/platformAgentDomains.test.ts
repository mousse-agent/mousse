import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { AGENT_DEFINITION_CAPABILITY } from '../src/shared/agentPlatform'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { AgentDefinitionRegistry, AgentResolver, StaticAgentIntegrationLookup, StaticAgentModelLookup } from '../src/mms/agentDefinitions'
import { registerAgentDefinitionMethods, type AgentDefinitionDomainServices } from '../src/mms/agentDefinitions/registerMethods'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { createAgentDefinitionsClient } from '../src/renderer/services/agentDefinitionsClient'

const roots: string[] = []
function services(profileId: string): AgentDefinitionDomainServices {
  const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-agent-domain-'))
  roots.push(profileRoot)
  const registry = new AgentDefinitionRegistry({ profileId, profileRoot })
  const integrationLookup = new StaticAgentIntegrationLookup()
  const modelLookup = new StaticAgentModelLookup([{
    ref: { providerId: 'fixture', modelId: 'fixture-model' }, available: true,
    efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: []
  }])
  return { registry, resolver: new AgentResolver({ registry, integrationLookup, modelLookup }), integrationLookup }
}
function fixture() {
  const a = services('profile-a'), b = services('profile-b')
  const domains = new DomainHandlerRegistry()
  registerAgentDefinitionMethods(domains, (profileId) => profileId === 'profile-a' ? a : b)
  const context = (profileId: string): HandlerContext => ({
    mms: {} as HandlerContext['mms'], globalSequence: () => 0,
    connection: { id: 'fixture-connection', binding: { profileId, epoch: 1 }, capabilities: new Set([AGENT_DEFINITION_CAPABILITY]) }
  })
  const client = (profileId: string) => createAgentDefinitionsClient({ request: async <T>(method: string, params: unknown) => domains.dispatch(context(profileId), method, params) as Promise<T> })
  return { a, b, domains, context, client }
}
function input(profileId = 'profile-a') {
  const settings = defaultAgentSettings({ name: 'Fixture', slug: 'fixture', purpose: 'Fixture task' })
  settings.primaryModel.ref = { providerId: 'fixture', modelId: 'fixture-model' }
  return { profileId, settings, systemPrompt: '# Fixture agent\nHelp with the task.' }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-agent-domain-') || path.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Agent Editor domain bridge', () => {
  it('saves, validates and publishes through the renderer client without implicit publication', async () => {
    const { client, a } = fixture(), c = client('profile-a')
    const created = await c.create(input())
    expect(await c.validate({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash })).toEqual({ issues: [] })
    expect(a.registry.get(created.id).published).toBeUndefined()
    const saved = await c.saveDraft({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash, systemPrompt: 'Edited source', visual: { orb: { paletteId: 'ember' } } })
    await expect(c.saveDraft({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash, systemPrompt: 'Stale source' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const published = await c.publish({ profileId: 'profile-a', id: created.id, expectedDraftHash: saved.draftHash })
    expect(published.revision).toBe(saved.semanticHash)
    expect((await c.get({ profileId: 'profile-a', id: created.id })).systemPrompt).toBe('Edited source')
    expect((await c.list({ profileId: 'profile-a' }))[0].visual).toEqual(saved.visual)
  })

  it('rejects forged profile IDs, foreign definition IDs, missing binding and missing capability', async () => {
    const { domains, context, client } = fixture()
    const record = await client('profile-a').create(input())
    await expect(client('profile-b').get({ profileId: 'profile-b', id: record.id })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    await expect(client('profile-b').get({ profileId: 'profile-a', id: record.id })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(domains.dispatch({ ...context('profile-a'), connection: undefined }, 'agentDefinitions.list', {})).rejects.toMatchObject({ code: 'profile_binding_required' })
    await expect(domains.dispatch({ ...context('profile-a'), connection: { ...context('profile-a').connection!, capabilities: new Set() } }, 'agentDefinitions.list', {})).rejects.toMatchObject({ code: 'capability_required' })
  })

  it('blocks publication of missing models and rejects invalid runtime/flags/unknown fields before mutation', async () => {
    const { client, domains, context, a } = fixture()
    const missing = input(); missing.settings.primaryModel.ref.modelId = 'missing'
    const record = await client('profile-a').create(missing)
    expect((await client('profile-a').validate({ profileId: 'profile-a', id: record.id })).issues[0].code).toBe('MODEL_CAPABILITY_MISSING')
    await expect(client('profile-a').publish({ profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash })).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISSING' })
    expect(a.registry.get(record.id).published).toBeUndefined()
    for (const bad of [{ runtimeKind: 'invalid' }, { flags: { enabled: 'yes' } }, { overwrite: true }]) {
      await expect(domains.dispatch(context('profile-a'), 'agentDefinitions.create', { ...input(), ...bad })).rejects.toMatchObject({ code: expect.stringMatching(/invalid_params|unknown_field/) })
    }
    expect(a.registry.list()).toHaveLength(1)
  })

  it('keeps visual edits out of execution revisions and round-trips an exported bundle', async () => {
    const { client } = fixture(), c = client('profile-a')
    const record = await c.create(input())
    const changed = await c.saveDraft({ profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash, visual: { palette: 'ember' } })
    expect(changed.semanticHash).toBe(record.semanticHash)
    const bundle = await c.exportBundle({ profileId: 'profile-a', id: record.id })
    const imported = await client('profile-b').importBundle({ profileId: 'profile-b', bundle })
    expect(imported.profileId).toBe('profile-b')
    expect(imported.systemPrompt).toBe(record.systemPrompt)
    expect(imported.visual).toEqual(changed.visual)
  })

  it('keeps exact draft try-runs honest until a real executor is attached', async () => {
    const { client, a } = fixture(), c = client('profile-a')
    const record = await c.create(input())
    expect(await c.tryRun({ profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash, prompt: 'Fixture task' })).toMatchObject({ ok: false, status: 'blocked' })
    expect(a.registry.get(record.id).published).toBeUndefined()
  })
})
