import { lstat, readdir, readFile, stat } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import type { EffectiveAgentGrantEntry } from '../../../shared/agents/types'
import type {
  IntegrationDiagnostic,
  SkillDescriptor,
  SkillReadResult,
  SkillsRegistrySnapshot,
  SkillSource,
  SkillSourceDescriptor
} from '../../../shared/integrations'
import { ProfilePathError } from '../../../shared/profiles/errors'
import { getSkillRootPaths } from '../../data/paths'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from '../profileContext'
import { getManagedSkillRevisionRoot, getManagedSkillStatePath, getNativeSkillRootCandidates, getProjectIdentityAsync } from '../nativePaths'
import { sha256Bytes, shortHash } from '../revision'
import { importSkillPath, skillPackageRevision } from './skillImport'
import { splitSkillMarkdown } from './yamlFrontmatter'
import { assertOwnedPathAsync } from '../../profiles/pathSafety'
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
  /**
   * The last snapshot may answer once it is past its time: it is returned at once and the folders are scanned again in
   * the background, for the next caller. A change Mousse made itself (`invalidateDiscoveryCache`) is never answered
   * from it.
   */
  stale?: boolean
}

interface ScannedSource {
  skills: SkillDescriptor[]
  diagnostics: IntegrationDiagnostic[]
  fetchedAt: number
}

type ManagedSkillState = {
  enabled?: boolean
  archived?: boolean
  revision?: string
  contentHash?: string
  installationId?: string
  provenance?: string
}

export class SkillsRegistry {
  /** One snapshot per project, most recently used last; expired entries are dropped. */
  private discoveryCache = new Map<string, { snapshot: SkillsRegistrySnapshot; fetchedAt: number }>()
  /** Shared (user-wide) Skills folders, scanned once for every project. */
  private sharedScans = new Map<string, ScannedSource>()
  /**
   * Shared scans still running. Foreground callers share a scan, but can start one while a background refresh is held.
   */
  private sharedScanning = new Map<string, { scan: Promise<ScannedSource>; background: boolean }>()
  /** Changes on invalidation, so a scan that started before it is not kept. */
  private sharedGeneration = 0
  private sharedScanOrder = 0
  private latestSharedScan = new Map<string, number>()
  /** Per project, the last snapshot scanned, kept past its time for a `stale` caller; most recently used last. */
  private lastSnapshots = new Map<string, SkillsRegistrySnapshot>()
  /** Background scans of a project for a `stale` caller that got the last snapshot. */
  private revalidating = new Map<string, Promise<unknown>>()
  /** Per project, the number of the newest scan started, and of the newest one published: an older scan never replaces a newer one. */
  private scansStarted = new Map<string, number>()
  private scansPublished = new Map<string, number>()
  private static readonly DISCOVERY_TTL_MS = 30_000
  static readonly MAX_DISCOVERY_ENTRIES = 16
  private readonly context: IntegrationRuntimeContext

  constructor(context?: IntegrationRuntimeContext) {
    this.context = context ?? createLegacySingleProfileContext()
  }

  invalidateDiscoveryCache(): void {
    this.discoveryCache.clear()
    this.lastSnapshots.clear()
    this.sharedScans.clear()
    this.sharedScanning.clear()
    this.latestSharedScan.clear()
    this.revalidating.clear()
    this.sharedGeneration++
  }

  async refresh(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    this.invalidateDiscoveryCache()
    return this.discover({ ...options, refresh: true })
  }

  discover(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    return this.discoverForProject(options, false)
  }

  private async discoverForProject(options: SkillsDiscoveryOptions, background: boolean): Promise<SkillsRegistrySnapshot> {
    const cacheKey = this.cacheKey(options.projectPath)
    this.dropExpired(Date.now())
    if (!options.refresh) {
      const cached = this.discoveryCache.get(cacheKey)
      if (cached) {
        this.discoveryCache.delete(cacheKey)
        this.discoveryCache.set(cacheKey, cached)
        return cached.snapshot
      }
      const last = options.stale ? this.lastSnapshots.get(cacheKey) : undefined
      if (last) {
        if (!this.revalidating.has(cacheKey)) {
          const scan = this.discoverForProject({ ...options, stale: false }, true).catch(() => undefined).finally(() => {
            if (this.revalidating.get(cacheKey) === scan) this.revalidating.delete(cacheKey)
          })
          this.revalidating.set(cacheKey, scan)
        }
        return last
      }
    }

    const generation = this.sharedGeneration
    const scan = (this.scansStarted.get(cacheKey) ?? 0) + 1
    this.scansStarted.set(cacheKey, scan)
    const result = await this.discoverUncached(options, generation, background)
    // Invalidation revokes the snapshot even for the caller already waiting for it.
    if (!result || generation !== this.sharedGeneration) {
      return this.discoverForProject({ ...options, refresh: false, stale: false }, background)
    }
    const { snapshot, scannedAt } = result
    if (scan < (this.scansPublished.get(cacheKey) ?? 0)) return snapshot
    this.scansPublished.set(cacheKey, scan)
    this.lastSnapshots.delete(cacheKey)
    this.lastSnapshots.set(cacheKey, snapshot)
    while (this.lastSnapshots.size > SkillsRegistry.MAX_DISCOVERY_ENTRIES) this.lastSnapshots.delete(this.lastSnapshots.keys().next().value!)
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
    options: SkillsDiscoveryOptions,
    generation: number,
    background: boolean
  ): Promise<{ snapshot: SkillsRegistrySnapshot; scannedAt: number } | undefined> {
    let scannedAt = Date.now()
    const projectPath = options.projectPath ?? this.context.projectPath
    const projectId = projectPath ? await scanSlot(() => getProjectIdentityAsync(projectPath)) : undefined
    const native = getNativeSkillRootCandidates(this.context, projectPath, projectId).map(
      ({ owner, label, ...descriptor }) => scanSlot(async (): Promise<SkillSourceDescriptor> => {
        const path = await assertOwnedPathAsync(owner, descriptor.path, label)
        return { ...descriptor, path, exists: await pathExists(path) }
      })
    )
    const external = getSkillRootPaths(projectPath).map(
      (descriptor) => scanSlot(async (): Promise<SkillSourceDescriptor> => ({
        ...descriptor,
        exists: await pathExists(descriptor.path),
        managed: false,
        projectId: descriptor.scope === 'project' ? projectId : undefined
      }))
    )
    const sources = await Promise.all([...native, ...external])

    const skills: SkillDescriptor[] = []
    const diagnostics: IntegrationDiagnostic[] = []

    for (const source of sources) {
      if (generation !== this.sharedGeneration) return undefined
      if (!source.exists) continue
      if (source.scope === 'global') {
        // Shared folders read the same for every project; each snapshot gets its own copies,
        // because managed state and duplicate marking below change them per snapshot.
        const scanned = await this.scanSharedSource(source, options.refresh === true, generation, background)
        scannedAt = Math.min(scannedAt, scanned.fetchedAt)
        skills.push(...scanned.skills.map((skill) => ({ ...skill })))
        diagnostics.push(...scanned.diagnostics)
        continue
      }
      const scanned = await this.scanSource(source)
      skills.push(...scanned.skills)
      diagnostics.push(...scanned.diagnostics)
    }

    if (generation !== this.sharedGeneration) return undefined
    await scanSlot(() => this.applyManagedState(skills))
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

  private async scanSharedSource(source: SkillSourceDescriptor, refresh: boolean, generation: number, background: boolean): Promise<ScannedSource> {
    const key = `${source.source}:${source.profileId ?? ''}:${source.path}`
    const cached = this.sharedScans.get(key)
    if (cached && !refresh && Date.now() - cached.fetchedAt < SkillsRegistry.DISCOVERY_TTL_MS) return cached
    const running = refresh ? undefined : this.sharedScanning.get(key)
    if (running && (background || !running.background)) return running.scan
    const order = ++this.sharedScanOrder
    this.latestSharedScan.set(key, order)
    const scan = this.scanSource(source).then((scanned) => {
      if (generation !== this.sharedGeneration) return scanned
      // A newer foreground scan can overtake a shared scan started by a different project.
      if (order !== this.latestSharedScan.get(key)) {
        const newer = this.sharedScanning.get(key)
        if (newer && (background || !newer.background)) return newer.scan
        return this.sharedScans.get(key) ?? scanned
      }
      this.sharedScans.set(key, scanned)
      return scanned
    })
    this.sharedScanning.set(key, { scan, background })
    void scan.finally(() => {
      if (this.sharedScanning.get(key)?.scan === scan) this.sharedScanning.delete(key)
    }).catch(() => {})
    return scan
  }

  private async scanSource(source: SkillSourceDescriptor): Promise<ScannedSource> {
    const skills: SkillDescriptor[] = []
    const diagnostics: IntegrationDiagnostic[] = []
    try {
      const skillFiles = await findSkillFiles(source.path)
      // Read together, up to `SKILL_SCAN_CONCURRENCY` at a time. Results keep the files' order.
      for (const parsed of await Promise.all(skillFiles.map((skillPath) => scanSlot(() => this.readSkillDescriptor(source, skillPath))))) {
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
    return this.readSkillFile(skill)
  }

  /** The turn's descriptor identifies the file. The file and its installation decide whether it may still be used. */
  async readSkillForModel(skill: SkillDescriptor, grant?: EffectiveAgentGrantEntry): Promise<SkillReadResult> {
    const skillPath = skill.managed
      ? await assertOwnedPathAsync(this.context.profileRoot, skill.skillPath, 'managed skill file')
      : skill.skillPath
    const bytes = await readFile(skillPath)
    const result = this.parseSkillFile({ ...skill, skillPath }, bytes.toString('utf-8'))
    const diagnostics = skillFrontmatterDiagnostics(result.frontmatter ?? {})
    if (diagnostics.length) throw new Error(diagnostics.map((item) => item.message).join('; '))
    const state = skill.managed ? managedStateFor(await this.readManagedState(), skill) : undefined
    // Loose packages can be discovered without a state entry. An installation that had an entry must still have one.
    if (skill.managed && (state ? state.enabled !== true || state.archived : skill.enabled !== undefined)) {
      throw new Error(`Skill installation is no longer available: ${skill.installationId ?? skill.id}`)
    }
    if (grant) await this.checkSkillGrant(result.skill, grant, sha256Bytes(bytes), state)
    return result
  }

  private async checkSkillGrant(skill: SkillDescriptor, grant: EffectiveAgentGrantEntry, hash: string, state?: ManagedSkillState): Promise<void> {
    if (grant.revision && grant.revision !== (state?.revision ?? skill.revision)) {
      throw new Error(`Granted skill revision is unavailable: ${grant.id}@${grant.revision}.`)
    }
    if ((!grant.hash || grant.hash === hash) && await this.matchesSkillContent(skill, hash, state)) return
    throw new Error(`Granted skill changed after agent resolution: ${grant.id}.`)
  }

  private async matchesSkillContent(skill: SkillDescriptor, hash: string, state?: ManagedSkillState): Promise<boolean> {
    const expected = state?.contentHash ?? skill.contentHash
    if (expected === hash) return true
    // Older imports stored the package revision as the file hash. Verify the package and the exact file we read.
    if (!state?.contentHash || state.contentHash !== state.revision || !['folder', 'zip'].includes(state.provenance ?? '')) return false
    const installed = await importSkillPath(dirname(skill.skillPath))
    if (installed.skillContentHash !== hash || skillPackageRevision(installed) !== state.revision) return false
    const current = managedStateFor(await this.readManagedState(), skill)
    return current?.enabled === true && !current.archived && current.revision === state.revision && current.contentHash === state.contentHash
  }

  private async readSkillFile(skill: SkillDescriptor): Promise<SkillReadResult> {
    return this.parseSkillFile(skill, await readFile(skill.skillPath, 'utf-8'))
  }

  private parseSkillFile(skill: SkillDescriptor, content: string): SkillReadResult {
    const parsed = splitSkillMarkdown(content)
    if (parsed.error) throw new Error(parsed.error)
    return {
      skill: { ...skill, 'disable-model-invocation': booleanValue(parsed.attributes['disable-model-invocation']) },
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
    const revisionPath = await assertOwnedPathAsync(
      this.context.profileRoot,
      join(getManagedSkillRevisionRoot(this.context.profileRoot, installationId), revision, 'SKILL.md'),
      'skill revision'
    )
    let content: string
    try { content = await readFile(revisionPath, 'utf-8') } catch { return undefined }
    const parsed = splitSkillMarkdown(content)
    return {
      skill: { ...skill, revision, skillPath: revisionPath, rootPath: dirname(revisionPath) },
      content,
      body: parsed.body,
      frontmatter: parsed.attributes
    }
  }

  private async readManagedState(): Promise<Record<string, ManagedSkillState>> {
    const path = await assertOwnedPathAsync(
      this.context.profileRoot,
      getManagedSkillStatePath(this.context.profileRoot),
      'managed skill state'
    )
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const { installations } = JSON.parse(text) as { installations?: Record<string, ManagedSkillState> }
    if (!installations || typeof installations !== 'object' || Array.isArray(installations)) {
      throw new Error('Managed skill state is malformed.')
    }
    return installations
  }

  private async applyManagedState(skills: SkillDescriptor[]): Promise<void> {
    const installations = await this.readManagedState().catch((error: unknown) => {
      // Keep listing loose packages if the state file is unreadable. A model read checks state again.
      if (error instanceof ProfilePathError) throw error
      return {}
    })
    for (const skill of skills) {
      const state = managedStateFor(installations, skill)
      if (!state) continue
      skill.enabled = state.enabled
      skill.archived = state.archived
      if (state.revision) skill.revision = state.revision
      if (state.installationId) skill.installationId = state.installationId
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
    const bytes = await readFile(skillPath)
    const content = bytes.toString('utf-8')
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
    const contentHash = sha256Bytes(bytes)
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
        hasScripts: await pathExists(join(rootPath, 'scripts')),
        hasAssets: await pathExists(join(rootPath, 'assets')),
        hasReferences: await pathExists(join(rootPath, 'references')),
        profileId: source.profileId ?? (managed ? this.context.profileId : undefined),
        projectId: source.projectId,
        managed,
        installationId: managed
          ? source.scope === 'project' && source.projectId ? `mousse-project:${source.projectId}:${name}` : id
          : `external-skill:${source.projectId ?? shortHash(source.path, 24)}:${source.source}:${relativeRoot || name}`,
        revision: contentHash,
        contentHash,
        executableAssets: await listExecutableAssets(rootPath)
      }
    }
  }
}

function managedStateFor(installations: Record<string, ManagedSkillState>, skill: SkillDescriptor): ManagedSkillState | undefined {
  if (skill.installationId && Object.hasOwn(installations, skill.installationId)) return installations[skill.installationId]
  return Object.hasOwn(installations, skill.id) ? installations[skill.id] : undefined
}

/** Filesystem operations in flight across all Skills scans in the process. */
export const SKILL_SCAN_CONCURRENCY = 16

/** Runs `task` once fewer than `max` tasks it was given are running; the others wait in call order. */
function concurrencyLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async (task) => {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      // A waiting task takes the slot over; otherwise it is free again.
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

const scanSlot = concurrencyLimit(SKILL_SCAN_CONCURRENCY)

async function findSkillFiles(rootPath: string): Promise<string[]> {
  // A slot is held for the listing only, never while subfolders are read, so the recursion cannot wait on itself.
  const entries = await scanSlot(() => readdir(rootPath, { withFileTypes: true }))
  // Subfolders are read together, up to `SKILL_SCAN_CONCURRENCY` at a time; results keep the entries' order.
  const found = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    if (entry.isSymbolicLink() || entry.name === '.' || entry.name === '..') return []
    const entryPath = join(rootPath, entry.name)
    // A link the listing did not name as one (a Windows junction) is never followed either.
    const info = await scanSlot(() => lstat(entryPath)).catch(() => undefined)
    if (!info || info.isSymbolicLink()) return []
    if (entry.isFile() && entry.name === 'SKILL.md') return [entryPath]
    return entry.isDirectory() ? findSkillFiles(entryPath) : []
  }))
  return found.flat()
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

async function listExecutableAssets(rootPath: string): Promise<string[] | undefined> {
  const scriptsRoot = join(rootPath, 'scripts')
  if (!(await pathExists(scriptsRoot))) return undefined
  try {
    return await collectFiles(scriptsRoot, scriptsRoot)
  } catch {
    return undefined
  }
}

/**
 * Every file under `current`, relative to `root`, one folder listing at a time. It runs inside a skill's parse, which
 * already holds one of the scan's slots, so it takes none of its own (that could wait on itself).
 */
async function collectFiles(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const entryPath = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(root, entryPath))
    else if (entry.isFile()) files.push(normalizePath(relative(root, entryPath)))
  }
  return files
}

/** Whether `path` is there. The surrounding root probe or skill parse holds a scan slot. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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
