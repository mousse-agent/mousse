import type { StorageCleanupRule } from '../../shared/storage'

/**
 * The words next to each cleanup rule. Every rule says what it deletes and what it never deletes, so a
 * person can decide without opening anything. Kept in one place so the page and its tests read the same text.
 */
export type StorageRuleId = 'trash' | 'deletedThreads' | 'inactive' | 'merged' | 'captures'

export interface StorageRuleCopy {
  title: string
  /** Completes "Deletes …". */
  deletes: string
  /** Completes "Never deletes …". */
  never: string
  /** One more sentence where the rule's wording could be misread. */
  note?: string
}

const KEPT_WORKTREE = 'a worktree with uncommitted, untracked or ignored files (such as .env or node_modules), commits that are not in the default branch, or a thread that is running or waiting.'

export const STORAGE_RULE_COPY: Record<StorageRuleId, StorageRuleCopy> = {
  trash: {
    title: 'Empty trash automatically',
    deletes: 'threads that have been in the trash longer than this, with their worktrees, branches and files.',
    never: 'work that has not been published. That needs your confirmation when you delete the thread yourself.'
  },
  deletedThreads: {
    title: 'Remove worktrees of deleted threads',
    deletes: 'the worktree folder of a thread when you move the thread to the trash. The thread stays in the trash until it is emptied.',
    never: KEPT_WORKTREE
  },
  inactive: {
    title: 'Remove worktrees inactive for',
    deletes: 'the worktree folder of a thread that has had no activity for this long. It is restored the next time you use the thread.',
    never: KEPT_WORKTREE
  },
  merged: {
    title: 'Remove worktrees whose work is merged into the default branch',
    deletes: 'the worktree folder of a thread once its commits are in the default branch. It is restored the next time you use the thread.',
    never: KEPT_WORKTREE,
    note: 'Merged means the worktree’s commits are in the default branch. A pull request’s state is not checked, and a rebased or squashed branch counts as not merged.'
  },
  captures: {
    title: 'Delete saved browser captures after',
    deletes: 'screenshots the browser saved in closed sessions that no conversation uses. Older capture links will no longer open.',
    never: 'a screenshot attached to a conversation, a download, or anything from a session that is still open.',
    note: 'A download saved by an older version with a .png name can look like a capture and may be deleted.'
  }
}

export const WORKTREE_GROUP_DESCRIPTION = 'Work that has not been published is never removed automatically.'

export const KEEP_WHEN_COPY = {
  title: 'Keep a worktree when it has any local files',
  description: 'Uncommitted, untracked and ignored files (such as .env or node_modules) all keep a worktree. Delete the thread to remove such a worktree; you review what is discarded.'
}

export const CLEANUP_COPY = {
  idle: 'Runs the rules above now. You see what would be removed, and confirm, before anything is deleted.',
  noRule: 'Turn on a cleanup rule to use this.',
  trashWarning: 'Threads removed from the trash cannot be restored.',
  worktreeNote: 'A removed worktree is restored the next time you use its thread.'
}

/** Short names for the report and the dry run: which rule acted. */
export const STORAGE_RULE_LABELS: Record<StorageCleanupRule, string> = {
  'worktree-deleted': 'Deleted thread',
  'worktree-inactive': 'Inactive worktree',
  'worktree-merged': 'Merged worktree',
  'worktree-orphan': 'Unused worktree',
  'browser-capture': 'Browser capture',
  trash: 'Trash'
}

/** Where each kind's size is cleaned up, for "selecting a kind jumps to that kind's cleanup rule". */
export const KIND_POLICY_GROUP: Record<'threads' | 'worktrees' | 'browser' | 'logs' | 'other', string | undefined> = {
  threads: 'storage-trash',
  worktrees: 'storage-worktrees',
  browser: 'storage-browser',
  logs: undefined,
  other: undefined
}

/** Shown where a thread's workspace is described when a cleanup rule removed its checkout. Empty for an unreadable time. */
export function retiredWorktreeNote(at: string): string {
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return ''
  return `Worktree removed by cleanup on ${new Date(time).toLocaleDateString()}; it is restored when you use the thread`
}

/** Where the trash is reviewed and restored: the sidebar's Recently deleted section. */
export function trashCountSentence(count: number): string {
  if (count === 0) return 'No threads in trash.'
  return `${count} ${count === 1 ? 'thread' : 'threads'} in trash · restore or delete them from Recently deleted in the sidebar.`
}
