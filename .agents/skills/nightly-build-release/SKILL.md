---
name: nightly-build-release
description: Build and publish a nightly prerelease of master on request, report each job as it finishes, and fix whatever blocks it, as many times as needed, until a nightly is published. Optionally install it on the user's machine when asked.
---

# Nightly build and release

Use when the user asks for a nightly to be built, published or installed. The job is done when a new nightly prerelease exists on GitHub (and, when asked, runs on the user's machine), not when a run has been started. How nightlies are made is in [releases.md](../../../docs/releases.md); the workflow is `.github/workflows/nightly.yml`.

A request to publish a nightly authorizes merging the PRs that fix what blocks it. Each fix still follows [work](../work/SKILL.md): its own task branch from the fetched default branch, the named test files for the changed code, a PR written for a teammate, and `gh pr merge --match-head-commit <tested SHA>`. It does not authorize merging unrelated open PRs.

## Start a run

1. `git fetch` and note the default branch's head.
2. Check for a nightly run already going on that head: `gh run list --workflow nightly.yml --limit 3 --json databaseId,headSha,status,conclusion`. Reuse it rather than starting another; runs share one concurrency group, so a second one only queues.
3. Otherwise start one: `gh workflow run nightly.yml --ref master -f force=true`, then read its id from `gh run list --workflow nightly.yml --limit 1`. Without `force`, a run on a head that already has a nightly stops after "Decide whether to build".
4. Tell the user the run link and which commit it builds.

## Report every job as it finishes

The user wants an update each time a job passes or fails, not only at the end. Run the watcher in the background and act on each exit:

```
node .agents/skills/nightly-build-release/watch-run.mjs <run id>
```

It exits as soon as a job finishes that it has not reported before, or when the run ends, and prints the newly finished jobs, the run's state and the jobs still going. On each exit:

1. Post a short update: what just passed or failed, how many of the jobs have passed, and what is still running.
2. If a job failed, start on it now (below) rather than waiting for the rest of the run.
3. Unless the run has ended, start the watcher again.

Never answer a watcher's exit with silence or "no response requested"; it is the cue for the next update or step. Do not poll with `sleep` loops, `gh run watch` or timers in the conversation; the background watcher is the wait.

## When a job fails

Read the failure: `gh run view <run id> --log-failed`. Look at the test summary and any "Unhandled Errors" section: a run can fail with every test passing when a test file leaves an error behind, such as a timer that fires after its window is torn down.

- **Infrastructure** (download or registry timeouts, a lost runner, a GitHub 5xx): `gh run rerun <run id> --failed` once the run has ended, and keep watching the same run.
- **A real failure** (a test that failed all three tries, an unhandled error, a type or lint error, a packaging step): reproduce it locally with the named test file, find the cause and fix it in the code, or in the test when the test is wrong. Do not skip, weaken or delete a test to get the build through. A failure from someone else's recent change is still fixed here; say in the PR which change it came from. Open the PR, merge it, and sync the primary worktree as described in "Local availability after merge" in the shared policy.
- Then start a new run on the new head (`force=true`) and report it as above. Teammates may have merged meanwhile, so the new run can find new failures; handle them the same way.

Repeat until a run publishes. There is no retry limit. Stop and report only when a fix needs a decision only the user can make, or access you do not have; then say exactly what blocks the nightly.

## Confirm the release

When the run ends with success, check `gh release list --limit 3` and `gh release view v<version>` for the new `<next stable>-nightly.<UTC date>.<run number>` prerelease and its assets. Tell the user the version, the commit it was built from and what changed since the previous nightly (the release notes list the PRs).

## Install it on the user's machine

Only when the user asks. This is the one case where the installed app, its daemon and its launchers may be touched; otherwise [work](../work/SKILL.md)'s "Run the app in a development environment" applies.

Linux:

1. Download into its own new folder, then move into place: `gh release download v<version> --pattern 'Mousse-<version>.AppImage' --pattern 'mousse-cli-<version>-linux-x86_64.AppImage'`, `chmod +x` both, and move them to where the current build lives (usually `~/Applications`).
2. Make sure no run is active: read the user's run database read-only. Never write to `~/.mousse` or the installed app's user data.
3. In one command, stop the running GUI and its daemon. The daemon outlives the GUI and would keep serving the old version; its pid is in `~/.mousse/mms.runtime.json`. Signal those pids only; never `pkill -f`.
4. In a separate command, start the new AppImage detached (`setsid nohup <AppImage> >/dev/null 2>&1 & disown`). When starting it from inside another Electron app (an agent host), unset `ELECTRON_RUN_AS_NODE`, `APPIMAGE`, `APPDIR`, `ARGV0` and `OWD` first. On start the app points the user's launchers at the new file and installs its icon.
5. Verify: the new process runs from the new file, the daemon reports the new version, and `mousse-cli --version` prints it.

Windows and macOS: download the installer or disk image from the release and run it; the same rules about active runs and stopping the old daemon apply.

Report the installed version and anything left over, such as the previous AppImage still on disk.
