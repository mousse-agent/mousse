import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceEnabled } from '../../shared/harness/status'
import type { HarnessScopesFile, ProjectProviderOverrides, ProviderScope, ProviderSelection } from '../../shared/harness/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * Project overrides of the profile's provider instances, in `<profileHome>/harness/scopes.json`.
 * The device setting (the instance's `enabled`) is a ceiling: a project can only turn an instance
 * off for itself, or back on when the device has it on, and pick its default selection.
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

  /** `enabled: null` clears the project's override of the instance. */
  setEnabled(projectId: string, instanceId: string, enabled: boolean | null): void {
    this.update(projectId, (project) => {
      if (enabled === null) delete project.instances[instanceId]
      else project.instances[instanceId] = { enabled }
    })
  }

  setDefaultSelection(projectId: string, selection: ProviderSelection | null): void {
    this.update(projectId, (project) => {
      if (selection) project.defaultSelection = { ...selection }
      else delete project.defaultSelection
    })
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

  /** Whether an instance applies in `scope`, and which layer decided it. */
  enabled(instanceId: string, deviceEnabled: boolean, scope: ProviderScope): InstanceEnabled {
    if (scope.kind !== 'project') return { device: deviceEnabled, effective: deviceEnabled, setBy: 'device' }
    const project = this.project(scope.projectId)?.instances[instanceId]?.enabled
    const base = { device: deviceEnabled, ...(project !== undefined ? { project } : {}) }
    if (!deviceEnabled) return { ...base, effective: false, setBy: 'device' }
    if (project !== undefined) return { ...base, effective: project, setBy: 'project' }
    return { ...base, effective: true, setBy: 'device' }
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
      project.defaultSelection = {
        instanceId: selection.instanceId,
        model: selection.model,
        ...(typeof selection.effort === 'string' ? { effort: selection.effort } : {})
      }
    file.projects[projectId] = project
  }
  return file
}
