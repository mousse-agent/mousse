import { useMemo } from 'react'
import type { Project } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/** The projects of this computer; a project of another computer carries `node`. */
export function localProjectsOf(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !project.node)
}

/**
 * This computer's own projects, for places that act on this computer alone (its settings, its chats).
 * The sidebar and the thread views read `projects` itself, which also lists the other computers'.
 */
export function useLocalProjects(): Project[] {
  const projects = useAppStore((state) => state.projects)
  return useMemo(() => localProjectsOf(projects), [projects])
}
