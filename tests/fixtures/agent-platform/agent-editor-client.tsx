import { AgentDefinitionError } from '../../../src/shared/agents/errors'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import type {
  AgentDefinitionRecord,
  AgentDefinitionSettings,
  AgentExportBundle,
  AgentLibraryFlags,
  AgentRuntimeKind
} from '../../../src/shared/agents/types'
import type {
  AgentDefinitionsClient,
  AgentLibraryItem,
  AgentTryRunResult
} from '../../../src/renderer/components/agentDefinitions/client'

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown): string {
  const json = stableStringify(value)
  let h = 2166136261
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + json.length.toString(16)
}

function newId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return '00000000-0000-4000-8000-000000000000'.replace(/0/g, () => Math.floor(Math.random() * 16).toString(16))
}

function withHashes(
  record: Omit<AgentDefinitionRecord, 'draftHash' | 'semanticHash' | 'visualHash'>
): AgentDefinitionRecord {
  const semanticHash = hash({
    id: record.id,
    runtimeKind: record.runtimeKind,
    settings: record.settings,
    systemPrompt: record.systemPrompt
  })
  const visualHash = hash(record.visual ?? {})
  const draftHash = hash({
    semanticHash,
    visualHash,
    flags: record.flags,
    systemPrompt: record.systemPrompt
  })
  return { ...record, semanticHash, visualHash, draftHash }
}

function toListItem(record: AgentDefinitionRecord): AgentLibraryItem {
  const ref = record.settings.primaryModel.ref
  return {
    profileId: record.profileId,
    id: record.id,
    runtimeKind: record.runtimeKind,
    name: record.settings.identity.name,
    slug: record.settings.identity.slug,
    purpose: record.settings.identity.purpose,
    tags: record.settings.identity.tags,
    enabled: record.flags.enabled,
    favorite: record.flags.favorite,
    archived: record.flags.archived,
    draftHash: record.draftHash,
    semanticHash: record.semanticHash,
    visualHash: record.visualHash,
    publishedRevision: record.published?.revision,
    updatedAt: record.updatedAt,
    model: ref.modelId ? ref : undefined,
    modelLabel: ref.modelId ? `${ref.providerId}/${ref.modelId}` : undefined,
    visual: record.visual,
    issues:
      !ref.providerId || !ref.modelId
        ? [
            {
              code: 'MODEL_CAPABILITY_MISSING',
              message: 'Choose a model before publishing or running.',
              retryable: false
            }
          ]
        : []
  }
}

function mergeSettings(
  identity: AgentDefinitionSettings['identity'],
  patch?: Partial<AgentDefinitionSettings>
): AgentDefinitionSettings {
  const base = defaultAgentSettings(identity)
  if (!patch) return base
  return {
    ...base,
    ...patch,
    identity: { ...base.identity, ...patch.identity },
    primaryModel: {
      ...base.primaryModel,
      ...patch.primaryModel,
      ref: patch.primaryModel?.ref ?? base.primaryModel.ref,
      capabilityOverrides: patch.primaryModel?.capabilityOverrides ?? base.primaryModel.capabilityOverrides
    },
    fallbacks: { ...base.fallbacks, ...patch.fallbacks },
    output: { ...base.output, ...patch.output },
    context: { ...base.context, ...patch.context },
    memory: { ...base.memory, ...patch.memory },
    skills: { ...base.skills, ...patch.skills },
    mcp: { ...base.mcp, ...patch.mcp },
    tools: { ...base.tools, ...patch.tools },
    browser: { ...base.browser, ...patch.browser },
    delegation: { ...base.delegation, ...patch.delegation },
    workspace: { ...base.workspace, ...patch.workspace },
    script: { ...base.script, ...patch.script },
    approval: { ...base.approval, ...patch.approval },
    limits: { ...base.limits, ...patch.limits },
    recovery: { ...base.recovery, ...patch.recovery },
    examples: patch.examples ?? base.examples
  }
}

/**
 * Explicitly fake isolated client for tests and the Electron fixture.
 * Not a production adapter. Production UI receives a host-bound port.
 */
export class IsolatedAgentDefinitionsClient implements AgentDefinitionsClient {
  private readonly records = new Map<string, AgentDefinitionRecord>()
  private delayMs = 0
  now = () => new Date().toISOString()

  setNetworkDelay(ms: number): void {
    this.delayMs = ms
  }

  private key(profileId: string, id: string): string {
    return `${profileId}:${id}`
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
  }

  seed(record: AgentDefinitionRecord): void {
    this.records.set(this.key(record.profileId, record.id), record)
  }

  async list(query: { profileId: string; archived?: boolean }): Promise<AgentLibraryItem[]> {
    await this.wait()
    return [...this.records.values()]
      .filter((record) => record.profileId === query.profileId)
      .filter((record) => (query.archived ? true : !record.flags.archived))
      .map(toListItem)
  }

  async get(query: { profileId: string; id: string }): Promise<AgentDefinitionRecord> {
    await this.wait()
    const record = this.records.get(this.key(query.profileId, query.id))
    if (!record || record.profileId !== query.profileId) {
      throw new AgentDefinitionError('AGENT_NOT_FOUND', `Agent ${query.id} was not found.`)
    }
    return structuredClone(record)
  }

  async create(query: Parameters<AgentDefinitionsClient['create']>[0]): Promise<AgentDefinitionRecord> {
    await this.wait()
    const id = newId()
    const settings = mergeSettings(query.settings.identity, query.settings)
    const flags: AgentLibraryFlags = {
      enabled: query.flags?.enabled ?? true,
      favorite: query.flags?.favorite ?? false,
      archived: false
    }
    const record = withHashes({
      profileId: query.profileId,
      id,
      runtimeKind: (query.runtimeKind ?? 'mousse') as AgentRuntimeKind,
      settings,
      systemPrompt: query.systemPrompt ?? '',
      visual: query.visual ?? {},
      flags,
      createdAt: this.now(),
      updatedAt: this.now()
    })
    this.records.set(this.key(query.profileId, id), record)
    return structuredClone(record)
  }

  async saveDraft(query: Parameters<AgentDefinitionsClient['saveDraft']>[0]): Promise<AgentDefinitionRecord> {
    await this.wait()
    const current = await this.get({ profileId: query.profileId, id: query.id })
    if (query.expectedDraftHash !== current.draftHash) {
      throw new AgentDefinitionError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', {
        retryable: true,
        details: { expectedDraftHash: query.expectedDraftHash, actualDraftHash: current.draftHash }
      })
    }
    const settings = query.settings ? mergeSettings(current.settings.identity, { ...current.settings, ...query.settings }) : current.settings
    const record = withHashes({
      ...current,
      runtimeKind: query.runtimeKind ?? current.runtimeKind,
      settings,
      systemPrompt: query.systemPrompt ?? current.systemPrompt,
      visual: query.visual ?? current.visual,
      flags: {
        ...current.flags,
        enabled: query.flags?.enabled ?? current.flags.enabled,
        favorite: query.flags?.favorite ?? current.flags.favorite
      },
      updatedAt: this.now()
    })
    this.records.set(this.key(query.profileId, query.id), record)
    return structuredClone(record)
  }

  async publish(query: { profileId: string; id: string; expectedDraftHash: string }) {
    await this.wait()
    const current = await this.get({ profileId: query.profileId, id: query.id })
    if (query.expectedDraftHash !== current.draftHash) {
      throw new AgentDefinitionError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', {
        retryable: true
      })
    }
    const ref = current.settings.primaryModel.ref
    if (!ref.providerId || !ref.modelId) {
      throw new AgentDefinitionError('MODEL_CAPABILITY_MISSING', 'Choose a model before publishing.')
    }
    current.published = {
      revision: current.semanticHash,
      visualRevision: current.visualHash,
      publishedAt: this.now(),
      dependencyHashes: {}
    }
    current.updatedAt = this.now()
    this.records.set(this.key(query.profileId, query.id), current)
    return current.published
  }

  async archive(query: { profileId: string; id: string }) {
    await this.wait()
    const current = await this.get(query)
    const record = withHashes({
      ...current,
      flags: { ...current.flags, archived: true, enabled: false },
      updatedAt: this.now()
    })
    this.records.set(this.key(query.profileId, query.id), record)
    return structuredClone(record)
  }

  async duplicate(query: { profileId: string; id: string }) {
    const source = await this.get(query)
    return this.create({
      profileId: query.profileId,
      runtimeKind: source.runtimeKind,
      settings: {
        ...source.settings,
        identity: {
          ...source.settings.identity,
          name: `${source.settings.identity.name} copy`,
          slug: `${source.settings.identity.slug}-copy`
        }
      },
      systemPrompt: source.systemPrompt,
      visual: source.visual
    })
  }

  async importBundle(query: { profileId: string; bundle: AgentExportBundle; conflict?: 'fail' | 'rename' }) {
    const identity = query.bundle.manifest.settings.identity
    return this.create({
      profileId: query.profileId,
      runtimeKind: query.bundle.manifest.runtimeKind,
      settings: { ...query.bundle.manifest.settings, identity },
      systemPrompt: query.bundle.files['system.md'] ?? '',
      visual: query.bundle.visual
    })
  }

  async exportBundle(query: { profileId: string; id: string; revision?: string }): Promise<AgentExportBundle> {
    const current = await this.get(query)
    return {
      format: 'mousse-agent',
      formatVersion: 1,
      manifest: {
        schemaVersion: 1,
        id: current.id,
        runtimeKind: current.runtimeKind,
        settings: current.settings
      },
      files: { 'system.md': current.systemPrompt },
      visual: current.visual,
      publishedRevision: current.published
    }
  }

  async validate(query: { profileId: string; id?: string }) {
    if (!query.id) return { issues: [] }
    const item = toListItem(await this.get({ profileId: query.profileId, id: query.id }))
    return { issues: item.issues ?? [] }
  }

  async tryRun(query: { profileId: string; id: string; prompt: string }): Promise<AgentTryRunResult> {
    await this.wait()
    const current = await this.get({ profileId: query.profileId, id: query.id })
    const ref = current.settings.primaryModel.ref
    if (!ref.modelId) {
      return {
        ok: false,
        status: 'blocked',
        summary: 'Choose a model before running.',
        trace: [{ at: this.now(), message: 'tryRun blocked: missing model' }],
        issues: [{ code: 'MODEL_CAPABILITY_MISSING', message: 'Choose a model before running.', retryable: false }]
      }
    }
    return {
      ok: false,
      status: 'blocked',
      summary: 'Isolated test client does not execute a model. Root must bind the production runner.',
      trace: [
        { at: this.now(), message: `tryRun received prompt (${query.prompt.length} chars)` },
        { at: this.now(), message: 'No production executor is attached to this isolated client.' }
      ]
    }
  }
}
