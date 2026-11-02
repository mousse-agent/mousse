import type { StorageCleanupRule } from '../../shared/storage'

/**
 * The words next to each cleanup rule. A rule row shows its title, one short line and its control; what it
 * deletes and never deletes is in the tooltip (and in full in the recommended-rules dialog). Kept in one place
 * so the page and its tests read the same text.
 */
export type StorageRuleId = 'trash' | 'deletedThreads' | 'inactive' | 'merged' | 'captures'

export interface StorageRuleCopy {
  title: string
  /** The one short line under the title. The Trash row shows how many threads wait there instead. */
  line?: string
  /** Completes "Deletes …". */
  deletes: string
  /** Completes "Never deletes …". Worktree rules leave it out: the Worktrees group says it once. */
  never?: string
  /** One more sentence where the rule's wording could be misread. */
  note?: string
}

export const STORAGE_RULE_COPY: Record<StorageRuleId, StorageRuleCopy> = {
  trash: {
    title: 'Empty trash automatically',
    deletes: 'threads that have been in the trash longer than this, with their worktrees, branches and files.',
    never: 'work that has not been published. That needs your confirmation when you delete the thread yourself.'
  },
  deletedThreads: {
    title: 'Remove worktrees of deleted threads',
    line: 'When a thread moves to the trash.',
    deletes: 'the worktree folder of a thread when you move the thread to the trash. The thread stays in the trash until it is emptied.'
  },
  inactive: {
    title: 'Remove worktrees inactive for',
    line: 'Restored when you use the thread again.',
    deletes: 'the worktree folder of a thread that has had no activity for this long. It is restored the next time you use the thread.'
  },
  merged: {
    title: 'Remove worktrees whose work is merged into the default branch',
    line: 'Restored when you use the thread again.',
    deletes: 'the worktree folder of a thread once its commits are in the default branch. It is restored the next time you use the thread.',
    note: 'Merged means the worktree’s commits are in the default branch, or Publish put exactly the worktree’s files into your checkout. A pull request’s state is not checked, and a rebased or squashed branch counts as not merged.'
  },
  captures: {
    title: 'Delete saved browser captures after',
    line: 'Only captures no conversation uses.',
    deletes: 'screenshots the browser saved in closed sessions that no conversation uses. Older capture links will no longer open.',
    never: 'a screenshot attached to a conversation, a download, or anything from a session that is still open.',
    note: 'A download saved by an older version with a .png name can look like a capture and may be deleted.'
  }
}

/** The tooltip on a rule row: everything the rule deletes and keeps. */
export function ruleTooltip(rule: StorageRuleId): string {
  const copy = STORAGE_RULE_COPY[rule]
  return [`Deletes ${copy.deletes}`, copy.never && `Never deletes ${copy.never}`, copy.note].filter(Boolean).join(' ')
}

/** The Worktrees group's one-line note: what no worktree rule ever removes. */
export const WORKTREE_GROUP_DESCRIPTION = 'Worktrees with ignored files, unpublished commits or a running thread are always kept. Uncommitted changes are saved when a worktree is removed.'

/** Its tooltip: what counts as a local file, and how to remove such a worktree. */
export const WORKTREE_GROUP_TOOLTIP = 'Ignored files (such as .env or node_modules) keep a worktree, as do commits that are not in the default branch, staged changes, a merge or rebase in progress, and a thread that is running or waiting. Uncommitted and untracked files do not: they are saved when the worktree is removed and come back with it. Delete the thread to remove a worktree that is kept; you review what is discarded.'

export const CLEANUP_COPY = {
  idle: 'Runs the rules above now. You see what would be removed, and confirm, before anything is deleted.',
  noRule: 'Turn on a cleanup rule to use this.',
  trashWarning: 'Threads removed from the trash cannot be restored.',
  worktreeNote: 'A removed worktree is restored the next time you use its thread.',
  onlyListed: 'Only the items listed here are removed. Anything else that becomes eligible waits for the next run.',
  expired: 'This check is out of date. Check again to see what would be removed now.'
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

/** The name of the rule in front of an item. A kept worktree is just a worktree: the rule that looked at it did not act. */
export function ruleLabel(rule: StorageCleanupRule, outcome: 'removed' | 'kept' | 'failed' | 'keep' | 'remove'): string {
  if ((rule === 'worktree-inactive' || rule === 'worktree-merged') && (outcome === 'kept' || outcome === 'keep')) return 'Worktree'
  return STORAGE_RULE_LABELS[rule]
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
  return `${count} ${count === 1 ? 'thread' : 'threads'} in trash, listed under Recently deleted.`
}

/** The notice for a profile that was already in use when the recommended rules arrived. */
export const RECOMMENDED_COPY = {
  title: 'Recommended cleanup rules are available',
  body: 'Nothing has changed: only the worktrees of deleted threads are removed automatically. Turning on more rules is up to you.',
  modalIntro: 'These rules are off for you now. Turning them on lets Mousse remove these things on a schedule, and Clean up now shows you what before it removes anything.',
  rules: {
    inactive: 'Remove worktrees inactive for 30 days',
    merged: 'Remove worktrees whose work is merged into the default branch',
    captures: 'Delete saved browser captures after 30 days'
  }
}
