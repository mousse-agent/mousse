import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface FileTabTarget {
  path: string
  /** Present only when the file was opened outside the thread's folder. */
  root?: string
}

export interface FileWorkspaceSnapshot {
  openPaths: string[]
  activePath: string | null
  targets?: Record<string, FileTabTarget>
}

interface FileWorkspaceState {
  workspaces: Record<string, FileWorkspaceSnapshot>
  openFile: (scope: string, path: string, target?: FileTabTarget, fromBrowsedFolder?: boolean) => void
  rememberTarget: (scope: string, path: string, target: FileTabTarget) => void
  mergeFileAlias: (scope: string, alias: string, path: string) => void
  activateFile: (scope: string, path: string) => void
  /** Hides the preview: the files stay open, and picking one shows it again. */
  deactivateFile: (scope: string) => void
  closeFile: (scope: string, path: string) => void
}

const EMPTY_WORKSPACE: FileWorkspaceSnapshot = { openPaths: [], activePath: null }

/** Files state follows the backend profile and thread checkout, not the visible action tab. */
export function fileWorkspaceScope(
  profileId?: string | null,
  threadId?: string | null,
  projectId?: string | null
): string {
  return `${profileId || 'default'}::${projectId || 'no-project'}::${threadId || 'no-thread'}`
}

export function openFileInSnapshot(snapshot: FileWorkspaceSnapshot, path: string): FileWorkspaceSnapshot {
  return {
    ...snapshot,
    openPaths: snapshot.openPaths.includes(path) ? snapshot.openPaths : [...snapshot.openPaths, path],
    activePath: path
  }
}

export function closeFileInSnapshot(snapshot: FileWorkspaceSnapshot, path: string): FileWorkspaceSnapshot {
  const index = snapshot.openPaths.indexOf(path)
  if (index < 0) return snapshot
  const openPaths = snapshot.openPaths.filter((candidate) => candidate !== path)
  let activePath = snapshot.activePath
  if (activePath === path) activePath = openPaths[Math.min(index, openPaths.length - 1)] ?? null
  const { targets } = snapshot
  if (!targets || !Object.hasOwn(targets, path)) return { ...snapshot, openPaths, activePath }
  const nextTargets = { ...targets }
  delete nextTargets[path]
  return { openPaths, activePath, targets: nextTargets }
}

export function fileTabTarget(workspace: FileWorkspaceSnapshot | undefined, path: string): FileTabTarget | undefined {
  const targets = workspace?.targets
  return targets && Object.hasOwn(targets, path) ? targets[path] : undefined
}

function current(state: FileWorkspaceState, scope: string): FileWorkspaceSnapshot {
  return state.workspaces[scope] ?? EMPTY_WORKSPACE
}

export const useFileWorkspaceStore = create<FileWorkspaceState>()(persist(
  (set) => ({
    workspaces: {},
    openFile: (scope, path, target, fromBrowsedFolder) => set((state) => {
      const workspace = current(state, scope)
      const next = openFileInSnapshot(workspace, path)
      const previous = fileTabTarget(workspace, path)
      if (target && (!workspace.openPaths.includes(path) || (fromBrowsedFolder && target.root && !previous?.root))) {
        next.targets = { ...workspace.targets, [path]: target }
      }
      return { workspaces: { ...state.workspaces, [scope]: next } }
    }),
    rememberTarget: (scope, path, target) => set((state) => {
      const workspace = current(state, scope)
      if (!workspace.openPaths.includes(path) || Object.hasOwn(workspace.targets ?? {}, path)) return state
      const next = { ...workspace, targets: { ...workspace.targets, [path]: target } }
      return { workspaces: { ...state.workspaces, [scope]: next } }
    }),
    mergeFileAlias: (scope, alias, path) => set((state) => {
      const workspace = current(state, scope)
      if (!workspace.openPaths.includes(alias) || !workspace.openPaths.includes(path)) return state
      const next = closeFileInSnapshot(workspace, alias)
      if (workspace.activePath === alias) next.activePath = path
      return { workspaces: { ...state.workspaces, [scope]: next } }
    }),
    activateFile: (scope, path) => set((state) => {
      const workspace = current(state, scope)
      if (!workspace.openPaths.includes(path)) return state
      return { workspaces: { ...state.workspaces, [scope]: { ...workspace, activePath: path } } }
    }),
    deactivateFile: (scope) => set((state) => {
      const workspace = current(state, scope)
      if (workspace.activePath === null) return state
      return { workspaces: { ...state.workspaces, [scope]: { ...workspace, activePath: null } } }
    }),
    closeFile: (scope, path) => set((state) => ({
      workspaces: { ...state.workspaces, [scope]: closeFileInSnapshot(current(state, scope), path) }
    }))
  }),
  {
    name: 'mousse-files-workspaces-v2',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({ workspaces: state.workspaces })
  }
))
