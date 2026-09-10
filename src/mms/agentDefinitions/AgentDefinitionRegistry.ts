import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync, atomicWriteJsonSync, durableExclusiveWriteSync } from '../data/AtomicFs'
import { AgentDefinitionError } from '../../shared/agents/errors'
import {
  AGENT_BUNDLE_FILES,
  AGENT_SYSTEM_PROMPT_FILE,
  type AgentDefinitionRecord,
  type AgentDefinitionSummary,
  type AgentExportBundle,
  type AgentImmutableRevision,
  type AgentLibraryFlags,
  type AgentPublishedRevision,
  type AgentRuntimeKind,
  type AgentVisualMetadata,
  type CreateAgentDefinitionInput,
  type SaveAgentDraftInput
} from '../../shared/agents/types'
import { defaultAgentSettings, defaultRuntimeKind } from '../../shared/agents/defaults'
import { computeDraftHash, computeSemanticHash, computeVisualHash } from '../../shared/agents/hashes'
import {
  assertSystemPrompt,
  createAgentDefinitionId,
  isAgentDefinitionId,
  isAgentRuntimeKind,
  mergeSettings,
  parseManifest,
  parseVisualMetadata,
  toManifest
} from '../../shared/agents/schema'
import { assertBundleSize, assertSafeBundlePath } from '../../shared/agents/pathSafety'
import { collectUnsupportedCliSettings } from '../../shared/agents/compatibility'
import { grantDependencyHashes, resolveEffectiveGrants } from '../../shared/agents/grants'
import type { AgentIntegrationLookup } from '../../shared/agents/types'
import { resolveWithinProfileRoot } from './pathSafety'

interface StoredMeta {
  profileId: string
  id: string
  runtimeKind: AgentRuntimeKind
  flags: AgentLibraryFlags
  draftHash: string
  semanticHash: string
  visualHash: string
  published?: AgentPublishedRevision
  createdAt: string
  updatedAt: string
}

export interface AgentDefinitionRegistryOptions {
  profileId: string
  /** Absolute profile root. Never derived from process.env.MOUSSE_HOME. */
  profileRoot: string
  now?: () => string
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export class AgentDefinitionRegistry {
  readonly profileId: string
  readonly profileRoot: string
  private readonly now: () => string
  private readonly agentsRoot: string

  constructor(options: AgentDefinitionRegistryOptions) {
    if (!options.profileId.trim()) {
      throw new AgentDefinitionError('PROFILE_MISMATCH', 'profileId is required.')
    }
    if (!options.profileRoot.trim()) {
      throw new AgentDefinitionError('INVALID_BUNDLE', 'profileRoot is required.')
    }
    this.profileId = options.profileId
    this.profileRoot = resolveWithinProfileRoot(options.profileRoot)
    this.now = options.now ?? (() => new Date().toISOString())
    this.agentsRoot = resolveWithinProfileRoot(this.profileRoot, 'agents')
    mkdirSync(this.agentsRoot, { recursive: true })
  }

  createDraft(input: CreateAgentDefinitionInput): AgentDefinitionRecord {
    const id = createAgentDefinitionId()
    const runtimeKind = input.runtimeKind && isAgentRuntimeKind(input.runtimeKind)
      ? input.runtimeKind
      : defaultRuntimeKind()
    const settings = mergeSettings(defaultAgentSettings(input.settings.identity), input.settings)
    this.assertUniqueSlug(settings.identity.slug)
    this.assertCliSettings(runtimeKind, settings)
    const systemPrompt = assertSystemPrompt(input.systemPrompt ?? '')
    const visual = parseVisualMetadata(input.visual)
    const flags: AgentLibraryFlags = {
      enabled: input.flags?.enabled ?? true,
      favorite: input.flags?.favorite ?? false,
      archived: false
    }
    const timestamp = this.now()
    const record = this.buildRecord({
      id,
      runtimeKind,
      settings,
      systemPrompt,
      visual,
      flags,
      published: undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    this.writeDraft(record)
    return record
  }

  list(filter: { archived?: boolean } = { archived: false }): AgentDefinitionSummary[] {
    const includeArchived = filter.archived === true
    const summaries: AgentDefinitionSummary[] = []
    if (!existsSync(this.agentsRoot)) return summaries
    for (const entry of readdirSync(this.agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isAgentDefinitionId(entry.name)) continue
      const record = this.readRecord(entry.name)
      if (!record) continue
      if (!includeArchived && record.flags.archived) continue
      if (filter.archived === false && record.flags.archived) continue
      summaries.push(this.toSummary(record))
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): AgentDefinitionRecord {
    const record = this.readRecord(id)
    if (!record) {
      throw new AgentDefinitionError('AGENT_NOT_FOUND', `Agent definition ${id} was not found.`, {
        details: { id, profileId: this.profileId }
      })
    }
    return record
  }

  getBySlug(slug: string): AgentDefinitionRecord | undefined {
    return this.list({ archived: true }).map((item) => this.get(item.id)).find((record) => record.settings.identity.slug === slug)
  }

  saveDraft(id: string, input: SaveAgentDraftInput): AgentDefinitionRecord {
    const current = this.get(id)
    if (current.flags.archived) {
      throw new AgentDefinitionError('AGENT_ARCHIVED', 'Archived definitions cannot be edited.', { details: { id } })
    }
    if (input.expectedDraftHash !== current.draftHash) {
      throw new AgentDefinitionError(
        'REVISION_CONFLICT',
        'Draft changed since it was loaded. Reload and retry.',
        {
          retryable: true,
          details: { expectedDraftHash: input.expectedDraftHash, actualDraftHash: current.draftHash }
        }
      )
    }
    const settings = mergeSettings(current.settings, input.settings)
    if (settings.identity.slug !== current.settings.identity.slug) {
      this.assertUniqueSlug(settings.identity.slug, id)
    }
    this.assertCliSettings(current.runtimeKind, settings)
    const systemPrompt = assertSystemPrompt(input.systemPrompt ?? current.systemPrompt)
    const visual = input.visual !== undefined ? parseVisualMetadata(input.visual) : current.visual
    const flags: AgentLibraryFlags = {
      ...current.flags,
      enabled: input.flags?.enabled ?? current.flags.enabled,
      favorite: input.flags?.favorite ?? current.flags.favorite
    }
    const record = this.buildRecord({
      id: current.id,
      runtimeKind: current.runtimeKind,
      settings,
      systemPrompt,
      visual,
      flags,
      published: current.published,
      createdAt: current.createdAt,
      updatedAt: this.now()
    })
    this.writeDraft(record)
    return record
  }

  publish(
    id: string,
    expectedDraftHash: string,
    options: { integrationLookup?: AgentIntegrationLookup } = {}
  ): AgentPublishedRevision {
    const current = this.get(id)
    if (current.flags.archived) {
      throw new AgentDefinitionError('AGENT_ARCHIVED', 'Archived definitions cannot be published.', { details: { id } })
    }
    if (expectedDraftHash !== current.draftHash) {
      throw new AgentDefinitionError(
        'REVISION_CONFLICT',
        'Draft changed since it was loaded. Reload and retry.',
        {
          retryable: true,
          details: { expectedDraftHash, actualDraftHash: current.draftHash }
        }
      )
    }
    this.assertCliSettings(current.runtimeKind, current.settings)
    const dependencyHashes = options.integrationLookup
      ? grantDependencyHashes(resolveEffectiveGrants(current.settings, options.integrationLookup))
      : {}
    const revisionDir = this.revisionDir(id, current.semanticHash)
    if (!existsSync(join(revisionDir, AGENT_BUNDLE_FILES.manifest))) {
      mkdirSync(revisionDir, { recursive: true })
      durableExclusiveWriteSync(
        join(revisionDir, AGENT_BUNDLE_FILES.manifest),
        `${JSON.stringify(toManifest(current), null, 2)}\n`
      )
      durableExclusiveWriteSync(join(revisionDir, AGENT_BUNDLE_FILES.systemPrompt), current.systemPrompt)
      durableExclusiveWriteSync(
        join(revisionDir, AGENT_BUNDLE_FILES.visual),
        `${JSON.stringify(current.visual, null, 2)}\n`
      )
      durableExclusiveWriteSync(
        join(revisionDir, 'lock.json'),
        `${JSON.stringify({ semanticHash: current.semanticHash, visualHash: current.visualHash, dependencyHashes }, null, 2)}\n`
      )
    }
    const published: AgentPublishedRevision = {
      revision: current.semanticHash,
      visualRevision: current.visualHash,
      publishedAt: this.now(),
      dependencyHashes
    }
    const record = this.buildRecord({
      ...current,
      published,
      updatedAt: published.publishedAt
    })
    this.writeDraft(record)
    return published
  }

  getRevision(id: string, revision: string): AgentImmutableRevision {
    const meta = this.readMeta(id)
    if (!meta) {
      throw new AgentDefinitionError('AGENT_NOT_FOUND', `Agent definition ${id} was not found.`, { details: { id } })
    }
    const revisionDir = this.revisionDir(id, revision)
    const manifestPath = join(revisionDir, AGENT_BUNDLE_FILES.manifest)
    if (!existsSync(manifestPath)) {
      throw new AgentDefinitionError('REVISION_NOT_FOUND', `Revision ${revision} was not found.`, {
        details: { id, revision }
      })
    }
    const manifest = parseManifest(readJsonFile(manifestPath))
    const systemPrompt = readFileSync(join(revisionDir, AGENT_BUNDLE_FILES.systemPrompt), 'utf8')
    const visual = existsSync(join(revisionDir, AGENT_BUNDLE_FILES.visual))
      ? parseVisualMetadata(readJsonFile(join(revisionDir, AGENT_BUNDLE_FILES.visual)))
      : {}
    const lock = existsSync(join(revisionDir, 'lock.json'))
      ? readJsonFile<{ visualHash?: string; dependencyHashes?: Record<string, string> }>(join(revisionDir, 'lock.json'))
      : {}
    return {
      definitionId: id,
      profileId: this.profileId,
      runtimeKind: manifest.runtimeKind,
      revision,
      visualRevision: lock.visualHash ?? computeVisualHash(visual),
      settings: manifest.settings,
      systemPrompt,
      visual,
      dependencyHashes: lock.dependencyHashes ?? {},
      publishedAt: meta.published?.publishedAt ?? meta.updatedAt
    }
  }

  duplicate(id: string): AgentDefinitionRecord {
    const source = this.get(id)
    const slug = this.allocateSlug(`${source.settings.identity.slug}-copy`)
    return this.createDraft({
      runtimeKind: source.runtimeKind,
      settings: {
        ...source.settings,
        identity: {
          ...source.settings.identity,
          name: `${source.settings.identity.name} copy`,
          slug
        }
      },
      systemPrompt: source.systemPrompt,
      visual: source.visual,
      flags: { enabled: source.flags.enabled, favorite: false }
    })
  }

  archive(id: string): AgentDefinitionRecord {
    const current = this.get(id)
    if (current.flags.archived) return current
    const record = this.buildRecord({
      ...current,
      flags: { ...current.flags, archived: true, enabled: false },
      updatedAt: this.now()
    })
    this.writeDraft(record)
    return record
  }

  exportBundle(id: string, revision?: string): AgentExportBundle {
    if (revision) {
      const pinned = this.getRevision(id, revision)
      return {
        format: 'mousse-agent',
        formatVersion: 1,
        manifest: toManifest({ id: pinned.definitionId, runtimeKind: pinned.runtimeKind, settings: pinned.settings }),
        files: { [AGENT_SYSTEM_PROMPT_FILE]: pinned.systemPrompt },
        visual: pinned.visual,
        publishedRevision: {
          revision: pinned.revision,
          visualRevision: pinned.visualRevision,
          publishedAt: pinned.publishedAt,
          dependencyHashes: pinned.dependencyHashes
        }
      }
    }
    const current = this.get(id)
    return {
      format: 'mousse-agent',
      formatVersion: 1,
      manifest: toManifest(current),
      files: { [AGENT_SYSTEM_PROMPT_FILE]: current.systemPrompt },
      visual: current.visual,
      publishedRevision: current.published
    }
  }

  importBundle(
    bundle: AgentExportBundle,
    options: { conflict?: 'fail' | 'rename'; retainId?: boolean } = {}
  ): AgentDefinitionRecord {
    if (bundle.format !== 'mousse-agent' || bundle.formatVersion !== 1) {
      throw new AgentDefinitionError('INVALID_BUNDLE', 'Unsupported agent export format.')
    }
    assertBundleSize(bundle.files)
    const manifest = parseManifest(bundle.manifest)
    const promptPath = assertSafeBundlePath(
      manifest.settings.instructions.systemPromptFile || AGENT_SYSTEM_PROMPT_FILE
    )
    const systemPrompt = assertSystemPrompt(bundle.files[promptPath] ?? bundle.files[AGENT_SYSTEM_PROMPT_FILE] ?? '')
    const visual = parseVisualMetadata(bundle.visual)
    const conflict = options.conflict ?? 'fail'
    let identity = manifest.settings.identity
    const existing = this.getBySlug(identity.slug)
    if (existing) {
      if (conflict === 'fail') {
        throw new AgentDefinitionError('SLUG_CONFLICT', `Slug "${identity.slug}" already exists in this profile.`, {
          details: { slug: identity.slug }
        })
      }
      identity = { ...identity, slug: this.allocateSlug(`${identity.slug}-imported`) }
    }
    return this.createDraft({
      runtimeKind: manifest.runtimeKind,
      settings: { ...manifest.settings, identity },
      systemPrompt,
      visual
    })
  }

  private assertCliSettings(runtimeKind: AgentRuntimeKind, settings: AgentDefinitionRecord['settings']): void {
    const unsupported = collectUnsupportedCliSettings(runtimeKind, settings)
    if (unsupported.length === 0) return
    throw new AgentDefinitionError(
      'SETTINGS_UNSUPPORTED',
      `Runtime ${runtimeKind} does not support ${unsupported.join(', ')}.`,
      { details: { runtimeKind, pointers: unsupported } }
    )
  }

  private assertUniqueSlug(slug: string, exceptId?: string): void {
    const existing = this.list({ archived: true }).find((item) => item.slug === slug && item.id !== exceptId)
    if (existing) {
      throw new AgentDefinitionError('SLUG_CONFLICT', `Slug "${slug}" already exists in this profile.`, {
        details: { slug, existingId: existing.id }
      })
    }
  }

  private allocateSlug(base: string): string {
    let candidate = base.slice(0, 64)
    let suffix = 2
    while (this.list({ archived: true }).some((item) => item.slug === candidate)) {
      const next = `${base.slice(0, Math.max(1, 64 - (`-${suffix}`).length))}-${suffix}`
      candidate = next
      suffix += 1
    }
    return candidate
  }

  private definitionDir(id: string): string {
    if (!isAgentDefinitionId(id)) {
      throw new AgentDefinitionError('INVALID_BUNDLE', 'Agent definition id must be a UUID.', { details: { id } })
    }
    return resolveWithinProfileRoot(this.agentsRoot, id)
  }

  private draftDir(id: string): string {
    return resolveWithinProfileRoot(this.definitionDir(id), 'draft')
  }

  private revisionDir(id: string, revision: string): string {
    if (!/^[a-f0-9]{64}$/i.test(revision)) {
      throw new AgentDefinitionError('REVISION_NOT_FOUND', 'Revision hash is not a SHA-256 hex digest.', {
        details: { revision }
      })
    }
    return resolveWithinProfileRoot(this.definitionDir(id), 'revisions', revision.toLowerCase())
  }

  private buildRecord(input: {
    id: string
    runtimeKind: AgentRuntimeKind
    settings: AgentDefinitionRecord['settings']
    systemPrompt: string
    visual: AgentVisualMetadata
    flags: AgentLibraryFlags
    published?: AgentPublishedRevision
    createdAt: string
    updatedAt: string
  }): AgentDefinitionRecord {
    const semanticHash = computeSemanticHash({
      id: input.id,
      runtimeKind: input.runtimeKind,
      settings: input.settings,
      systemPrompt: input.systemPrompt
    })
    const visualHash = computeVisualHash(input.visual)
    const draftHash = computeDraftHash({
      id: input.id,
      runtimeKind: input.runtimeKind,
      settings: input.settings,
      systemPrompt: input.systemPrompt,
      visual: input.visual,
      flags: input.flags
    })
    return {
      profileId: this.profileId,
      id: input.id,
      runtimeKind: input.runtimeKind,
      settings: input.settings,
      systemPrompt: input.systemPrompt,
      visual: input.visual,
      flags: input.flags,
      draftHash,
      semanticHash,
      visualHash,
      published: input.published,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    }
  }

  private writeDraft(record: AgentDefinitionRecord): void {
    const draftDir = this.draftDir(record.id)
    mkdirSync(draftDir, { recursive: true })
    atomicWriteJsonSync(join(draftDir, AGENT_BUNDLE_FILES.manifest), toManifest(record))
    atomicWriteFileSync(join(draftDir, AGENT_BUNDLE_FILES.systemPrompt), record.systemPrompt)
    atomicWriteJsonSync(join(draftDir, AGENT_BUNDLE_FILES.visual), record.visual)
    const meta: StoredMeta = {
      profileId: this.profileId,
      id: record.id,
      runtimeKind: record.runtimeKind,
      flags: record.flags,
      draftHash: record.draftHash,
      semanticHash: record.semanticHash,
      visualHash: record.visualHash,
      published: record.published,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }
    atomicWriteJsonSync(join(this.definitionDir(record.id), 'meta.json'), meta)
  }

  private readMeta(id: string): StoredMeta | undefined {
    const path = join(this.definitionDir(id), 'meta.json')
    if (!existsSync(path)) return undefined
    const meta = readJsonFile<StoredMeta>(path)
    if (meta.profileId !== this.profileId) {
      throw new AgentDefinitionError('PROFILE_MISMATCH', 'Definition does not belong to this profile.', {
        details: { id, profileId: this.profileId, storedProfileId: meta.profileId }
      })
    }
    return meta
  }

  private readRecord(id: string): AgentDefinitionRecord | undefined {
    const meta = this.readMeta(id)
    if (!meta) return undefined
    const draftDir = this.draftDir(id)
    const manifest = parseManifest(readJsonFile(join(draftDir, AGENT_BUNDLE_FILES.manifest)))
    const systemPrompt = readFileSync(join(draftDir, AGENT_BUNDLE_FILES.systemPrompt), 'utf8')
    const visual = existsSync(join(draftDir, AGENT_BUNDLE_FILES.visual))
      ? parseVisualMetadata(readJsonFile(join(draftDir, AGENT_BUNDLE_FILES.visual)))
      : {}
    return {
      profileId: this.profileId,
      id: manifest.id,
      runtimeKind: manifest.runtimeKind,
      settings: manifest.settings,
      systemPrompt,
      visual,
      flags: meta.flags,
      draftHash: meta.draftHash,
      semanticHash: meta.semanticHash,
      visualHash: meta.visualHash,
      published: meta.published,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    }
  }

  private toSummary(record: AgentDefinitionRecord): AgentDefinitionSummary {
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
      updatedAt: record.updatedAt
    }
  }
}

/** Test helper: remove a profile-root agents tree. Not used in production paths. */
export function removeAgentDefinitionsRoot(profileRoot: string): void {
  const root = resolveWithinProfileRoot(profileRoot, 'agents')
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
