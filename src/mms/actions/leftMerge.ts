import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { MOUSSE_COMMIT_ENV, git, tryGit } from './git'
import { worktreeTree } from './snapshots'

/**
 * Which `git merge` is in progress in a folder, closely enough to tell the merge an earlier version of Mousse left
 * from one the person or the agent started later, even of the same commit at the same HEAD. Git writes `MERGE_HEAD`
 * anew for every merge, so its file identity changes with each one.
 */
export interface MergeIdentity {
  /** HEAD when the merge was recorded. */
  head: string
  /** `MERGE_HEAD`: what it names, and the file itself. */
  mergeHead: string
  mergeHeadFile: { ino: string; mtimeNs: string; ctimeNs: string }
  /** SHA-256 of `MERGE_MSG`, or null when there was none. */
  mergeMsg: string | null
}

function gitPath(folder: string, name: string): string | undefined {
  const path = tryGit(folder, ['rev-parse', '--path-format=absolute', '--git-path', name])
  return path.ok && path.stdout ? path.stdout : undefined
}

function hashOf(path: string | undefined): string | null {
  if (!path) return null
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** The merge in progress in `folder` now, or undefined when none is. */
export function mergeIdentity(folder: string): MergeIdentity | undefined {
  const mergeHeadPath = gitPath(folder, 'MERGE_HEAD')
  if (!mergeHeadPath) return undefined
  const file = statSync(mergeHeadPath, { bigint: true, throwIfNoEntry: false })
  const head = tryGit(folder, ['rev-parse', '--verify', '-q', 'HEAD']).stdout
  if (!file || !head) return undefined
  let mergeHead: string
  try {
    mergeHead = readFileSync(mergeHeadPath, 'utf8').trim()
  } catch {
    return undefined
  }
  return {
    head,
    mergeHead,
    mergeHeadFile: { ino: String(file.ino), mtimeNs: String(file.mtimeNs), ctimeNs: String(file.ctimeNs) },
    mergeMsg: hashOf(gitPath(folder, 'MERGE_MSG'))
  }
}

/** Whether the merge in progress in `folder` is exactly the recorded one: same HEAD, same `MERGE_HEAD` file, same message. */
export function isRecordedMerge(folder: string, recorded: unknown): boolean {
  const now = mergeIdentity(folder)
  const was = recorded as Partial<MergeIdentity> | undefined
  if (!now || !was?.mergeHeadFile) return false
  return now.head === was.head && now.mergeHead === was.mergeHead && now.mergeMsg === was.mergeMsg &&
    now.mergeHeadFile.ino === was.mergeHeadFile.ino && now.mergeHeadFile.mtimeNs === was.mergeHeadFile.mtimeNs &&
    now.mergeHeadFile.ctimeNs === was.mergeHeadFile.ctimeNs
}

/**
 * Keeps every file of the folder as it is now, conflicted ones with their markers and edits included, as one commit
 * under a new `refs/mousse/preserved/` ref, before an abort rewrites them. Reads the files only; HEAD, the branch,
 * the index and the files stay as they are. The caller holds the mutation locks.
 */
export function preserveBeforeAbort(folder: string, operationId: string): string {
  const top = git(folder, ['rev-parse', '--show-toplevel'])
  const tree = worktreeTree(top)
  const head = tryGit(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout
  const sha = git(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'mousse snapshot: files kept before an abort', '-m', `Mousse-Operation: ${operationId}`], MOUSSE_COMMIT_ENV)
  const ref = `refs/mousse/preserved/${operationId}-abort-${sha.slice(0, 12)}`
  git(top, ['update-ref', '--no-deref', ref, sha])
  return ref
}

interface LeftMergeRecord { operationId: string; state: string; details?: unknown; expectedPreState?: unknown }

/**
 * Why `operations.abort` would refuse the left merge `record` describes in `folder`, or undefined when it would abort
 * it. The one check the banner and Abort share, so the banner never offers an Abort that refuses: the merge must be
 * exactly the recorded one (`isRecordedMerge`), HEAD must be where it was before that merge, and `MERGE_HEAD` must
 * name what that merge brought in. `records` is the thread's journal, for the merge's intent.
 */
export function leftMergeRefusal(folder: string, record: LeftMergeRecord, records: readonly LeftMergeRecord[]): string | undefined {
  const details = (record.details ?? {}) as { mergeIdentity?: unknown; preMergeSha?: string; prePublishSha?: string; workerHeadSha?: string; sourceSha?: string }
  if (!isRecordedMerge(folder, details.mergeIdentity)) return 'The merge in progress is not the one an earlier version left, so Mousse left it alone.'
  const before = details.preMergeSha ?? details.prePublishSha
  if (!before || tryGit(folder, ['rev-parse', '--verify', '-q', 'HEAD']).stdout !== before) return 'Conflict HEAD changed outside the selected operation.'
  const intent = records.find((entry) => entry.operationId === record.operationId && ['prepared', 'running'].includes(entry.state))
  const expected = details.workerHeadSha ?? (intent?.expectedPreState as { sourceSha?: string } | undefined)?.sourceSha ?? details.sourceSha
  if (!expected || tryGit(folder, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).stdout !== expected) return 'Git sequencer belongs to another operation.'
  return undefined
}
