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
 * when they first show, on window focus, when a run ends (every project, and the thread whose run it was), when
 * Mousse changes a thread's branch (`git.headsChanged`: its worktree is planned or made, its branch renamed), and every
 * few seconds while the window is visible, so a checkout, detach or rebase made by hand shows soon. The daemon reads a
 * `HEAD` file again only when it changed; otherwise a read costs a few file system calls. A newer read of a project's
 * folder by the Git panel wins. A read that fails changes nothing shown, and is read once more a moment later.
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
/** Older services answer with Git reads. Refresh those cards on explicit triggers only. */
let legacy = false
/** The number of the read whose answer each key shows: an older read's late answer never replaces a newer one's. */
const shownRead = new Map<string, number>()
/** Keys whose next read is the one read again after a failure: if it fails too, the regular reads carry on. */
const recovering = new Set<string>()

/** The window shows its warm start and does not know its profile yet: nothing is read for its threads until it does. */
const warmOnly = (state: ReturnType<typeof useAppStore.getState>): boolean => !state.profileReady && state.warmView !== null

function request(keys: Iterable<string>, recovery = false) {
  for (const key of keys) {
    pending.add(key)
    if (recovery) recovering.add(key)
  }
  if (flushing === undefined && pending.size) flushing = setTimeout(flush, 0)
}

// A failed read (`error`) answers nothing: the card keeps what it shows.
function fromProject(head: GitFolderHead | undefined): Omit<BranchRead, 'readAt'> | undefined {
  if (!head || 'error' in head) return undefined
  return { branch: head.repo ? head.branch : null, repo: head.repo, ...(head.repo && head.detachedAt !== undefined ? { detachedAt: head.detachedAt } : {}) }
}

function fromThread(head: GitThreadHead | undefined): Omit<BranchRead, 'readAt'> | undefined {
  if (!head || 'error' in head || ('own' in head && head.unavailable)) return undefined
  return 'project' in head ? { branch: null, project: true } : { branch: head.branch, own: true, ...(head.detachedAt !== undefined ? { detachedAt: head.detachedAt } : {}) }
}

/** Whether a read names what the card already shows. */
const sameRead = (read: Omit<BranchRead, 'readAt'>, shown: BranchRead | undefined): shown is BranchRead =>
  shown !== undefined && read.branch === shown.branch && read.detachedAt === shown.detachedAt && read.repo === shown.repo &&
  read.own === shown.own && read.project === shown.project

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
  const recovery = new Set(reads.filter(({ key }) => recovering.delete(key)).map(({ key }) => key))
  recovering.clear()
  if (!reads.length) return
  const count = ++readCount
  const threadIds = new Set<string>()
  const projectIds = new Set<string>()
  for (const { threadId, projectId } of reads) {
    if (threadId) threadIds.add(threadId)
    else projectIds.add(projectId)
  }
  const failedOnce = (keys: string[]) => readOnceMore(keys.filter((key) => !recovery.has(key)))
  void api.heads({ threadIds: [...threadIds], projectIds: [...projectIds] }).then((result) => {
    legacy = result.legacy === true
    const now = Date.now()
    const shown = useBranchReads.getState()
    const changes: Record<string, BranchRead> = {}
    const failed: string[] = []
    for (const { key, threadId, projectId } of reads) {
      if ((shownRead.get(key) ?? 0) > count) continue
      const read = threadId ? fromThread(result.threads[threadId]) : fromProject(result.projects[projectId])
      if (!read) { failed.push(key); continue }
      shownRead.set(key, count)
      // A read that finds nothing changed leaves the card alone (no re-render), unless the Git panel read the project's
      // folder since: then this newer read is dated now, so the panel's older answer does not win over it.
      const panelAt = threadId ? 0 : useGitStatusStore.getState().entries[folderKey({ projectId, workspaceThreadId: null })!]?.fetchedAt ?? 0
      const known = shown[key]
      if (sameRead(read, known) && panelAt <= known.readAt) continue
      changes[key] = { ...read, readAt: now }
    }
    if (Object.keys(changes).length) useBranchReads.setState(changes)
    failedOnce(failed)
  }, () => failedOnce(reads.map(({ key }) => key)))
}

/** How long after a read that failed (a drive that did not answer, a service restarting) its cards are read once more. */
export const FAILED_READ_AGAIN_MS = 5_000
let again: ReturnType<typeof setTimeout> | undefined
const againKeys = new Set<string>()

/**
 * Reads the cards whose read failed once more a moment later, while they still show, so a card never stays blank or
 * stale until something unrelated happens. One read per failure: if it fails too, the regular reads carry on.
 */
function readOnceMore(keys: readonly string[]) {
  for (const key of keys) againKeys.add(key)
  if (again !== undefined || !againKeys.size) return
  again = setTimeout(() => {
    again = undefined
    const due = [...againKeys].filter((key) => watched.has(key))
    againKeys.clear()
    request(due, true)
  }, FAILED_READ_AGAIN_MS)
}

/**
 * How often the cards shown are read again while the window is visible: a checkout, detach or rebase made by hand in a
 * worktree or a project folder shows within this. Each read costs the daemon a few file system calls per card (a `HEAD`
 * file is read only when it changed) and no Git process; a card whose branch did not change does not re-render.
 */
export const HEAD_RECHECK_MS = 4_000

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
  const recheck = setInterval(() => {
    if (!legacy && document.visibilityState === 'visible') readAll()
  }, HEAD_RECHECK_MS)
  detach = () => {
    window.removeEventListener('focus', readAll)
    unsubscribe()
    stopHeads?.()
    clearInterval(recheck)
  }
}

function watch(key: string, target: Target): () => void {
  watched.set(key, { count: (watched.get(key)?.count ?? 0) + 1, target })
  attach()
  // Read once; after that, only the moments above read it again.
  if (!useBranchReads.getState()[key]) request([key])
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
  if (sharedStatus && (!own || sharedAt > own.readAt)) {
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
  // Until the worktree is read, nothing: the project's branch could be the wrong one.
  if (!own) return undefined
  if (own.project) return projectBranch
  return named(own, true)
}
