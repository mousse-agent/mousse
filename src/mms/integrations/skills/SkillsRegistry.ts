import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import type {
  IntegrationDiagnostic,
  SkillDescriptor,
  SkillReadResult,
  SkillsRegistrySnapshot,
  SkillSource,
  SkillSourceDescriptor
} from '../../../shared/integrations'
import { getSkillRootPaths, type SkillRootPathDescriptor } from '../../data/paths'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from '../profileContext'
import { getManagedSkillRevisionRoot, getManagedSkillStatePath, getNativeSkillRoots, getProjectIdentity } from '../nativePaths'
import { sha256Bytes, shortHash } from '../revision'
import { splitSkillMarkdown } from './yamlFrontmatter'
import { assertOwnedPath } from '../../profiles/pathSafety'
import {
  booleanValue,
  recordValue,
  skillFrontmatterDiagnostics,
  stringArrayValue,
  stringValue
} from './skillValidation'

export interface SkillsDiscoveryOptions {
  projectPath?: string
  refresh?: boolean
  includeDisabled?: boolean
}

interface ScannedSource {
  skills: SkillDescriptor[]
  diagnostics: IntegrationDiagnostic[]
  fetchedAt: number
}

export class SkillsRegistry {
  /** One snapshot per project, most recently used last; expired entries are dropped. */
  private discoveryCache = new Map<string, { snapshot: SkillsRegistrySnapshot; fetchedAt: number }>()
  /** Shared (user-wide) Skills folders, scanned once for every project. */
  private sharedScans = new Map<string, ScannedSource>()
  /**
   * Shared scans still running. The first turns of threads started together each discover at once,
   * before any scan has finished; they wait for the same one instead of each walking the folders.
   */
  private sharedScanning = new Map<string, Promise<ScannedSource>>()
  /** Changes on invalidation, so a scan that started before it is not kept. */
  private sharedGeneration = 0
  private static readonly DISCOVERY_TTL_MS = 30_000
  static readonly MAX_DISCOVERY_ENTRIES = 16
  private readonly context: IntegrationRuntimeContext

  constructor(context?: IntegrationRuntimeContext) {
    this.context = context ?? createLegacySingleProfileContext()
  }

  invalidateDiscoveryCache(): void {
    this.discoveryCache.clear()
    this.sharedScans.clear()
    this.sharedScanning.clear()
    this.sharedGeneration++
  }

  async refresh(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    this.invalidateDiscoveryCache()
    return this.discover({ ...options, refresh: true })
  }

  async discover(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    const cacheKey = this.cacheKey(options.projectPath)
    this.dropExpired(Date.now())
    if (!options.refresh) {
      const cached = this.discoveryCache.get(cacheKey)
      if (cached) {
        this.discoveryCache.delete(cacheKey)
        this.discoveryCache.set(cacheKey, cached)
        return cached.snapshot
      }
    }

    const { snapshot, scannedAt } = await this.discoverUncached(options)
    this.discoveryCache.delete(cacheKey)
    // The snapshot is as old as the oldest scan in it, so it never outlives a shared scan it reused.
    this.discoveryCache.set(cacheKey, { snapshot, fetchedAt: scannedAt })
    while (this.discoveryCache.size > SkillsRegistry.MAX_DISCOVERY_ENTRIES) {
      const oldest = this.discoveryCache.keys().next().value
      if (oldest === undefined) break
      this.discoveryCache.delete(oldest)
    }
    return snapshot
  }

  private dropExpired(now: number): void {
    for (const [key, entry] of this.discoveryCache) {
      if (now - entry.fetchedAt >= SkillsRegistry.DISCOVERY_TTL_MS) this.discoveryCache.delete(key)
    }
    for (const [key, entry] of this.sharedScans) {
      if (now - entry.fetchedAt >= SkillsRegistry.DISCOVERY_TTL_MS) this.sharedScans.delete(key)
    }
  }

  private cacheKey(projectPath?: string): string {
    return `${this.context.profileId}:${projectPath ?? this.context.projectPath ?? ''}`
  }

  private async discoverUncached(
    options: SkillsDiscoveryOptions = {}
  ): Promise<{ snapshot: SkillsRegistrySnapshot; scannedAt: number }> {
    let scannedAt = Date.now()
    const projectPath = options.projectPath ?? this.context.projectPath
    const external = getSkillRootPaths(projectPath).map(
      (descriptor): SkillSourceDescriptor => ({
        ...descriptor,
        exists: existsSync(descriptor.path),
        managed: false,
        projectId: descriptor.scope === 'project' && projectPath ? getProjectIdentity(projectPath) : undefined
      })
    )
    const native = getNativeSkillRoots(this.context, projectPath).map(
      (descriptor): SkillSourceDescriptor => ({
        source: descriptor.source,
        scope: descriptor.scope,
        path: descriptor.path,
        exists: existsSync(descriptor.path),
        projectId: descriptor.projectId,
        profileId: descriptor.profileId,
        managed: descriptor.managed
      })
    )
    const sources = [...native, ...external]

    const skills: SkillDescriptor[] = []
    const diagnostics: IntegrationDiagnostic[] = []

    for (const source of sources) {
      if (!source.exists) continue
      if (source.scope === 'global') {
        // Shared folders read the same for every project; each snapshot gets its own copies,
        // because managed state and duplicate marking below change them per snapshot.
        const scanned = await this.scanSharedSource(source, options.refresh === true)
        scannedAt = Math.min(scannedAt, scanned.fetchedAt)
        skills.push(...scanned.skills.map((skill) => ({ ...skill })))
        diagnostics.push(...scanned.diagnostics)
        continue
      }
      const scanned = await this.scanSource(source)
      skills.push(...scanned.skills)
      diagnostics.push(...scanned.diagnostics)
    }

    this.applyManagedState(skills)
    const visible = options.includeDisabled === false
      ? skills.filter((skill) => skill.enabled !== false && skill.archived !== true)
      : skills.filter((skill) => skill.archived !== true)
    const sortedSkills = visible.sort(compareSkills)
    const duplicateDiagnostics = markDuplicateSkills(sortedSkills)

    return {
      snapshot: {
        sources,
        skills: sortedSkills,
        diagnostics: [...diagnostics, ...duplicateDiagnostics]
      },
      scannedAt
    }
  }

  private async scanSharedSource(source: SkillSourceDescriptor, refresh: boolean): Promise<ScannedSource> {
    const key = `${source.source}:${source.profileId ?? ''}:${source.path}`
    const cached = this.sharedScans.get(key)
    if (cached && !refresh && Date.now() - cached.fetchedAt < SkillsRegistry.DISCOVERY_TTL_MS) return cached
    const running = refresh ? undefined : this.sharedScanning.get(key)
    if (running) return running
    const generation = this.sharedGeneration
    const scan = this.scanSource(source).then((scanned) => {
      if (generation === this.sharedGeneration) this.sharedScans.set(key, scanned)
      return scanned
    })
    this.sharedScanning.set(key, scan)
    void scan.finally(() => {
      if (this.sharedScanning.get(key) === scan) this.sharedScanning.delete(key)
    }).catch(() => {})
    return scan
  }

  private async scanSource(source: SkillSourceDescriptor): Promise<ScannedSource> {
    const skills: SkillDescriptor[] = []
    const diagnostics: IntegrationDiagnostic[] = []
    try {
      const skillFiles = await findSkillFiles(source.path)
      // Read together: one wait for the folder's files, not one per file. Results keep the files' order.
      for (const parsed of await Promise.all(skillFiles.map((skillPath) => this.readSkillDescriptor(source, skillPath)))) {
        if (parsed.skill) skills.push(parsed.skill)
        diagnostics.push(...parsed.diagnostics)
      }
    } catch (err) {
      diagnostics.push({
        level: 'error',
        source: source.source,
        path: source.path,
        message: `Failed to scan Skills root: ${formatError(err)}`
      })
    }
    return { skills, diagnostics, fetchedAt: Date.now() }
  }

  async readSkill(
    skillId: string,
    options: SkillsDiscoveryOptions = {},
    snapshot?: SkillsRegistrySnapshot
  ): Promise<SkillReadResult> {
    if (options.refresh) this.invalidateDiscoveryCache()
    const resolved = snapshot ?? (await this.discover(options))
    const skill = resolved.skills.find(
      (entry) =>
        entry.id === skillId ||
        entry.installationId === skillId ||
        entry.name === skillId
    )
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`)
    }
    const pinned = await this.readPinnedRevision(skill, options)
    if (pinned) return pinned
    const content = await readFile(skill.skillPath, 'utf-8')
    const parsed = splitSkillMarkdown(content)
    return {
      skill,
      content,
      body: parsed.body,
      frontmatter: parsed.attributes
    }
  }

  async readSkillRevision(
    skillId: string,
    revision: string,
    options: SkillsDiscoveryOptions = {}
  ): Promise<SkillReadResult> {
    const snapshot = await this.discover(options)
    const skill = snapshot.skills.find(
      (entry) => entry.id === skillId || entry.installationId === skillId || entry.name === skillId
    )
    if (!skill) throw new Error(`Skill not found: ${skillId}`)
    const pinned = await this.readPinnedRevision({ ...skill, revision }, { ...options, pinRevision: revision })
    if (!pinned) throw new Error(`Skill revision not found: ${revision}`)
    return pinned
  }

  private async readPinnedRevision(
    skill: SkillDescriptor,
    options: SkillsDiscoveryOptions & { pinRevision?: string } = {}
  ): Promise<SkillReadResult | undefined> {
    const revision = options.pinRevision ?? skill.revision
    const installationId = skill.installationId
    if (!revision || !installationId) return undefined
    if (skill.contentHash === revision || !options.pinRevision) return undefined
    const revisionPath = assertOwnedPath(
      this.context.profileRoot,
      join(getManagedSkillRevisionRoot(this.context.profileRoot, installationId), revision, 'SKILL.md'),
      'skill revision'
    )
    if (!existsSync(revisionPath)) return undefined
    const content = await readFile(revisionPath, 'utf-8')
    const parsed = splitSkillMarkdown(content)
    return {
      skill: { ...skill, revision, skillPath: revisionPath, rootPath: dirname(revisionPath) },
      content,
      body: parsed.body,
      frontmatter: parsed.attributes
    }
  }

  private applyManagedState(skills: SkillDescriptor[]): void {
    const path = assertOwnedPath(
      this.context.profileRoot,
      getManagedSkillStatePath(this.context.profileRoot),
      'managed skill state'
    )
    if (!existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        installations?: Record<
          string,
          { enabled?: boolean; archived?: boolean; revision?: string; installationId?: string }
        >
      }
      const installations = parsed.installations ?? {}
      for (const skill of skills) {
        const state =
          (skill.installationId ? installations[skill.installationId] : undefined) ??
          installations[skill.id]
        if (!state) continue
        skill.enabled = state.enabled
        skill.archived = state.archived
        if (state.revision) skill.revision = state.revision
        if (state.installationId) skill.installationId = state.installationId
      }
    } catch {
      // Discovery still returns parsed packages if the state file is unreadable.
    }
  }

  /**
   * Parsed values are slices of the whole SKILL.md text, so keeping one keeps the file. The copy
   * holds fresh strings only, and the file text can be collected after parsing.
   */
  private async readSkillDescriptor(
    source: SkillSourceDescriptor,
    skillPath: string
  ): Promise<{ skill?: SkillDescriptor; diagnostics: IntegrationDiagnostic[] }> {
    return structuredClone(await this.parseSkillDescriptor(source, skillPath))
  }

  private async parseSkillDescriptor(
    source: SkillSourceDescriptor,
    skillPath: string
  ): Promise<{ skill?: SkillDescriptor; diagnostics: IntegrationDiagnostic[] }> {
    const diagnostics: IntegrationDiagnostic[] = []
    const content = await readFile(skillPath, 'utf-8')
    const frontmatter = splitSkillMarkdown(content)

    if (frontmatter.error) {
      diagnostics.push({
        level: 'warning',
        source: source.source,
        path: skillPath,
        message: frontmatter.error
      })
      return { diagnostics }
    }

    diagnostics.push(...skillFrontmatterDiagnostics(frontmatter.attributes, skillPath))
    const name = stringValue(frontmatter.attributes.name)
    const description = stringValue(frontmatter.attributes.description)
    if (!name || !description) {
      diagnostics.push({
        level: 'warning',
        source: source.source,
        path: skillPath,
        message: 'Skill frontmatter must include name and description.'
      })
      return { diagnostics }
    }

    const rootPath = dirname(skillPath)
    const relativeRoot = normalizePath(relative(source.path, rootPath))
    const id = `${source.source}:${relativeRoot || name}`
    const contentHash = sha256Bytes(content)
    const managed = source.managed === true || (source.managed === undefined && isNativeSkillSource(source.source))
    return {
      diagnostics,
      skill: {
        id,
        name,
        description,
        rootPath,
        skillPath,
        scope: source.scope,
        source: source.source,
        paths: stringArrayValue(frontmatter.attributes.paths),
        'disable-model-invocation': booleanValue(
          frontmatter.attributes['disable-model-invocation']
        ),
        metadata: recordValue(frontmatter.attributes.metadata),
        compatibility: compatibilityValue(frontmatter.attributes.compatibility),
        license: stringValue(frontmatter.attributes.license),
        allowedTools: stringValue(frontmatter.attributes['allowed-tools']),
        hasScripts: existsSync(join(rootPath, 'scripts')),
        hasAssets: existsSync(join(rootPath, 'assets')),
        hasReferences: existsSync(join(rootPath, 'references')),
        profileId: source.profileId ?? (managed ? this.context.profileId : undefined),
        projectId: source.projectId,
        managed,
        installationId: managed
          ? source.scope === 'project' && source.projectId ? `mousse-project:${source.projectId}:${name}` : id
          : `external-skill:${source.projectId ?? shortHash(source.path, 24)}:${source.source}:${relativeRoot || name}`,
        revision: contentHash,
        contentHash,
        executableAssets: listExecutableAssets(rootPath)
      }
    }
  }
}

async function findSkillFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true })
  // Subfolders are read together, one wait per level rather than per folder; results keep the entries' order.
  const found: Array<string[] | Promise<string[]>> = []

  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === '.' || entry.name === '..') continue
    const entryPath = join(rootPath, entry.name)
    try {
      if (lstatSync(entryPath).isSymbolicLink()) continue
    } catch {
      continue
    }
    if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push([entryPath])
      continue
    }
    if (entry.isDirectory()) {
      found.push(findSkillFiles(entryPath))
    }
  }

  return (await Promise.all(found)).flat()
}

function compatibilityValue(
  value: unknown
): string[] | Record<string, unknown> | string | undefined {
  if (typeof value === 'string') return value
  return stringArrayValue(value) ?? recordValue(value)
}

function isNativeSkillSource(source: SkillSource): boolean {
  return source === 'mousse-profile' || source === 'mousse-project' || source === 'generated-agent'
}

function listExecutableAssets(rootPath: string): string[] | undefined {
  const scriptsRoot = join(rootPath, 'scripts')
  if (!existsSync(scriptsRoot)) return undefined
  try {
    return collectFiles(scriptsRoot, scriptsRoot)
  } catch {
    return undefined
  }
}

function collectFiles(root: string, current: string): string[] {
  const entries = readdirSync(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const entryPath = join(current, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(root, entryPath))
    else if (entry.isFile()) files.push(normalizePath(relative(root, entryPath)))
  }
  return files
}

function compareSkills(a: SkillDescriptor, b: SkillDescriptor): number {
  return sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name)
}

function sourceRank(source: SkillSource): number {
  const ranks: Record<SkillSource, number> = {
    'mousse-project': 0,
    'mousse-profile': 1,
    'generated-agent': 2,
    'mousse-project-external': 3,
    'cursor-project': 4,
    'agents-project': 5,
    'claude-project': 6,
    'codex-project': 7,
    'opencode-project': 8,
    'cursor-global': 9,
    'agents-global': 10,
    'claude-global': 11,
    'codex-global': 12,
    'opencode-global': 13
  }
  return ranks[source]
}

function markDuplicateSkills(skills: SkillDescriptor[]): IntegrationDiagnostic[] {
  const seen = new Map<string, SkillDescriptor>()
  const diagnostics: IntegrationDiagnostic[] = []

  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    const existing = seen.get(key)
    if (existing) {
      skill.isActive = false
      skill.duplicateOf = existing.id
      diagnostics.push({
        level: 'info',
        source: skill.source,
        path: skill.skillPath,
        targetId: skill.id,
        message: `Skill name also appears in ${existing.source}; higher-precedence skill remains active.`
      })
      continue
    }
    skill.isActive = true
    seen.set(key, skill)
  }

  return diagnostics
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
