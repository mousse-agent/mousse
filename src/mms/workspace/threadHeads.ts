import { readFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import type { GitFolderHead, GitThreadHead } from '../../shared/types'
import { waitForFolderAccess } from '../files/folderAccess'
import { folderBranch, readFolderHead } from '../git/gitHead'
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

interface Drive { running: number; queue: Array<() => void>; stalledUntil: number }
const drives = new Map<string, Drive>()
const driveOf = (path: string): string => {
  const root = parse(resolve(path)).root
  return process.platform === 'win32' ? root.toLowerCase() : root
}
const notAnswering = (path: string): string => `The drive at ${parse(resolve(path)).root} is not answering.`

/**
 * Runs `work`, which reads files on `path`'s drive, at most {@link PER_DRIVE} at a time per drive, and answers
 * `stalled` when it has not finished within {@link HEAD_ANSWER_MS} or the drive did not answer a moment ago.
 */
async function onDrive<T>(path: string, work: () => Promise<T>, stalled: (reason: string) => T): Promise<T> {
  const key = driveOf(path)
  let drive = drives.get(key)
  if (!drive) drives.set(key, drive = { running: 0, queue: [], stalledUntil: 0 })
  const d = drive
  // A drive that did not answer a moment ago is not asked again yet, nor waited for.
  if (Date.now() < d.stalledUntil) return stalled(notAnswering(path))
  const release = () => {
    d.running--
    d.queue.shift()?.()
  }
  let gaveUp = false
  // A slot on the drive; one handed to a caller that already gave up is handed on at once.
  const turn = new Promise<void>((done) => {
    const go = () => {
      d.running++
      if (gaveUp) release()
      else done()
    }
    if (d.running < PER_DRIVE) go()
    else d.queue.push(go)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((done) => { timer = setTimeout(() => done('late'), HEAD_ANSWER_MS) })
  try {
    if (await Promise.race([turn.then(() => 'turn' as const), late]) === 'late') {
      gaveUp = true
      return stalled(notAnswering(path))
    }
    if (Date.now() < d.stalledUntil) {
      release()
      return stalled(notAnswering(path))
    }
    const answer = await Promise.race([work().finally(release), late])
    if (answer !== 'late') return answer
    d.stalledUntil = Date.now() + STALLED_FOR_MS
    return stalled(notAnswering(path))
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

/** The thread's workspace record, read without blocking; undefined when it has none or it cannot be read. */
async function readRecord(threadDirectory: string): Promise<ThreadWorkspaceMetadata | undefined> {
  // The project folder's record wins, as `ThreadWorkspaceManager.workspacePath` has it.
  for (const name of ['project-folder.json', 'workspace.json']) {
    const text = await readFile(join(threadDirectory, name), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    try {
      const value = JSON.parse(text) as ThreadWorkspaceMetadata
      return value && typeof value.worktreePath === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const sameFolder = (a: string, b: string): boolean =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

/**
 * What a thread's card names: its project's branch (`project`) when it works in its project's folder or has no worktree
 * yet; else its worktree's branch, with the folder it works in when the worktree is on disk and ready. Reads files
 * only: it never sets a worktree up or brings one back.
 */
export async function threadHead(threadDirectory: string): Promise<GitThreadHead> {
  const record = await readRecord(threadDirectory)
  if (!record || record.kind === 'project-folder') return { project: true }
  const recorded = { own: true as const, branch: record.branch || null, generation: record.generation ?? 0, lifecycle: record.lifecycle }
  if (record.lifecycle !== 'ready') return recorded
  // A drive that does not answer: the branch Mousse recorded, and no folder to work in for now.
  return onDrive(record.worktreePath, async (): Promise<GitThreadHead> => {
    try {
      try {
        await waitForFolderAccess([resolve(record.worktreePath)], { whenNotAnswering: 'fail' })
      } catch (error) {
        return { ...recorded, unavailable: errorText(error) }
      }
      const head = await readFolderHead(record.worktreePath)
      // Not on disk (retired, or its `.git` gone, so a folder above answers): the branch Mousse made for it.
      if (!head?.repo || !sameFolder(head.top, record.worktreePath)) return recorded
      const sub = record.projectRelativeSubdirectory
      return {
        ...recorded,
        branch: head.branch,
        ...(head.commit ? { detachedAt: head.commit.slice(0, 7) } : {}),
        folder: !sub || sub === '.' ? record.worktreePath : join(record.worktreePath, sub)
      }
    } catch {
      return recorded
    }
  }, (reason) => ({ ...recorded, unavailable: reason }))
}
