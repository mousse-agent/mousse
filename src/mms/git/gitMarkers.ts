/**
 * Files and folders in the Git directory that exist while a merge, rebase, cherry-pick or revert waits for the user.
 * A rebase is told by its state folder, not `REBASE_HEAD`: Git can leave that file behind after the rebase finishes.
 */
export const IN_PROGRESS_GIT_MARKERS = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'] as const

/**
 * What Git says when a folder is not in a repository it can open: none found, or a `.git` file naming a Git folder that
 * is gone or broken. Git 2.56 words the second as "gitfile does not point to a valid repository"; older Git says
 * "not a git repository" for both.
 */
export const NOT_A_GIT_REPOSITORY = /not a git repository|gitfile does not point to a valid repository/i
