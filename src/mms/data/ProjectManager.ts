import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Project, Thread } from '../../shared/types'
import type { ThreadDataStore } from './ThreadDataStore'
import { atomicWriteJsonSync, quarantineUnreadableFileSync } from './AtomicFs'
import { getMousseHomeDir } from './paths'
import { trustRepositoryPrograms } from '../git/repoPrograms'
import { retireProjectSnapshots } from '../workspace/SnapshotWorkspace'

export class ProjectManager {
  private projects: Project[] = []
  private threadStore: ThreadDataStore | null = null

  private readonly projectsPath: string

  constructor(private readonly homeDir = getMousseHomeDir()) {
    this.projectsPath = join(homeDir, 'projects.json')
    this.projects = this.loadProjects()
  }

  setThreadStore(store: ThreadDataStore): void {
    this.threadStore = store
  }

  listProjects(): Project[] {
    return this.sortProjects([...this.projects])
  }

  getProject(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  openProject(folderPath: string): Project {
    const existing = this.projects.find((p) => p.path === folderPath)
    if (existing) return existing

    const now = new Date().toISOString()
    const project: Project = {
      id: uuidv4(),
      name: basename(folderPath),
      path: folderPath,
      createdAt: now,
      order: this.projects.length
    }

    this.projects.push(project)
    this.persist()
    // The repository's own filters as the user has them now (git-crypt, a local LFS) are theirs.
    try { trustRepositoryPrograms(folderPath) } catch { /* not a repository yet: nothing to record */ }
    return project
  }

  /** Records the project's repository's own Git filters as the user's again, after they changed one. */
  trustGitSettings(id: string): { filters: string[] } {
    const project = this.getProject(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    const record = trustRepositoryPrograms(project.path)
    if (!record) throw new Error('This project is not in a Git repository.')
    return { filters: [...new Set(Object.keys(record.filters).map((key) => key.split('.').slice(1, -1).join('.')))] }
  }

  removeProject(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
    // The snapshots of a project that is not a Git repository live in Mousse's data. They stay while a thread still
    // uses them, and then go to Mousse's trash, never straight to deletion.
    try { retireProjectSnapshots(id, this.homeDir) } catch (error) { console.warn('the project snapshot store could not be retired', { projectId: id, error: error instanceof Error ? error.message : String(error) }) }
  }

  renameProject(id: string, name: string): Project {
    const project = this.getProject(id)
    if (!project) {
      throw new Error(`Project not found: ${id}`)
    }

    const trimmed = name.trim()
    if (!trimmed) {
      throw new Error('Project name cannot be empty')
    }

    project.name = trimmed
    this.persist()
    return project
  }

  setProjectPinned(id: string, pinned: boolean): Project {
    const project = this.getProject(id)
    if (!project) {
      throw new Error(`Project not found: ${id}`)
    }

    if (pinned) {
      project.pinnedAt = new Date().toISOString()
    } else {
      delete project.pinnedAt
    }

    this.persist()
    return project
  }

  reorderProjects(projectIds: string[]): Project[] {
    if (projectIds.length !== this.projects.length || new Set(projectIds).size !== projectIds.length) {
      throw new Error('Project reorder must include every project exactly once')
    }
    const byId = new Map(this.projects.map((project) => [project.id, project]))
    if (projectIds.some((id) => !byId.has(id))) {
      throw new Error('Project reorder contains an unknown project')
    }
    this.projects = projectIds.map((id, order) => ({ ...byId.get(id)!, order }))
    this.persist()
    return this.listProjects()
  }

  listProjectThreads(projectId: string): Thread[] {
    if (!this.threadStore) return []
    return this.threadStore.listThreads(projectId)
  }

  private loadProjects(): Project[] {
    try {
      if (!existsSync(this.projectsPath)) return []
      const raw = readFileSync(this.projectsPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        quarantineUnreadableFileSync(this.projectsPath, new Error('projects.json is not an array'))
        return []
      }
      const projects = parsed as Project[]
      let changed = false
      const ordered = [...projects].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      ordered.forEach((project, order) => {
        if (!Number.isFinite(project.order)) {
          project.order = order
          changed = true
        }
      })
      if (changed) {
        this.projects = projects
        this.persist()
      }
      return projects
    } catch (error) {
      if (existsSync(this.projectsPath)) quarantineUnreadableFileSync(this.projectsPath, error)
      return []
    }
  }

  private persist(): void {
    atomicWriteJsonSync(this.projectsPath, this.projects)
  }

  private sortProjects(projects: Project[]): Project[] {
    return projects.sort((a, b) => a.order - b.order)
  }
}
