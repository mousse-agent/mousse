import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceEnabled } from '../../shared/harness/status'
import type { HarnessScopesFile, ProjectProviderOverrides, ProviderSelection } from '../../shared/harness/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { upgradeSelection, type ModelPick } from '../../shared/modelSelection'

/**
 * Project defaults of the profile's provider instances, in `<profileHome>/harness/scopes.json`.
 * Whether an instance is on is decided by the computer alone (the instance's `enabled`); per-project
 * switches written by an older Mousse stay in the file and are ignored.
 * `ProjectManager`'s `projects.json` is never touched.
 */
export class HarnessScopeStore {
  private cache?: HarnessScopesFile
  private readonly path: string

  constructor(profileHome: string) {
    this.path = join(profileHome, 'harness', 'scopes.json')
  }

  /** The stored overrides; an unreadable or malformed file reads as empty and is left alone. */
  read(): HarnessScopesFile {
    if (this.cache) return this.cache
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[harness] could not read provider scopes; using none', error instanceof Error ? error.message : String(error))
      return (this.cache = { version: 1, projects: {} })
    }
    return (this.cache = decodeScopes(parsed))
  }

  project(projectId: string): ProjectProviderOverrides | undefined {
    return this.read().projects[projectId]
  }

  setDefaultSelection(projectId: string, selection: ProviderSelection | null): void {
    this.update(projectId, (project) => {
      if (selection) project.defaultSelection = { ...selection }
      else delete project.defaultSelection
    })
  }

  /** Project defaults that named `from` name `to` now, with `model` mapping their models; returns what changed. */
  moveDefaults(from: string, to: string, model: (pick: ModelPick) => ModelPick = (pick) => pick): Array<{ projectId: string; from: string; to: string }> {
    const file = structuredClone(this.read())
    const moved: Array<{ projectId: string; from: string; to: string }> = []
    for (const [projectId, project] of Object.entries(file.projects)) {
      if (project.defaultSelection?.instanceId !== from) continue
      const { effort: _effort, ...rest } = project.defaultSelection
      const mapped = model(project.defaultSelection)
      moved.push({ projectId, from: project.defaultSelection.model, to: mapped.model })
      project.defaultSelection = { ...rest, instanceId: to, model: mapped.model, ...(mapped.effort ? { effort: mapped.effort } : {}) }
    }
    if (moved.length) this.write(file)
    return moved
  }

  /** Drops every project's override of a removed instance. */
  forgetInstance(instanceId: string): void {
    const file = structuredClone(this.read())
    let changed = false
    for (const project of Object.values(file.projects)) {
      if (project.instances[instanceId]) {
        delete project.instances[instanceId]
        changed = true
      }
      if (project.defaultSelection?.instanceId === instanceId) {
        delete project.defaultSelection
        changed = true
      }
    }
    if (changed) this.write(file)
  }

  private update(projectId: string, change: (project: ProjectProviderOverrides) => void): void {
    const file = structuredClone(this.read())
    const project = file.projects[projectId] ?? { instances: {} }
    change(project)
    if (Object.keys(project.instances).length === 0 && !project.defaultSelection) delete file.projects[projectId]
    else file.projects[projectId] = project
    this.write(file)
  }

  private write(file: HarnessScopesFile): void {
    atomicWriteJsonSync(this.path, file)
    this.cache = file
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Well-formed parts of a stored scopes file; anything else is dropped from the view. */
export function decodeScopes(raw: unknown): HarnessScopesFile {
  const file: HarnessScopesFile = { version: 1, projects: {} }
  if (!isRecord(raw) || !isRecord(raw.projects)) return file
  for (const [projectId, value] of Object.entries(raw.projects)) {
    if (!projectId || projectId === '__proto__' || !isRecord(value)) continue
    const project: ProjectProviderOverrides = { instances: {} }
    if (isRecord(value.instances))
      for (const [instanceId, entry] of Object.entries(value.instances))
        if (instanceId !== '__proto__' && isRecord(entry) && typeof entry.enabled === 'boolean') project.instances[instanceId] = { enabled: entry.enabled }
    const selection = value.defaultSelection
    if (isRecord(selection) && typeof selection.instanceId === 'string' && typeof selection.model === 'string')
      // A level packed into the model (written before #490) moves into its own field.
      project.defaultSelection = upgradeSelection({
        instanceId: selection.instanceId,
        model: selection.model,
        ...(typeof selection.effort === 'string' ? { effort: selection.effort } : {})
      })
    file.projects[projectId] = project
  }
  return file
}

/** Whether an instance is on: the computer's own switch, in every scope. */
export function instanceEnabled(deviceEnabled: boolean): InstanceEnabled {
  return { device: deviceEnabled, effective: deviceEnabled, setBy: 'device' }
}
