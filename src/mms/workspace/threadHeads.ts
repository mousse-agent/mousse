import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

/** A folder's branch from Git's files; a folder whose drive does not answer, or that cannot be read, says why. */
export async function folderHead(path: string): Promise<GitFolderHead> {
  try {
    await waitForFolderAccess([resolve(path)], { whenNotAnswering: 'fail' })
    return await folderBranch(path)
  } catch (error) {
    return { error: errorText(error) }
  }
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
 * yet; else its worktree's branch, with the folder it works in when the worktree is on disk and ready.
 */
export async function threadHead(threadDirectory: string): Promise<GitThreadHead> {
  const record = await readRecord(threadDirectory)
  if (!record || record.kind === 'project-folder') return { project: true }
  const recorded: GitThreadHead = { own: true, branch: record.branch || null }
  if (record.lifecycle !== 'ready') return recorded
  try {
    await waitForFolderAccess([resolve(record.worktreePath)], { whenNotAnswering: 'fail' })
    const head = await readFolderHead(record.worktreePath)
    // Not on disk (retired, or its `.git` gone, so a folder above answers): the branch Mousse made for it.
    if (!head?.repo || !sameFolder(head.top, record.worktreePath)) return recorded
    const sub = record.projectRelativeSubdirectory
    return { own: true, branch: head.branch, folder: !sub || sub === '.' ? record.worktreePath : join(record.worktreePath, sub) }
  } catch {
    return recorded
  }
}
