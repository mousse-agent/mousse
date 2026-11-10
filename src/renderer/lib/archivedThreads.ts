import { knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'

/**
 * Deleting archived threads: a thread is archived first, and only an archived thread is deleted, for good. No React
 * in here, so the words and the Clear all loop run in plain tests.
 */

export interface ArchivedThreadRef {
  id: string
  name: string
  /** Set for a thread of another computer: it is deleted on that computer, not from here. */
  node?: string
}

/** What the confirmation asks about: one archived thread, or every archived thread of this computer. */
export type DeleteRequest =
  | { kind: 'one'; thread: ArchivedThreadRef }
  | { kind: 'all'; threads: ArchivedThreadRef[]; elsewhere: number }

export interface DeleteDialogCopy {
  title: string
  body: string
  confirm: string
}

/** Only the threads go: worktrees, their branches and uncommitted changes stay. */
const WORKTREES_STAY = 'Worktrees stay.'

export function deleteDialogCopy(request: DeleteRequest): DeleteDialogCopy {
  if (request.kind === 'one') {
    return {
      title: `Delete “${request.thread.name}”?`,
      body: `Deletes it and its subagent threads for good. ${WORKTREES_STAY}`,
      confirm: 'Delete'
    }
  }
  const count = request.threads.length
  const threads = count === 1 ? 'thread' : 'threads'
  return {
    title: `Delete ${count} archived ${threads}?`,
    body: `Deletes ${count === 1 ? 'it and its' : 'them and their'} subagent threads for good. ${WORKTREES_STAY}${request.elsewhere ? ' Threads on other computers stay.' : ''}`,
    confirm: count === 1 ? 'Delete' : `Delete ${count}`
  }
}

/** The archived threads Clear all deletes: this computer's own. */
export function clearAllRequest(archived: readonly ArchivedThreadRef[]): DeleteRequest {
  const local = archived.filter((thread) => !thread.node)
  return { kind: 'all', threads: local, elsewhere: archived.length - local.length }
}

/** Why a delete did not go through, in the daemon's words when it gave them. */
export function deleteErrorMessage(cause: unknown): string {
  const shape = cause as Partial<AppErrorShape> | null
  if (shape && typeof shape.code === 'string' && typeof shape.message === 'string' && parseErrorInfo(shape.errorInfo)) return knownAppError(shape as AppErrorShape).message
  if (shape && typeof shape.message === 'string' && shape.message.trim()) return shape.message
  return normalizeAppError(cause, 'storage_request_failed').message
}

/**
 * Deletes the threads one after another; one that fails does not stop the rest. Says which failed and why, in a
 * single line when there are any.
 */
export async function deleteThreads(
  threads: readonly ArchivedThreadRef[],
  remove: (threadId: string) => Promise<unknown>
): Promise<{ deleted: string[]; error?: string }> {
  const deleted: string[] = []
  const failed: Array<{ thread: ArchivedThreadRef; message: string }> = []
  for (const thread of threads) {
    try {
      await remove(thread.id)
      deleted.push(thread.id)
    } catch (cause) {
      failed.push({ thread, message: deleteErrorMessage(cause) })
    }
  }
  if (!failed.length) return { deleted }
  if (threads.length === 1) return { deleted, error: failed[0]!.message }
  const first = failed[0]!
  const others = failed.length - 1
  return { deleted, error: `“${first.thread.name}” was not deleted: ${first.message}${others ? ` (and ${others} more)` : ''}` }
}
