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

  it("publish refuses a primary the gateway's check refuses, whichever client publishes, and checks only on request", async () => {
    const { client, a } = fixture(), c = client('profile-a')
    const refusal = "Claude Code can't enforce this agent's workspace and tool limits yet, so it can't run agent definitions."
    const checked: string[] = []
    a.checkRuntime = (request) => {
      checked.push(request.definitionId)
      return [{ code: 'SETTINGS_UNSUPPORTED', message: refusal, pointer: '/settings/tools/mode', retryable: false, details: { model: request.settings.primaryModel.ref } }]
    }
    const created = await c.create(input())
    // The editor's check: only where it runs, with nothing else resolved.
    expect(await c.validate({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash, runtimeOnly: true })).toEqual({ issues: [expect.objectContaining({ message: refusal })] })
    await expect(c.publish({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash })).rejects.toMatchObject({ code: 'SETTINGS_UNSUPPORTED', message: refusal })
    expect(a.registry.get(created.id).published).toBeUndefined()
    // A refused fallback alone does not stop publishing: the run skips it.
    a.checkRuntime = () => [{ code: 'SETTINGS_UNSUPPORTED', message: `Fallback x will be skipped: ${refusal}`, pointer: '/settings/tools/mode', retryable: false, details: { blocking: false } }]
    expect((await c.publish({ profileId: 'profile-a', id: created.id, expectedDraftHash: created.draftHash })).revision).toBe(created.semanticHash)
    expect(checked).toEqual([created.id, created.id])
  })

  it('a fallback or override model that cannot be reached (signed out, or a runtime that never runs definitions) is skipped, not blocking', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-agent-domain-'))
    roots.push(profileRoot)
    const registry = new AgentDefinitionRegistry({ profileId: 'profile-a', profileRoot })
    const unreachable = (modelId: string, code: string) => ({ ref: { providerId: 'cursor', modelId }, available: false, efforts: [], speeds: [], contexts: [], capabilities: [], unavailableReasons: [`${code} reason`], unavailableCode: code })
    const resolver = new AgentResolver({
      registry,
      integrationLookup: new StaticAgentIntegrationLookup(),
      modelLookup: new StaticAgentModelLookup([
        { ref: { providerId: 'fixture', modelId: 'fixture-model' }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools', 'vision'], unavailableReasons: [] },
        unreachable('agent', 'policy_unenforceable'),
        unreachable('vision', 'signed_out')
      ] as never)
    })
    const settings = input().settings
    settings.fallbacks = { ...settings.fallbacks, enabled: true, allowHigherCost: true, models: [{ providerId: 'cursor', modelId: 'agent' }] }
    settings.primaryModel.capabilityOverrides = { vision: { providerId: 'cursor', modelId: 'vision' } }
    const created = registry.createDraft({ settings, systemPrompt: 'Hi' })
    const resolved = resolver.resolveDraft({ definitionId: created.id, expectedDraftHash: created.draftHash })
    expect(resolved.model.primary.ref.providerId).toBe('fixture')
    expect(resolved.model.fallbacks).toEqual([])
    expect(resolved.model.capabilityOverrides).toEqual({})
    expect(resolved.issues.map((issue) => [issue.pointer, issue.details?.blocking, issue.details?.errorCode])).toEqual([
      ['/settings/fallbacks/models/0', false, 'policy_unenforceable'],
      ['/settings/primaryModel/capabilityOverrides/vision', false, 'signed_out']
    ])
    // The same model as the primary blocks.
    const primary = registry.createDraft({ settings: { ...input().settings, identity: { ...settings.identity, slug: 'primary-cursor' }, primaryModel: { ref: { providerId: 'cursor', modelId: 'agent' }, capabilityOverrides: {} } }, systemPrompt: 'Hi' })
    expect(() => resolver.resolveDraft({ definitionId: primary.id, expectedDraftHash: primary.draftHash })).toThrow(/policy_unenforceable reason/)
  })

  it('rejects forged profile IDs and foreign definition IDs', async () => {
    const { client } = fixture()
    const record = await client('profile-a').create(input())
    await expect(client('profile-b').get({ profileId: 'profile-b', id: record.id })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    await expect(client('profile-b').get({ profileId: 'profile-a', id: record.id })).rejects.toMatchObject({ code: 'profile_mismatch' })
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

  it('reports a stale exact-draft validation as a revision conflict', async () => {
    const { client } = fixture(), c = client('profile-a')
    const record = await c.create(input())
    await c.saveDraft({
      profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash,
      systemPrompt: 'A newer draft'
    })
    await expect(c.validate({
      profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('publishes the dependency hashes from the same validated resolver snapshot', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'mousse-agent-domain-'))
    roots.push(profileRoot)
    const registry = new AgentDefinitionRegistry({ profileId: 'profile-a', profileRoot })
    const validatedLookup = new StaticAgentIntegrationLookup({
      skills: [{ id: 'review', available: true, revision: 'skill-rev', hash: 'validated-hash' }]
    })
    const modelLookup = new StaticAgentModelLookup([{
      ref: { providerId: 'fixture', modelId: 'fixture-model' }, available: true,
      efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: []
    }])
    const service: AgentDefinitionDomainServices = {
      registry,
      resolver: new AgentResolver({ registry, integrationLookup: validatedLookup, modelLookup }),
      // A mismatched host lookup must not silently replace the grants that were
      // just validated by the resolver.
      integrationLookup: new StaticAgentIntegrationLookup()
    }
    const domains = new DomainHandlerRegistry()
    registerAgentDefinitionMethods(domains, () => service)
    const c = createAgentDefinitionsClient({
      request: async <T>(method: string, params: unknown) =>
        domains.dispatch({
          mms: {} as HandlerContext['mms'], globalSequence: () => 0,
          connection: {
            id: 'fixture-connection', binding: { profileId: 'profile-a', epoch: 1 },
            capabilities: new Set([AGENT_DEFINITION_CAPABILITY])
          }
        }, method, params) as Promise<T>
    })
    const createInput = input()
    createInput.settings.skills = {
      mode: 'explicit', selections: [{ skillId: 'review', enabled: true }]
    }
    const record = await c.create(createInput)
    const published = await c.publish({
      profileId: 'profile-a', id: record.id, expectedDraftHash: record.draftHash
    })
    expect(published.dependencyHashes).toEqual({ 'skill:review': 'validated-hash' })
  })
})
