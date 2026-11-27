---
name: work
description: Start or resume authorized implementation or local testing in this repository. Keep experiments local and coordinate meaningful changes intended for the shared codebase. Excludes discussion, planning, review, and diagnosis without a request to implement.
---

# Work

Goals: no duplicate work, coordination with teammates, verified changes, recoverable pushed work, clear PRs. Use Git and authenticated GitHub CLI (`gh`). The scripts below do the searching, claiming, testing and record-keeping; each prints a short result and has `--help`. Read [the shared policy](../../../docs/team-workflow.md) by section, only when a step names it.

## Size the change

Pick the tier from what the change touches, not from how many files it has. Use the highest tier any part reaches and name it in the PR's Verification section. Record it: `node scripts/task-notes.mjs set tier 3`.

| Tier | Examples | Related-work check | Checks before the PR | Evidence |
|---|---|---|---|---|
| 1. Trivial | Copy, docs, comments, one CSS value | None beyond the task's known issue or PR | None; review the diff | The diff, plus a screenshot when visible |
| 2. Small UI | Layout, styling, one component's look or a small interaction; no data, IPC or protocol change | `related-work.mjs` with two or three terms | Named test files for the touched component, if any | Before/after screenshots |
| 3. Feature | New behavior in one area (a view and its store, one service) | `related-work.mjs` with terms and paths; claim | Named test files, plus `--typecheck` of the touched project | Tests and a direct check |
| 4. Cross-area | Several modules, shared types, renderer-to-main IPC | As tier 3, with the subagent verdict | Named test files per affected area, plus `--typecheck all` | Tests and a direct check |
| 5. Core | Run engine, persistence and migrations, auth and permissions, daemon protocol, networking and security, anything that deletes data | As tier 4 | Named test files across the boundaries crossed; the full suite only when the change spans multiple modules | Tests and a direct check. Storage, sync, size-limit and performance changes also run [check-on-real-data](../check-on-real-data/SKILL.md) |

Run each tier's checks once. Interactive UI logic still runs its tests; screenshots show appearance, not behavior. Do not run hosted CI's checks locally as a precaution, and do not wait for hosted CI.

## Scope

1. Confirm the requested outcome. Discussing a change is not implementing it.
2. Decide: local-only (testing or combining existing PRs, conflict resolution for a trial, experiments) or shared (a durable change meant to ship). Local-only work creates no issue, PR, push or GitHub update unless asked; follow [local-only](local-only.md). The policy's "Decide what needs tracking" has the full rules.
3. Once per task, and again when resuming later: `node scripts/team-status.mjs --fetch`. Do not switch, stash or commit unrelated work; use a worktree (`git worktree list` first, reuse the task's).
4. After a context reset or when resuming, run `node scripts/task-notes.mjs show`. It lists tier, related-work verdict, claim, tested results with the commands run, and PR. Reuse a tested result only when `show` calls it current, meaning the working-tree fingerprint (the exact file contents, not just the commit) matches; "NOT VERIFIED" means the files changed since, so rerun `verify.mjs`. Do not rerun checks it records as current.
5. Work that will not fit one PR is planned with [slice](../slice/SKILL.md) before any of it starts, and a new subsystem with [design](../design/SKILL.md) before that. Handing part of a task to a subagent: [subagents](subagents.md).

## Shared work: check, claim, branch

1. Check: `node scripts/related-work.mjs --term "<subject>" --path <planned file or dir>...` (terms and paths from the plan; it fetches). It prints only hits: open and closed issues and PRs, open PRs and recent remote branches that touch the paths. `--path .` means the whole repository and matches every open change. `NOT CHECKED: ...` means the check did not happen: retry or report it, never treat it as clear. `INCOMPLETE:` lines mean part of the search was cut short; treat that as not clear. `CLEAR` is recorded and needs nothing more.
2. On hits, start a background explorer subagent with the brief in [check-related-work](../check-related-work/SKILL.md): it reads only the overlapping hunks and returns PR numbers, files and owner. Record its answer with `task-notes.mjs set related.review "<one line>"`. A subagent failure or timeout counts as not checked. Keep working on the scope that does not overlap while it runs.
3. Gate on that verdict: tiers 4 and 5 wait for it before substantial edits; tier 3 before its first commit; tiers 1 and 2 do not wait. Another person on the same task: reconcile ownership before editing their branch or duplicating it. Shared files alone do not prove duplicate scope. A matching merged change: verify on the default branch first.
4. Claim (tier 3 and up, before substantial edits): `node scripts/work-claim.mjs claim --task <branch> --path <planned paths>`. A refusal names the holder: coordinate with them. An overlap warning names who touches the same paths: mention it in the PR. Renew with `renew` when work outlasts the two hours; release on merge or abandonment. `NOT CLAIMED` means no claim exists; continue only for work already authorized and say so.
5. Reuse a matching issue and PR. Create an issue only when the task needs its own scope, owner, acceptance criteria or handoff; a small change can use the PR alone. Assign the human taking the next action. Do not silently take over someone's active issue.
6. Branch from the freshly fetched default branch, named after the work (`issue-123-short-description`, or a short description); never an agent, model or tool name. Compare resumed work with the default branch and keep only what is still needed. When `package-lock.json` differs from the one `node_modules` came from, run `npm ci` before building or testing.

## Keep shared work recoverable

- Keep commits focused on this task. Inspect the diff for credentials, generated junk and unrelated work; never broad-stage someone else's files.
- At useful checkpoints, commit and push the task branch, and confirm the remote has the commit; a local commit or attempted push is not a backup. Open or reuse a draft PR when the diff helps review and its relevant tests pass; WIP that fails them stays on the pushed branch with the failures noted on the issue or handoff. A separate integration PR just to test another PR is not needed.
- Record material decisions, blockers, changed scope and the next action on the issue or PR. No routine activity logs.
- Leave the task branch on its base. Merge the default branch in only when GitHub reports a conflict, or when a new default-branch commit changes a file this task changes or takes a shared counter it also takes (a migration number, a contract version). Then rerun the tests for those files. A branch that is only behind merges as it is.

## Verify

This is the only place the pre-PR test rule lives. Run on the commit you will publish:

`node scripts/verify.mjs <named test files> [--typecheck web|node|all]`

- Find the files with `rg -l <module> tests`, plus the files that mention the copy, class, default or list entry you changed (`rg` in `tests/`). When none covers the change, say so in Verification instead of running something broader.
- Never use `npm run test:branch` or `test:related` as the check: a change to main, preload, CLI or build inputs selects most of the suite. `npm test` only for tier 5 changes that span multiple modules.
- The script prints a pass/fail summary with the command it ran for each check, plus the first failures, and records the commit, the working-tree fingerprint, the commands and the results in `.task-notes.json`. Checkpoints, the PR, the merge and session end reuse that record only while `task-notes.mjs show` calls it current; any edit, even with the same commit, makes it not verified. After a later code change, rerun only the tests it affects.
- A failure is fixed, or the work stays on its pushed branch without a PR with the failing tests reported. One you think is unrelated still blocks the PR until shown to fail on the default branch too; the PR then names it. Show that once per task and record it (`task-notes.mjs set knownFailures "<file>: <how it fails>"`); later runs skip a failure that `task-notes.mjs get knownFailures` already lists instead of looking into it again.
- Documentation-only changes need diff and consistency review, not application tests. Hosted CI runs only basic checks; the local run is the real gate. Once the checks pass, do not broaden or repeat testing without a new change, a failure, or a concrete unresolved concern.
- Before writing or changing tests, read [test-the-claim](../test-the-claim/SKILL.md). To launch the app for a direct check, read [run-the-app](run-the-app.md).

## Write it up and hand off

- Reading "Writing PRs and issues" in the policy, and the templates in `.github/`, is for the moment you create or edit an issue, PR or comment. Rewrite the body when scope changes; never append a log.
- The PR body must contain `Closes #N` (merging finishes the issue), `Refs #N` (partial; keeps it open) or `No issue`; a workflow checks it. Copy the Verification section from `task-notes.mjs show`: it lists each check with the exact command run, which is the evidence the PR needs.
- Review: [review](../review/SKILL.md) says who reviews at each tier. One pass, then merge; a re-check reads only the fix.
- Report the published commit and links. This is ordinary task completion; do not start a session-end menu.
- Merging, and syncing the primary worktree afterwards: [merge-and-sync](merge-and-sync.md), read only when asked to merge or after a merge.
- Nightly builds: [nightly-build-release](../nightly-build-release/SKILL.md). Session end, only when explicitly asked: [end-session](../end-session/SKILL.md).
- GitHub access, ownership or publishing blocked: follow the policy's "Failures and interruptions". Report what was verified and published, and what still needs attention.
