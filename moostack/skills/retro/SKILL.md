---
name: retro
description: After work that ran long (several PRs, more than a day, or repeated fix rounds), find where the time went and change a skill, script or check so it does not happen again. Use when asked for a retro, or asked why something took so long.
---

# Retro

The result is at most three changes to skills, scripts or checks, each tied to a number. Not a story of what happened.

## 1. Measure from the record

- Each PR: hours from opened to merged, commits, lines, and how many fix rounds. `gh pr view <n> --json createdAt,mergedAt,commits,additions,deletions`.
- Subagent sessions started, and how much of each went to setup (checkout, dependencies, reading) before the first edit.
- How often the default branch was merged in, how often verify ran, and how many failures were looked into that were not the PR's.
- Where a human was waited on, and whether the agent could have decided.

Read the sessions and PRs themselves. A summary written during the work describes what was meant, not what happened.

## 2. Name the cause

| What the record shows | Usual cause | Where to fix it |
|---|---|---|
| More than one full review of a PR | The review ran until the reviewer was satisfied, or to a score | [review](../review/SKILL.md): one pass, re-check of the fix only |
| Findings in one area, one per round | The rules were never written down | [slice](../slice/SKILL.md) section 1 |
| A fix carried into the PR built on it | Stacked PRs | [slice](../slice/SKILL.md) section 3 |
| The default branch merged in again and again | PRs open too long, or merged in without a conflict | "Keep shared work recoverable" in [work](../work/SKILL.md) |
| The same unrelated test failure looked into twice | It was never recorded | "Verify" in [work](../work/SKILL.md) |
| Each fix round rebuilt a checkout and reread the code | A new subagent per round | [subagents](../work/subagents.md) |
| Committed work lost to a restart | It was not pushed | [subagents](../work/subagents.md) |
| Waiting on hosted CI | The local run is the gate | [merge-and-sync](../work/merge-and-sync.md) |
| One session carrying days of work | State kept in the conversation | [slice](../slice/SKILL.md) section 4 |

## 3. Fix it at the strongest level

A script or check that fails beats a line in a skill, and a line in a skill beats a note. A rule that was written and not followed does not need writing again: find out why it was not read (not on a path `AGENTS.md` names, too long, saved on one machine only) and fix that. Delete a rule that cost more than it saved.

## 4. Hand back

One table: cause, the number that shows it, the change. Make documentation changes as one small PR. Propose script changes and wait for a go.
