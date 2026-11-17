---
name: check-related-work
description: Before presenting a final plan or starting a substantial implementation, check open and recently merged PRs and open issues for work that already does part of it, conflicts with it, or will collide with it. Read-only; it writes nothing to GitHub.
---

# Check related work

A plan written against the default branch alone can miss work in flight: a draft PR that does half of it, a PR that changes the same files, or an issue that is already fixed. Run this before presenting a plan as final and before implementing anything that spans several modules. It is part of the policy's "search issues and PRs in all states" rule ([team workflow](../../../docs/team-workflow.md); read that section only if the rule's wording is needed).

The check only reads. It does not create, comment on, close or assign anything. It does not list everything open and does not read whole diffs.

## 1. Run the script

`node scripts/related-work.mjs --term "<subject>" --term "<main module or symptom>" --path <file or dir the plan changes>...`

It fetches, searches issues and PRs by the terms (open, plus merged in the last 14 days), compares the planned paths with the changed files of every open PR (cached by PR head commit), and prints only hits: PR number, title, author, branch, overlapping files, last update; term matches as number and title.

- `NOT CHECKED: <reason>` (exit 1): the check did not happen. Retry or report that it was not done; never say there is no related work.
- `CLEAR`: it completed and found nothing. State the base commit it printed as the commit the plan was checked against, and stop.
- Terms alone cannot clear a plan: without `--path` the output says the files were not checked.
- Branches without a PR are not covered. Only when a hit points to one, look at it with `git ls-remote --heads origin "*<term>*"`.

## 2. Read only what overlaps

Start one background Sonnet subagent, or do this yourself when none is available. Brief:

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
