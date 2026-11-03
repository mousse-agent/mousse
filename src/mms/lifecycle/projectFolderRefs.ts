import { existsSync, readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { keptFilesFromListing, PRESERVED_REF_FORMAT, PRESERVED_REFS, type KeptFilesRef } from '../actions/preservedFiles'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { lifecycleGitAsync, lifecycleReadAsync, readDirectLifecycleRefAsync } from './WorktreeRetirementService'

/** What a purge releases for a thread that worked in its project's own folder: refs only, in that folder's repository. */
export type ProjectFolderPurgeRefs =
  | { commonDir: string; refs: Array<{ ref: string; sha: string; discardReason?: string }> }
  | { unavailable: string }

/** A purge never releases anything outside Mousse's own namespace, whatever a record names. */
function releasable(ref: string): boolean {
  return ref.startsWith('refs/mousse/') && !/[\s\0]/.test(ref)
}

/**
 * The thread's own `refs/mousse/preserved/` refs in the repository of `cwd`: files set aside before a restore or an abort
 * of this thread wrote over them (see `threadPreservedIndex` for which refs are the thread's). They go with the thread's
 * other refs when it is purged; while they may be the only copy of a file they carry a `discardReason`
 * (`keptFilesFromListing`), so a purge asks the person to discard them and automatic cleanup keeps the thread. Reads only.
 */
export async function threadKeptFilesRefs(cwd: string, threadDirectory: string, now = Date.now()): Promise<KeptFilesRef[]> {
  return keptFilesFromListing(await lifecycleReadAsync(cwd, ['for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, PRESERVED_REFS]), threadDirectory, now)
}

/**
 * The refs a project-folder thread (`project-folder.json`, see `ThreadWorkspaceManager.ensureProjectFolder`) holds in
 * the person's repository, for a purge to delete one by one: its pins under `refs/mousse/threads/<id>/`, its receipts'
 * `refs/mousse/changes/<receipt>/{before,after}`, its conversation branches' pins and the files its restores kept
 * (`threadKeptFilesRefs`), each with the value it has now.
 *
 * Only reads. The record is used for its repository, never as a place to change: nothing in the person's folder is
 * deleted or moved, and the folder's own index, HEAD and branches are never touched. Undefined for a thread without such
 * a record. `unavailable` when the folder is gone or now holds another repository, so no ref of a different repository
 * is ever named. The person's folder is read without blocking the daemon; the thread's own records synchronously.
 */
export async function projectFolderPurgeRefs(task: Pick<TaskLifecycleRecord, 'taskId' | 'location'>): Promise<ProjectFolderPurgeRefs | undefined> {
  const path = join(task.location, 'project-folder.json')
  if (!existsSync(path)) return undefined
  let record: Partial<ThreadWorkspaceMetadata>
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as Partial<ThreadWorkspaceMetadata>
  } catch {
    return { unavailable: 'The project folder record is unreadable' }
  }
  if (record.schemaVersion !== 1 || record.kind !== 'project-folder' || record.threadId !== task.taskId || typeof record.worktreePath !== 'string' || !isAbsolute(record.worktreePath)) {
    return { unavailable: 'The project folder record is not this thread\'s' }
  }
  const folder = record.worktreePath
  if (!await access(folder).then(() => true, () => false)) return { unavailable: `The project folder ${folder} is not there, so its refs cannot be released` }
  let commonDir: string
  try {
    const identity = await resolveRepositoryIdentityAsync(folder)
    if (!identity.capability.allowed || identity.key !== record.repositoryId) return { unavailable: `The project folder ${folder} no longer holds the thread's repository` }
    commonDir = resolve(folder, await lifecycleGitAsync(folder, ['rev-parse', '--git-common-dir']))
  } catch (error) {
    return { unavailable: `The project folder's repository cannot be read: ${(error as Error).message}` }
  }

  const names = new Set<string>()
  const threadPins = `refs/mousse/threads/${task.taskId}/`
  for (const name of (await lifecycleGitAsync(commonDir, ['for-each-ref', '--format=%(refname)', threadPins])).split(/\r?\n/)) if (name) names.add(name)
  if (typeof record.retainedRef === 'string' && record.retainedRef.startsWith(threadPins)) names.add(record.retainedRef)
  // Read only: a trashed thread's journal is never appended to here.
  const receipts = new ThreadJournal(task.location, { readOnly: true }).list().map((entry) => (entry.details as { receipt?: ChangeReceipt } | undefined)?.receipt).filter((receipt): receipt is ChangeReceipt => Boolean(receipt?.id))
  for (const receipt of receipts) {
    const pair = [`refs/mousse/changes/${receipt.id}/before`, `refs/mousse/changes/${receipt.id}/after`]
    // A receipt names its own pair and nothing else; any other shape is not trusted to point at the thread's refs.
    if (JSON.stringify(receipt.retainedRefs) === JSON.stringify(pair)) for (const name of pair) names.add(name)
  }
  const branches = join(task.location, 'conversation-branches.json')
  if (existsSync(branches)) {
    try {
      for (const branch of JSON.parse(readFileSync(branches, 'utf8')) as Array<{ retainedRef?: unknown }>) {
        if (typeof branch.retainedRef === 'string' && branch.retainedRef.startsWith('refs/mousse/conversation-branches/')) names.add(branch.retainedRef)
      }
    } catch {
      // An unreadable branch list names no refs.
    }
  }

  const refs: Array<{ ref: string; sha: string; discardReason?: string }> = []
  for (const ref of [...names].filter(releasable).sort()) {
    const sha = await readDirectLifecycleRefAsync(commonDir, ref)
    if (sha) refs.push({ ref, sha })
  }
  for (const kept of await threadKeptFilesRefs(commonDir, task.location)) {
    const sha = await readDirectLifecycleRefAsync(commonDir, kept.ref)
    if (sha === kept.sha && !refs.some((item) => item.ref === kept.ref)) refs.push(kept)
  }
  return { commonDir, refs }
}
