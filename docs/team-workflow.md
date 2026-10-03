# Team workflow

GitHub records work intended for the shared codebase: meaningful tasks, ownership, decisions, blockers, and handoffs. The remote task branch contains the work; the PR contains the proposed diff and verification. Local testing and experiments stay local unless publishing is explicitly requested.

## Using the skills

The repository contains two shared skills under `.agents/skills/`: `work` and `end-session`. Simply describe what to implement or resume; `work` automatically handles coordination, checkpoints, verification, and PR preparation. Skill names are optional. Only an explicit request to end the session triggers `end-session`; normal task completion and casual goodbyes do not. `AGENTS.md` routes these requests to the same files even for clients that do not automatically discover this directory.

Clients must load this checkout's project instructions. OpenCode discovery has been verified; Grok's inspector suppresses project instructions and skills in an untrusted checkout, so its discovery must be checked after the user trusts the project through the normal client UI.

Discussion, planning, reviews, and diagnosis alone do not authorize code changes, issue creation, assignment, or PR updates. An implementation request authorizes the requested outcome; it does not automatically make local work a shared deliverable. Apply the scope rules below before creating GitHub records or publishing. Small, low-risk documentation and communication-guidance changes have standing merge authorization as described below. Other changes require task-specific merge authorization; requesting a push alone does not authorize their merge.

## Decide what needs tracking

- Local-only work includes checking out or combining existing PRs for testing, resolving conflicts for a local trial, temporary instrumentation, and experiments. Preserve the user's edits and keep the result available where requested. Use a local branch, worktree, or commit when useful for recovery. Do not create an issue or PR, push a checkpoint, or post routine GitHub updates for this work unless explicitly requested. Permission to comment on an existing PR authorizes that comment, not a new tracking task or publication.
- Shared work proposes a durable change to the repository, such as a feature, bug fix, or maintained documentation or policy. Reuse a matching issue and PR. Create an issue only when a meaningful task needs its own scope, owner, acceptance criteria, or handoff; a small self-contained change can be recorded in its PR without a separate issue. Record material decisions, blockers, and handoffs rather than routine activity.
- Testing an existing PR does not need a second integration PR. Keep fixes intended to ship with the original task where ownership permits. Create a separate PR only for an independently reviewable deliverable or when explicitly requested. Conflict resolution for local testing alone is not a new deliverable.
- A request to push a local backup authorizes that push, not issue or PR creation. If an experiment later becomes work intended to ship, apply the shared workflow then; do not infer publication or merge permission from the earlier local-testing request.

## Shared conventions

- For shared work, search issues and PRs in all states, inspect their discussions/diffs, and check remote branches before starting. Closed work may already solve the problem; an inactive-looking issue is not permission to take it over.
- One logical shared task has one active owner and normally one task branch and PR; use an issue when it adds meaningful coordination. Assignment is temporary responsibility, not ownership of files or an exclusive lock. Resolve overlapping scope with the people involved before proceeding; independent tasks may touch the same files.
- Assign the authenticated human taking responsibility. Verify their identity and permissions. Record an agreed handoff when ownership changes.
- Detect the remote default branch rather than assuming `main` or `master`. Start new shared work from its latest fetched commit. Use `codex/issue-123-short-description` when an issue number is available, otherwise a descriptive task branch. For local PR testing, use the requested source and target commits and checkout. Respect an explicit branch name from the user.
- Use small, descriptive commits; this repo uses Conventional Commits. Commit only task-owned changes. For shared work, push useful checkpoints during work and before going offline. WIP commits need not pass every test.
- For shared work, open a draft PR when the diff is useful for review or handoff, reusing the existing PR for the task. Keep material decisions and blockers attached to the issue/PR. Use the handoff format in `end-session` when pausing or transferring responsibility. A local experiment or backup alone does not warrant a PR.
- Before resuming, inspect changes on the default branch, related issues, and teammate branches. Reconcile old work and discard duplicate implementation only after verifying what is already accepted; do not destroy unpublished work automatically.
- Use `Closes #123` only when merging the PR completes the issue; otherwise use `Refs #123`. Keep WIP/review issues open. Status belongs in the handoff and draft/review state; no custom labels are required.

## Testing scope

Default to focused tests for the changed behavior and directly affected areas. Choose checks that establish the requested behavior and relevant regressions, including a targeted app check when the change warrants it. Run the full test suite only when explicitly requested; implementation, merge, and session-wrap-up requests alone do not authorize a full run.

Once relevant checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern. Keep any additional checks focused unless a full suite is explicitly requested. Reuse passing evidence for unchanged code and state what was tested. Documentation-only changes normally need diff and consistency review, not application tests.

Automatic CI may run independently. Do not manually trigger, repeat, or wait for an optional full-suite run as an extra completion or merge gate unless explicitly requested. Actual GitHub-enforced checks still apply; if they require a full run, explain that requirement rather than bypassing it or launching a duplicate local run.

## Review and merge

Changes intended for the shared default branch go through a PR. Local-only testing does not require a PR and does not authorize a remote merge. Focused verification must cover the current changes, and actual GitHub-required checks and reviews must be satisfied. Passing tests do not by themselves prove the requested behavior works; include direct verification evidence. An optional full-suite CI run is not an additional merge requirement.

For routine changes, the present human may authorize a merge after verification, including when they authored the PR, if GitHub rules permit it. This is permission to merge, not a self-approval review. No additional teammate approval is imposed by these skills for routine work.

For small, low-risk documentation and communication-guidance changes, review the complete diff, run checks appropriate to the change, and merge promptly without another confirmation or an arbitrary waiting period. This standing authorization still requires a PR, current-head verification, resolution of review conversations, and any required GitHub checks or reviews. It does not cover application behavior changes or sensitive changes listed below. A direct instruction to document and apply a specific workflow preference authorizes that exact procedural update; do not expand it into broader permission changes.

Changes to authentication/authorization, credentials, destructive data migrations, or the merge/permission rules themselves require review by the other teammate. If unavailable, preserve a draft or ready PR and record the blocker. Expand or revise this list through an agreed policy change. Actual GitHub requirements always apply; no timer, label, or agent judgment bypasses them.

GitHub may automatically delete a merged PR's remote head branch. Move follow-up work to another task branch before merging. Automatic remote deletion does not remove local commits or worktrees; clean up a local branch only when it has no unpublished work and is not in use by another worktree. Review abandoned branches manually.

## Local availability after merge

A merge is not finished until the change is available in the user's primary worktree (the first entry of `git worktree list`, normally the checkout they run and read). This applies to every merge or push to the default branch, including one made from a temporary worktree or task branch.

1. After the merge or push, run `git fetch`, then inspect the primary worktree: its branch, its dirty files, and whether it contains the merge commit (`git merge-base --is-ancestor <merge-sha> HEAD`, run there).
2. If it is on the default branch and behind, run `git pull --ff-only` there. Unrelated uncommitted changes may stay. If the pull would overwrite local edits or is not a fast-forward, do not stash, reset, or force it.
3. If it is on another branch, do not switch it.
4. Do not report the change as merged and available until the primary worktree contains it. If it cannot be synced safely, say so plainly: name the branch it is on, state that it is behind, and give the exact command the user should run (for example `git switch master && git pull --ff-only`).
5. When the primary worktree is clean, prefer making small changes there on a task branch. Use a separate worktree only when the checkout is busy, and still finish with the sync above.

## Failures and interruptions

Never treat failed authentication, an incomplete search, or a failed push as success. Report the exact missing evidence. Keep the next step concrete. If the preflight fetch fails, rerun the helper without `--fetch` (or inspect local Git state directly) before editing; label that remote information as cached.

If GitHub is unavailable, continue only work already authorized and whose scope is clear; do not claim to have checked for duplicates or acquired ownership. Preserve work in an isolated task branch. For shared work, if Git SSH still works, publish there and report the branch/commit plus the missing issue/PR handoff. Reconcile remote ownership and create/update the necessary records when access returns, before merging. Local-only work remains local regardless of GitHub availability.

If a push fails, retain the local work and state that it is not backed up remotely. Never include credentials or unrelated changes just to satisfy the checkpoint rule. Session-end skills cannot run after an abrupt shutdown, so checkpoints during work are essential.

## Repository enforcement

Skills are instructions, not access controls. Maintainers must configure GitHub separately:

- Require PRs into the default branch and passing focused checks appropriate to the changed behavior. Configure required checks to support the focused-testing default; do not make a full-suite run the routine gate. Confirm checks pass before making them required.
- Require conversation resolution and block default-branch force pushes and deletion.
- Set the review policy consistently with the routine/sensitive distinction above. A blanket one-review requirement will block routine merges during absences; sensitive-review requirements here remain procedural unless separately enforced in GitHub.
- Enable automatic deletion of merged PR head branches. Do not automatically delete unmerged branches.

Adding workflow files does not enable these settings. Verify actual rules and permissions before reporting them as active. The application CI uses the repository's existing typecheck and test commands; its first hosted run must establish the baseline.

## Preflight helper

Run `node scripts/team-status.mjs --fetch` for a fresh Git snapshot, or omit `--fetch` for cached local information. It reports the default branch, dirty files, ongoing merge/rebase state, upstream, and task-branch publishing state as JSON. It does not stage, commit, merge, switch, or push work. With `--fetch`, it updates remote-tracking refs without pruning branches.

This helper does not search GitHub issues/PRs or decide whether tasks overlap. The agent performs those checks with authenticated `gh` and inspects the evidence.
