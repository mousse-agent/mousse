import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../../data/AtomicFs'
import {
  WorkflowConcurrencyError,
  WORKFLOW_UUID_PATTERN,
  type CompiledWorkflow,
  type WorkflowBundle,
  type WorkflowDraftRecord,
  type WorkflowHeadManifest,
  type WorkflowListItem,
  type WorkflowLockDocument
} from '../../../shared/workflows'
import { ZipArchiveImportNotConfigured, type WorkflowArchiveImporter } from '../archive'
import {
  collectLockDependencies,
  loadWorkflowDirectory,
  semanticAssetsFromBundle,
  writeWorkflowDirectory
} from '../bundleIo'
import { compileWorkflow } from '../compiler/compileWorkflow'
import { computeSemanticHash, computeVisualHash } from '../hash'
import { normalizeRoot, resolveContainedPath } from '../pathSafety'

export interface WorkflowTrustedProject {
  projectId: string
  root: string
}

export interface WorkflowRegistryOptions {
  profileId: string
  profileRoot: string
  trustedProjectRoots?: WorkflowTrustedProject[]
  now?: () => Date
  archiveImporter?: WorkflowArchiveImporter
  watchDebounceMs?: number
}

export interface SaveDraftOptions {
  bundle: WorkflowBundle
  definitionId?: string
  expectedDraftSemanticHash?: string | null
  expectedHeadRevisionId?: string | null
  visualOnly?: boolean
}

export interface PublishOptions {
  definitionId: string
  expectedDraftSemanticHash: string
  expectedHeadRevisionId?: string | null
}

export interface WorkflowRecordSnapshot {
  profileId: string
  definitionId: string
  draft?: WorkflowDraftRecord
  head?: WorkflowHeadManifest | null
  bundle: WorkflowBundle
  compiled: CompiledWorkflow
  semanticHash: string
  visualHash: string
}

interface MetaDocument {
  id: string
  slug: string
  name: string
  createdAt: string
  archived?: boolean
  source: 'profile' | 'project'
}

export class WorkflowRegistry {
  readonly profileId: string
  readonly profileRoot: string
  private readonly trustedProjects: WorkflowTrustedProject[]
  private readonly now: () => Date
  private readonly archiveImporter: WorkflowArchiveImporter
  private readonly watchDebounceMs: number
  private readonly workflowsRoot: string

  constructor(options: WorkflowRegistryOptions) {
    if (!options.profileId) throw new Error('WorkflowRegistry requires explicit profileId')
    if (!options.profileRoot) throw new Error('WorkflowRegistry requires explicit profileRoot')
    const root = normalizeRoot(options.profileRoot)
    if (!root.ok) throw new Error(`Invalid profileRoot: ${root.reason}`)
    this.profileId = options.profileId
    this.profileRoot = root.resolved
    this.trustedProjects = options.trustedProjectRoots ?? []
    this.now = options.now ?? (() => new Date())
    this.archiveImporter = options.archiveImporter ?? new ZipArchiveImportNotConfigured()
    this.watchDebounceMs = options.watchDebounceMs ?? 150
    this.workflowsRoot = join(this.profileRoot, 'workflows')
    mkdirSync(this.workflowsRoot, { recursive: true })
  }

  list(): WorkflowListItem[] {
    return [...this.listProfile(), ...this.discoverProjects()]
  }

  discover(): WorkflowListItem[] {
    return this.list()
  }

  get(definitionId: string): WorkflowRecordSnapshot | undefined {
    const dir = this.definitionDir(definitionId)
    if (!existsSync(join(dir, 'meta.json'))) return undefined
    const draftDir = join(dir, 'draft')
    if (!existsSync(join(draftDir, 'workflow.json'))) return undefined
    const loaded = loadWorkflowDirectory(draftDir)
    const compiled = this.compileBundle(loaded.bundle, 'draft')
    const semanticHash = computeSemanticHash(loaded.bundle.manifest, semanticAssetsFromBundle(loaded.bundle))
    const visualHash = computeVisualHash(loaded.bundle.editor)
    return {
      profileId: this.profileId,
      definitionId,
      draft: this.readDraftRecord(dir),
      head: this.readHead(dir),
      bundle: loaded.bundle,
      compiled,
      semanticHash,
      visualHash
    }
  }

  getRevision(definitionId: string, revisionId: string): WorkflowRecordSnapshot | undefined {
    const dir = join(this.definitionDir(definitionId), 'revisions', revisionId)
    if (!existsSync(join(dir, 'workflow.json'))) return undefined
    const loaded = loadWorkflowDirectory(dir)
    const compiled = this.compileBundle(loaded.bundle, 'publish')
    const semanticHash = computeSemanticHash(loaded.bundle.manifest, semanticAssetsFromBundle(loaded.bundle))
    return {
      profileId: this.profileId,
      definitionId,
      head: this.readHead(this.definitionDir(definitionId)),
      bundle: loaded.bundle,
      compiled,
      semanticHash,
      visualHash: computeVisualHash(loaded.bundle.editor)
    }
  }

  validate(bundle: WorkflowBundle): CompiledWorkflow {
    return this.compileBundle(bundle, 'draft')
  }

  saveDraft(options: SaveDraftOptions): WorkflowRecordSnapshot {
    const bundle = options.bundle
    const definitionId = options.definitionId ?? bundle.manifest.id
    if (definitionId !== bundle.manifest.id) {
      throw new Error('definitionId must match manifest.id')
    }
    this.assertSafeId(definitionId)
    const dir = this.definitionDir(definitionId)
    mkdirSync(dir, { recursive: true })
    const current = existsSync(join(dir, 'draft', 'workflow.json')) ? this.get(definitionId) : undefined

    if (options.expectedDraftSemanticHash !== undefined) {
      const actual = current?.semanticHash ?? null
      if (actual !== options.expectedDraftSemanticHash) {
        throw new WorkflowConcurrencyError(
          `Draft semantic hash conflict for ${definitionId}: expected ${options.expectedDraftSemanticHash}, found ${actual}`
        )
      }
    }
    if (options.expectedHeadRevisionId !== undefined) {
      const actual = current?.head?.revisionId ?? null
      if (actual !== options.expectedHeadRevisionId) {
        throw new WorkflowConcurrencyError(
          `Head revision conflict for ${definitionId}: expected ${options.expectedHeadRevisionId}, found ${actual}`
        )
      }
    }

    this.assertUniqueSlug(bundle.manifest.slug, definitionId)

    if (options.visualOnly && current) {
      const editor = bundle.editor
      if (editor) {
        atomicWriteFileSync(join(dir, 'draft', 'editor.json'), `${JSON.stringify(editor, null, 2)}\n`)
      }
      const visualHash = computeVisualHash(editor ?? current.bundle.editor)
      this.writeDraftRecord(dir, {
        definitionId,
        slug: current.bundle.manifest.slug,
        name: current.bundle.manifest.name,
        savedAt: this.now().toISOString(),
        semanticHash: current.semanticHash,
        visualHash,
        schemaVersion: current.bundle.manifest.schemaVersion
      })
      return this.get(definitionId)!
    }

    const compiled = this.compileBundle(bundle, 'draft')
    const assets = semanticAssetsFromBundle(bundle)
    const semanticHash = computeSemanticHash(bundle.manifest, assets)
    const visualHash = computeVisualHash(bundle.editor)
    const staging = join(this.profileRoot, '.tmp', `wf-draft-${randomUUID()}`)
    try {
      writeWorkflowDirectory(staging, bundle)
      loadWorkflowDirectory(staging)
      const draftDir = join(dir, 'draft')
      rmSync(draftDir, { recursive: true, force: true })
      mkdirSync(draftDir, { recursive: true })
      copyDirContained(staging, draftDir)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }

    const meta: MetaDocument = {
      id: definitionId,
      slug: bundle.manifest.slug,
      name: bundle.manifest.name,
      createdAt: current?.draft?.savedAt ?? this.now().toISOString(),
      source: 'profile'
    }
    atomicWriteFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    this.writeDraftRecord(dir, {
      definitionId,
      slug: bundle.manifest.slug,
      name: bundle.manifest.name,
      savedAt: this.now().toISOString(),
      semanticHash,
      visualHash,
      schemaVersion: bundle.manifest.schemaVersion
    })
    void compiled
    return this.get(definitionId)!
  }

  publish(options: PublishOptions): WorkflowRecordSnapshot {
    const current = this.get(options.definitionId)
    if (!current) throw new Error(`Workflow ${options.definitionId} does not exist`)
    if (current.semanticHash !== options.expectedDraftSemanticHash) {
      throw new WorkflowConcurrencyError(
        `Publish draft hash conflict for ${options.definitionId}: expected ${options.expectedDraftSemanticHash}, found ${current.semanticHash}`
      )
    }
    const headId = current.head?.revisionId ?? null
    if (options.expectedHeadRevisionId !== undefined && headId !== options.expectedHeadRevisionId) {
      throw new WorkflowConcurrencyError(
        `Publish head conflict for ${options.definitionId}: expected ${options.expectedHeadRevisionId}, found ${headId}`
      )
    }
    const compiled = this.compileBundle(current.bundle, 'publish')
    if (!compiled.runnable) {
      const first = compiled.diagnostics.find((item) => item.severity === 'error')
      throw new Error(`Cannot publish: ${first?.message ?? 'workflow is not runnable'}`)
    }
    const assets = semanticAssetsFromBundle(current.bundle)
    const semanticHash = computeSemanticHash(current.bundle.manifest, assets)
    const visualHash = computeVisualHash(current.bundle.editor)
    const lock: WorkflowLockDocument = {
      ...collectLockDependencies(current.bundle.manifest, assets),
      semanticHash,
      pinnedAt: this.now().toISOString()
    }
    const published: WorkflowBundle = { ...current.bundle, lock }
    const revisionDir = join(this.definitionDir(options.definitionId), 'revisions', semanticHash)
    if (existsSync(revisionDir)) {
      const existing = loadWorkflowDirectory(revisionDir)
      const existingHash = computeSemanticHash(existing.bundle.manifest, semanticAssetsFromBundle(existing.bundle))
      if (existingHash !== semanticHash) {
        throw new Error(`Refusing to overwrite immutable revision ${semanticHash}`)
      }
    } else {
      mkdirSync(revisionDir, { recursive: true })
      writeWorkflowDirectory(revisionDir, published)
    }
    const head: WorkflowHeadManifest = {
      definitionId: options.definitionId,
      revisionId: semanticHash,
      semanticHash,
      visualHash,
      publishedAt: this.now().toISOString(),
      slug: current.bundle.manifest.slug,
      name: current.bundle.manifest.name
    }
    atomicWriteFileSync(
      join(this.definitionDir(options.definitionId), 'head.json'),
      `${JSON.stringify(head, null, 2)}\n`
    )
    return this.getRevision(options.definitionId, semanticHash)!
  }

  archive(definitionId: string): void {
    const dir = this.definitionDir(definitionId)
    const metaPath = join(dir, 'meta.json')
    if (!existsSync(metaPath)) throw new Error(`Workflow ${definitionId} does not exist`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MetaDocument
    meta.archived = true
    atomicWriteFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  }

  importDirectory(directory: string, options: { expectedId?: string } = {}): WorkflowRecordSnapshot {
    const loaded = loadWorkflowDirectory(directory)
    if (options.expectedId && loaded.bundle.manifest.id !== options.expectedId) {
      throw new Error(`Imported id ${loaded.bundle.manifest.id} does not match ${options.expectedId}`)
    }
    this.compileBundle(loaded.bundle, 'draft')
    return this.saveDraft({ bundle: loaded.bundle, definitionId: loaded.bundle.manifest.id })
  }

  exportDirectory(
    definitionId: string,
    destination: string,
    options: { revisionId?: string; draft?: boolean } = {}
  ): void {
    const snapshot = options.draft
      ? this.get(definitionId)
      : this.getRevision(definitionId, options.revisionId ?? this.get(definitionId)?.head?.revisionId ?? '')
    const fallback = options.draft ? snapshot : snapshot ?? this.get(definitionId)
    if (!fallback) throw new Error(`Workflow ${definitionId} cannot be exported`)
    const dest = normalizeRoot(destination)
    if (!dest.ok) throw new Error(dest.reason)
    mkdirSync(dest.resolved, { recursive: true })
    writeWorkflowDirectory(dest.resolved, fallback.bundle)
  }

  async importArchive(archivePath: string): Promise<WorkflowRecordSnapshot> {
    const staging = join(this.profileRoot, '.tmp', `wf-archive-${randomUUID()}`)
    mkdirSync(staging, { recursive: true })
    try {
      const extracted = await this.archiveImporter.extractToStaging(archivePath, staging)
      if (extracted.entryCount > 200) throw new Error('Archive has too many entries')
      return this.importDirectory(extracted.rootDir)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  watch(onChange?: () => void): { close(): void } {
    mkdirSync(this.workflowsRoot, { recursive: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        this.refreshSafe()
        onChange?.()
      }, this.watchDebounceMs)
    }
    let watcher: FSWatcher
    try {
      watcher = watch(this.workflowsRoot, { recursive: true }, fire)
    } catch {
      watcher = watch(this.workflowsRoot, fire)
    }
    return {
      close: () => {
        if (timer) clearTimeout(timer)
        watcher.close()
      }
    }
  }

  private refreshSafe(): void {
    const root = normalizeRoot(this.workflowsRoot)
    if (!root.ok) return
    try {
      for (const name of readdirSync(this.workflowsRoot)) {
        const contained = resolveContainedPath(this.workflowsRoot, name)
        if (!contained.ok) continue
      }
    } catch {
      // Watcher refresh is best-effort and never executes bundle code.
    }
  }

  private compileBundle(bundle: WorkflowBundle, mode: 'draft' | 'publish'): CompiledWorkflow {
    const knownAssets = new Set(bundle.assets.map((asset) => asset.relativePath.replace(/\\/g, '/')))
    return compileWorkflow(bundle.manifest, {
      currentWorkflowId: bundle.manifest.id,
      mode,
      knownAssets
    })
  }

  private listProfile(): WorkflowListItem[] {
    if (!existsSync(this.workflowsRoot)) return []
    const items: WorkflowListItem[] = []
    for (const name of readdirSync(this.workflowsRoot)) {
      if (!WORKFLOW_UUID_PATTERN.test(name)) continue
      const dir = this.definitionDir(name)
      const contained = resolveContainedPath(this.workflowsRoot, name)
      if (!contained.ok) continue
      const metaPath = join(dir, 'meta.json')
      if (!existsSync(metaPath)) continue
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MetaDocument
      const draft = this.readDraftRecord(dir)
      const head = this.readHead(dir)
      items.push({
        id: meta.id,
        slug: meta.slug,
        name: meta.name,
        source: 'profile',
        enabled: !meta.archived,
        archived: meta.archived,
        draftSemanticHash: draft?.semanticHash,
        draftVisualHash: draft?.visualHash,
        headRevisionId: head?.revisionId ?? null,
        headSemanticHash: head?.semanticHash ?? null
      })
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  private discoverProjects(): WorkflowListItem[] {
    const items: WorkflowListItem[] = []
    for (const project of this.trustedProjects) {
      const workflowsDir = join(project.root, '.mousse', 'workflows')
      const root = normalizeRoot(project.root)
      if (!root.ok) continue
      if (!existsSync(workflowsDir)) continue
      let names: string[] = []
      try {
        names = readdirSync(workflowsDir)
      } catch {
        continue
      }
      for (const name of names) {
        const candidate = join(workflowsDir, name, 'workflow.json')
        const resolved = resolveContainedPath(join(workflowsDir, name), 'workflow.json')
        if (!resolved.ok) continue
        if (!existsSync(candidate)) continue
        try {
          const loaded = loadWorkflowDirectory(join(workflowsDir, name))
          items.push({
            id: loaded.bundle.manifest.id,
            slug: loaded.bundle.manifest.slug,
            name: loaded.bundle.manifest.name,
            description: loaded.bundle.manifest.description,
            source: 'project',
            projectId: project.projectId,
            projectRoot: project.root,
            enabled: false
          })
        } catch {
          // Discovery never executes code; invalid packages are skipped.
        }
      }
    }
    return items
  }

  private definitionDir(id: string): string {
    this.assertSafeId(id)
    const dir = join(this.workflowsRoot, id)
    const contained = resolveContainedPath(this.workflowsRoot, id)
    if (!contained.ok) throw new Error(contained.reason)
    return dir
  }

  private assertSafeId(id: string): void {
    if (!WORKFLOW_UUID_PATTERN.test(id)) throw new Error('Workflow id must be a UUID')
  }

  private assertUniqueSlug(slug: string, definitionId: string): void {
    for (const item of this.listProfile()) {
      if (item.slug === slug && item.id !== definitionId && !item.archived) {
        throw new Error(`Slug "${slug}" is already used by ${item.id}`)
      }
    }
  }

  private readHead(dir: string): WorkflowHeadManifest | null {
    const path = join(dir, 'head.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowHeadManifest
  }

  private readDraftRecord(dir: string): WorkflowDraftRecord | undefined {
    const path = join(dir, 'draft-record.json')
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowDraftRecord
  }

  private writeDraftRecord(dir: string, record: WorkflowDraftRecord): void {
    atomicWriteFileSync(join(dir, 'draft-record.json'), `${JSON.stringify(record, null, 2)}\n`)
  }
}

function copyDirContained(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  const loaded = loadWorkflowDirectory(from)
  writeWorkflowDirectory(to, loaded.bundle)
}
