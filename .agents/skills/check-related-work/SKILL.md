---
name: check-related-work
description: Before presenting a final plan or starting a substantial implementation, check open and recently merged PRs, open issues and remote branches for work that already does part of it, conflicts with it, or will collide with it. Read-only; it writes nothing to GitHub.
---

# Check related work

A plan written against the default branch alone can miss work that is already in flight: a draft PR that does half of it, a stacked PR that changes the same design, or an issue that is already fixed. Run this check before presenting a plan as final, and before implementing anything that spans several modules. Read [the shared team policy](../../../docs/team-workflow.md); this check is part of its "search issues and PRs in all states" rule, done thoroughly.

The check only reads. It does not create, comment on, close or assign anything.

## 1. Collect the candidates

1. `git fetch origin` and note the default branch's head. State it in the report as the commit the plan was checked against.
2. List everything that could overlap, from every author, the user's own drafts included:
   - open PRs: `gh pr list --state open --limit 200 --json number,title,author,headRefName,baseRefName,isDraft`;
   - PRs merged since the plan's base commit, or in the last two weeks: `gh pr list --state merged --search "merged:>=<date>"`;
   - open issues: `gh issue list --state open --limit 300`;
   - remote branches with recent commits and no PR: `git for-each-ref --sort=-committerdate refs/remotes/origin --format='%(committerdate:short) %(refname:short)'`.
   A truncated list is not evidence of no related work; raise the limit until the count is below it.
3. Shortlist by two tests, not by title alone:
   - **Terms:** the plan's subject, its main modules and the problems it fixes.
   - **Files:** the files the plan changes, intersected with each open PR's files (`git diff --name-only origin/<default>...origin/<branch>`). Stacked PRs (a base other than the default branch) count with their whole stack.

## 2. Read them

- Read each shortlisted PR's body and diff, and each issue's body and discussion. Titles mislead: a PR named after one symptom can redesign the area the plan covers.
- For each part of the plan, check the candidate branch's code, not its description. Example: a PR that says "Publish refuses a dirty folder" can still re-run Publish from automatic recovery.
- For an open issue that looks already fixed, look for the merged PR that fixed it and check the code on the default branch.

## 3. Report before the plan is final

Report in plain words, with PR and issue numbers, under these headings, leaving out empty ones:

- **Already done:** which parts of the plan an open or merged PR implements, and whether its design matches the plan's.
- **Still needed:** what remains once those PRs land, checked in their code.
- **Conflicts:** PRs or issues whose design or decisions contradict the plan.
- **Will collide:** PRs that change the same files, with the files and what must move.
- **Stale issues:** open issues that look already fixed, and by what.
- **Suggested order:** which PRs should land first, and how the plan changes on top of them.

Then revise the plan against that order before calling it final. When the plan's parts are already done by someone else's active PR, reconcile ownership as the shared policy says before proposing to redo them.
