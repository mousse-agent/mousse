import { useEffect, useState } from 'react'
import { folderRecheckKey, resolveActiveProject, type ActiveProject } from '../lib/activeProject'
import { isNewEmptyThread, localWorkspaceFor } from '../lib/newThread'
import { useAppStore } from '../stores/appStore'

interface ResolvedWorkspace {
  path: string | null
  /** The thread whose ready worktree `path` is, when it is one. */
  workspaceThreadId: string | null
  /** That worktree's generation. */
  workspaceGeneration?: number
  /** Why the thread's own worktree cannot be read now; `path` is then null. */
  unavailable?: string
}

/** Said when a storage rule retired the thread's worktree: it comes back when the thread runs or its files are opened. */
export const WORKTREE_NOT_ON_DISK = 'Worktree not on disk'

/**
 * The folder the thread works in, from Mousse's record and Git's files (`git.heads`): no Git process, and nothing set up
 * or brought back to answer it. A worktree still being made reads as its project's folder until it is ready.
 */
async function resolveWorkspaceProjectPath(threadId: string | null): Promise<ResolvedWorkspace> {
  if (!threadId) return { path: await window.mousse.app.getActiveProjectPath(threadId), workspaceThreadId: null }
  try {
    const head = (await window.mousse.git.heads({ threadIds: [threadId] })).threads[threadId]
    if (head && 'own' in head) {
      const generation = { workspaceGeneration: head.generation }
      // A thread in its project's folder works there as the person does: the project's own Git rules, no Publish.
      if (head.folder) return { path: head.folder, workspaceThreadId: threadId, ...generation }
      if (head.unavailable) return { path: null, workspaceThreadId: threadId, ...generation, unavailable: head.unavailable }
      if (head.lifecycle === 'ready') return { path: null, workspaceThreadId: threadId, ...generation, unavailable: WORKTREE_NOT_ON_DISK }
    }
  } catch {
    // Legacy/standalone threads keep the existing project-path behavior.
  }
  return { path: await window.mousse.app.getActiveProjectPath(threadId), workspaceThreadId: null }
}

/** Lookups still running, by profile and thread: the side card, the panels and the toolbar ask at the same moment. */
const resolving = new Map<string, { lookup: Promise<ResolvedWorkspace>; at: number }>()
/** A lookup older than this is not joined: one that hung (a drive, a busy service) never holds a later look. */
const SHARE_MS = 2_000

/** {@link resolveWorkspaceProjectPath}, with every caller that asks while one recent lookup runs sharing it. */
function resolveShared(scope: string, threadId: string | null): Promise<ResolvedWorkspace> {
  const running = resolving.get(scope)
  if (running && Date.now() - running.at < SHARE_MS) return running.lookup
  const entry = { lookup: resolveWorkspaceProjectPath(threadId), at: Date.now() }
  entry.lookup = entry.lookup.finally(() => { if (resolving.get(scope) === entry) resolving.delete(scope) })
  resolving.set(scope, entry)
  return entry.lookup
}

/**
 * The project and folder the selected thread works on. A new, empty thread
 * follows the composer's project pick, so every surface agrees with the card.
 * Keeps unresolved lookups distinct from a confirmed standalone thread.
 */
export function useActiveProjectLocation(): ActiveProject {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const projects = useAppStore((s) => s.projects)
  const threadProjectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId ?? null)
  const isNewChat = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((thread) => thread.id === s.activeThreadId),
    s.messages.length
  ))
  const draftProjectId = useAppStore((s) => localWorkspaceFor(
    s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'],
    s.threads.find((thread) => thread.id === s.activeThreadId),
    s.projects
  ).projectId)
  const scope = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [resolved, setResolved] = useState<({ scope: string } & ResolvedWorkspace) | null>(null)
  // Retry (the Git section's) looks the folder up again.
  const [attempt, setAttempt] = useState(0)
  const turnPhase = useAppStore((s) => (s.activeThreadId ? s.turnStates[s.activeThreadId]?.phase ?? null : null))
  // The warm start's thread is not looked up until the window knows its profile (showWarmView).
  const warmOnly = useAppStore((s) => !s.profileReady && s.warmView !== null)
  // A new worktree thread's worktree is made when its first turn starts: look again as that turn moves on.
  const recheck = folderRecheckKey({
    threadId: activeThreadId,
    threadProjectId,
    resolvedWorkspaceThreadId: resolved?.scope === scope && resolved.path ? resolved.workspaceThreadId : null,
    turnPhase
  })

  useEffect(() => {
    if (warmOnly) return
    let cancelled = false
    void resolveShared(scope, activeThreadId).then((workspace) => {
      if (!cancelled) setResolved({ scope, ...workspace })
    }).catch(() => { if (!cancelled) setResolved({ scope, path: null, workspaceThreadId: null }) })
    return () => { cancelled = true }
  }, [activeThreadId, profileId, scope, recheck, warmOnly, attempt])

  const location = resolveActiveProject({
    isNewChat,
    draftProjectId,
    threadProjectId,
    projects,
    resolved: resolved?.scope === scope
      ? { path: resolved.path, loading: false, workspaceThreadId: resolved.workspaceThreadId, workspaceGeneration: resolved.workspaceGeneration, unavailable: resolved.unavailable }
      : { path: null, loading: true, workspaceThreadId: null }
  })
  return { ...location, retry: () => setAttempt((count) => count + 1) }
}

export function useActiveProjectPath(): string | null {
  return useActiveProjectLocation().path
}

export function useFilesRoot(): { root: string; label: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const [root, setRoot] = useState('')
  const [label, setLabel] = useState('~')

  useEffect(() => {
    let cancelled = false
    setRoot('')
    setLabel('~')
    void window.mousse.app.getFilesRoot(activeThreadId).then((filesRoot) => {
      if (cancelled) return
      setRoot(filesRoot)
      setLabel(filesRoot || '~')
    }).catch(() => { if (!cancelled) setRoot('') })
    return () => { cancelled = true }
  }, [activeThreadId, profileId])

  return { root, label }
}
