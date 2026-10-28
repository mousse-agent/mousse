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
4. Run `node scripts/team-cleanup.mjs --apply`. It removes local branches, clean worktrees, and remote branches whose work already landed on the default branch, and keeps anything with uncommitted changes, open PRs, unmerged commits, recent use, or app ownership. Mention what it removed or kept only when it bears on the task. Before creating a worktree, check `git worktree list` and reuse the task's existing one.

For local-only work, inspect the relevant source PR and target commits, perform the requested integration or experiment, run focused verification, and report the local result. Use local branches or commits when useful for recovery. Keep publication and GitHub updates limited to what was explicitly requested; a backup push or comment on the source PR does not require a new issue or PR. Stop here when the local outcome is complete.

## Coordinate shared work

For changes intended to ship:

1. Verify the repository and authenticated identity with `gh repo view --json nameWithOwner,defaultBranchRef` and `gh api user --jq .login`. Search issues and PRs in all states using several relevant terms; inspect recent open work and remote branches too. A failed or truncated search is not evidence of no related work.
2. Read candidate issue discussions and PR diffs, not just titles. If already merged, verify the requested behavior on the current default branch. If another person is working on the same task, reconcile ownership before editing their branch or creating duplicate work. Shared files alone do not prove duplicate scope.
3. Reuse a matching issue and PR. Create an issue only when a meaningful task needs its own scope, owner, acceptance criteria, or handoff; a small self-contained change can use the PR alone. When using an issue, assign the human taking the next action and verify assignment. Record an agreed handoff; do not silently take over someone else's active issue.
4. Use a dedicated task branch based on the freshly fetched default branch. Name it after the work only: `issue-123-short-description` when an issue exists, otherwise a short description of the task. Never put an agent, model, or tool name in a branch name. Reuse the existing task branch when appropriate. Before resuming old work, compare it with the default branch and keep only changes still needed.

## Keep shared work recoverable

- Implement and verify the requested outcome. Keep commits focused on this task.
- At useful checkpoints, commit and push the task's work. Open or reuse a draft PR when the diff is useful for review or handoff and its relevant tests pass (see "Finish shared work"). WIP that fails them stays on the pushed branch without a PR; record failures and remaining work on the issue or in the handoff. Do not create a separate integration PR merely to test or combine another PR locally.
- Confirm the push succeeded and the remote branch contains the checkpoint. A local commit or an attempted push is not a remote backup.
- Record material decisions, blockers, changed scope, and the next action on the issue/PR. Link the branch and PR; avoid routine activity logs and repetitive no-change updates.
- Inspect the diff for credentials, generated junk, and unrelated work before committing. Never use broad staging to absorb someone else's files.

## Write it up

Follow "Writing PRs and issues" in the shared policy whenever you create or edit an issue, PR, or comment:

- Title: Conventional Commit prefix plus the outcome in plain words for PRs; the problem or goal for issues.
- PR body: Problem, Change, Verification, plus How to review for large PRs and an optional Notes line. Issue body: Problem, Goal, Done when, and optionally Out of scope. Use the templates in `.github/`.
- Rewrite the body when scope or approach changes. Never append a running log of follow-ups.
- Use plain words and the terms in `docs/GLOSSARY.md`. Keep build, install, and stacking details in Notes or a comment.
- One goal per PR, at any size. Split out unrelated fixes and cleanups, not large work that belongs together.

## Finish shared work

When implementation is ready, run focused checks for the changed behavior and directly affected areas, verify the requested outcome, and commit and push the task's changes.

Before opening a PR for a code change, run only the named test files that cover the changed code (for example `npx vitest run tests/foo.test.ts`; find them with `rg -l <module> tests`) on the commit you will publish. Do not use `npm run test:branch` or `test:related` as the pre-PR check: a change to main, preload, CLI or build inputs makes them select most of the suite. Open the PR when they pass. Run the full suite (`npm test`) only for very large changes that affect multiple modules. If tests fail, fix the failure or leave the work on its pushed task branch without a PR, and report the failing tests; a failure you believe is unrelated or flaky still blocks the PR until you have shown it also fails on the default branch, and the PR must then name it. Hosted CI runs only basic checks, because local hardware is faster than the hosted runners, so the local run is the real gate. Rerun the relevant tests after later commits that change code. Documentation-only changes normally need diff and consistency review, not application tests.

Then open or update the PR with verification evidence, written as described in "Write it up", including which tests ran locally and their result. Once checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern. When an issue exists, use `Closes #123` for full completion or `Refs #123` for partial delivery and keep it open until completion lands. Keep unfinished shared work that passes its relevant tests in a draft PR, and work that does not on its pushed task branch. Report the published commit and links. This is ordinary task completion; do not start a session-end menu.

When explicitly asked to merge, or when a small, low-risk documentation or communication-guidance change falls under the shared policy's standing authorization, review and merge promptly: verify the current head's relevant local test results, and actual GitHub-required checks/reviews/conversations, guard against a changed PR head, merge using an enabled method, confirm issue completion, and clean up the merged task as described in "Cleanup after merge" in the shared policy. Do not trigger or wait for the optional full-suite CI run as an extra merge gate unless explicitly requested. Do not ask for another confirmation or add an arbitrary wait for changes covered by standing authorization. A request to commit and push alone does not authorize merging other changes.

After any merge or push to the default branch, sync the primary worktree as described in "Local availability after merge" in the shared policy: fetch, fast-forward it when it is on the default branch, and verify it contains the merge commit. Never switch its branch, stash, or discard unrelated work to do this. If it cannot be synced, tell the user which branch it is on and the exact command to run; do not say the change is merged and available until it is.

Only when explicitly asked to end the session, follow [end-session](../end-session/SKILL.md). Do not infer session end from task completion or a casual goodbye.

If GitHub access, ownership, or publishing is blocked, follow the shared policy's failure handling. Report what was actually verified and published, and what still needs attention.
