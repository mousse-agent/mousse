import { existsSync } from 'fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { assertOwnedPath } from '../../profiles/pathSafety'
import type {
  IntegrationDiagnostic,
  IntegrationScope,
  SkillDescriptor,
  SkillPackageFile
} from '../../../shared/integrations'
import type {
  ManagedSkillRecord,
  SkillCreateInput,
  SkillEditorDto,
  SkillExportResult,
  SkillImportInput,
  SkillUpdateInput
} from '../../../shared/integrations/lifecycle'
import { atomicWriteFile } from '../atomicWrite'
import {
  getManagedSkillArchiveRoot,
  getManagedSkillRevisionRoot,
  getManagedSkillRoot,
  getManagedSkillStatePath,
  getProjectMousseSkillRoot
} from '../nativePaths'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from '../profileContext'
import { sha256Bytes } from '../revision'
import { inspectRelativePath } from '../pathSafety'
import { exportSkillDirectory, exportSkillMarkdown } from './skillExport'
import { importSkillPath, importSkillZip, type ImportedSkillPackage } from './skillImport'
import { SkillsRegistry } from './SkillsRegistry'
import { renderSkillTemplate } from './skillTemplate'
import { isValidSkillName, skillFrontmatterDiagnostics, stringValue } from './skillValidation'
import { splitSkillMarkdown } from './yamlFrontmatter'

interface SkillStateFile {
  version: 1
  installations: Record<string, SkillStateEntry>
}

interface SkillStateEntry {
  installationId: string
  name: string
  scope: IntegrationScope
  enabled: boolean
  archived: boolean
  revision: string
  contentHash: string
  projectPath?: string
  provenance: string
  createdAt: string
  updatedAt: string
}

export class SkillLifecycleService {
  private readonly context: IntegrationRuntimeContext

  constructor(
    private readonly registry: SkillsRegistry,
    context?: IntegrationRuntimeContext
  ) {
    this.context = context ?? createLegacySingleProfileContext()
  }

  async create(input: SkillCreateInput): Promise<ManagedSkillRecord> {
    await this.readState()
    if (!isValidSkillName(input.name)) {
      throw new Error(
        'Skill name must be 1-64 lowercase alphanumeric characters with single hyphens.'
      )
    }
    if (!input.description.trim() || input.description.length > 1024) {
      throw new Error('Skill description is required and must be at most 1024 characters.')
    }
    const root = this.skillRoot(input.scope, input.projectPath)
    const dest = join(root, input.name)
    if (existsSync(dest)) {
      throw new Error(`A skill named "${input.name}" already exists in this scope.`)
    }
    const content = renderSkillTemplate(input)
    await this.stageAndPromote(dest, [
      { relativePath: 'SKILL.md', bytes: Buffer.from(content, 'utf-8'), executable: false }
    ])
    const installationId = this.installationId(input.scope, input.name)
    const hash = sha256Bytes(content)
    await this.putState({
      installationId,
      name: input.name,
      scope: input.scope,
      enabled: input.enable !== false,
      archived: false,
      revision: hash,
      contentHash: hash,
      projectPath: input.projectPath,
      provenance: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    return this.loadRecord(installationId, input.projectPath)
  }

  async update(input: SkillUpdateInput): Promise<ManagedSkillRecord> {
    const current = await this.requireState(input.installationId)
    if (input.expectedRevision && input.expectedRevision !== current.revision) {
      throw new Error('Skill revision conflict. Reload the skill before saving.')
    }
    const dest = this.installationPath(current)
    if (input.content) {
      this.assertValidSkillMarkdown(input.content, current.name)
      await this.pinCurrentRevision(current, dest)
      await atomicWriteFile(join(dest, 'SKILL.md'), input.content)
      current.revision = sha256Bytes(input.content)
      current.contentHash = current.revision
    }
    if (typeof input.enable === 'boolean') current.enabled = input.enable
    current.updatedAt = new Date().toISOString()
    await this.putState(current)
    return this.loadRecord(current.installationId, input.projectPath ?? current.projectPath)
  }

  async read(installationId: string, projectPath?: string, pinRevision?: string): Promise<SkillEditorDto> {
    const snapshot = await this.registry.refresh({ projectPath })
    const skill = snapshot.skills.find(
      (entry) =>
        entry.installationId === installationId ||
        entry.id === installationId ||
        entry.name === installationId
    )
    if (!skill) throw new Error(`Skill not found: ${installationId}`)
    const result = pinRevision
      ? await this.registry.readSkillRevision(skill.id, pinRevision, { projectPath })
      : await this.registry.readSkill(skill.id, { projectPath }, snapshot)
    const files = await this.listPackageFiles(result.skill.rootPath)
    return {
      ...result,
      packageTree: files,
      source: result.content,
      previewMarkdown: result.body ?? splitSkillMarkdown(result.content).body
    }
  }

  async enable(installationId: string, enabled: boolean, projectPath?: string): Promise<ManagedSkillRecord> {
    const current = await this.requireState(installationId)
    current.enabled = enabled
    current.updatedAt = new Date().toISOString()
    await this.putState(current)
    return this.loadRecord(installationId, projectPath ?? current.projectPath)
  }

  async archive(installationId: string, projectPath?: string): Promise<void> {
    const current = await this.requireState(installationId)
    const dest = this.installationPath(current)
    const archiveRoot = assertOwnedPath(
      this.context.profileRoot,
      join(getManagedSkillArchiveRoot(this.context.profileRoot), `${current.name}-${Date.now()}`),
      'skill archive'
    )
    if (existsSync(dest)) {
      await mkdir(dirname(archiveRoot), { recursive: true })
      await cp(dest, archiveRoot, { recursive: true })
      await rm(dest, { recursive: true, force: true })
    }
    current.archived = true
    current.enabled = false
    current.updatedAt = new Date().toISOString()
    await this.putState(current)
    await this.registry.refresh({ projectPath: projectPath ?? current.projectPath })
  }

  async importPackage(input: SkillImportInput): Promise<ManagedSkillRecord> {
    const state = await this.readState()
    const imported = input.zipBytes
      ? importSkillZip(input.zipBytes, input.zipName)
      : input.sourcePath
        ? await importSkillPath(input.sourcePath)
        : (() => {
            throw new Error('Skill import requires a folder, SKILL.md file, or ZIP bytes.')
          })()
    const parsed = splitSkillMarkdown(imported.skillMarkdown)
    if (parsed.error) throw new Error(parsed.error)
    const diagnostics = skillFrontmatterDiagnostics(parsed.attributes)
    if (diagnostics.some((item) => item.level === 'error')) {
      throw new Error(diagnostics.map((item) => item.message).join('; '))
    }
    const name = stringValue(parsed.attributes.name)
    if (!name || !isValidSkillName(name)) {
      throw new Error('Imported SKILL.md does not contain a valid name.')
    }
    const root = this.skillRoot(input.scope, input.projectPath)
    const dest = join(root, name)
    if (existsSync(dest) && !input.replaceInstallationId) {
      throw new Error(`A skill named "${name}" already exists. Pass replaceInstallationId to replace it.`)
    }
    if (existsSync(dest) && input.replaceInstallationId) {
      const existing = await this.requireState(input.replaceInstallationId)
      if (existing.name !== name || existing.scope !== input.scope || existing.projectPath !== input.projectPath) {
        throw new Error('replaceInstallationId does not identify the destination skill package.')
      }
      await this.pinCurrentRevision(existing, dest)
    }
    await this.stageAndPromote(dest, imported.files)
    const hash = packageHash(imported)
    const installationId = this.installationId(input.scope, name)
    const previous = state.installations[installationId]
    await this.putState({
      installationId,
      name,
      scope: input.scope,
      enabled: input.enable !== false,
      archived: false,
      revision: hash,
      contentHash: hash,
      projectPath: input.projectPath,
      provenance: input.zipBytes ? 'zip' : 'folder',
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    return this.loadRecord(installationId, input.projectPath)
  }

  async exportPackage(installationId: string, projectPath?: string): Promise<SkillExportResult> {
    const snapshot = await this.registry.refresh({ projectPath })
    const skill = snapshot.skills.find(
      (entry) => entry.installationId === installationId || entry.id === installationId
    )
    if (!skill) throw new Error(`Skill not found: ${installationId}`)
    const bytes = exportSkillDirectory(skill.rootPath, skill.name)
    return {
      fileName: `${skill.name}.zip`,
      bytes,
      contentType: 'application/zip'
    }
  }

  async exportMarkdown(installationId: string, projectPath?: string): Promise<SkillExportResult> {
    const result = await this.registry.readSkill(installationId, { projectPath, refresh: true })
    return {
      fileName: 'SKILL.md',
      bytes: exportSkillMarkdown(result.content),
      contentType: 'text/markdown'
    }
  }

  private async loadRecord(installationId: string, projectPath?: string): Promise<ManagedSkillRecord> {
    const snapshot = await this.registry.refresh({ projectPath })
    const state = (await this.readState()).installations[installationId]
    const skill = snapshot.skills.find(
      (entry) => entry.installationId === installationId || entry.id === installationId
    )
    if (!skill || !state) {
      throw new Error(`Skill installation is not readable: ${installationId}`)
    }
    skill.enabled = state.enabled
    skill.archived = state.archived
    skill.installationId = installationId
    skill.revision = state.revision
    skill.profileId = this.context.profileId
    return {
      installationId,
      skill,
      enabled: state.enabled,
      archived: state.archived,
      revision: state.revision,
      diagnostics: skill.diagnostics ?? []
    }
  }

  private skillRoot(scope: IntegrationScope, projectPath?: string): string {
    if (scope === 'project') {
      if (!projectPath) throw new Error('Project path is required for project-scoped skills.')
      return assertOwnedPath(projectPath, getProjectMousseSkillRoot(projectPath), 'project skill root')
    }
    return assertOwnedPath(
      this.context.profileRoot,
      getManagedSkillRoot(this.context.profileRoot),
      'profile skill root'
    )
  }

  private installationId(scope: IntegrationScope, name: string): string {
    const source = scope === 'project' ? 'mousse-project' : 'mousse-profile'
    return `${source}:${name}`
  }

  private installationPath(entry: SkillStateEntry): string {
    return join(this.skillRoot(entry.scope, entry.projectPath), entry.name)
  }

  private async stageAndPromote(
    dest: string,
    files: Array<{ relativePath: string; bytes: Uint8Array; executable: boolean }>
  ): Promise<void> {
    const staging = `${dest}.staging-${randomUUID()}`
    const backup = `${dest}.backup-${randomUUID()}`
    await mkdir(staging, { recursive: true })
    let backedUp = false
    try {
      for (const file of files) {
        const unsafe = inspectRelativePath(file.relativePath)
        if (unsafe) throw new Error(unsafe.reason)
        const target = join(staging, file.relativePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.bytes)
      }
      if (!existsSync(join(staging, 'SKILL.md'))) {
        throw new Error('Staged skill is missing SKILL.md.')
      }
      const markdown = await readFile(join(staging, 'SKILL.md'), 'utf-8')
      this.assertValidSkillMarkdown(markdown)
      await mkdir(dirname(dest), { recursive: true })
      if (existsSync(dest)) {
        await rename(dest, backup)
        backedUp = true
      }
      try {
        await rename(staging, dest)
      } catch (error) {
        if (backedUp && !existsSync(dest)) await rename(backup, dest)
        throw error
      }
      if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => {})
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      if (backedUp && existsSync(backup) && !existsSync(dest)) {
        await rename(backup, dest).catch(() => {})
      }
    }
  }

  private assertValidSkillMarkdown(content: string, expectedName?: string): void {
    const parsed = splitSkillMarkdown(content)
    if (parsed.error) throw new Error(parsed.error)
    const diagnostics = skillFrontmatterDiagnostics(parsed.attributes)
    if (diagnostics.some((item) => item.level === 'error')) {
      throw new Error(diagnostics.map((d) => d.message).join('; '))
    }
    const name = stringValue(parsed.attributes.name)
    if (expectedName && name !== expectedName) {
      throw new Error(`Skill name "${name}" does not match installation "${expectedName}".`)
    }
  }

  private async pinCurrentRevision(entry: SkillStateEntry, dest: string): Promise<void> {
    if (!existsSync(dest)) return
    const revisionRoot = assertOwnedPath(
      this.context.profileRoot,
      join(getManagedSkillRevisionRoot(this.context.profileRoot, entry.installationId), entry.revision),
      'skill revision'
    )
    await mkdir(dirname(revisionRoot), { recursive: true })
    if (!existsSync(revisionRoot)) {
      await cp(dest, revisionRoot, { recursive: true })
    }
  }

  private async listPackageFiles(rootPath: string): Promise<SkillPackageFile[]> {
    const { readdirSync, statSync } = await import('fs')
    const files: SkillPackageFile[] = []
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const entryPath = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(entryPath)
          continue
        }
        if (!entry.isFile()) continue
        const relativePath = entryPath.slice(rootPath.length + 1).replace(/\\/g, '/')
        files.push({
          relativePath,
          bytes: statSync(entryPath).size,
          executable: /(^|\/)scripts\//.test(relativePath)
        })
      }
    }
    if (existsSync(rootPath)) walk(rootPath)
    return files
  }

  private async readState(): Promise<SkillStateFile> {
    const path = assertOwnedPath(
      this.context.profileRoot,
      getManagedSkillStatePath(this.context.profileRoot),
      'managed skill state'
    )
    if (!existsSync(path)) return { version: 1, installations: {} }
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as SkillStateFile
      if (parsed.version !== 1 || !parsed.installations || typeof parsed.installations !== 'object' || Array.isArray(parsed.installations)) {
        throw new Error(`Managed skill state is malformed: ${path}`)
      }
      return parsed
    } catch (error) {
      throw new Error(`Managed skill state cannot be read without risking data loss: ${path}`, { cause: error })
    }
  }

  private async putState(entry: SkillStateEntry): Promise<void> {
    const state = await this.readState()
    state.installations[entry.installationId] = entry
    const path = assertOwnedPath(
      this.context.profileRoot,
      getManagedSkillStatePath(this.context.profileRoot),
      'managed skill state'
    )
    await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`)
  }

  private async requireState(installationId: string): Promise<SkillStateEntry> {
    const entry = (await this.readState()).installations[installationId]
    if (!entry || entry.archived) {
      throw new Error(`Skill installation not found: ${installationId}`)
    }
    return entry
  }
}

function packageHash(imported: ImportedSkillPackage): string {
  const parts = imported.files
    .map((file) => `${file.relativePath}:${sha256Bytes(file.bytes)}`)
    .sort()
  return sha256Bytes(parts.join('\n'))
}

export function skillDiagnosticsSummary(diagnostics: IntegrationDiagnostic[]): string {
  return diagnostics.map((item) => item.message).join('; ')
}
