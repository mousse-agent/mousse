---
name: check-related-work
description: Before presenting a final plan or starting a substantial implementation, check open and closed PRs and issues, and recent remote branches without a PR, for work that already does part of it, conflicts with it, or will collide with it. Read-only; it writes nothing to GitHub.
---

# Check related work

A plan written against the default branch alone can miss work in flight: a draft PR that does half of it, a PR that changes the same files, or an issue that is already fixed. Run this before presenting a plan as final and before implementing anything that spans several modules. It is part of the policy's "search issues and PRs in all states" rule ([team workflow](../../../docs/team-workflow.md); read that section only if the rule's wording is needed).

The check only reads. It does not create, comment on, close or assign anything. It does not list everything open and does not read whole diffs; the script does the listing and comparing and prints only hits.

## 1. Run the script

`node scripts/related-work.mjs --term "<subject>" --term "<main module or symptom>" --path <file or dir the plan changes>...`

It fetches and then covers four things:

- issues and PRs matching the terms, open and closed (merged or not, any age): each term search pages through the results and ranks at most 300 per search (it asks for 301 to know whether more exist), then the report shows only a short ranked list (open first, best title match, newest) as number and title, with a count of the rest;
- every open PR's changed files against the planned paths (cached by PR head and base commit), as number, title, author, branch, overlapping files and last update;
- recent remote branches (last 14 days, `--days`) that have no open PR, matched by branch name against the terms or by files changed against the default branch, bounded to the newest 400;
- the current task's own PR is ignored, but a fork's branch of the same name is not.

- `NOT CHECKED: <reason>` (exit 1): the check did not happen, including when a list reached its limit and may be cut short. Retry or report that it was not done; never say there is no related work.
- `INCOMPLETE: <what>` (exit 3): it ran but part was cut short: a term search matched more than 300 items (the line names the term; exactly 300 is complete), there were more branches than the bound, or a branch could not be compared. Candidates are still printed, but incomplete outranks hits in the verdict and exit status, so the plan is not cleared. Narrow the named term and rerun, or say what was not covered. A long list of matches alone is not incomplete; the short list is a display limit, not a retrieval limit.
- `CLEAR`: it completed everything and found nothing. State the base commit it printed as the commit the plan was checked against, and stop.
- Terms alone cannot clear a plan: without `--path` the output says the files were not checked. `--path .` means the whole repository and matches every open change, so it never clears.
- Branches older than the window, or on other remotes, are not covered; say so when the plan is large and old work might matter.

## 2. Read only what overlaps

Start one background explorer subagent, or do this yourself when none is available. Brief:

> Read-only check of overlap between a plan and open work in `<repo>`. Plan: `<two or three sentences and the planned paths>`. Candidates: `<PR numbers with their overlapping files; issue numbers with titles>`. For each PR, read only the hunks of the overlapping files (`gh api repos/<repo>/pulls/<n>/files --paginate`, use each file's `patch`), not the rest of the diff, and read its body or comments only when a hunk is unclear. For an issue, read the body only when its title looks like the same problem. Return, per candidate: number, overlapping files, one sentence on what it changes there, its owner (author or assignee), and one label: duplicate, conflicts, will collide, already done, or unrelated. No narration.

A subagent that fails or times out means the overlap was not checked; say so. For an open issue that looks already fixed, find the merged PR and check the code on the default branch, not its description.

## 3. Report before the plan is final

Report in plain words with PR and issue numbers, under these headings, leaving out empty ones:

- **Already done:** parts of the plan an open or merged PR implements, and whether its design matches.
- **Still needed:** what remains once those land.
- **Conflicts:** PRs or issues whose design or decisions contradict the plan.
- **Will collide:** PRs changing the same files, with the files and what must move.
- **Stale issues:** open issues that look already fixed, and by what.
- **Suggested order:** which PRs should land first, and how the plan changes on top of them.

Revise the plan against that order before calling it final. When someone else's active PR already does part of it, reconcile ownership as the policy says before proposing to redo it. When used from the work skill, record the result with `node scripts/task-notes.mjs set related.review "<one line>"`.
