# MooStack

The agent skills Mousse is built with. Each one is a folder in `skills/` with a `SKILL.md` and any scripts it runs. They work in Claude Code, Codex and the other harnesses Mousse runs. Most of them drive this repository's scripts, so they are meant to be used in a Mousse checkout.

## Skills

| Skill | When | What it does |
|---|---|---|
| `work` | Any authorized implementation | Takes a change from branch to merged PR: related-work check, claim, focused tests, PR text, merge and sync. |
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

- `work` uses `check-related-work`, `test-the-claim` and `check-on-real-data`, and hands off to `nightly-build-release` and `end-session`.
- `nightly-build-release` follows `work` for each fix it merges.

They share [the team workflow](../docs/team-workflow.md); each reads only the section a step names.

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
