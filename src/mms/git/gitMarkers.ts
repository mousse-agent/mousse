/** Files and folders in the Git directory that exist while a merge, rebase, cherry-pick or revert waits for the user. */
export const IN_PROGRESS_GIT_MARKERS = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'] as const
