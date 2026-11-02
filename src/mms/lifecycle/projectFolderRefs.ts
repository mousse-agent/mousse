import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { lifecycleGit, readDirectLifecycleRef } from './WorktreeRetirementService'

/** What a purge releases for a thread that worked in its project's own folder: refs only, in that folder's repository. */
export type ProjectFolderPurgeRefs =
  | { commonDir: string; refs: Array<{ ref: string; sha: string }> }
  | { unavailable: string }

/**
 * Files a restore kept before writing over them are in `refs/mousse/preserved/*` and exist nowhere else, so a purge never
 * releases them; nor anything outside Mousse's own namespace, whatever a record names.
 */
function releasable(ref: string): boolean {
  return ref.startsWith('refs/mousse/') && !ref.startsWith('refs/mousse/preserved/') && !/[\s\0]/.test(ref)
}

/**
 * The refs a project-folder thread (`project-folder.json`, see `ThreadWorkspaceManager.ensureProjectFolder`) holds in
 * the person's repository, for a purge to delete one by one: its pins under `refs/mousse/threads/<id>/`, its receipts'
 * `refs/mousse/changes/<receipt>/{before,after}` and its conversation branches' pins, each with the value it has now.
 *
 * Only reads. The record is used for its repository, never as a place to change: nothing in the person's folder is
 * deleted or moved, and the folder's own index, HEAD and branches are never touched. Undefined for a thread without such
 * a record. `unavailable` when the folder is gone or now holds another repository, so no ref of a different repository
 * is ever named.
 */
export function projectFolderPurgeRefs(task: Pick<TaskLifecycleRecord, 'taskId' | 'location'>): ProjectFolderPurgeRefs | undefined {
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
  if (!existsSync(folder)) return { unavailable: `The project folder ${folder} is not there, so its refs cannot be released` }
  let commonDir: string
  try {
    const identity = resolveRepositoryIdentity(folder)
    if (!identity.capability.allowed || identity.key !== record.repositoryId) return { unavailable: `The project folder ${folder} no longer holds the thread's repository` }
    commonDir = resolve(folder, lifecycleGit(folder, ['rev-parse', '--git-common-dir']))
  } catch (error) {
    return { unavailable: `The project folder's repository cannot be read: ${(error as Error).message}` }
  }

  const names = new Set<string>()
  const threadPins = `refs/mousse/threads/${task.taskId}/`
  for (const name of lifecycleGit(commonDir, ['for-each-ref', '--format=%(refname)', threadPins]).split(/\r?\n/)) if (name) names.add(name)
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

  const refs: Array<{ ref: string; sha: string }> = []
  for (const ref of [...names].filter(releasable).sort()) {
    const sha = readDirectLifecycleRef(commonDir, ref)
    if (sha) refs.push({ ref, sha })
  }
  return { commonDir, refs }
}
