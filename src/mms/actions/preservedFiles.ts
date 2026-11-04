import { randomUUID } from 'node:crypto'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { waitForFolderAccess } from '../files/folderAccess'
import { withGitAccess } from '../git/gitPolicy'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { collectStoreGarbageAsync, threadSnapshotStoreAsync } from '../workspace/SnapshotWorkspace'
import { KEEP_COPY_OPERATIONS, PRESERVED_EXPIRY_OPERATION, PRESERVED_REFS } from '../../shared/resourceLifecycle'
import { settleInterruptedKeeps, uncountedSince } from './keptCopies'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { gitAsync, LISTING } from './git'
import { UndoRetentionService } from './UndoRetentionService'

/**
 * Files a restore found in its way, or an abort was about to rewrite, or an action was about to remove, are kept as one
 * commit under a `refs/mousse/preserved/` ref. These writers name them:
 * - `moveFiles` (Undo, Redo, revert, switching conversation branches): `<operation>-<12 hex>`, where the operation is a
 *   UUID Mousse made and recorded in the thread's journal under one of {@link RESTORE_OPERATION_TYPES}.
 * - `keepCopy` (Discard, worktree cleanup, Abort, and a restore's exact bytes that Git would convert): the same shape,
 *   recorded under `git-discard`, `worktree-cleanup`, `git-abort` or `restore-keep` in its owner's journal: a thread's,
 *   the project's for the person's own checkout (`projectKeptFilesOwner`), or a dispatch's for its worktree
 *   (`dispatchKeptFilesOwner`).
 * - An abort of an older version: `<operation>-abort-<12 hex>`, and the abort recorded that exact name as `preservedRef`.
 *   No abort writes these any more; those already written are still the thread's.
 * A thread owns a ref only by one of these two exact shapes, so an operation id that is a prefix of another thread's
 * (a client may choose a Publish's id) never claims it.
 */
export { PRESERVED_REFS }

/**
 * The journal record of an expiry: an intent (`prepared`, which thread recovery leaves to its owner), then its outcome,
 * with exactly the refs that went. An unsettled intent touches no file and no Undo material, so nothing else waits on it.
 */
export { PRESERVED_EXPIRY_OPERATION }

/** Operation types whose restores, or keeps of a copy, write `<operation>-<12 hex>` refs. */
const RESTORE_OPERATION_TYPES = new Set<string>(['undo', 'redo', 'change-undo', 'change-redo', 'code-revert', 'conversation-activate', ...KEEP_COPY_OPERATIONS])
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const OPERATION_ID = new RegExp(`^${UUID}$`)
const RESTORE_REF = new RegExp(`^refs/mousse/preserved/(${UUID})-[0-9a-f]{12}$`)
const ABORT_REF = /^refs\/mousse\/preserved\/[^\s\0]+-abort-[0-9a-f]{12}$/

export interface ThreadPreservedIndex {
  /** Whether the ref is the thread's own: written by one of its operations, by the exact name that writer uses. */
  owns(ref: string): boolean
  /**
   * When the thread's journal last recorded the operation that wrote the ref, in milliseconds of Mousse's clock.
   * Undefined for a ref that is not the thread's, or whose record has no readable time.
   */
  recordedAt(ref: string): number | undefined
}

/** The thread's own preserved refs, read from its journal only. */
export function threadPreservedIndex(threadDirectory: string): ThreadPreservedIndex {
  const restores = new Map<string, number | undefined>()
  const aborts = new Map<string, number | undefined>()
  const later = (previous: number | undefined, at: number): number | undefined => (Number.isFinite(at) ? Math.max(previous ?? at, at) : previous)
  for (const entry of new ThreadJournal(threadDirectory, { readOnly: true }).list()) {
    const at = Date.parse(entry.createdAt)
    if (RESTORE_OPERATION_TYPES.has(entry.operationType) && OPERATION_ID.test(entry.operationId)) restores.set(entry.operationId, later(restores.get(entry.operationId), at))
    const named = (entry.details as { preservedRef?: unknown } | undefined)?.preservedRef
    if (typeof named === 'string' && ABORT_REF.test(named) && named.startsWith(`${PRESERVED_REFS}${entry.operationId}-abort-`)) aborts.set(named, later(aborts.get(named), at))
  }
  const operationOf = (ref: string): string | undefined => RESTORE_REF.exec(ref)?.[1]
  return {
    owns: (ref) => aborts.has(ref) || restores.has(operationOf(ref) ?? ''),
    recordedAt: (ref) => (aborts.has(ref) ? aborts.get(ref) : restores.get(operationOf(ref) ?? ''))
  }
}

export interface PreservedRef {
  ref: string
  sha: string
  /** The commit's committer time, in milliseconds. Git takes it from the environment, so it only ever extends a wait. */
  committedAt?: number
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
    refs.push({ ref, sha, ...(date && Number.isSafeInteger(seconds) && seconds > 0 ? { committedAt: seconds * 1000 } : {}) })
  }
  return refs
}

export interface ThreadPreservedRef {
  ref: string
  sha: string
  /**
   * When the files were kept: the journal's record of the operation that kept them, under Mousse's clock, or the commit
   * time when that is later. Undefined when the journal gives no time; such a ref never expires.
   */
  keptAt?: number
}

/** The thread's own refs in a {@link PRESERVED_REF_FORMAT} listing, with when they were kept. */
export function threadPreservedRefs(listing: string, threadDirectory: string): ThreadPreservedRef[] {
  const index = threadPreservedIndex(threadDirectory)
  return parsePreservedRefs(listing).filter((item) => index.owns(item.ref)).map((item) => {
    const recorded = index.recordedAt(item.ref)
    return { ref: item.ref, sha: item.sha, ...(recorded !== undefined ? { keptAt: Math.max(recorded, item.committedAt ?? recorded) } : {}) }
  })
}

export interface KeptFilesRef {
  ref: string
  sha: string
  /** Why a purge must not drop it unasked: it is within its Undo window, or has no recorded time, so it may be the only copy of a file. */
  discardReason?: string
}

/**
 * The thread's own kept-files refs in a {@link PRESERVED_REF_FORMAT} listing, each with a `discardReason` while it may
 * still be the only copy of a person's file (an ignored `.env`, say): within its Undo window
 * (`UndoRetentionService.retainedUntil`), or with no recorded time. Reads only.
 */
export function keptFilesFromListing(listing: string, threadDirectory: string, now = Date.now()): KeptFilesRef[] {
  const refs = threadPreservedRefs(listing, threadDirectory)
  if (!refs.length) return []
  const retention = new UndoRetentionService(threadDirectory, () => now, true)
  return refs.map((item) => {
    const until = item.keptAt === undefined ? undefined : retention.retainedUntil(item.keptAt)
    if (until !== undefined && until <= now) return { ref: item.ref, sha: item.sha }
    const kept = until === undefined ? 'kept with no recorded time' : `kept until ${new Date(until).toISOString().slice(0, 10)}`
    return { ref: item.ref, sha: item.sha, discardReason: `Files set aside before a restore, an abort or a Discard wrote over or removed them, ${kept}; they may be the only copy` }
  })
}

export interface PreservedFilesExpiry {
  expiredRefs: string[]
  /** Why nothing, or not everything, went this time. */
  skipped?: string
}

interface ExpiryDetails { phase: 'intent' | 'outcome'; refs: Array<{ name: string; sha: string; keptAt?: string }>; windowMs?: number; error?: string; interrupted?: boolean }

const detailsOf = (entry: ThreadJournalRecord): ExpiryDetails | undefined => {
  const details = entry.details as Partial<ExpiryDetails> | undefined
  return details && (details.phase === 'intent' || details.phase === 'outcome') && Array.isArray(details.refs) ? details as ExpiryDetails : undefined
}

/**
 * Records the outcome of an expiry that stopped between its intent and its outcome: the refs of its intent that are
 * gone. Returns them.
 */
async function settleInterrupted(journal: ThreadJournal, present: () => Promise<Set<string>>): Promise<string[]> {
  const records = journal.list().filter((entry) => entry.operationType === PRESERVED_EXPIRY_OPERATION)
  const settled = new Set(records.filter((entry) => detailsOf(entry)?.phase === 'outcome').map((entry) => entry.operationId))
  const went: string[] = []
  for (const intent of records) {
    const details = detailsOf(intent)
    if (details?.phase !== 'intent' || settled.has(intent.operationId)) continue
    const now = await present()
    const gone = details.refs.filter((item) => !now.has(item.name))
    journal.append({ operationId: intent.operationId, operationType: PRESERVED_EXPIRY_OPERATION, state: gone.length ? 'completed' : 'failed', details: { phase: 'outcome', refs: gone, interrupted: true } satisfies ExpiryDetails })
    settled.add(intent.operationId)
    went.push(...gone.map((item) => item.name))
  }
  return went
}

/**
 * Deletes the thread's own `refs/mousse/preserved/` refs once their files have been kept for the thread's Undo retention
 * window (`UndoRetentionPolicy.windowMs`, 30 days unless changed), counted the way Undo's own deadline is
 * (`UndoRetentionService.retainedUntil`). Runs from the hourly Undo retention sweep only, never as part of another action.
 *
 * The refs that are due are recorded in the thread's journal first (an intent), then deleted together in one
 * `update-ref --stdin` transaction, each with the value it was read with, so either all go or none does. The outcome
 * records exactly the refs that went. An expiry that stopped in between is settled by the next one from what is still
 * there. Nothing is deleted while the retention clock needs review or an operation of the thread is unfinished. In a
 * hidden snapshot store, which only Mousse uses, the garbage is collected after the outcome is recorded.
 *
 * The folder is checked through the folder access check first: one whose volume is not answering fails at once and is
 * tried again by a later sweep.
 */
export async function expirePreservedFiles(threadDirectory: string, workspacePath: string, options: { signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; now?: () => number } = {}): Promise<PreservedFilesExpiry> {
  await waitForFolderAccess([threadDirectory, workspacePath], { whenNotAnswering: 'fail', signal: options.signal })
  return withGitAccess('undoRetention.expirePreservedFiles', 'owned', () => withGitMutationLocks(threadDirectory, workspacePath, 'preserved-files-expiry', async (): Promise<PreservedFilesExpiry> => {
    const retention = new UndoRetentionService(threadDirectory, options.now)
    const journal = new ThreadJournal(threadDirectory)
    const store = await threadSnapshotStoreAsync(threadDirectory, workspacePath)
    const listing = () => gitAsync(workspacePath, ['for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, PRESERVED_REFS], undefined, undefined, LISTING)
    const present = async () => new Set(parsePreservedRefs(await listing()).map((item) => item.ref))
    const finish = async (went: string[], skipped?: string): Promise<PreservedFilesExpiry> => {
      if (went.length && store) await collectStoreGarbageAsync(store)
      return { expiredRefs: went, ...(skipped ? { skipped } : {}) }
    }
    // An interrupted expiry or keep is settled first, whatever else holds this one back: settling only records what is
    // gone, or what was kept.
    const settled = await settleInterrupted(journal, present)
    // Only this repository's keeps: a keep of the same owner in another repository may still be running.
    const top = store ? undefined : (await gitAsync(workspacePath, ['rev-parse', '--show-toplevel']).catch(() => undefined))
    if (top) await settleInterruptedKeeps(threadDirectory, top)
    if (!retention.clockAllowsRelease()) return finish(settled, 'The Undo retention clock needs review before kept files expire.')
    if (retention.unfinishedOperation()) return finish(settled, 'An unfinished operation protects kept files.')
    const now = (options.now ?? Date.now)()
    // Time a project's clock did not count (it resumed after a jump with no person to review it) keeps copies longer.
    const due = threadPreservedRefs(await listing(), threadDirectory).filter((item) => item.keptAt !== undefined && retention.retainedUntil(item.keptAt) + uncountedSince(threadDirectory, item.keptAt) <= now)
    if (!due.length) return finish(settled)
    const operationId = randomUUID()
    const refs = due.map((item) => ({ name: item.ref, sha: item.sha, keptAt: new Date(item.keptAt!).toISOString() }))
    journal.append({ operationId, operationType: PRESERVED_EXPIRY_OPERATION, state: 'prepared', details: { phase: 'intent', windowMs: retention.policy().windowMs, refs } satisfies ExpiryDetails })
    let error: string | undefined
    try {
      await gitAsync(workspacePath, ['update-ref', '--no-deref', '--stdin'], undefined, `start\n${due.map((item) => `delete ${item.ref} ${item.sha}`).join('\n')}\nprepare\ncommit\n`)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const remaining = await present()
    const went = refs.filter((item) => !remaining.has(item.name))
    journal.append({ operationId, operationType: PRESERVED_EXPIRY_OPERATION, state: went.length ? 'completed' : 'failed', details: { phase: 'outcome', refs: went, ...(error ? { error } : {}) } satisfies ExpiryDetails })
    return finish([...settled, ...went.map((item) => item.name)], error ? `Kept files could not be deleted: ${error.split('\n').find((line) => /fatal|error/i.test(line)) ?? error}` : undefined)
  }, options.signal, options.heldThreadLease))
}
