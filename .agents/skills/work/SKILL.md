---
name: work
description: Start or resume authorized implementation or local testing in this repository. Keep experiments local and coordinate meaningful changes intended for the shared codebase. Excludes discussion, planning, review, and diagnosis without a request to implement.
---

# Work

Read [the shared team policy](../../../docs/team-workflow.md) before acting. Use Git and authenticated GitHub CLI (`gh`); an available GitHub connector may perform equivalent operations.

## Establish the scope

1. Confirm the requested outcome from the conversation. Preserve the distinction between discussing a change and implementing it.
2. Decide whether the outcome is local-only testing or a change intended for the shared codebase, using the shared policy's scope rules. Testing or combining existing PRs, local conflict resolution, and experiments do not automatically authorize issues, PRs, pushes, or GitHub status updates.
3. Run `node scripts/team-status.mjs --fetch` from the repository root. Inspect dirty files, current branch, remote default, unpublished commits, and merge/rebase state. Do not switch, stash, or commit unrelated work. Use an isolated worktree when needed; respect a request to make the result available in the primary checkout.

For local-only work, inspect the relevant source PR and target commits, perform the requested integration or experiment, run focused verification, and report the local result. Use local branches or commits when useful for recovery. Keep publication and GitHub updates limited to what was explicitly requested; a backup push or comment on the source PR does not require a new issue or PR. Stop here when the local outcome is complete.

## Coordinate shared work

For changes intended to ship:

1. Verify the repository and authenticated identity with `gh repo view --json nameWithOwner,defaultBranchRef` and `gh api user --jq .login`. Search issues and PRs in all states using several relevant terms; inspect recent open work and remote branches too. A failed or truncated search is not evidence of no related work.
2. Read candidate issue discussions and PR diffs, not just titles. If already merged, verify the requested behavior on the current default branch. If another person is working on the same task, reconcile ownership before editing their branch or creating duplicate work. Shared files alone do not prove duplicate scope.
3. Reuse a matching issue and PR. Create an issue only when a meaningful task needs its own scope, owner, acceptance criteria, or handoff; a small self-contained change can use the PR alone. When using an issue, assign the human taking the next action and verify assignment. Record an agreed handoff; do not silently take over someone else's active issue.
4. Use a dedicated task branch based on the freshly fetched default branch. Prefer `codex/issue-123-short-description` when an issue exists, otherwise a descriptive task name. Reuse the existing task branch when appropriate. Before resuming old work, compare it with the default branch and keep only changes still needed.

## Keep shared work recoverable

- Implement and verify the requested outcome. Keep commits focused on this task.
- At useful checkpoints, commit and push the task's work. Open or reuse a draft PR when the diff is useful for review or handoff. WIP may have failing checks; record failures and remaining work clearly. Do not create a separate integration PR merely to test or combine another PR locally.
- Confirm the push succeeded and the remote branch contains the checkpoint. A local commit or an attempted push is not a remote backup.
- Record material decisions, blockers, changed scope, and the next action on the issue/PR. Link the branch and PR; avoid routine activity logs and repetitive no-change updates.
- Inspect the diff for credentials, generated junk, and unrelated work before committing. Never use broad staging to absorb someone else's files.

## Finish shared work

When implementation is ready, run focused checks for the changed behavior and directly affected areas, verify the requested outcome, commit and push the task's changes, and open or update the PR with verification evidence. Run the full test suite only when explicitly requested. Once focused checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern; keep additional checks focused. Documentation-only changes normally need diff and consistency review, not application tests. When an issue exists, use `Closes #123` for full completion or `Refs #123` for partial delivery and keep it open until completion lands. Keep unfinished shared work in a draft PR. Report the published commit and links. This is ordinary task completion; do not start a session-end menu.

When explicitly asked to merge, or when a small, low-risk documentation or communication-guidance change falls under the shared policy's standing authorization, review and merge promptly: verify current-head focused checks and actual GitHub-required checks/reviews/conversations, guard against a changed PR head, merge using an enabled method, confirm issue completion, and clean up only the merged task branch as permitted by the policy. Do not wait for optional full-suite CI as an extra merge gate unless explicitly requested. Do not ask for another confirmation or add an arbitrary wait for changes covered by standing authorization. A request to commit and push alone does not authorize merging other changes.

After any merge or push to the default branch, sync the primary worktree as described in "Local availability after merge" in the shared policy: fetch, fast-forward it when it is on the default branch, and verify it contains the merge commit. Never switch its branch, stash, or discard unrelated work to do this. If it cannot be synced, tell the user which branch it is on and the exact command to run; do not say the change is merged and available until it is.

Only when explicitly asked to end the session, follow [end-session](../end-session/SKILL.md). Do not infer session end from task completion or a casual goodbye.

If GitHub access, ownership, or publishing is blocked, follow the shared policy's failure handling. Report what was actually verified and published, and what still needs attention.
