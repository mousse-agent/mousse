import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface FileWorkspaceSnapshot {
  openPaths: string[]
  activePath: string | null
}

interface FileWorkspaceState {
  workspaces: Record<string, FileWorkspaceSnapshot>
  openFile: (scope: string, path: string) => void
  activateFile: (scope: string, path: string) => void
  closeFile: (scope: string, path: string) => void
}

const EMPTY_WORKSPACE: FileWorkspaceSnapshot = { openPaths: [], activePath: null }

/** Files state follows a thread checkout, not whichever action tab happens to be visible. */
export function fileWorkspaceScope(threadId?: string | null, projectId?: string | null): string {
  return `${projectId || 'no-project'}::${threadId || 'no-thread'}`
}

export function openFileInSnapshot(snapshot: FileWorkspaceSnapshot, path: string): FileWorkspaceSnapshot {
  return {
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
  return { openPaths, activePath }
}

function current(state: FileWorkspaceState, scope: string): FileWorkspaceSnapshot {
  return state.workspaces[scope] ?? EMPTY_WORKSPACE
}

export const useFileWorkspaceStore = create<FileWorkspaceState>()(persist(
  (set) => ({
    workspaces: {},
    openFile: (scope, path) => set((state) => ({
      workspaces: { ...state.workspaces, [scope]: openFileInSnapshot(current(state, scope), path) }
    })),
    activateFile: (scope, path) => set((state) => {
      const workspace = current(state, scope)
      if (!workspace.openPaths.includes(path)) return state
      return { workspaces: { ...state.workspaces, [scope]: { ...workspace, activePath: path } } }
    }),
    closeFile: (scope, path) => set((state) => ({
      workspaces: { ...state.workspaces, [scope]: closeFileInSnapshot(current(state, scope), path) }
    }))
  }),
  {
    name: 'mousse-files-workspaces-v1',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({ workspaces: state.workspaces })
  }
))
