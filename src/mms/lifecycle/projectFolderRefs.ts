import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import type { ChangeReceipt } from '../../shared/threadActions'
import { ThreadJournal } from '../data/ThreadJournal'
import { PRESERVED_REF_FORMAT, PRESERVED_REFS, threadPreservedRefs } from '../actions/preservedFiles'
import { UndoRetentionService } from '../actions/UndoRetentionService'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { lifecycleGit, lifecycleRead, readDirectLifecycleRef } from './WorktreeRetirementService'

/** What a purge releases for a thread that worked in its project's own folder: refs only, in that folder's repository. */
export type ProjectFolderPurgeRefs =
  | { commonDir: string; refs: Array<{ ref: string; sha: string; discardReason?: string }> }
  | { unavailable: string }

/** A purge never releases anything outside Mousse's own namespace, whatever a record names. */
function releasable(ref: string): boolean {
  return ref.startsWith('refs/mousse/') && !/[\s\0]/.test(ref)
}

export interface KeptFilesRef {
  ref: string
  sha: string
  /** Why a purge must not drop it unasked: it is still within its Undo window, so it may be the only copy of a file. */
  discardReason?: string
}

/**
 * The thread's own `refs/mousse/preserved/` refs in the repository of `cwd`: files a restore or an abort of this thread
 * set aside before writing over them (see `threadPreservedIndex` for which refs are the thread's). They go with the
 * thread's other refs when it is purged. While their Undo window lasts, or when the thread's journal gives no time for
 * them, they may be the only copy of a person's file (an ignored `.env`, say): such a ref carries a `discardReason`, so a
 * purge asks the person to discard it and automatic cleanup keeps the thread. Reads only.
 */
export function threadKeptFilesRefs(cwd: string, threadDirectory: string, now = Date.now()): KeptFilesRef[] {
  const refs = threadPreservedRefs(lifecycleRead(cwd, ['for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, PRESERVED_REFS]), threadDirectory)
  if (!refs.length) return []
  const retention = new UndoRetentionService(threadDirectory, () => now, true)
  return refs.map((item) => {
    const until = item.keptAt === undefined ? undefined : retention.retainedUntil(item.keptAt)
    if (until !== undefined && until <= now) return { ref: item.ref, sha: item.sha }
    const kept = until === undefined ? 'kept with no recorded time' : `kept until ${new Date(until).toISOString().slice(0, 10)}`
    return { ref: item.ref, sha: item.sha, discardReason: `Files a restore set aside before writing over them, ${kept}; they may be the only copy` }
  })
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

  const refs: Array<{ ref: string; sha: string; discardReason?: string }> = []
  for (const ref of [...names].filter(releasable).sort()) {
    const sha = readDirectLifecycleRef(commonDir, ref)
    if (sha) refs.push({ ref, sha })
  }
  for (const kept of threadKeptFilesRefs(commonDir, task.location)) {
    const sha = readDirectLifecycleRef(commonDir, kept.ref)
    if (sha === kept.sha && !refs.some((item) => item.ref === kept.ref)) refs.push(kept)
  }
  return { commonDir, refs }
}
