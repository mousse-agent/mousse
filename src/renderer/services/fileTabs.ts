import { create } from 'zustand'

export const useFileTabStatus = create<{ dirtyPaths: Record<string, string[]> }>(() => ({ dirtyPaths: {} }))

export function setFileTabDirtyPaths(scope: string, paths: string[]): void {
  useFileTabStatus.setState((state) => ({ dirtyPaths: { ...state.dirtyPaths, [scope]: paths } }))
}

/** The editor owns save/conflict handling, even when its tab is hidden. */
const roots = new Map<string, string>()
const closers = new Map<string, (path: string) => Promise<boolean>>()

export function registerFileTabCloser(scope: string, close: (path: string) => Promise<boolean>, root: string): () => void {
  closers.set(scope, close)
  roots.set(scope, root)
  return () => { if (closers.get(scope) === close) { closers.delete(scope); roots.delete(scope) } }
}

export async function closeFileTab(scope: string, path: string): Promise<boolean> {
  return await closers.get(scope)?.(path) ?? false
}

export function fileTabRoot(scope: string): string { return roots.get(scope) ?? '' }
