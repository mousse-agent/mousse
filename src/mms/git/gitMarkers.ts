/**
 * Files and folders in the Git directory that exist while a merge, rebase, cherry-pick or revert waits for the user.
 * A rebase is told by its state folder, not `REBASE_HEAD`: Git can leave that file behind after the rebase finishes.
 */
export const IN_PROGRESS_GIT_MARKERS = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'] as const
