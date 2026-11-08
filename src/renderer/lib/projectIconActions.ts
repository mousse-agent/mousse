import type { Project } from '../../shared/types'
import type { ProjectIconChoice } from '../../shared/projectIcon'
import { runWithToast } from './actionToast'
import { projectIconUrl } from './projectIcons'

interface ProjectIconApi {
  setIcon?: (projectId: string, choice: ProjectIconChoice) => Promise<unknown>
  pickIcon?: (defaultPath?: string) => Promise<string | null>
}

function iconApi(): Required<ProjectIconApi> | undefined {
  const api = (globalThis as { mousse?: { projects?: ProjectIconApi } }).mousse?.projects
  return typeof api?.setIcon === 'function' && typeof api.pickIcon === 'function' ? (api as Required<ProjectIconApi>) : undefined
}

export interface ProjectIconMenuActions {
  onChangeIcon?: () => void
  onResetIcon?: () => void
  onUseFolderIcon?: () => void
}

/**
 * The project menu's icon items, for a project of this computer: "Change icon…" always, "Reset icon" once the user
 * chose a file or turned icons off, "Use folder icon" while it shows an image. None when the app has no icon support.
 */
export function projectIconMenuActions(project: Project | undefined, close: () => void): ProjectIconMenuActions {
  const api = iconApi()
  if (!api || !project || project.node) return {}
  const set = (verb: string, choice: ProjectIconChoice) =>
    void runWithToast(verb, () => api.setIcon(project.id, choice), { retry: true })
  const showsImage = !project.iconOff && Boolean(project.iconPath || project.detectedIconPath || projectIconUrl(project))
  return {
    onChangeIcon: () => {
      close()
      void (async () => {
        const path = await api.pickIcon(project.path)
        if (path) set('change the icon', { mode: 'custom', path })
      })()
    },
    ...(project.iconPath || project.iconOff ? { onResetIcon: () => { close(); set('reset the icon', { mode: 'auto' }) } } : {}),
    ...(showsImage ? { onUseFolderIcon: () => { close(); set('use the folder icon', { mode: 'off' }) } } : {})
  }
}
