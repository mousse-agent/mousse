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
- Detect the remote default branch rather than assuming `main` or `master`. Start new shared work from its latest fetched commit. Name branches after the work only: `issue-123-short-description` when an issue number is available, otherwise a short description of the task. Never put an agent, model, or tool name in a branch name. For local PR testing, use the requested source and target commits and checkout. Respect an explicit branch name from the user.
- Use small, descriptive commits; this repo uses Conventional Commits. Commit only task-owned changes. For shared work, push useful checkpoints during work and before going offline. WIP commits need not pass every test.
- For shared work, open a draft PR when the diff is useful for review or handoff and its relevant tests pass, reusing the existing PR for the task. Keep material decisions and blockers attached to the issue/PR. Use the handoff format in `end-session` when pausing or transferring responsibility. A local experiment or backup alone does not warrant a PR.
- Before resuming, inspect changes on the default branch, related issues, and teammate branches. Reconcile old work and discard duplicate implementation only after verifying what is already accepted; do not destroy unpublished work automatically.
- Use `Closes #123` only when merging the PR completes the issue; otherwise use `Refs #123`. Keep WIP/review issues open. Status belongs in the handoff and draft/review state; no custom labels are required.

## Writing PRs and issues

Write for a teammate who has not seen the chat or the code. They should understand what changed and why in under a minute. The PR and issue templates in `.github/` follow this section.

### Titles

- PRs use a Conventional Commit prefix, then the outcome in plain words: `fix(chat): switching models keeps the conversation`. Say what changes for the user or the codebase, not which internals moved.
- Issues name the problem or goal: `Switching models loses the conversation`.

### PR descriptions

- **Problem:** one or two sentences on what is broken or missing, as the user sees it. For a bug, add the expected behavior and how to reproduce it.
- **Change:** how the PR solves it, in short paragraphs or bullets. Describe the change directly ("Claude sessions now restart when the model changes"). Leave yourself out of most sentences; say "I" only where a decision or check needs an owner.
- **How to review:** large PRs only. See below.
- **Verification:** bullets listing what you checked, what you saw, and what you could not check. Name the focused commands. "Tests pass" alone is not evidence. UI changes need before/after screenshots, and a short recording when motion or timing matters. Upload them to the PR; never commit PR-only assets.
- **Notes:** optional, one or two lines for stacking, rollout or install steps, and follow-ups. End with `Closes #123` or `Refs #123` when an issue exists.

### Keep it current

The description describes the PR as it is now. When the scope or approach changes, rewrite the affected section instead of appending "I also..." paragraphs. Commits and comments hold the history. Post a short comment when a change matters to reviewers who already read the PR.

### Plain words

- Short sentences, one idea per paragraph. Lead with the result.
- Use the terms in the [glossary](GLOSSARY.md). Explain any other internal term the first time it appears, or replace it with plain words.
- Leave out build hashes, file counts, and process narration unless a reviewer needs them.
- Link issues, PRs, commits, and files instead of retelling them.

### Scope and large PRs

One PR delivers one goal, at any size. A large feature such as the Run Engine belongs in one PR when its parts only make sense together. Split out work that does not serve the goal, such as an unrelated bug fix, an adjacent cleanup, or a second feature. Size alone is not a reason to split.

For a large PR:

- Add a **How to review** section listing the parts, the order to read them, and where the risk is.
- Keep commits in reviewable steps, such as one per phase.
- Put design reasoning that outlives the PR in a doc and link it instead of copying it into the description.

### Issues

- **Problem:** what is wrong or missing and who it affects. Bugs add the expected behavior and steps to reproduce.
- **Goal:** the outcome we want, in one sentence.
- **Done when:** checkboxes of observable results.
- **Out of scope:** optional; what the issue deliberately leaves out.

Keep the issue body current like a PR description. Decisions, blockers, and handoffs go in comments, written in the same plain style with the point first.

## Testing scope

While working, default to focused tests for the changed behavior and directly affected areas. `npm run test:changed` runs the tests related to the working tree and `npm run test:plan` shows that selection without running it; see `docs/testing.md` for how related tests are chosen and which tests must stay. Choose checks that establish the requested behavior and relevant regressions, including a targeted app check when the change warrants it.

Before a PR is opened, run only the named test files that cover the changed code, for example `npx vitest run tests/foo.test.ts tests/bar.test.ts` (find them with `rg -l <module> tests`), on the commit you will publish, and open the PR when they pass. `npm run test:branch` and `test:related` are not the pre-PR check: they follow imports, so a change to main, preload, CLI or build inputs selects most of the suite. Run the full suite (`npm test`) only for very large changes that affect multiple modules, such as shared infrastructure or cross-cutting refactors. If the tests fail, fix them or keep the work on its pushed task branch without a PR. A failure that looks unrelated or flaky still blocks the PR until it is shown to fail on the default branch too; the PR then names it. Rerun the relevant tests after later commits that change code, and state what ran and the result in the PR's Verification section.

Once relevant checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern. Reuse passing evidence for unchanged code and state what was tested. Documentation-only changes normally need diff and consistency review, not application tests.

Hosted CI runs basic checks on every PR and push to the default branch: the workflow tools test, typecheck and lint, a build, and the Windows-relevant tests. It does not run the full suite. The full suite can be started by hand from the CI workflow's `workflow_dispatch` trigger, and the nightly and stable release builds run it before publishing (`docs/releases.md`); do not start or wait for it as an extra completion or merge gate unless explicitly requested. Actual GitHub-enforced checks still apply.

## Review and merge

Changes intended for the shared default branch go through a PR. Local-only testing does not require a PR and does not authorize a remote merge. The relevant local tests must have passed on the current code, focused verification must cover the current changes, and actual GitHub-required checks and reviews must be satisfied. Passing tests do not by themselves prove the requested behavior works; include direct verification evidence. The manual full-suite CI run is not an additional merge requirement.

For routine changes, the present human may authorize a merge after verification, including when they authored the PR, if GitHub rules permit it. This is permission to merge, not a self-approval review. No additional teammate approval is imposed by these skills for routine work.

For small, low-risk documentation and communication-guidance changes, review the complete diff, run checks appropriate to the change, and merge promptly without another confirmation or an arbitrary waiting period. This standing authorization still requires a PR, current-head verification, resolution of review conversations, and any required GitHub checks or reviews. It does not cover application behavior changes or sensitive changes listed below. A direct instruction to document and apply a specific workflow preference authorizes that exact procedural update; do not expand it into broader permission changes.

Changes to authentication/authorization, credentials, destructive data migrations, or the merge/permission rules themselves require review by the other teammate. If unavailable, preserve a draft or ready PR and record the blocker. Expand or revise this list through an agreed policy change. Actual GitHub requirements always apply; no timer, label, or agent judgment bypasses them.

Move follow-up work to another task branch before merging. Remote deletion on merge, by GitHub or the cleanup helper, does not remove local commits or worktrees; see "Cleanup after merge". Review abandoned branches manually.

## Local availability after merge

A merge is not finished until the change is available in the user's primary worktree (the first entry of `git worktree list`, normally the checkout they run and read). This applies to every merge or push to the default branch, including one made from a temporary worktree or task branch.

1. After the merge or push, run `git fetch`, then inspect the primary worktree: its branch, its dirty files, and whether it contains the merge commit (`git merge-base --is-ancestor <merge-sha> HEAD`, run there).
2. If it is on the default branch and behind, run `git pull --ff-only` there. Unrelated uncommitted changes may stay. If the pull would overwrite local edits or is not a fast-forward, do not stash, reset, or force it.
3. If it is on another branch, do not switch it.
4. Do not report the change as merged and available until the primary worktree contains it. If it cannot be synced safely, say so plainly: name the branch it is on, state that it is behind, and give the exact command the user should run (for example `git switch master && git pull --ff-only`).
5. When the primary worktree is clean, prefer making small changes there on a task branch. Use a separate worktree only when the checkout is busy, and still finish with the sync above.

## Cleanup after merge

After the sync, remove the merged task's branch and worktree so they do not pile up. From the primary checkout, run `node scripts/team-cleanup.mjs --apply --branch <task-branch>`. It deletes the branch locally and on origin, and removes its worktree when that worktree has no uncommitted changes. It refuses the checkout it runs in, so leave the task worktree first. If it keeps something, report the reason instead of forcing it.

The same helper also runs at the start of work without `--branch` (see "Cleanup helper"), which catches branches merged elsewhere or by teammates.

## Failures and interruptions

Never treat failed authentication, an incomplete search, or a failed push as success. Report the exact missing evidence. Keep the next step concrete. If the preflight fetch fails, rerun the helper without `--fetch` (or inspect local Git state directly) before editing; label that remote information as cached.

If GitHub is unavailable, continue only work already authorized and whose scope is clear; do not claim to have checked for duplicates or acquired ownership. Preserve work in an isolated task branch. For shared work, if Git SSH still works, publish there and report the branch/commit plus the missing issue/PR handoff. Reconcile remote ownership and create/update the necessary records when access returns, before merging. Local-only work remains local regardless of GitHub availability.

If a push fails, retain the local work and state that it is not backed up remotely. Never include credentials or unrelated changes just to satisfy the checkpoint rule. Session-end skills cannot run after an abrupt shutdown, so checkpoints during work are essential.

## Repository enforcement

Skills are instructions, not access controls. Maintainers must configure GitHub separately:

- Require PRs into the default branch and the basic CI checks. Do not make a hosted full-suite run the routine gate; PRs are gated on the relevant local tests. Confirm checks pass before making them required.
- Require conversation resolution and block default-branch force pushes and deletion.
- Set the review policy consistently with the routine/sensitive distinction above. A blanket one-review requirement will block routine merges during absences; sensitive-review requirements here remain procedural unless separately enforced in GitHub.
- Enable automatic deletion of merged PR head branches (needs repository admin). The cleanup helper covers this until it is enabled. Do not automatically delete unmerged branches.

Adding workflow files does not enable these settings. Verify actual rules and permissions before reporting them as active. CI uses the repository's existing typecheck, lint, build and test commands.

## Preflight helper

Run `node scripts/team-status.mjs --fetch` for a fresh Git snapshot, or omit `--fetch` for cached local information. It reports the default branch, dirty files, ongoing merge/rebase state, upstream, and task-branch publishing state as JSON. It does not stage, commit, merge, switch, or push work. With `--fetch`, it updates remote-tracking refs without pruning branches.

## Cleanup helper

Run `node scripts/team-cleanup.mjs` from the primary checkout for a dry run, or add `--apply` to act. It prunes remote-tracking refs and treats a branch as delivered when a merged PR's head matches its tip, or when its tip is already on the default branch (but not equal to it). For delivered branches it removes the worktree and local branch, and deletes the origin branch of a merged PR with a lease on the checked tip.

It keeps, and reports, anything with an open PR, commits not on the default branch, uncommitted or untracked files, a lock, use within the last day, the primary or current checkout, `backup/*` and `mousse/*` branches, worktrees managed by the Mousse app, and detached checkouts. `--branch <name>` limits it to one branch and skips the recent-use check; use it for the task you just merged. Without GitHub access it falls back to branches already on the default branch and leaves origin alone.

This helper does not search GitHub issues/PRs or decide whether tasks overlap. The agent performs those checks with authenticated `gh` and inspects the evidence.
