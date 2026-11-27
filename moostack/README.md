# MooStack

The agent skills Mousse is built with. Each one is a folder in `skills/` with a `SKILL.md` and any scripts it runs. They work in Claude Code, Codex and the other harnesses Mousse runs. Most of them drive this repository's scripts, so they are meant to be used in a Mousse checkout.

## Skills

| Skill | When | What it does |
|---|---|---|
| `work` | Any authorized implementation | Takes a change from branch to merged PR: related-work check, claim, focused tests, PR text, merge and sync. |
| `design` | A large goal with no plan yet | Gets to an architecture that lasts: the problem and its rules, a rubric, options that really differ, spikes for the unknowns, one decision, a thin slice. Three levels: the agent proposes; two model families propose and a judge marks them; or three propose and a council names the winner. |
| `slice` | Work that needs more than one PR | Plans it as slices that each merge on their own within a day: the rules first, then the slices, their order and their files. |
| `review` | Reviewing a PR, diff or plan, or answering findings | One pass: who reviews at each tier, findings that need proof, a re-check of the fix only, and when to stop. |
| `council` | Heavy core changes, only after the human agrees | Two independent reviewers from different model families for a design or PR. Same proof rules as `review`, no scores. |
| `retro` | After work that ran long | Finds where the time went from the record and changes a skill, script or check. |
| `check-related-work` | Before a final plan or a substantial change | Finds open and closed PRs, issues and branches that already do part of the work or will collide with it. Read-only. |
| `test-the-claim` | Writing, changing or reviewing tests | Decides what to test for a change, at which level, and what not to write. |
| `check-on-real-data` | Storage, sync, size-limit and performance changes | Proves the change against copies of the real threads on this machine. Read-only on `~/.mousse`. |
| `mousse-ui` | Building, restyling or reviewing UI in `src/renderer` | Mousse's UI and UX principles, and how to tell a screen is slop. |
| `nightly-build-release` | "Build a nightly" | Publishes a nightly prerelease of master, fixing whatever blocks it until one is out. |
| `update-model-catalog` | Adding, retiring or re-tiering bundled models | Checks models live on signed-in providers, then updates the catalog, tiers, bundled test and docs together. |
| `gh-attach-images` | Screenshots or videos for a PR or issue | Attaches them with `gh --attach`, never by committing them to the repository. |
| `debug-journal` | "Fixed" after a long debugging session | Appends one line on the root cause and the faster path to `journal.md`. |
| `end-session` | Only an explicit "end the session" | Keeps local experiments or publishes the chosen outcome, and leaves a handoff. |

Some skills call others:

- `work` uses `slice`, `check-related-work`, `test-the-claim`, `check-on-real-data` and `review`, and hands off to `nightly-build-release` and `end-session`.
- `design` uses `check-related-work`, then `review` for the one read of the chosen design (at level 3, `council` judges the proposals), and hands off to `slice`.
- `slice` uses `check-related-work`, and `review` for a tier 5 plan.
- `council` is `review` with two reviewers.
- `retro` points back at whichever skill the lost time traces to.
- `nightly-build-release` follows `work` for each fix it merges.

They share [the team workflow](../docs/team-workflow.md); each reads only the section a step names.

## The loop

The skills are built for speed: a change should merge the day it starts.

1. **Plan.** One PR's worth of work goes straight to `work`. Anything larger goes through `slice` first. A new subsystem, or a replacement for one, starts a step earlier with `design`.
2. **Build.** `work` sizes the change into a tier, which sets how much to check. Each check runs once.
3. **Review.** One pass by the reviewer the tier names. A finding needs proof. Only a wrong intended case, lost data or a skipped permission check blocks the merge; the rest become notes.
4. **Merge.** On the local test results, without waiting for hosted CI, and without merging the default branch in unless there is a conflict.
5. **Look back.** After long work, `retro` turns the lost time into a change here.

What the loop leaves out on purpose: review rounds that run until a score is reached, panels of reviewers, PRs built on unmerged PRs, and repeat test runs with no new change.

## Using them

No harness finds this folder on its own. [`AGENTS.md`](../AGENTS.md) at the repository root says which skill applies when, by path, so an agent working in this repository reads the right one without installing anything.

To make them show up as skills in a harness, copy them to its skills folder:

```bash
cp -R moostack/skills/* ~/.claude/skills/   # Claude Code
cp -R moostack/skills/* ~/.codex/skills/    # Codex
```

The copies don't follow later changes here, so copy again after pulling.

## Adding a skill

Add `skills/<name>/SKILL.md` with `name` and `description` front matter, plus any scripts it runs in the same folder. Add it to the table above and, if an agent should use it without being asked, add a line to `AGENTS.md` that says when. Keep skills here rather than in a machine's home folder, so every computer and teammate gets the same version.

## Requirements

- An authenticated [GitHub CLI](https://cli.github.com) (`gh`), 2.99.0 or later for `gh-attach-images`.
- Node.js and this repository's dependencies (`npm ci`) for the scripts under `scripts/` that `work` drives.
