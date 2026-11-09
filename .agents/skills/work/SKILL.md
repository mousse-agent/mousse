---
name: work
description: Start or resume authorized implementation or local testing in this repository. Keep experiments local and coordinate meaningful changes intended for the shared codebase. Excludes discussion, planning, review, and diagnosis without a request to implement.
---

# Work

Read [the shared team policy](../../../docs/team-workflow.md) before acting. Use Git and authenticated GitHub CLI (`gh`); an available GitHub connector may perform equivalent operations.

## Size the change

Pick the tier from what the change touches, not from how many files it has. Use the highest tier any part of the change reaches, and name the tier in the PR's Verification section.

| Tier | Examples | Related-work check | Tests before the PR | Evidence |
|---|---|---|---|---|
| 1. Trivial | Copy, docs, comments, one CSS value | The task's known issue or PR, if any | None; review the diff | The diff, plus a screenshot when it is visible in the app |
| 2. Small UI | Layout, styling, one component's look or a small interaction; no data, IPC or protocol change | One search of issues and PRs in all states with two or three terms | Named test files for the touched component, if any. No typecheck, lint or build | Before/after screenshots |
| 3. Feature | New behavior in one area, such as a renderer view and its store, or one service | "Coordinate shared work" below | Named test files covering the changed code, plus a typecheck of the touched project (`npx tsc --noEmit -p tsconfig.web.json` or `tsconfig.node.json`) | Tests and a direct check of the behavior |
| 4. Cross-area | Several modules, shared types, or renderer-to-main IPC | [check-related-work](../check-related-work/SKILL.md) | Named test files in each affected area, plus `npm run typecheck` | Tests and a direct check of the behavior |
| 5. Core | Run engine, persistence and migrations, auth and permissions, daemon protocol, networking and security, anything that deletes data | [check-related-work](../check-related-work/SKILL.md) | Named test files across the boundaries it crosses; the full suite only when the change spans multiple modules | Tests, a direct check, and teammate review for the sensitive changes listed in the shared policy |

In every tier:

- Run the tier's checks once. Record the tested commit, the commands and the results. Checkpoints, the PR, the merge and session end reuse that record while the code is unchanged; after a later code commit, rerun only the tests that commit affects.
- Do not run hosted CI's checks locally as a precaution, and do not wait for hosted CI. A build needed to launch the app for a direct check is fine.
- Interactive UI logic still runs its tests; screenshots show appearance, not behavior.

## Establish the scope

1. Confirm the requested outcome from the conversation. Preserve the distinction between discussing a change and implementing it.
2. Decide whether the outcome is local-only testing or a change intended for the shared codebase, using the shared policy's scope rules. Testing or combining existing PRs, local conflict resolution, and experiments do not automatically authorize issues, PRs, pushes, or GitHub status updates.
3. Run `node scripts/team-status.mjs --fetch` from the repository root once per task, and again only when resuming the task later. Inspect dirty files, current branch, remote default, unpublished commits, and merge/rebase state. Do not switch, stash, or commit unrelated work. Use an isolated worktree when needed; respect a request to make the result available in the primary checkout.
4. Before creating a worktree, check `git worktree list` and reuse the task's existing one. Cleanup of merged branches runs after the merge (see "Cleanup after merge" in the shared policy), not at the start of every task.

For local-only work, inspect the relevant source PR and target commits, perform the requested integration or experiment, run focused verification, and report the local result. Use local branches or commits when useful for recovery. Keep publication and GitHub updates limited to what was explicitly requested; a backup push or comment on the source PR does not require a new issue or PR. Stop here when the local outcome is complete.

## Run the app in a development environment

The user's installed Mousse (stable or nightly) is in daily use. It owns `~/.mousse`, its Electron user data, its background service (daemon), the installed app files and their launchers. To see a change working, run the app from the task's worktree in a development environment, never through the installed app or a packaged build.

- Start it with `npm run dev`, or `npm run dev:mms` for the daemon alone. By default these keep everything under `<worktree>/.mousse-dev/runtime` (Mousse home, Electron user data, browser and artifacts) and pick a renderer port from the checkout path, so each worktree runs beside the installed app and beside other worktrees. If two worktrees get the same port, set `MOUSSE_RENDERER_PORT`.
- Never use the real home from a checkout: do not run `npm start` or `npm run preview`, set `MOUSSE_DEV_USE_GLOBAL=1`, or point `MOUSSE_HOME` at `~/.mousse`. If the checkout's `.mousse-dev/dev.json` sets `"useGlobalHome": true`, run with `MOUSSE_DEV_USE_GLOBAL=0`.
- Send CLI commands to the development daemon with `node out/cli/index.js --home <worktree>/.mousse-dev/runtime …`. The installed `mousse-cli`, or any command without a development home, talks to the user's daemon.
- Scripted or headless runs (CDP, a fake provider) use the same isolated paths: set `MOUSSE_HOME` and `MOUSSE_ELECTRON_USER_DATA` under the worktree, and do not pass the agent's own provider credentials through. A new development home has no providers or sign-ins; add what the test needs there.
- Do not build installers or AppImages (`npm run dist*`) to test a change. Do not install or launch a packaged build, edit launchers or icons, or stop, restart or signal the installed app or its daemon. A packaged build uses the installed app's home and user data, and on Linux it rewrites the user's launchers when it starts. Build, install or restart the real app only when the user asks for it.
- Never write to `~/.mousse` or the installed app's user data. Stop the development app and daemon you started before handing back.

## Coordinate shared work

For changes intended to ship. Tiers 1 and 2 use the lighter related-work check from "Size the change" in place of steps 1 and 2, and widen it to these steps only when the search finds possible overlap.

1. Verify the repository and authenticated identity with `gh repo view --json nameWithOwner,defaultBranchRef` and `gh api user --jq .login`. Search issues and PRs in all states using several relevant terms; inspect recent open work and remote branches too. A failed or truncated search is not evidence of no related work.
2. Read candidate issue discussions and PR diffs, not just titles. If already merged, verify the requested behavior on the current default branch. If another person is working on the same task, reconcile ownership before editing their branch or creating duplicate work. Shared files alone do not prove duplicate scope.
3. Reuse a matching issue and PR. Create an issue only when a meaningful task needs its own scope, owner, acceptance criteria, or handoff; a small self-contained change can use the PR alone. When using an issue, assign the human taking the next action and verify assignment. Record an agreed handoff; do not silently take over someone else's active issue.
4. Use a dedicated task branch based on the freshly fetched default branch. Name it after the work only: `issue-123-short-description` when an issue exists, otherwise a short description of the task. Never put an agent, model, or tool name in a branch name. Reuse the existing task branch when appropriate. Before resuming old work, compare it with the default branch and keep only changes still needed. When the branch's `package-lock.json` differs from the one its installed (or linked) `node_modules` came from, run `npm ci` before building or testing.

## Keep shared work recoverable

- Implement and verify the requested outcome. Keep commits focused on this task.
- At useful checkpoints, commit and push the task's work. Open or reuse a draft PR when the diff is useful for review or handoff and its relevant tests pass (see "Finish shared work"). WIP that fails them stays on the pushed branch without a PR; record failures and remaining work on the issue or in the handoff. Do not create a separate integration PR merely to test or combine another PR locally.
- Confirm the push succeeded and the remote branch contains the checkpoint. A local commit or an attempted push is not a remote backup.
- Record material decisions, blockers, changed scope, and the next action on the issue/PR. Link the branch and PR; avoid routine activity logs and repetitive no-change updates.
- Inspect the diff for credentials, generated junk, and unrelated work before committing. Never use broad staging to absorb someone else's files.

## Write it up

Follow "Writing PRs and issues" in the shared policy whenever you create or edit an issue, PR, or comment, and use the templates in `.github/`. Rewrite the body when scope or approach changes; never append a running log of follow-ups.

## Finish shared work

When implementation is ready, run the tier's checks from "Size the change", verify the requested outcome, and commit and push the task's changes.

Before opening a PR for a code change, run only the named test files that cover the changed code (for example `npx vitest run tests/foo.test.ts`; find them with `rg -l <module> tests`) on the commit you will publish. When no test file covers it, say so in Verification rather than running a broader selection. Do not use `npm run test:branch` or `test:related` as the pre-PR check: a change to main, preload, CLI or build inputs makes them select most of the suite. Open the PR when they pass. Run the full suite (`npm test`) only for tier 5 changes that span multiple modules. If tests fail, fix the failure or leave the work on its pushed task branch without a PR, and report the failing tests; a failure you believe is unrelated or flaky still blocks the PR until you have shown it also fails on the default branch, and the PR must then name it. Hosted CI runs only basic checks, because local hardware is faster than the hosted runners, so the local run is the real gate. Rerun the relevant tests after later commits that change code. Documentation-only changes normally need diff and consistency review, not application tests.

Then open or update the PR with verification evidence, written as described in "Write it up", including which tests ran locally and their result. Once checks pass, do not broaden or repeat testing without a new change, failure, or concrete unresolved concern. When an issue exists, use `Closes #123` for full completion or `Refs #123` for partial delivery and keep it open until completion lands. Keep unfinished shared work that passes its relevant tests in a draft PR, and work that does not on its pushed task branch. Report the published commit and links. This is ordinary task completion; do not start a session-end menu.

When explicitly asked to merge, or when a small, low-risk documentation or communication-guidance change falls under the shared policy's standing authorization, review and merge promptly: confirm the PR head is the commit the recorded checks ran on, check actual GitHub-required checks/reviews/conversations, and merge with `gh pr merge --match-head-commit <tested SHA>` using an enabled method. Do not wait for hosted CI that GitHub does not require; if GitHub blocks the merge on a required check, report it. Then confirm issue completion and clean up the merged task as described in "Cleanup after merge" in the shared policy. Do not trigger the optional full-suite CI run unless explicitly requested. Do not ask for another confirmation or add an arbitrary wait for changes covered by standing authorization. A request to commit and push alone does not authorize merging other changes.

After any merge or push to the default branch, sync the primary worktree as described in "Local availability after merge" in the shared policy: fetch, fast-forward it when it is on the default branch, and verify it contains the merge commit. Never switch its branch, stash, or discard unrelated work to do this. If it cannot be synced, tell the user which branch it is on and the exact command to run; do not say the change is merged and available until it is.

Only when explicitly asked to end the session, follow [end-session](../end-session/SKILL.md). Do not infer session end from task completion or a casual goodbye.

If GitHub access, ownership, or publishing is blocked, follow the shared policy's failure handling. Report what was actually verified and published, and what still needs attention.
