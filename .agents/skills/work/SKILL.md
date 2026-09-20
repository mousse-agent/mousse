---
name: work
description: Start or resume authorized implementation in this repository, coordinating GitHub issues, ownership, task branches, and pushed checkpoints. Excludes discussion, planning, review, and diagnosis without a request to implement.
---

# Work

Read [the shared team policy](../../../docs/team-workflow.md) before acting. Use Git and authenticated GitHub CLI (`gh`); an available GitHub connector may perform equivalent operations.

## Establish the task

1. Confirm the requested outcome from the conversation. Preserve the distinction between discussing a change and implementing it.
2. Run `node scripts/team-status.mjs --fetch` from the repository root. Inspect dirty files, current branch, remote default, unpublished commits, and merge/rebase state. Do not switch, stash, or commit unrelated work. Use an isolated worktree when the current checkout is busy.
3. Verify the repository and authenticated identity with `gh repo view --json nameWithOwner,defaultBranchRef` and `gh api user --jq .login`. Search issues and PRs in all states using several relevant terms; inspect recent open work and remote branches too. A failed or truncated search is not evidence of no related work.
4. Read candidate issue discussions and PR diffs, not just titles. If already merged, verify the requested behavior on the current default branch. If another person is working on the same task, reconcile ownership before editing their branch or creating duplicate work. Shared files alone do not prove duplicate scope.
5. Reuse a matching issue, or create one describing intent, scope, and observable acceptance criteria. Assign the human taking the next action. For a handoff, record the ownership change and verify assignment; do not silently take over someone else's active issue.
6. Use a dedicated task branch, preferably `codex/issue-123-short-description`, based on the freshly fetched default branch. Reuse the existing task branch when appropriate. Before resuming old work, compare it with the default branch and keep only changes still needed.

## Keep work recoverable

- Implement and verify the requested outcome. Keep commits focused on this task.
- At useful checkpoints, commit and push the task's work. Open a draft PR once there is a useful pushed diff. WIP may have failing checks; record failures and remaining work clearly. Do not wait for a perfect implementation to publish a checkpoint.
- Confirm the push succeeded and the remote branch contains the checkpoint. A local commit or an attempted push is not a remote backup.
- Record decisions, blockers, changed scope, and the next action on the issue/PR. Link the branch and PR; avoid posting repetitive no-change updates.
- Inspect the diff for credentials, generated junk, and unrelated work before committing. Never use broad staging to absorb someone else's files.

## Finish or pause

When implementation is ready for review or the user asks to stop, follow [end-session](../end-session/SKILL.md). Carry forward the user's existing authorization: a request to commit and push authorizes those actions, not merging.

If GitHub access, ownership, or publishing is blocked, follow the shared policy's failure handling. Report what was actually verified and published, and what still needs attention.
