import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitFolderHead, GitThreadHead } from '../../shared/types'
import { volumeKey, waitForFolderAccess } from '../files/folderAccess'
import { folderBranch } from '../git/gitHead'
import type { WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'

/**
 * The branches the sidebar's thread cards name (`git.heads`), without a Git process in steady state: a project's
 * folder and a thread's own worktree are read from Git's files (`gitHead`), and a worktree that is not on disk (being
 * set up, retired by a storage rule) names the branch Mousse recorded for it. Mousse's own changes to a thread's branch
 * (its worktree is made, its branch is renamed) are pushed as `git.headsChanged` (`noteThreadBranchChanged`).
 */

const listeners = new Set<(threadId: string) => void>()

/** Calls `listener` with the thread whose recorded branch Mousse just changed. Returns the unsubscribe. */
export function onThreadBranchChanged(listener: (threadId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Mousse made the thread's worktree, or renamed its branch: windows read its card's branch again. Never throws. */
export function noteThreadBranchChanged(threadId: string): void {
  for (const listener of listeners) {
    try { listener(threadId) } catch { /* A window reads it again on its next focus. */ }
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A folder's reads that have not answered by then answer that the drive is not answering; they finish in the background. */
export const HEAD_ANSWER_MS = 2_000
/** Reads running at once on one drive: a drive that hangs holds at most this many of Node's few file threads. */
const PER_DRIVE = 2
/** After a read on a drive did not answer, its other folders answer at once that it is not answering, for this long. */
const STALLED_FOR_MS = 10_000

interface Drive { running: number; queue: Set<() => void>; stalledUntil: number }
const drives = new Map<string, Drive>()
const notAnswering = (volume: string): string => `The drive at ${volume} is not answering.`

/** Number of branch reads waiting for a slot on this path's drive. */
export function pendingHeadReads(path: string): number {
  return drives.get(volumeKey(path))?.queue.size ?? 0
}

/**
 * Runs `work`, which reads files on `path`'s drive, at most {@link PER_DRIVE} at a time per drive, and answers
 * `stalled` when it has not finished within {@link HEAD_ANSWER_MS} or the drive did not answer a moment ago.
 */
async function onDrive<T>(path: string, work: () => Promise<T>, stalled: (reason: string) => T, deadline = Date.now() + HEAD_ANSWER_MS, fresh = false): Promise<T> {
  const key = volumeKey(path)
  let drive = drives.get(key)
  if (!drive) drives.set(key, drive = { running: 0, queue: new Set(), stalledUntil: 0 })
  const d = drive
  // A retry can use a free slot even if another read on this drive stalled.
  if (Date.now() >= deadline || (!fresh && Date.now() < d.stalledUntil)) return stalled(notAnswering(key))
  const release = () => {
    d.running--
    const next = d.queue.values().next().value
    if (next) {
      d.queue.delete(next)
      next()
    }
  }
  let admitted!: () => void
  const turn = new Promise<void>((done) => { admitted = done })
  const start = () => {
    d.running++
    admitted()
  }
  if (d.running < PER_DRIVE) start()
  else d.queue.add(start)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((done) => { timer = setTimeout(() => done('late'), Math.max(0, deadline - Date.now())) })
  try {
    if (await Promise.race([turn.then(() => 'turn' as const), late]) === 'late') {
      // Drop the waiter immediately. If it already received a slot, hand that slot on.
      if (!d.queue.delete(start)) release()
      return stalled(notAnswering(key))
    }
    if (!fresh && Date.now() < d.stalledUntil) {
      release()
      return stalled(notAnswering(key))
    }
    const answer = await Promise.race([work().finally(release), late])
    if (answer !== 'late') return answer
    d.stalledUntil = Date.now() + STALLED_FOR_MS
    return stalled(notAnswering(key))
  } finally {
    clearTimeout(timer)
  }
}

/** A folder's branch from Git's files; a folder whose drive does not answer, or that cannot be read, says why. */
export async function folderHead(path: string): Promise<GitFolderHead> {
  return onDrive(path, async () => {
    try {
      await waitForFolderAccess([resolve(path)], { whenNotAnswering: 'fail' })
      return await folderBranch(path)
    } catch (error) {
      return { error: errorText(error) }
    }
  }, (reason) => ({ error: reason }))
}

const missingFile = (error: NodeJS.ErrnoException): undefined => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
  throw error
}

/** The project-folder record takes precedence, as in `ThreadWorkspaceManager.workspacePath`. */
export async function readWorkspaceRecord(threadDirectory: string): Promise<ThreadWorkspaceMetadata | undefined> {
  for (const name of ['project-folder.json', 'workspace.json']) {
    const text = await readFile(join(threadDirectory, name), 'utf8').catch(missingFile)
    if (text === undefined) continue
    const record = JSON.parse(text) as ThreadWorkspaceMetadata
    if (!record || typeof record.worktreePath !== 'string') throw new Error('The thread’s workspace record is unreadable.')
    return record
  }
  return undefined
}

async function readPlacement(threadDirectory: string): Promise<'worktree' | 'project-folder'> {
  const text = await readFile(join(threadDirectory, 'meta.json'), 'utf8').catch(missingFile)
  return text !== undefined && (JSON.parse(text) as { worktreeEnabled?: unknown }).worktreeEnabled === false ? 'project-folder' : 'worktree'
}

const WORKTREE_NOT_A_CHECKOUT = 'The worktree folder is not a Git checkout.'

type ThreadLocation = { directory: string; placement?: 'worktree' | 'project-folder' }

/**
 * Looks up the thread, checks its workspace record around the branch read, and shares one deadline across those
 * steps. Each occupies a slot on its own drive. No reads create, register, or restore a worktree.
 */
export async function threadHead(profileHome: string, locate: () => Promise<ThreadLocation | undefined>, retirement: WorktreeRetirementService, fresh = false): Promise<GitThreadHead> {
  const deadline = Date.now() + HEAD_ANSWER_MS
  const error = (reason: string) => ({ error: reason })
  try {
    const known = await onDrive<ThreadLocation | ReturnType<typeof error> | undefined>(profileHome, locate, error, deadline, fresh)
    if (!known) return { error: 'Thread not found' }
    if ('error' in known) return known

    const state = await onDrive<{ record?: ThreadWorkspaceMetadata; project: boolean; rebuilding: boolean } | ReturnType<typeof error>>(known.directory, async () => {
      const record = await readWorkspaceRecord(known.directory)
      const project = record ? record.kind === 'project-folder' : (known.placement ?? await readPlacement(known.directory)) === 'project-folder'
      const rebuilding = !project && record?.lifecycle === 'ready' &&
        (record.rebuilding === true || await retirement.rebuildUnfinishedAsync(record.threadId, record.worktreePath))
      return { record, project, rebuilding }
    }, error, deadline, fresh)
    if ('error' in state) return state
    if (state.project) return { project: true }
    const { record } = state
    if (!record) return { own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' }
    const recorded = { own: true as const, branch: record.branch || null, generation: record.generation ?? 0, lifecycle: record.lifecycle }
    if (record.lifecycle !== 'ready') return recorded
    const missing = { ...recorded, missing: true as const }
    if (state.rebuilding) return missing

    const unavailable = (reason: string) => ({ ...recorded, unavailable: reason })
    const head = await onDrive<GitThreadHead>(record.worktreePath, async () => {
      try {
        await waitForFolderAccess([resolve(record.worktreePath)], { whenNotAnswering: 'fail' })
        const info = await stat(record.worktreePath).catch(missingFile)
        if (!info) return missing
        if (!info.isDirectory()) return unavailable(WORKTREE_NOT_A_CHECKOUT)

        const checked = await folderBranch(record.worktreePath, { requireRoot: true })
        if (!checked.repo) return unavailable(WORKTREE_NOT_A_CHECKOUT)
        const sub = record.projectRelativeSubdirectory
        const folder = !sub || sub === '.' ? record.worktreePath : join(record.worktreePath, sub)
        return { ...recorded, branch: checked.branch, ...(checked.detachedAt !== undefined ? { detachedAt: checked.detachedAt } : {}), folder }
      } catch (failure) {
        return unavailable(errorText(failure))
      }
    }, unavailable, deadline, fresh)
    if (!('folder' in head) || !head.folder) return head
    return await onDrive<GitThreadHead>(known.directory, async () => {
      if (await retirement.rebuildUnfinishedAsync(record.threadId, record.worktreePath)) return missing
      const current = await readWorkspaceRecord(known.directory)
      if (current?.lifecycle !== 'ready' || current.rebuilding || (current.generation ?? 0) !== recorded.generation || current.worktreePath !== record.worktreePath) return missing
      return head
    }, unavailable, deadline, fresh)
  } catch (failure) {
    return error(errorText(failure))
  }
}
