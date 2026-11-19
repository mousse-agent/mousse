import { useEffect } from 'react'
import { create } from 'zustand'
import { isTurnActivePhase, type Thread } from '../../shared/types'
import { folderKey } from '../lib/activeProject'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from '../stores/appStore'
import { useGitStatusStore } from '../stores/gitStatusStore'

/**
 * The branch a thread's card names: the branch of the thread's own worktree, else of its project's folder. Only the
 * status is read (not the log, branches and diff counts the Git panel reads). A project's folder is read once however
 * many cards show it, again on window focus and when any run ends; a worktree once, and again when its thread's run
 * ends. A newer read of the same folder by the Git panel wins.
 *
 * A worktree is read only once the thread's workspace says it is ready and still on disk: a Git read that names a
 * thread sets up (or brings back) its worktree, which a card must never do.
 */

/**
 * A folder's branch as last read: null when it is not a repository, has no branch checked out, or could not be read.
 * A thread with no worktree of its own reads as `project`: its card names its project's branch.
 */
interface BranchRead {
  branch: string | null
  /** The folder is a Git repository (only on a project's read). */
  repo?: boolean
  /** The thread works in its own worktree (only on a thread's read). */
  own?: boolean
  /** The thread has no worktree of its own (only on a thread's read). */
  project?: boolean
  readAt: number
}

/** A read younger than this is reused when another card of the same folder mounts. */
const PROJECT_FRESH_MS = 5_000
/** A worktree moves only by its own thread's runs, which read it again when they end. */
const THREAD_FRESH_MS = 60_000

const useBranchReads = create<Record<string, BranchRead>>(() => ({}))
const reading = new Set<string>()
/** What a key reads: a project's folder, or a thread's own worktree in its project. */
interface Target {
  projectId: string
  threadId?: string
}
/** The keys mounted cards show, with how many show each and what each reads. */
const watched = new Map<string, { count: number; target: Target }>()
let detach: (() => void) | null = null

const projectKey = (projectId: string) => JSON.stringify(['project', projectId])
const threadKey = (threadId: string, projectId: string) => JSON.stringify(['thread', threadId, projectId])

function store(key: string, read: Omit<BranchRead, 'readAt'>) {
  useBranchReads.setState({ [key]: { ...read, readAt: Date.now() } })
}

async function readThread(threadId: string, projectId: string): Promise<Omit<BranchRead, 'readAt'>> {
  const status = await window.mousse.workspace.getStatus(threadId) as {
    metadata?: { kind?: 'project-folder'; branch?: string } | null
    execution?: { lifecycle?: string; placement?: 'project-folder' }
    retiredByCleanup?: unknown
  } | null
  if (!status?.metadata || status.metadata.kind === 'project-folder' || status.execution?.placement === 'project-folder') return { branch: null, project: true }
  if (status.execution?.lifecycle === 'ready' && !status.retiredByCleanup) {
    const git = await window.mousse.git.status({ projectId, workspaceThreadId: threadId })
    if (git?.isRepo) return { branch: git.branch, own: true }
  }
  // Not on disk now (retired, or being set up): the branch Mousse made for it.
  return { branch: status.metadata.branch || null, own: true }
}

function read(key: string, { projectId, threadId }: Target) {
  const api = window.mousse
  if (!api?.git?.status || reading.has(key)) return
  reading.add(key)
  const reads = threadId
    ? readThread(threadId, projectId)
    : api.git.status({ projectId, workspaceThreadId: null }).then((snapshot) => ({ branch: snapshot?.isRepo ? snapshot.branch : null, repo: Boolean(snapshot?.isRepo) }))
  void reads
    .then((value) => store(key, value), () => store(key, { branch: null }))
    .finally(() => reading.delete(key))
}

function attach() {
  if (detach) return
  const readProjects = () => {
    for (const [key, { target }] of watched) if (!target.threadId) read(key, target)
  }
  window.addEventListener('focus', readProjects)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!anyTurnEnded(previous.turnStates, state.turnStates)) return
    readProjects()
    for (const [key, { target }] of watched) {
      if (!target.threadId) continue
      const before = previous.turnStates[target.threadId]
      const after = state.turnStates[target.threadId]
      if (before && after && isTurnActivePhase(before.phase) && !isTurnActivePhase(after.phase)) read(key, target)
    }
  })
  detach = () => {
    window.removeEventListener('focus', readProjects)
    unsubscribe()
  }
}

function watch(key: string, target: Target, freshMs: number): () => void {
  watched.set(key, { count: (watched.get(key)?.count ?? 0) + 1, target })
  attach()
  const last = useBranchReads.getState()[key]
  if (!last || Date.now() - last.readAt > freshMs) read(key, target)
  return () => {
    const entry = watched.get(key)
    if (entry && entry.count > 1) watched.set(key, { ...entry, count: entry.count - 1 })
    else watched.delete(key)
    if (watched.size === 0 && detach) {
      detach()
      detach = null
    }
  }
}

/** A project's folder (nothing to read when null): whether it is a Git repository and its branch; undefined until read. */
function useProjectFolderBranch(projectId: string | null): { repo: boolean; branch: string | null } | undefined {
  const key = projectId ? projectKey(projectId) : null
  const gitKey = projectId ? folderKey({ projectId, workspaceThreadId: null }) : null
  const own = useBranchReads((state) => (key ? state[key] : undefined))
  const sharedStatus = useGitStatusStore((state) => (gitKey ? state.entries[gitKey]?.status : undefined))
  const sharedAt = useGitStatusStore((state) => (gitKey ? state.entries[gitKey]?.fetchedAt ?? 0 : 0))

  useEffect(() => (key && projectId ? watch(key, { projectId }, PROJECT_FRESH_MS) : undefined), [key, projectId])

  if (!key) return undefined
  if (sharedStatus && sharedAt >= (own?.readAt ?? 0)) return { repo: sharedStatus.isRepo, branch: sharedStatus.isRepo ? sharedStatus.branch : null }
  return own ? { repo: Boolean(own.repo), branch: own.branch } : undefined
}

export interface ThreadBranch {
  branch: string
  /** The branch is the thread's own worktree's, not its project folder's. */
  worktree: boolean
}

/**
 * The branch a thread's card names, or undefined while unknown and where there is none: a thread without a project or
 * of another computer, a project that is not a Git repository, a folder with no branch checked out.
 */
export function useThreadBranch(thread: Pick<Thread, 'projectId' | 'node' | 'worktreeEnabled'>, threadId: string): ThreadBranch | undefined {
  const projectId = thread.projectId && !thread.node ? thread.projectId : null
  const folder = useProjectFolderBranch(projectId)
  // A thread that chose its project's folder has no worktree to look for; nor does one of a folder without Git.
  const key = projectId && thread.worktreeEnabled !== false && folder?.repo ? threadKey(threadId, projectId) : null
  const own = useBranchReads((state) => (key ? state[key] : undefined))

  useEffect(() => (key && projectId ? watch(key, { projectId, threadId }, THREAD_FRESH_MS) : undefined), [key, projectId, threadId])

  if (!folder?.repo) return undefined
  const projectBranch = folder.branch ? { branch: folder.branch, worktree: false } : undefined
  if (!key) return projectBranch
  // Until the worktree is read, nothing: the project's branch could be the wrong one.
  if (!own) return undefined
  if (own.project) return projectBranch
  return own.branch ? { branch: own.branch, worktree: true } : undefined
}
