---
name: review
description: Review a PR, a diff or a plan, or get one reviewed, in one pass. Use when asked to review, before merging tier 3 to 5 work, and when answering review findings. Says who reviews at each tier, what counts as a finding, and when the loop stops.
---

# Review

One pass, then merge. A review catches a wrong intended case before it ships; it does not make a PR perfect. A loop that runs until the reviewer is satisfied, or until a score is reached, does not end: every full re-read finds new edge cases and every fix grows the PR.

## Who reviews

| Tier (from [work](../work/SKILL.md)) | Review |
|---|---|
| 1 and 2 | The author reads the full diff. |
| 3 | The author reads the full diff after the tests pass, as if someone else wrote it. |
| 4 and 5 | One reviewer that did not write the code: a subagent with fresh context, or a teammate. |

One reviewer, not a panel. Several reviewers only when the human asks for them.

## Asking for a review

- Verify passes on the commit first. Never send code that fails its own tests.
- Tier 5: name the one fact the change is safe because of, and prove it by running something. One line in the PR: the fact, and the test or command that shows it.
- The brief: the goal in one or two sentences, what is out of scope, the rules from the plan if there are any ([slice](../slice/SKILL.md) section 1), the base commit and the diff command, and the checks that ran with their results. Point to files; do not paste them.

## Reviewing

Read only: no edits, commits, pushes, GitHub comments or subagents unless asked. Read the diff and the code around it on the latest remote default branch, as `AGENTS.md` says.

Look for: the intended case being wrong, a caller the change breaks, a broken rule from the plan, a claim in the PR the code does not keep, and a test that would still pass with the fix removed ([test-the-claim](../test-the-claim/SKILL.md)). Also flag code, tests and guards the goal does not need. Skip style unless it hides a bug.

Each finding has an id (R1, R2), a severity, `file:line`, one sentence, and proof.

| Severity | Means |
|---|---|
| blocker | The intended case is wrong, data is lost, or a permission check is skipped. |
| should | A real bug a person hits in normal use of this change. |
| note | Everything else: other paths, rare timing, small performance cost, more tests, compatibility, style. |

Proof is a command you ran and what it printed (a failing test, a script, a reproduction), or the exact path through the code, line by line, that reaches the failure. A blocker or should without proof is a note. "This could race" is a note until an interleaving is shown.

End with `merge` or `fix first`. No score.

## Answering findings

- Check each finding and its severity against the code yourself, and relabel it when the code says otherwise.
- A real blocker or should gets the smallest fix. Prefer deleting or narrowing code over a new lock, cache, option or helper. Add one test that fails without the fix when the claim needs it.
- A wrong finding gets one or two lines of evidence.
- A note is not fixed in this PR. List it under Notes in the PR, and open one follow-up issue for the notes worth doing.
- If the fixes grew the diff more than the findings needed, cut before going on.
- When two fixes for the same finding have failed, stop fixing. Write down the assumption both shared and test it directly.

## The re-check

- No blocker or should was fixed: no re-check. Merge.
- A blocker or should was fixed: one re-check of the fix only. Give it `git diff <commit the review saw>..HEAD` and the findings with what was done about each. It marks each `fixed` or `still open` and reports new breakage inside that diff. Anything else it notices is a note.
- The author does the re-check for a fix of a few lines that has a test failing without it.
- Still open after the re-check: the author decides. Fix once more and merge on the tests, or record the disagreement under Notes with each side in two lines. No third pass. For the policy's sensitive changes, the human who authorizes the merge sees the open items.
- Merging the default branch in, and changes to docs, comments or tests alone, need no re-check.

Record it in the PR in one line: who reviewed, how many findings were fixed and how many declined.

## Reviewing a plan

Same rules, one pass. Read the plan against the code on the default branch. A finding is a rule the plan breaks or leaves out, work that already exists, a slice that cannot merge on its own, or two slices that collide. Proof is the `file:line` or the PR that shows it.
