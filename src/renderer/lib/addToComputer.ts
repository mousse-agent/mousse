import { create } from 'zustand'
import type { Project } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { sourceControlClient } from './sourceControl'

/** A project of this computer to add to another one, from a new thread's composer that picked that computer. */
export interface AddToComputerRequest {
  /** The computer to add it to. */
  node: string
  /** The project here. */
  projectId: string
  name: string
  /** Called with that computer's project once it is there (picked, cloned or added from a folder). */
  onAdded: (project: Project) => void
}

interface AddToComputerState {
  request: AddToComputerRequest | null
  /** The project's GitHub repository and branch, once read; `{}` when it has none or the read failed. */
  source: { repository?: string; branch?: string } | null
}

/** The add New project is doing, if any; it ends when the project is there or New project closes without it. */
export const useAddToComputer = create<AddToComputerState>(() => ({ request: null, source: null }))

/** Opens New project to add a project of this computer to another computer, reading where the project came from. */
export function openAddToComputer(request: AddToComputerRequest): void {
  useAddToComputer.setState({ request, source: null })
  useAppStore.getState().setNewProjectOpen(true)
  const keep = (source: AddToComputerState['source']) => {
    if (useAddToComputer.getState().request === request) useAddToComputer.setState({ source })
  }
  void sourceControlClient.projectSource(request.projectId).then(keep, () => keep({}))
}

/** Ends the add: hands the project over when it is there. */
export function endAddToComputer(project?: Project): boolean {
  const { request } = useAddToComputer.getState()
  if (!request) return false
  useAddToComputer.setState({ request: null, source: null })
  if (project) request.onAdded(project)
  return true
}
