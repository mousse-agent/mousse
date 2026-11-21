import { useEffect } from 'react'
import { create } from 'zustand'
import { isTurnActivePhase, type GitFolderHead, type GitHeadsChangedEvent, type GitThreadHead, type Thread } from '../../shared/types'
import { folderKey } from '../lib/activeProject'
import { anyTurnEnded } from '../lib/turnEnded'
import { useAppStore } from '../stores/appStore'
import { useGitStatusStore } from '../stores/gitStatusStore'

/**
 * The branch a thread's card names: the branch of the thread's own worktree, else of its project's folder. The daemon
 * reads it from Git's files (`git.heads`), never with a Git process, and the cards shown are read together in one call:
 * when they first show, on window focus, when a run ends (every project, and the thread whose run it was), and when
 * Mousse changes a thread's branch (`git.headsChanged`: its worktree is made, its branch renamed). The daemon reads a
 * `HEAD` file again only when it changed. A newer read of a project's folder by the Git panel wins. A read that fails
 * changes nothing shown; the next of those moments reads again.
 *
 * A worktree that is not on disk (being set up, retired by a storage rule) names the branch Mousse recorded for it:
 * nothing here sets a worktree up or brings one back.
 */

/**
 * A folder's branch as last read: null when it is not a repository or has no branch checked out.
 * A thread with no worktree of its own reads as `project`: its card names its project's branch.
 */
interface BranchRead {
  branch: string | null
  /** HEAD names a commit (this one, its short id; '' when not known) instead of a branch. Never a failed read. */
  detachedAt?: string
  /** The folder is a Git repository (only on a project's read). */
  repo?: boolean
  /** The thread works in its own worktree (only on a thread's read). */
  own?: boolean
  /** The thread has no worktree of its own (only on a thread's read). */
  project?: boolean
  readAt: number
  /** Kept from the last launch (`seedBranchReads`): shown at once, and read again when its card first shows. */
  seeded?: boolean
}

const useBranchReads = create<Record<string, BranchRead>>(() => ({}))
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

/** Keys waiting for the next read; every card that asks before it starts is read in the same call. */
const pending = new Set<string>()
let flushing: ReturnType<typeof setTimeout> | undefined
let readCount = 0
/** The number of the read whose answer each key shows: an older read's late answer never replaces a newer one's. */
const shownRead = new Map<string, number>()

/** The window shows its warm start and does not know its profile yet: nothing is read for its threads until it does. */
const warmOnly = (state: ReturnType<typeof useAppStore.getState>): boolean => !state.profileReady && state.warmView !== null

function request(keys: Iterable<string>) {
  for (const key of keys) pending.add(key)
  if (flushing === undefined && pending.size) flushing = setTimeout(flush, 0)
}

// A failed read (`error`) answers nothing: the card keeps what it shows.
function fromProject(head: GitFolderHead | undefined): Omit<BranchRead, 'readAt'> | undefined {
  if (!head || 'error' in head) return undefined
  return { branch: head.repo ? head.branch : null, repo: head.repo, ...(head.repo && head.detachedAt !== undefined ? { detachedAt: head.detachedAt } : {}) }
}

function fromThread(head: GitThreadHead | undefined): Omit<BranchRead, 'readAt'> | undefined {
  if (!head || 'error' in head) return undefined
  return 'project' in head ? { branch: null, project: true } : { branch: head.branch, own: true, ...(head.detachedAt !== undefined ? { detachedAt: head.detachedAt } : {}) }
}

/**
 * Shows what the cards named when the window last closed, before anything is read (`app.warmStartView`): a card that
 * first shows names its branch at once, and the read that follows replaces it. Never replaces a read of this window.
 */
export function seedBranchReads(heads: { threads?: Record<string, GitThreadHead>; projects?: Record<string, GitFolderHead> } | undefined, threadProjects: Record<string, string>): void {
  if (!heads) return
  const current = useBranchReads.getState()
  const seeds: Record<string, BranchRead> = {}
  for (const [projectId, head] of Object.entries(heads.projects ?? {})) {
    const read = fromProject(head)
    const key = projectKey(projectId)
    if (read && !current[key]) seeds[key] = { ...read, readAt: 0, seeded: true }
  }
  for (const [threadId, head] of Object.entries(heads.threads ?? {})) {
    const read = fromThread(head)
    const projectId = threadProjects[threadId]
    const key = projectId ? threadKey(threadId, projectId) : null
    if (read && key && !current[key]) seeds[key] = { ...read, readAt: 0, seeded: true }
  }
  if (Object.keys(seeds).length) useBranchReads.setState(seeds)
}

function flush() {
  flushing = undefined
  const api = window.mousse?.git
  // Read once the profile is known (`attach`); until then the keys wait.
  if (!api?.heads || warmOnly(useAppStore.getState())) return
  const reads = [...pending].flatMap((key) => {
    const entry = watched.get(key)
    return entry ? [{ key, ...entry.target }] : []
  })
  pending.clear()
  if (!reads.length) return
  const count = ++readCount
  const threadIds = new Set<string>()
  const projectIds = new Set<string>()
  for (const { threadId, projectId } of reads) {
    if (threadId) threadIds.add(threadId)
    else projectIds.add(projectId)
  }
  void api.heads({ threadIds: [...threadIds], projectIds: [...projectIds] }).then((result) => {
    const now = Date.now()
    const changes: Record<string, BranchRead> = {}
    for (const { key, threadId, projectId } of reads) {
      if ((shownRead.get(key) ?? 0) > count) continue
      const read = threadId ? fromThread(result.threads[threadId]) : fromProject(result.projects[projectId])
      if (!read) continue
      shownRead.set(key, count)
      changes[key] = { ...read, readAt: now }
    }
    if (Object.keys(changes).length) useBranchReads.setState(changes)
  }, () => undefined)
}

function attach() {
  if (detach) return
  const readAll = () => request(watched.keys())
  window.addEventListener('focus', readAll)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    // The window's profile is known: the cards shown meanwhile are read now.
    if (warmOnly(previous) && !warmOnly(state)) {
      readAll()
      return
    }
    if (!anyTurnEnded(previous.turnStates, state.turnStates)) return
    const ended: string[] = []
    for (const [key, { target }] of watched) {
      if (!target.threadId) { ended.push(key); continue }
      const before = previous.turnStates[target.threadId]
      const after = state.turnStates[target.threadId]
      if (before && after && isTurnActivePhase(before.phase) && !isTurnActivePhase(after.phase)) ended.push(key)
    }
    request(ended)
  })
  const stopHeads = window.mousse?.git?.onHeadsChanged?.((event: GitHeadsChangedEvent) => {
    const threads = new Set(event?.threadIds ?? [])
    request([...watched].filter(([, { target }]) => target.threadId && threads.has(target.threadId)).map(([key]) => key))
  })
  detach = () => {
    window.removeEventListener('focus', readAll)
    unsubscribe()
    stopHeads?.()
  }
}

function watch(key: string, target: Target): () => void {
  watched.set(key, { count: (watched.get(key)?.count ?? 0) + 1, target })
  attach()
  // Read once (a card seeded from the last launch is read too); after that, only the moments above read it again.
  const known = useBranchReads.getState()[key]
  if (!known || known.seeded) request([key])
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
function useProjectFolderBranch(projectId: string | null): { repo: boolean; branch: string | null; detachedAt?: string } | undefined {
  const key = projectId ? projectKey(projectId) : null
  const gitKey = projectId ? folderKey({ projectId, workspaceThreadId: null }) : null
  const own = useBranchReads((state) => (key ? state[key] : undefined))
  const sharedStatus = useGitStatusStore((state) => (gitKey ? state.entries[gitKey]?.status : undefined))
  const sharedAt = useGitStatusStore((state) => (gitKey ? state.entries[gitKey]?.fetchedAt ?? 0 : 0))

  useEffect(() => (key && projectId ? watch(key, { projectId }) : undefined), [key, projectId])

  if (!key) return undefined
  if (sharedStatus && sharedAt >= (own?.readAt ?? 0)) {
    const detached = sharedStatus.isRepo && sharedStatus.tracking === 'detached'
    return { repo: sharedStatus.isRepo, branch: sharedStatus.isRepo ? sharedStatus.branch : null, ...(detached ? { detachedAt: '' } : {}) }
  }
  return own ? { repo: Boolean(own.repo), branch: own.branch, ...(own.detachedAt !== undefined ? { detachedAt: own.detachedAt } : {}) } : undefined
}

export interface ThreadBranch {
  /** The branch's name; for a detached HEAD, `detached` and the commit. */
  branch: string
  /** The branch is the thread's own worktree's, not its project folder's. */
  worktree: boolean
  /** HEAD names a commit, not a branch. */
  detached?: boolean
}

/** What a card names for a read: its branch, `detached <commit>` for a detached HEAD, else nothing. */
function named(read: { branch: string | null; detachedAt?: string }, worktree: boolean): ThreadBranch | undefined {
  if (read.branch) return { branch: read.branch, worktree }
  if (read.detachedAt !== undefined) return { branch: read.detachedAt ? `detached ${read.detachedAt}` : 'detached', worktree, detached: true }
  return undefined
}

/**
 * The branch a thread's card names, or undefined while unknown and where there is none: a thread without a project or
 * of another computer, a project that is not a Git repository, a folder with no branch checked out.
 */
export function useThreadBranch(thread: Pick<Thread, 'projectId' | 'node' | 'worktreeEnabled'>, threadId: string): ThreadBranch | undefined {
  const projectId = thread.projectId && !thread.node ? thread.projectId : null
  const folder = useProjectFolderBranch(projectId)
  // A thread that chose its project's folder has no worktree to look for; nor does one of a folder known to be without
  // Git. One whose project folder has not answered (a drive asleep) is still read: its worktree may be elsewhere.
  const key = projectId && thread.worktreeEnabled !== false && folder?.repo !== false ? threadKey(threadId, projectId) : null
  const own = useBranchReads((state) => (key ? state[key] : undefined))

  useEffect(() => (key && projectId ? watch(key, { projectId, threadId }) : undefined), [key, projectId, threadId])

  const projectBranch = folder?.repo ? named(folder, false) : undefined
  if (!key) return projectBranch
  // Until the worktree is read (or seeded), nothing: the project's branch could be the wrong one.
  if (!own) return undefined
  if (own.project) return projectBranch
  return named(own, true)
}
