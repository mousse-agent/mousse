# Team workflow

The issue records intent, ownership, decisions, and next steps. The remote task branch contains the work. The PR contains the diff and verification. Both teammates should be able to continue from those records when the other is unavailable.

## Using the skills

The repository contains two shared skills under `.agents/skills/`: `work` and `end-session`. Ask the agent to implement or resume a task, or explicitly name `work`. Ask to end a session, publish WIP, prepare a review, or merge, and `end-session` handles that outcome. `AGENTS.md` routes these requests to the same files even for clients that do not automatically discover this directory.

Clients must load this checkout's project instructions. OpenCode discovery has been verified; Grok's inspector suppresses project instructions and skills in an untrusted checkout, so its discovery must be checked after the user trusts the project through the normal client UI.

Discussion, planning, reviews, and diagnosis alone do not authorize code changes, issue creation, assignment, or PR updates. Once implementation is requested, issue creation/assignment, task branches, focused commits, pushed checkpoints, draft PRs, and status updates are normal steps within that task. Merge requires authorization for that task; requesting a push does not authorize a merge.

## Shared conventions

- Search issues and PRs in all states, inspect their discussions/diffs, and check remote branches before starting. Closed work may already solve the problem; an inactive-looking issue is not permission to take it over.
- One logical task has one active owner and normally one issue, task branch, and PR. Assignment is temporary responsibility, not ownership of files or an exclusive lock. Resolve overlapping scope with the people involved before proceeding; independent tasks may touch the same files.
- Assign the authenticated human taking responsibility. Verify their identity and permissions. Record an agreed handoff when ownership changes.
- Detect the remote default branch rather than assuming `main` or `master`. Start new work from its latest fetched commit. Use `codex/issue-123-short-description` when an issue number is available; respect an explicit branch name from the user.
- Use small, descriptive commits; this repo uses Conventional Commits. Commit only task-owned changes. Push useful checkpoints during work and before going offline. WIP commits need not pass every test.
- Open a draft PR for useful WIP. Keep decisions and blockers attached to the issue/PR. Use the handoff format in `end-session` when pausing or transferring responsibility.
- Before resuming, inspect changes on the default branch, related issues, and teammate branches. Reconcile old work and discard duplicate implementation only after verifying what is already accepted; do not destroy unpublished work automatically.
- Use `Closes #123` only when merging the PR completes the issue; otherwise use `Refs #123`. Keep WIP/review issues open. Status belongs in the handoff and draft/review state; no custom labels are required.

## Review and merge

All changes go through a PR. Required checks must pass for the current changes, and repository review requirements must be satisfied. A passing test suite does not by itself prove the requested behavior works; include direct verification evidence.

For routine changes, the present human may authorize a merge after verification, including when they authored the PR, if GitHub rules permit it. This is permission to merge, not a self-approval review. No additional teammate approval is imposed by these skills for routine work.

Changes to authentication/authorization, credentials, destructive data migrations, or the merge/permission rules themselves require review by the other teammate. If unavailable, preserve a draft or ready PR and record the blocker. Expand or revise this list through an agreed policy change. Actual GitHub requirements always apply; no timer, label, or agent judgment bypasses them.

GitHub may automatically delete a merged PR's remote head branch. Move follow-up work to another task branch before merging. Automatic remote deletion does not remove local commits or worktrees; clean up a local branch only when it has no unpublished work and is not in use by another worktree. Review abandoned branches manually.

## Failures and interruptions

Never treat failed authentication, an incomplete search, or a failed push as success. Report the exact missing evidence. Keep the next step concrete. If the preflight fetch fails, rerun the helper without `--fetch` (or inspect local Git state directly) before editing; label that remote information as cached.

If GitHub is unavailable, continue only work already authorized and whose scope is clear; do not claim to have checked for duplicates or acquired ownership. Preserve work in an isolated task branch. If Git SSH still works, publish there and report the branch/commit plus the missing issue/PR handoff. Reconcile remote ownership and create/update the records when access returns, before merging.

If a push fails, retain the local work and state that it is not backed up remotely. Never include credentials or unrelated changes just to satisfy the checkpoint rule. Session-end skills cannot run after an abrupt shutdown, so checkpoints during work are essential.

## Repository enforcement

Skills are instructions, not access controls. Maintainers must configure GitHub separately:

- Require PRs into the default branch and passing `Application checks` and `Workflow tools` jobs from the CI workflow after their first runs. Confirm the baseline checks pass before making them required.
- Require conversation resolution and block default-branch force pushes and deletion.
- Set the review policy consistently with the routine/sensitive distinction above. A blanket one-review requirement will block routine merges during absences; sensitive-review requirements here remain procedural unless separately enforced in GitHub.
- Enable automatic deletion of merged PR head branches. Do not automatically delete unmerged branches.

Adding workflow files does not enable these settings. Verify actual rules and permissions before reporting them as active. The application CI uses the repository's existing typecheck and test commands; its first hosted run must establish the baseline.

## Preflight helper

Run `node scripts/team-status.mjs --fetch` for a fresh Git snapshot, or omit `--fetch` for cached local information. It reports the default branch, dirty files, ongoing merge/rebase state, upstream, and task-branch publishing state as JSON. It does not stage, commit, merge, switch, or push work. With `--fetch`, it updates remote-tracking refs without pruning branches.

This helper does not search GitHub issues/PRs or decide whether tasks overlap. The agent performs those checks with authenticated `gh` and inspects the evidence.
