# Merge and sync

Read this only when asked to merge, when a small documentation or communication-guidance change falls under the policy's standing merge authorization, or after any merge or push to the default branch. A request to commit and push alone does not authorize merging.

## Merge

1. The PR head must be the commit the recorded checks ran on: `node scripts/task-notes.mjs get tested.sha` against `gh pr view <n> --json headRefOid`. If they differ, rerun only what the later commits affect (`node scripts/verify.mjs ...`).
2. Check the checks, reviews and conversations GitHub actually requires. Do not wait for hosted CI that GitHub does not require; if GitHub blocks the merge on a required check, report it. Do not start the full-suite CI run unless asked.
3. Merge: `gh pr merge <n> --match-head-commit <tested sha>` with an enabled method. No extra confirmation or arbitrary wait for changes the policy authorizes. Sensitive changes in the policy's "Review and merge" need no teammate review, only the present human's authorization for that merge.
4. Release the claim: `node scripts/work-claim.mjs release --task <branch>`.
5. Issue completion: the issue-hygiene workflow closes issues named by `Closes #N` after the merge. Look at the issue once (`gh issue view <n> --json state`); for `Refs #N`, leave it open.

## Sync the primary worktree

Read "Local availability after merge" and "Cleanup after merge" in [the policy](../../../docs/team-workflow.md) and follow them. In short: `git fetch`; if the primary worktree (first entry of `git worktree list`) is on the default branch and behind, `git pull --ff-only` there; never switch its branch, stash or discard unrelated work. Do not say the change is merged and available until it contains the merge commit; if it cannot be synced, name its branch and give the exact command. Then clean up the task: `node scripts/team-cleanup.mjs --apply --branch <task-branch>` from the primary checkout.
