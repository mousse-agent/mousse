import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { folderRecheckKey, resolveActiveProject, type ActiveProject } from '../lib/activeProject'
import { isNewEmptyThread, localWorkspaceFor } from '../lib/newThread'
import { useAppStore } from '../stores/appStore'
import { isQualifiedId } from '../../shared/threadRef'
import { useComputer } from '../lib/computers'

interface ResolvedWorkspace {
  path: string | null
  pending?: boolean
  /** The thread whose ready worktree `path` is, when it is one. */
  workspaceThreadId: string | null
  /** That worktree's generation. */
  workspaceGeneration?: number
  /** Why the thread's own worktree cannot be read now; `path` is then null. */
  unavailable?: string
  /**
   * For a thread of another computer whose worktree is not made yet: the project folder that computer reads the
   * thread's files in meanwhile (`files.list` there). The Files panel shows it; `path` stays null for the Git section.
   */
  filesFolder?: string
}

/** Said when a storage rule retired the thread's worktree: it comes back when the thread runs or its files are opened. */
export const WORKTREE_NOT_ON_DISK = 'Worktree not on disk'
/** Said for a worktree Mousse records as ready that the service did not name a folder for (an older service). */
const WORKTREE_NOT_READY = 'Worktree not ready'

/** Reads a remote thread's placement and generation from the computer that owns its checkout. */
async function resolveRoutedWorkspace(threadId: string, fresh: boolean): Promise<ResolvedWorkspace> {
  try {
    const status = await window.mousse.workspace.getStatus(threadId, fresh) as {
      metadata?: { kind?: string; generation?: number; lifecycle?: string } | null
      execution?: { projectPath?: string; primaryPath?: string; generation?: number; lifecycle?: string; placement?: 'project-folder' }
      retiredByCleanup?: unknown
    }
    const { execution, metadata } = status
    if (execution?.placement === 'project-folder' || metadata?.kind === 'project-folder') {
      return { path: execution?.projectPath || await window.mousse.app.getActiveProjectPath(threadId), workspaceThreadId: null }
    }
    const lifecycle = execution?.lifecycle ?? metadata?.lifecycle
    if (!metadata || lifecycle === 'unprovisioned' || lifecycle === 'provisioning') {
      // Named only while that computer reads the project folder itself (no worktree record yet, or one only prepared).
      const filesFolder = execution?.lifecycle === 'unprovisioned' && execution.projectPath === execution.primaryPath ? execution.projectPath : undefined
      return { path: null, workspaceThreadId: threadId, pending: true, ...(filesFolder ? { filesFolder } : {}) }
    }
    if (execution?.projectPath && lifecycle === 'ready') {
      return { path: execution.projectPath, workspaceThreadId: threadId, workspaceGeneration: execution.generation ?? metadata.generation }
    }
    return {
      path: null,
      workspaceThreadId: threadId,
      unavailable: status.retiredByCleanup || lifecycle === 'missing' ? WORKTREE_NOT_ON_DISK : WORKTREE_NOT_READY
    }
  } catch (error) {
    return { path: null, workspaceThreadId: threadId, unavailable: failureText(error) }
  }
}

const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The folder the thread works in, from Mousse's record and Git's files (`git.heads`): no Git process, and nothing set up
 * or brought back to answer it. Git waits for a worktree that is still being made.
 * `attempt` makes a Retry's request its own.
 */
async function resolveWorkspaceProjectPath(threadId: string | null, attempt?: number): Promise<ResolvedWorkspace> {
  if (!threadId) return { path: await window.mousse.app.getActiveProjectPath(threadId), workspaceThreadId: null }
  if (isQualifiedId(threadId)) return resolveRoutedWorkspace(threadId, attempt !== undefined)
  let head
  try {
    head = (await window.mousse.git.heads({ threadIds: [threadId], ...(attempt ? { attempt } : {}) })).threads[threadId]
  } catch (error) {
    return { path: null, workspaceThreadId: null, unavailable: failureText(error) }
  }
  if (!head) return { path: null, workspaceThreadId: null, unavailable: 'No answer for this thread' }
  if ('error' in head) return { path: null, workspaceThreadId: null, unavailable: head.error }
  if ('own' in head) {
    const generation = { workspaceGeneration: head.generation }
    if (head.folder) return { path: head.folder, workspaceThreadId: threadId, ...generation }
    if (head.unavailable) return { path: null, workspaceThreadId: threadId, ...generation, unavailable: head.unavailable }
    if (head.missing) return { path: null, workspaceThreadId: threadId, ...generation, unavailable: WORKTREE_NOT_ON_DISK }
    if (head.lifecycle === 'unprovisioned' || head.lifecycle === 'provisioning') {
      return { path: null, workspaceThreadId: threadId, ...generation, pending: true }
    }
    return { path: null, workspaceThreadId: threadId, ...generation, unavailable: WORKTREE_NOT_READY }
  }
  return { path: await window.mousse.app.getActiveProjectPath(threadId), workspaceThreadId: null }
}

/** Lookups still running, by profile and thread: the side card, the panels and the toolbar ask at the same moment. */
const resolving = new Map<string, { lookup: Promise<ResolvedWorkspace>; at: number; fresh: number }>()
/** A lookup older than this is not joined: one that hung (a drive, a busy service) never holds a later look. */
const SHARE_MS = 2_000

/**
 * {@link resolveWorkspaceProjectPath}, with every caller that asks while one recent lookup runs sharing it. A lookup
 * asked as fresh (`fresh`, a number from {@link nextFresh}: Retry, or Mousse saying the worktree changed) joins only one
 * started for that number or a later one; callers that ask with the same number share it.
 */
function resolveShared(scope: string, threadId: string | null, fresh = 0): Promise<ResolvedWorkspace> {
  const running = resolving.get(scope)
  if (running && running.fresh >= fresh && Date.now() - running.at < SHARE_MS) return running.lookup
  const entry = { lookup: resolveWorkspaceProjectPath(threadId, fresh || undefined), at: Date.now(), fresh }
  entry.lookup = entry.lookup.finally(() => { if (resolving.get(scope) === entry) resolving.delete(scope) })
  resolving.set(scope, entry)
  return entry.lookup
}

/** Numbers fresh lookups (Retry, a worktree change), so their request is never answered by one already in flight. */
let freshLookups = 0
const nextFresh = (): number => ++freshLookups

/**
 * The fresh-lookup number of each thread's last worktree change (`git.headsChanged`): every surface showing the thread
 * looks it up again with the same number, so they share one lookup.
 */
const changedAt = new Map<string, number>()
const changeListeners = new Set<() => void>()
let stopChanges: (() => void) | undefined
function subscribeChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  stopChanges ??= window.mousse?.git?.onHeadsChanged?.((event) => {
    for (const threadId of event?.threadIds ?? []) changedAt.set(threadId, nextFresh())
    for (const notify of changeListeners) notify()
  })
  return () => {
    changeListeners.delete(listener)
    if (!changeListeners.size) {
      stopChanges?.()
      stopChanges = undefined
    }
  }
}

// No worktree change has been heard before the window is live (a server render).
const noChange = (): number => 0

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
  const { projectId: draftProjectId, worktreeEnabled: draftWorktree } = useAppStore(useShallow((s) => {
    const { projectId, worktreeEnabled } = localWorkspaceFor(
      s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'],
      s.threads.find((thread) => thread.id === s.activeThreadId),
      s.projects
    )
    return { projectId, worktreeEnabled }
  }))
  const scope = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [resolved, setResolved] = useState<({ scope: string; changed: number } & ResolvedWorkspace) | null>(null)
  // Retry (the Git section's), and Mousse saying the thread's worktree changed (made, rebuilt, restored, its branch
  // renamed), look the folder up again: fresh, never answered by a lookup already running.
  const changed = useSyncExternalStore(subscribeChanges, () => (activeThreadId ? changedAt.get(activeThreadId) ?? 0 : 0), noChange)
  const [retried, setRetried] = useState<{ scope: string; fresh: number } | null>(null)
  const fresh = Math.max(changed, retried?.scope === scope ? retried.fresh : 0)
  const retry = useCallback(() => setRetried({ scope, fresh: nextFresh() }), [scope])
  // A thread of another computer whose lookup failed (that computer was offline, or did not answer) is looked up again
  // when the computers are read again and list it online: at most once per read, never in a loop.
  const node = useAppStore((s) => (s.activeThreadId && isQualifiedId(s.activeThreadId) ? s.threads.find((thread) => thread.id === s.activeThreadId)?.node : undefined))
  const computer = useComputer(node)
  const lookupFailed = Boolean(node) && resolved?.scope === scope && Boolean(resolved.unavailable) && !resolved.path
  useEffect(() => {
    if (lookupFailed && computer?.online) retry()
    // `computer` is a new object each time the computers are read.
  }, [computer, lookupFailed, retry])
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
    void resolveShared(scope, activeThreadId, fresh).then((workspace) => {
      if (!cancelled) setResolved({ scope, changed, ...workspace })
    }).catch((error: unknown) => { if (!cancelled) setResolved({ scope, changed, path: null, workspaceThreadId: null, unavailable: failureText(error) }) })
    return () => { cancelled = true }
  }, [activeThreadId, scope, recheck, warmOnly, changed, fresh])

  const location = resolveActiveProject({
    isNewChat,
    draftProjectId,
    draftWorktree,
    threadProjectId,
    projects,
    resolved: resolved?.scope === scope && resolved.changed === changed
      ? { path: resolved.path, loading: resolved.pending === true, provisioning: resolved.pending, workspaceThreadId: resolved.workspaceThreadId, workspaceGeneration: resolved.workspaceGeneration, unavailable: resolved.unavailable }
      : { path: null, loading: true, workspaceThreadId: null }
  })
  return { ...location, retry }
}

export function useActiveProjectPath(): string | null {
  return useActiveProjectLocation().path
}

/** Said when a thread of another computer has no folder there (no project). */
const NO_THREAD_FOLDER = 'This thread has no folder'

/**
 * The folder the Files panel and the terminal name for the selected thread. Empty with `unavailable` when the
 * lookup finished without one, so a panel says why instead of loading forever.
 */
export function useFilesRoot(): { root: string; label: string; loading: boolean; unavailable?: string } {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const scope = `${profileId}:${activeThreadId ?? '__blank__'}`
  const [resolved, setResolved] = useState<{ scope: string; root: string; unavailable?: string } | null>(null)
  // Follow the daemon's Files root when a turn makes the first checkout or a later workspace change replaces it.
  const changed = useSyncExternalStore(subscribeChanges, () => activeThreadId ? changedAt.get(activeThreadId) ?? 0 : 0, noChange)
  const hasProject = useAppStore((s) => Boolean(activeThreadId && s.threads.find((thread) => thread.id === activeThreadId)?.projectId))
  const turnPhase = useAppStore((s) => activeThreadId && hasProject ? s.turnStates[activeThreadId]?.phase ?? null : null)

  useEffect(() => {
    let cancelled = false
    const settle = (root: string, unavailable?: string): void => {
      if (!cancelled) setResolved({ scope, root, ...(root ? {} : { unavailable: unavailable || 'No folder' }) })
    }
    if (activeThreadId && isQualifiedId(activeThreadId)) {
      // `files.root` answers a window of the thread's own computer only. A thread of another computer names its folder
      // through the routed workspace lookup the side card shares; listing and reading go to that computer by thread.
      void resolveShared(scope, activeThreadId, changed).then((workspace) => {
        if (workspace.path) settle(workspace.path)
        else if (workspace.filesFolder) settle(workspace.filesFolder)
        // A worktree still being made: the next turn phase or worktree change looks again.
        else if (workspace.pending && hasProject) return
        else settle('', workspace.unavailable ?? NO_THREAD_FOLDER)
      }, (error: unknown) => settle('', failureText(error)))
      return () => { cancelled = true }
    }
    void window.mousse.app.getFilesRoot(activeThreadId, changed > 0 || turnPhase !== null).then(
      (root) => settle(root),
      (error: unknown) => settle('', failureText(error))
    )
    return () => { cancelled = true }
  }, [activeThreadId, scope, changed, turnPhase, hasProject])

  const loading = resolved?.scope !== scope
  const root = loading ? '' : resolved.root
  return { root, label: root || '~', loading, ...(!loading && resolved.unavailable ? { unavailable: resolved.unavailable } : {}) }
}
