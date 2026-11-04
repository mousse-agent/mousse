import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tryGitStep } from './git'
import { files, runAsync, step, type Steps } from './steps'

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

function* gitPath(folder: string, name: string): Steps<string | undefined> {
  const path = yield* tryGitStep(folder, ['rev-parse', '--path-format=absolute', '--git-path', name])
  return path.ok && path.stdout ? path.stdout : undefined
}

function* hashOf(path: string | undefined): Steps<string | null> {
  if (!path) return null
  try {
    return createHash('sha256').update(yield* files.readBytes(path)).digest('hex')
  } catch {
    return null
  }
}

/** `statSync(path, { bigint: true, throwIfNoEntry: false })` as a step. */
function bigStat(path: string): Steps<{ ino: bigint; mtimeNs: bigint; ctimeNs: bigint } | undefined> {
  return step(() => statSync(path, { bigint: true, throwIfNoEntry: false }), () => stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }))
}

/** The merge in progress in `folder` now, or undefined when none is. */
export function* mergeIdentitySteps(folder: string): Steps<MergeIdentity | undefined> {
  const mergeHeadPath = yield* gitPath(folder, 'MERGE_HEAD')
  if (!mergeHeadPath) return undefined
  const file = yield* bigStat(mergeHeadPath)
  const head = (yield* tryGitStep(folder, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout
  if (!file || !head) return undefined
  let mergeHead: string
  try {
    mergeHead = (yield* files.readText(mergeHeadPath)).trim()
  } catch {
    return undefined
  }
  return {
    head,
    mergeHead,
    mergeHeadFile: { ino: String(file.ino), mtimeNs: String(file.mtimeNs), ctimeNs: String(file.ctimeNs) },
    mergeMsg: yield* hashOf(yield* gitPath(folder, 'MERGE_MSG'))
  }
}


export function mergeIdentityAsync(folder: string): Promise<MergeIdentity | undefined> {
  return runAsync(mergeIdentitySteps(folder))
}

/** Whether the merge in progress in `folder` is exactly the recorded one: same HEAD, same `MERGE_HEAD` file, same message. */
function* isRecordedMergeSteps(folder: string, recorded: unknown): Steps<boolean> {
  const now = yield* mergeIdentitySteps(folder)
  const was = recorded as Partial<MergeIdentity> | undefined
  if (!now || !was?.mergeHeadFile) return false
  return now.head === was.head && now.mergeHead === was.mergeHead && now.mergeMsg === was.mergeMsg &&
    now.mergeHeadFile.ino === was.mergeHeadFile.ino && now.mergeHeadFile.mtimeNs === was.mergeHeadFile.mtimeNs &&
    now.mergeHeadFile.ctimeNs === was.mergeHeadFile.ctimeNs
}


interface LeftMergeRecord { operationId: string; state: string; details?: unknown; expectedPreState?: unknown }

/**
 * Why `operations.abort` would refuse the left merge `record` describes in `folder`, or undefined when it would abort
 * it. The one check the banner and Abort share, so the banner never offers an Abort that refuses: the merge must be
 * exactly the recorded one (`isRecordedMerge`), HEAD must be where it was before that merge, and `MERGE_HEAD` must
 * name what that merge brought in. `records` is the thread's journal, for the merge's intent.
 */
function* leftMergeRefusalSteps(folder: string, record: LeftMergeRecord, records: readonly LeftMergeRecord[]): Steps<string | undefined> {
  const details = (record.details ?? {}) as { mergeIdentity?: unknown; preMergeSha?: string; prePublishSha?: string; workerHeadSha?: string; sourceSha?: string }
  if (!(yield* isRecordedMergeSteps(folder, details.mergeIdentity))) return 'The merge in progress is not the one an earlier version left, so Mousse left it alone.'
  const before = details.preMergeSha ?? details.prePublishSha
  if (!before || (yield* tryGitStep(folder, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout !== before) return 'Conflict HEAD changed outside the selected operation.'
  const intent = records.find((entry) => entry.operationId === record.operationId && ['prepared', 'running'].includes(entry.state))
  const expected = details.workerHeadSha ?? (intent?.expectedPreState as { sourceSha?: string } | undefined)?.sourceSha ?? details.sourceSha
  if (!expected || (yield* tryGitStep(folder, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).stdout !== expected) return 'Git sequencer belongs to another operation.'
  return undefined
}


export function leftMergeRefusalAsync(folder: string, record: LeftMergeRecord, records: readonly LeftMergeRecord[]): Promise<string | undefined> {
  return runAsync(leftMergeRefusalSteps(folder, record, records))
}
