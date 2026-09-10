import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDefinitionError } from '../src/shared/agents/errors'
import { AGENT_PROMPT_MAX_BYTES, defaultAgentSettings } from '../src/shared/agents/defaults'
import { computeSemanticHash, computeVisualHash } from '../src/shared/agents/hashes'
import { assertSafeBundlePath } from '../src/shared/agents/pathSafety'
import { AGENT_RUNTIME_KINDS } from '../src/shared/agents/types'
import { collectUnsupportedCliSettings, getRuntimeCompatibility } from '../src/shared/agents/compatibility'
import { resolveEffectiveGrants } from '../src/shared/agents/grants'
import { draftFromModePrompt } from '../src/shared/agents/prompt'
import {
  AgentDefinitionRegistry,
  AgentResolver,
  BUILTIN_CLI_ENGINE_IDS,
  StaticAgentIntegrationLookup,
  StaticAgentModelLookup
} from '../src/mms/agentDefinitions'
import type { AgentDefinitionSettings, AgentRuntimeKind } from '../src/shared/agents/types'

const tempRoots: string[] = []

function tempProfileRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `mousse-agent-def-${label}-`))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

const grokModel = {
  ref: { providerId: 'xai', modelId: 'grok-4' },
  available: true,
  label: 'Grok 4',
  efforts: ['low', 'high'],
  speeds: ['fast'],
  contexts: ['128k'],
  capabilities: ['reasoning', 'tools', 'json_schema'],
  unavailableReasons: []
}

function nativeSettings(slug: string, extra: Partial<AgentDefinitionSettings> = {}): AgentDefinitionSettings {
  return {
    ...defaultAgentSettings({ name: slug, slug, purpose: 'test agent' }),
    primaryModel: {
      ref: { providerId: 'xai', modelId: 'grok-4', effort: 'high' },
      capabilityOverrides: {}
    },
    ...extra
  }
}

function createServices(profileId: string, profileRoot: string, integration?: StaticAgentIntegrationLookup) {
  const registry = new AgentDefinitionRegistry({ profileId, profileRoot })
  const resolver = new AgentResolver({
    registry,
    modelLookup: new StaticAgentModelLookup([grokModel]),
    integrationLookup:
      integration ??
      new StaticAgentIntegrationLookup({
        skills: [
          { id: 'review', available: true, revision: 'skill-rev-1', hash: 'skillhash1' },
          { id: 'search', available: true, revision: 'skill-rev-2', hash: 'skillhash2' }
        ],
        mcpTools: [
          {
            serverId: 'docs',
            toolName: 'lookup',
            available: true,
            revision: 'mcp-rev-1',
            hash: 'mcphash1'
          }
        ],
        builtinToolIds: ['read', 'grep', 'ask_user']
      })
  })
  return { registry, resolver }
}

describe('agent definition identity vs runtime Agent', () => {
  it('uses UUIDs and preserves built-in CLI engine ids', () => {
    expect(BUILTIN_CLI_ENGINE_IDS).toEqual(AGENT_RUNTIME_KINDS)
    expect(BUILTIN_CLI_ENGINE_IDS).toContain('mousse')
    expect(BUILTIN_CLI_ENGINE_IDS).toContain('claude-code')
    expect(BUILTIN_CLI_ENGINE_IDS).toContain('codex')
    expect(BUILTIN_CLI_ENGINE_IDS).toContain('opencode')
    expect(BUILTIN_CLI_ENGINE_IDS).toContain('cursor-agents-cli')
    const runtimeAgent = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
    expect(runtimeAgent).toContain('export interface Agent {')
    expect(runtimeAgent).toContain('cliType: CliType')
    const definitionTypes = readFileSync(new URL('../src/shared/agents/types.ts', import.meta.url), 'utf8')
    expect(definitionTypes).toContain('Distinct from the runtime')
    expect(readFileSync(new URL('../src/mms/agents/AgentRegistry.ts', import.meta.url), 'utf8')).toContain(
      'class AgentRegistry'
    )
  })
})

describe('profile-root isolation', () => {
  it('keeps A/B registries isolated and ignores MOUSSE_HOME', () => {
    const originalHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = join(tmpdir(), 'should-not-be-used-mousse-home')
    try {
      const rootA = tempProfileRoot('a')
      const rootB = tempProfileRoot('b')
      const a = createServices('profile-a', rootA)
      const b = createServices('profile-b', rootB)
      const created = a.registry.createDraft({
        settings: { identity: { name: 'Reviewer', slug: 'reviewer', purpose: '', tags: [] } },
        systemPrompt: 'Review the diff.'
      })
      expect(a.registry.list()).toHaveLength(1)
      expect(b.registry.list()).toHaveLength(0)
      expect(() => b.registry.get(created.id)).toThrow(AgentDefinitionError)
      expect(created.profileId).toBe('profile-a')
    } finally {
      if (originalHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = originalHome
    }
  })

  it('rejects an agents junction that escapes the injected profile root', () => {
    const profileRoot = tempProfileRoot('junction-profile')
    const outside = tempProfileRoot('junction-outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(profileRoot, 'agents'), 'junction')
    expect(() => new AgentDefinitionRegistry({ profileId: 'profile-a', profileRoot })).toThrow(/link outside/)
  })
})

describe('draft publish pin and edit', () => {
  it('does not resolve an unpublished draft as a runnable revision', () => {
    const { registry, resolver } = createServices('profile-a', tempProfileRoot('unpublished'))
    const created = registry.createDraft({
      settings: nativeSettings('draft-only'),
      systemPrompt: 'Not published'
    })
    expect(() => resolver.resolve({ definitionId: created.id })).toThrow(/has not been published/)
  })

  it('pins the published revision while later draft edits change only the draft', () => {
    const { registry, resolver } = createServices('profile-a', tempProfileRoot('pin'))
    const created = registry.createDraft({
      settings: nativeSettings('pinned-bot'),
      systemPrompt: 'You are revision one.'
    })
    const published = registry.publish(created.id, created.draftHash)
    const edited = registry.saveDraft(created.id, {
      expectedDraftHash: registry.get(created.id).draftHash,
      systemPrompt: 'You are a later unpublished draft.'
    })
    expect(edited.systemPrompt).toBe('You are a later unpublished draft.')
    expect(edited.semanticHash).not.toBe(published.revision)
    expect(edited.published?.revision).toBe(published.revision)

    const pinned = registry.getRevision(created.id, published.revision)
    expect(pinned.systemPrompt).toBe('You are revision one.')

    const resolved = resolver.resolve({ definitionId: created.id })
    expect(resolved.revision).toBe(published.revision)
    expect(resolved.instructions.definitionInstructions).toBe('You are revision one.')
    expect(resolved.instructions.compiled).toContain('You are revision one.')
    expect(resolved.instructions.compiled).not.toContain('later unpublished')
  })

  it('rejects stale draft writes', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('conflict'))
    const created = registry.createDraft({
      settings: nativeSettings('conflict-bot'),
      systemPrompt: 'v1'
    })
    registry.saveDraft(created.id, { expectedDraftHash: created.draftHash, systemPrompt: 'v2' })
    expect(() =>
      registry.saveDraft(created.id, { expectedDraftHash: created.draftHash, systemPrompt: 'v3' })
    ).toThrow(/Draft changed/)
    try {
      registry.saveDraft(created.id, { expectedDraftHash: created.draftHash, systemPrompt: 'v3' })
    } catch (error) {
      expect(error).toBeInstanceOf(AgentDefinitionError)
      expect((error as AgentDefinitionError).code).toBe('REVISION_CONFLICT')
    }
  })
})

describe('archive duplicate import export', () => {
  it('hides archived definitions from the default list but keeps revisions', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('archive'))
    const created = registry.createDraft({
      settings: nativeSettings('archive-bot'),
      systemPrompt: 'Keep me.'
    })
    const published = registry.publish(created.id, created.draftHash)
    registry.archive(created.id)
    expect(registry.list()).toHaveLength(0)
    expect(registry.list({ archived: true })).toHaveLength(1)
    const still = registry.get(created.id)
    expect(still.flags.archived).toBe(true)
    expect(registry.getRevision(created.id, published.revision).systemPrompt).toBe('Keep me.')
    expect(() => registry.saveDraft(created.id, { expectedDraftHash: still.draftHash, systemPrompt: 'nope' })).toThrow(
      /Archived/
    )
  })

  it('duplicates into a new UUID and slug', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('dup'))
    const created = registry.createDraft({
      settings: nativeSettings('original-bot'),
      systemPrompt: 'Original'
    })
    const copy = registry.duplicate(created.id)
    expect(copy.id).not.toBe(created.id)
    expect(copy.settings.identity.slug).toBe('original-bot-copy')
    expect(copy.systemPrompt).toBe('Original')
  })

  it('exports and imports a bundle without executing hooks', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('io'))
    const created = registry.createDraft({
      settings: nativeSettings('portable-bot'),
      systemPrompt: 'Portable prompt'
    })
    const bundle = registry.exportBundle(created.id)
    expect(bundle.format).toBe('mousse-agent')
    expect(bundle.files['system.md']).toBe('Portable prompt')
    const imported = registry.importBundle(bundle, { conflict: 'rename' })
    expect(imported.id).not.toBe(created.id)
    expect(imported.settings.identity.slug).toBe('portable-bot-imported')
    expect(imported.systemPrompt).toBe('Portable prompt')
  })

  it('retains an exported id only when explicitly requested and rejects collisions', () => {
    const source = createServices('profile-a', tempProfileRoot('retain-source')).registry
    const created = source.createDraft({ settings: nativeSettings('retain-id'), systemPrompt: 'Portable' })
    const bundle = source.exportBundle(created.id)
    const target = createServices('profile-b', tempProfileRoot('retain-target')).registry
    const imported = target.importBundle(bundle, { retainId: true })
    expect(imported.id).toBe(created.id)
    expect(() => target.importBundle(bundle, { retainId: true, conflict: 'rename' })).toThrow(/already exists/)
  })
})

describe('prompt bytes and path safety', () => {
  it('rejects traversal, absolute paths, and oversized prompts', () => {
    expect(() => assertSafeBundlePath('../secret.md')).toThrow(AgentDefinitionError)
    expect(() => assertSafeBundlePath('/etc/passwd')).toThrow(AgentDefinitionError)
    expect(() => assertSafeBundlePath('C:\\Windows\\system32')).toThrow(AgentDefinitionError)
    expect(() => assertSafeBundlePath('foo\\..\\bar')).toThrow(AgentDefinitionError)
    const { registry } = createServices('profile-a', tempProfileRoot('prompt'))
    expect(() =>
      registry.createDraft({
        settings: nativeSettings('huge-bot'),
        systemPrompt: 'x'.repeat(AGENT_PROMPT_MAX_BYTES + 1)
      })
    ).toThrow(/System prompt is/)
    expect(() =>
      registry.createDraft({
        settings: {
          ...nativeSettings('escape-bot'),
          context: {
            ...nativeSettings('escape-bot').context,
            selectedFiles: ['../outside.txt']
          }
        }
      })
    ).toThrow(AgentDefinitionError)
  })
})

describe('visual vs semantic hashes', () => {
  it('changes visual metadata without rewriting the execution hash', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('visual'))
    const created = registry.createDraft({
      settings: nativeSettings('looks-bot'),
      systemPrompt: 'Same prompt',
      visual: { note: 'opaque-to-agents-worker' }
    })
    const visualOnly = registry.saveDraft(created.id, {
      expectedDraftHash: created.draftHash,
      visual: { note: 'still-opaque', seed: 2 }
    })
    expect(visualOnly.semanticHash).toBe(created.semanticHash)
    expect(visualOnly.visualHash).not.toBe(created.visualHash)
    expect(visualOnly.visualHash).toBe(computeVisualHash({ note: 'still-opaque', seed: 2 }))
    const promptEdit = registry.saveDraft(visualOnly.id, {
      expectedDraftHash: visualOnly.draftHash,
      systemPrompt: 'Different prompt'
    })
    expect(promptEdit.semanticHash).not.toBe(created.semanticHash)
    expect(promptEdit.semanticHash).toBe(
      computeSemanticHash({
        id: created.id,
        runtimeKind: created.runtimeKind,
        settings: promptEdit.settings,
        systemPrompt: 'Different prompt'
      })
    )
  })

  it('publishes visual-only edits independently of the execution revision', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('visual-publish'))
    const created = registry.createDraft({
      settings: nativeSettings('visual-publish'),
      systemPrompt: 'Same prompt',
      visual: { palette: 'aurora' }
    })
    const first = registry.publish(created.id, created.draftHash)
    const edited = registry.saveDraft(created.id, {
      expectedDraftHash: registry.get(created.id).draftHash,
      visual: { palette: 'ember' }
    })
    const second = registry.publish(created.id, edited.draftHash)
    expect(second.revision).toBe(first.revision)
    expect(second.visualRevision).not.toBe(first.visualRevision)
    const pinned = registry.getRevision(created.id, second.revision)
    expect(pinned.visualRevision).toBe(second.visualRevision)
    expect(pinned.visual).toEqual({ palette: 'ember' })
  })

  it('rejects modified bytes in an immutable published revision', () => {
    const root = tempProfileRoot('revision-integrity')
    const { registry } = createServices('profile-a', root)
    const created = registry.createDraft({
      settings: nativeSettings('revision-integrity'),
      systemPrompt: 'Original bytes'
    })
    const published = registry.publish(created.id, created.draftHash)
    writeFileSync(join(root, 'agents', created.id, 'revisions', published.revision, 'system.md'), 'Modified bytes')
    expect(() => registry.getRevision(created.id, published.revision)).toThrow(/integrity check/)
  })
})

describe('model capability and CLI compatibility', () => {
  it('fails resolve when the model is missing or an effort is unsupported', () => {
    const { registry, resolver } = createServices('profile-a', tempProfileRoot('model'))
    const missing = registry.createDraft({
      settings: {
        ...nativeSettings('missing-model'),
        primaryModel: { ref: { providerId: 'xai', modelId: 'does-not-exist' }, capabilityOverrides: {} }
      },
      systemPrompt: 'Hi'
    })
    registry.publish(missing.id, missing.draftHash)
    try {
      resolver.resolve({ definitionId: missing.id })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentDefinitionError)
      expect((error as AgentDefinitionError).code).toBe('MODEL_CAPABILITY_MISSING')
      expect((error as AgentDefinitionError).message).toMatch(/does-not-exist/)
    }

    const effort = registry.createDraft({
      settings: {
        ...nativeSettings('bad-effort'),
        primaryModel: { ref: { providerId: 'xai', modelId: 'grok-4', effort: 'max' }, capabilityOverrides: {} }
      },
      systemPrompt: 'Hi'
    })
    registry.publish(effort.id, effort.draftHash)
    expect(() => resolver.resolve({ definitionId: effort.id })).toThrow(/Effort "max"/)
  })

  it('rejects an optional model control when the catalog advertises no supported values', () => {
    const root = tempProfileRoot('empty-model-controls')
    const registry = new AgentDefinitionRegistry({ profileId: 'profile-a', profileRoot: root })
    const resolver = new AgentResolver({
      registry,
      modelLookup: new StaticAgentModelLookup([{ ...grokModel, efforts: [] }]),
      integrationLookup: new StaticAgentIntegrationLookup()
    })
    const created = registry.createDraft({ settings: nativeSettings('unsupported-effort'), systemPrompt: 'Hi' })
    registry.publish(created.id, created.draftHash)
    expect(() => resolver.resolve({ definitionId: created.id })).toThrow(/Effort "high"/)
  })

  it('rejects unsupported CLI settings instead of pretending they work', () => {
    const { registry } = createServices('profile-a', tempProfileRoot('cli'))
    expect(getRuntimeCompatibility('codex').native).toBe(false)
    const settings = {
      ...nativeSettings('codex-bot'),
      browser: { mode: 'native' as const, allowedDomains: ['example.com'], traceRetention: 'run' as const }
    }
    expect(collectUnsupportedCliSettings('codex', settings)).toContain('/settings/browser')
    expect(() =>
      registry.createDraft({
        runtimeKind: 'codex',
        settings,
        systemPrompt: 'CLI prompt'
      })
    ).toThrow(/does not support/)
    const allowed = registry.createDraft({
      runtimeKind: 'codex',
      settings: nativeSettings('codex-ok'),
      systemPrompt: 'CLI prompt'
    })
    expect(allowed.runtimeKind).toBe('codex')

    const switchable = registry.createDraft({
      settings: nativeSettings('switch-runtime'),
      systemPrompt: 'Switch me'
    })
    const switched = registry.saveDraft(switchable.id, {
      expectedDraftHash: switchable.draftHash,
      runtimeKind: 'codex'
    })
    expect(switched.runtimeKind).toBe('codex')
    expect(switched.semanticHash).not.toBe(switchable.semanticHash)
    expect(registry.get(switched.id).runtimeKind).toBe('codex')

    expect(() =>
      registry.saveDraft(switched.id, {
        expectedDraftHash: switched.draftHash,
        runtimeKind: 'mousse',
        settings: {
          browser: { mode: 'native', allowedDomains: ['example.com'], traceRetention: 'run' }
        }
      })
    ).not.toThrow()
    const nativeAgain = registry.get(switched.id)
    expect(nativeAgain.runtimeKind).toBe('mousse')

    expect(() =>
      registry.saveDraft(nativeAgain.id, {
        expectedDraftHash: nativeAgain.draftHash,
        runtimeKind: 'invalid-runtime' as AgentRuntimeKind
      })
    ).toThrow(/Unknown runtime kind/)
  })
})

describe('integrations and grants', () => {
  it('reports missing integrations instead of synthesizing success', () => {
    const { registry, resolver } = createServices('profile-a', tempProfileRoot('deps'))
    const created = registry.createDraft({
      settings: {
        ...nativeSettings('needs-skill'),
        skills: { mode: 'explicit', selections: [{ skillId: 'missing-skill', enabled: true }] }
      },
      systemPrompt: 'Use the skill.'
    })
    registry.publish(created.id, created.draftHash)
    try {
      resolver.resolve({ definitionId: created.id })
      throw new Error('expected failure')
    } catch (error) {
      expect((error as AgentDefinitionError).code).toBe('DEPENDENCY_MISSING')
      expect((error as AgentDefinitionError).message).toMatch(/missing-skill/)
    }
  })

  it('distinguishes inherited and explicit grants', () => {
    const lookup = new StaticAgentIntegrationLookup({
      skills: [
        { id: 'review', available: true, hash: 'h-review' },
        { id: 'search', available: true, hash: 'h-search' }
      ],
      mcpTools: [{ serverId: 'docs', toolName: 'lookup', available: true, hash: 'h-mcp' }],
      builtinToolIds: ['read', 'grep', 'ask_user']
    })
    const inherited = resolveEffectiveGrants(nativeSettings('g'), lookup)
    expect(inherited.skills.map((item) => item.id).sort()).toEqual(['review', 'search'])
    expect(inherited.skills.every((item) => item.source === 'inherited')).toBe(true)
    expect(inherited.mcpTools).toEqual([
      expect.objectContaining({ serverId: 'docs', toolName: 'lookup', source: 'inherited' })
    ])

    const explicit = resolveEffectiveGrants(
      {
        ...nativeSettings('g'),
        skills: {
          mode: 'inherit',
          selections: [
            { skillId: 'review', enabled: false },
            { skillId: 'search', enabled: true }
          ]
        },
        mcp: {
          mode: 'explicit',
          servers: [{ serverId: 'docs', enabled: true, tools: [{ toolName: 'lookup', enabled: true }] }]
        },
        tools: { mode: 'explicit', allowlist: ['read'] }
      },
      lookup
    )
    expect(explicit.skills.map((item) => item.id)).toEqual(['search'])
    expect(explicit.skills[0]?.source).toBe('explicit')
    expect(explicit.denied.some((item) => item.id === 'review')).toBe(true)
    expect(explicit.mcpTools[0]?.source).toBe('explicit')
    expect(explicit.builtinTools.map((item) => item.id)).toEqual(['read'])
    expect(explicit.denied.some((item) => item.kind === 'tool' && item.id === 'grep')).toBe(false)
  })

  it('does not silently substitute the current skill for an unavailable pinned revision', () => {
    const lookup = new StaticAgentIntegrationLookup({
      skills: [{ id: 'review', available: true, revision: 'skill-rev-2', hash: 'h-review-2' }]
    })
    const effective = resolveEffectiveGrants(
      {
        ...nativeSettings('pinned-skill'),
        skills: {
          mode: 'explicit',
          selections: [{ skillId: 'review', enabled: true, pinRevision: 'skill-rev-1' }]
        }
      },
      lookup
    )
    expect(effective.skills).toEqual([])
    expect(effective.denied).toContainEqual(expect.objectContaining({ kind: 'skill', id: 'review' }))
  })

  it('keeps unmentioned profile MCP tools when one inherited tool is overridden', () => {
    const lookup = new StaticAgentIntegrationLookup({
      mcpTools: [
        { serverId: 'docs', toolName: 'read', available: true },
        { serverId: 'search', toolName: 'query', available: true }
      ]
    })
    const effective = resolveEffectiveGrants(
      {
        ...nativeSettings('inherit-mcp'),
        mcp: {
          mode: 'inherit',
          servers: [{ serverId: 'docs', enabled: true, tools: [{ toolName: 'read', enabled: false }] }]
        }
      },
      lookup
    )
    expect(effective.mcpTools.map((tool) => tool.id)).toEqual(['search/query'])
    expect(effective.denied).toContainEqual(expect.objectContaining({ kind: 'mcp', id: 'docs/read' }))
  })
})

describe('modes remain separate', () => {
  it('copies prompt text only when explicitly asked', () => {
    const copied = draftFromModePrompt({
      name: 'From mode',
      slug: 'from-mode',
      prompt: 'Mode prompt bytes',
      purpose: 'explicit copy'
    })
    expect(copied.systemPrompt).toBe('Mode prompt bytes')
    expect(readFileSync(new URL('../src/mms/agentDefinitions/index.ts', import.meta.url), 'utf8')).not.toContain(
      'ModeRegistry'
    )
  })
})
