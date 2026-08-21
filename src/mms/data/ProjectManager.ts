import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Project, Thread } from '../../shared/types'
import type { ThreadDataStore } from './ThreadDataStore'
import { atomicWriteJsonSync } from './AtomicFs'
import { getProjectsIndexPath } from './paths'

export class ProjectManager {
  private projects: Project[] = []
  private threadStore: ThreadDataStore | null = null

  constructor() {
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
    return project
  }

  removeProject(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
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
      if (!existsSync(getProjectsIndexPath())) return []
      const raw = readFileSync(getProjectsIndexPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
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
    } catch {
      return []
    }
  }

  private persist(): void {
    atomicWriteJsonSync(getProjectsIndexPath(), this.projects)
  }

  private sortProjects(projects: Project[]): Project[] {
    return projects.sort((a, b) => a.order - b.order)
  }
}
