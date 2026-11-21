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
 * ends. A newer read of the same folder by the Git panel wins. A read that fails or does not answer changes nothing
 * shown and is tried again; a worktree shows the branch Mousse recorded for it until Git answers.
 *
 * A worktree is read only once the thread's workspace says it is ready and still on disk: a Git read that names a
 * thread sets up (or brings back) its worktree, which a card must never do.
 */

/**
 * A folder's branch as last read: null when it is not a repository or has no branch checked out.
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

/** A read that has not answered by then is given up on, so the card can read again; its answer still lands if it comes. */
export const BRANCH_READ_TIMEOUT_MS = 20_000
/** How long after a failed read a card reads again: a drive or Git that did not answer is tried less often each time. */
export const BRANCH_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const

/** The read running for each key, by its number; reads are numbered in the order they start. */
const reading = new Map<string, number>()
let readCount = 0
/** The number of the read whose answer each key shows: an older read's late answer never replaces a newer one's. */
const shownRead = new Map<string, number>()
/** Failed reads in a row, and the read waiting to try again, for each key. */
const failures = new Map<string, number>()
const retries = new Map<string, ReturnType<typeof setTimeout>>()

function clearRetry(key: string) {
  const timer = retries.get(key)
  if (timer !== undefined) clearTimeout(timer)
  retries.delete(key)
}

/**
 * Takes a read's answer for `key` unless a newer read's answer is already shown. Only a read's last answer (`final`)
 * ends its key's run of failures: the recorded branch shown while Git has not answered does not.
 */
function land(key: string, count: number, read: Omit<BranchRead, 'readAt'>, final: boolean) {
  if ((shownRead.get(key) ?? 0) > count) return
  shownRead.set(key, count)
  if (final) {
    failures.delete(key)
    clearRetry(key)
  }
  store(key, read)
}

/**
 * A worktree's branch. The branch Mousse recorded for it shows as soon as the workspace answers (`early`), then the
 * branch Git reads there; when Git cannot be read, the recorded branch stays.
 */
async function readThread(threadId: string, projectId: string, early: (read: Omit<BranchRead, 'readAt'>) => void): Promise<Omit<BranchRead, 'readAt'>> {
  const status = await window.mousse.workspace.getStatus(threadId) as {
    metadata?: { kind?: 'project-folder'; branch?: string } | null
    execution?: { lifecycle?: string; placement?: 'project-folder' }
    retiredByCleanup?: unknown
  } | null
  if (!status?.metadata || status.metadata.kind === 'project-folder' || status.execution?.placement === 'project-folder') return { branch: null, project: true }
  const recorded = { branch: status.metadata.branch || null, own: true }
  // Not on disk now (retired, or being set up): the branch Mousse made for it.
  if (status.execution?.lifecycle !== 'ready' || status.retiredByCleanup) return recorded
  if (recorded.branch) early(recorded)
  const git = await window.mousse.git.status({ projectId, workspaceThreadId: threadId }).catch(() => null)
  return git?.isRepo ? { branch: git.branch, own: true } : recorded
}

/** The window shows its warm start and does not know its profile yet: nothing is read for its threads until it does. */
const warmOnly = (state: ReturnType<typeof useAppStore.getState>): boolean => !state.profileReady && state.warmView !== null

/**
 * Reads a key's folder. A read that fails or does not answer keeps what the card shows and tries again later
 * (`BRANCH_RETRY_MS`) while a card still shows the key: a failure never reads as "no branch".
 */
function read(key: string, target: Target) {
  const api = window.mousse
  if (!api?.git?.status || reading.has(key) || warmOnly(useAppStore.getState())) return
  clearRetry(key)
  const count = ++readCount
  reading.set(key, count)
  const { projectId, threadId } = target
  const reads = threadId
    ? readThread(threadId, projectId, (early) => land(key, count, early, false))
    : api.git.status({ projectId, workspaceThreadId: null }).then((snapshot) => ({ branch: snapshot?.isRepo ? snapshot.branch : null, repo: Boolean(snapshot?.isRepo) }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (): boolean => {
    clearTimeout(timer)
    if (reading.get(key) !== count) return false
    reading.delete(key)
    return true
  }
  const fail = () => {
    if (!finish()) return
    const failed = (failures.get(key) ?? 0) + 1
    failures.set(key, failed)
    if (!watched.has(key)) return
    const delay = BRANCH_RETRY_MS[Math.min(failed, BRANCH_RETRY_MS.length) - 1]
    retries.set(key, setTimeout(() => {
      retries.delete(key)
      const entry = watched.get(key)
      if (entry) read(key, entry.target)
    }, delay))
  }
  timer = setTimeout(fail, BRANCH_READ_TIMEOUT_MS)
  void reads.then((value) => {
    finish()
    land(key, count, value, true)
  }, fail)
}

function attach() {
  if (detach) return
  const readProjects = () => {
    for (const [key, { target }] of watched) if (!target.threadId) read(key, target)
  }
  window.addEventListener('focus', readProjects)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    // The window's profile is known: the cards shown meanwhile are read now.
    if (warmOnly(previous) && !warmOnly(state)) {
      for (const [key, { target }] of watched) read(key, target)
      return
    }
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
    else {
      // No card shows it: no read tries it again.
      watched.delete(key)
      clearRetry(key)
      failures.delete(key)
    }
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
  // A thread that chose its project's folder has no worktree to look for; nor does one of a folder known to be without
  // Git. One whose project folder has not answered (a drive asleep) is still read: its worktree may be elsewhere.
  const key = projectId && thread.worktreeEnabled !== false && folder?.repo !== false ? threadKey(threadId, projectId) : null
  const own = useBranchReads((state) => (key ? state[key] : undefined))

  useEffect(() => (key && projectId ? watch(key, { projectId, threadId }, THREAD_FRESH_MS) : undefined), [key, projectId, threadId])

  const projectBranch = folder?.repo && folder.branch ? { branch: folder.branch, worktree: false } : undefined
  if (!key) return projectBranch
  // Until the worktree is read, nothing: the project's branch could be the wrong one.
  if (!own) return undefined
  if (own.project) return projectBranch
  return own.branch ? { branch: own.branch, worktree: true } : undefined
}
