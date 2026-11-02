import { randomUUID } from 'node:crypto'
import { ThreadJournal } from '../data/ThreadJournal'
import { waitForFolderAccess } from '../files/folderAccess'
import { withGitAccess } from '../git/gitPolicy'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { collectStoreGarbage, threadSnapshotStore } from '../workspace/SnapshotWorkspace'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git } from './git'
import { UndoRetentionService } from './UndoRetentionService'

/**
 * Files a restore found in its way, or an abort was about to rewrite, are kept as one commit under
 * `refs/mousse/preserved/<operation>-…` (see `moveFiles` and `preserveBeforeAbort`). The ref names the operation that
 * wrote it, which is how a thread knows the ref is its own.
 */
export const PRESERVED_REFS = 'refs/mousse/preserved/'

/** The journal record of an expiry: which refs went, at which commit, and the window they were kept for. */
export const PRESERVED_EXPIRY_OPERATION = 'preserved-files-expired'

const ACTIVE = ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required']

/** The operations in a thread's journal. Read only. */
export function threadOperationIds(threadDirectory: string): Set<string> {
  return new Set(new ThreadJournal(threadDirectory, { readOnly: true }).list().map((entry) => entry.operationId).filter((id) => typeof id === 'string' && id.length > 0))
}

/** Whether `ref` holds files one of `operations` kept: `refs/mousse/preserved/<operation>-…`. */
export function preservedByOperations(ref: string, operations: ReadonlySet<string>): boolean {
  if (!ref.startsWith(PRESERVED_REFS) || /[\s\0]/.test(ref)) return false
  const leaf = ref.slice(PRESERVED_REFS.length)
  for (const operation of operations) if (leaf.startsWith(`${operation}-`)) return true
  return false
}

export interface PreservedRef {
  ref: string
  sha: string
  /** When the files were kept: the commit's committer time, in milliseconds. */
  keptAt?: number
}

/** `for-each-ref` format read by {@link parsePreservedRefs}. */
export const PRESERVED_REF_FORMAT = '%(refname)%00%(objectname)%00%(committerdate:unix)%00%(symref)'

/** The rows of a `for-each-ref --format=PRESERVED_REF_FORMAT refs/mousse/preserved/` listing. A symbolic ref is never one. */
export function parsePreservedRefs(listing: string): PreservedRef[] {
  const refs: PreservedRef[] = []
  for (const line of listing.split(/\r?\n/)) {
    const [ref, sha, date, symref] = line.split('\0')
    if (!ref?.startsWith(PRESERVED_REFS) || !sha || !/^[a-f0-9]{40,64}$/.test(sha) || symref) continue
    const seconds = Number(date)
    refs.push({ ref, sha, ...(date && Number.isSafeInteger(seconds) && seconds > 0 ? { keptAt: seconds * 1000 } : {}) })
  }
  return refs
}

export interface PreservedFilesExpiry {
  expiredRefs: string[]
  /** Why nothing was looked at this time. */
  skipped?: string
}

/**
 * Deletes the thread's `refs/mousse/preserved/` refs whose files were kept longer ago than the thread's Undo retention
 * window (`UndoRetentionPolicy.windowMs`, 30 days unless changed), the same window after which the Undo itself expires.
 * Runs from the hourly Undo retention sweep only, never as part of another action.
 *
 * Only refs whose name starts with one of this thread's operations are considered; another thread's, and a ref no thread
 * names, are left. Each is deleted with `update-ref -d` and the value it was read with, so a ref that changed in between
 * stays. What was deleted is recorded in the thread's journal. Nothing happens while the retention clock needs review or
 * an operation is unfinished. In a hidden snapshot store, which only Mousse uses, the garbage is collected afterwards.
 *
 * The folder is checked through the folder access check first: one whose volume is not answering fails at once and is
 * tried again by a later sweep.
 */
export async function expirePreservedFiles(threadDirectory: string, workspacePath: string, options: { signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; now?: () => number } = {}): Promise<PreservedFilesExpiry> {
  await waitForFolderAccess([threadDirectory, workspacePath], { whenNotAnswering: 'fail', signal: options.signal })
  return withGitAccess('undoRetention.expirePreservedFiles', 'owned', () => withGitMutationLocks(threadDirectory, workspacePath, 'preserved-files-expiry', () => {
    const retention = new UndoRetentionService(threadDirectory, options.now)
    if (!retention.clockAllowsRelease()) return { expiredRefs: [], skipped: 'The Undo retention clock needs review before kept files expire.' }
    const journal = new ThreadJournal(threadDirectory)
    const records = journal.list()
    const latest = new Map(records.map((entry) => [entry.operationId, entry.state]))
    if ([...latest.values()].some((state) => ACTIVE.includes(state))) return { expiredRefs: [], skipped: 'An unfinished operation protects kept files.' }
    const operations = new Set(records.map((entry) => entry.operationId))
    const now = (options.now ?? Date.now)()
    const { windowMs } = retention.policy()
    const due = parsePreservedRefs(git(workspacePath, ['for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, PRESERVED_REFS]))
      .filter((item) => preservedByOperations(item.ref, operations) && item.keptAt !== undefined && item.keptAt + windowMs <= now)
    const expired: PreservedRef[] = []
    for (const item of due) {
      git(workspacePath, ['update-ref', '--no-deref', '-d', item.ref, item.sha])
      expired.push(item)
    }
    if (!expired.length) return { expiredRefs: [] }
    journal.append({
      operationId: randomUUID(), operationType: PRESERVED_EXPIRY_OPERATION, state: 'completed',
      details: { windowMs, refs: expired.map((item) => ({ name: item.ref, sha: item.sha, keptAt: new Date(item.keptAt!).toISOString() })) }
    })
    const store = threadSnapshotStore(threadDirectory, workspacePath)
    if (store) collectStoreGarbage(store)
    return { expiredRefs: expired.map((item) => item.ref) }
  }, options.signal, options.heldThreadLease))
}
