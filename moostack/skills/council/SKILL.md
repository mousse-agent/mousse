---
name: council
description: Two independent reviewers for a design, plan or PR, run only after the human agrees. For heavy changes to core infrastructure that must not break (run engine, persistence and migrations, auth and permissions, daemon protocol, networking and security, anything that deletes data). Not for UI work, docs or small fixes. One round by default.
---

# Council

Two independent reviewers check a design, a plan or a PR before it moves on. It is expensive, so it runs only where a mistake is costly. It is [review](../review/SKILL.md) with two reviewers: that skill's rules for findings, severity, proof and the re-check apply here, and this file adds only when a council runs and how. It never replaces merge authorization.

## When to use it

**Ask the human first, every time.** Say in one line what you want reviewed and why, and run it only after a yes. A yes covers that one review, not later ones.

Use it for work that is both:

- **Core infrastructure that should not break:** the Run Engine and queues, durable state and migrations, authorization and permission modes, approvals, the daemon protocol, network transports and enrollment, credentials and sign-in, automatic deletion or cleanup, crash recovery.
- **Heavy:** a new subsystem, concurrency, restart and replay behavior, or a security boundary. Not a few lines.

Everything else gets the one review pass its tier sets in [review](../review/SKILL.md). If unsure, ask: "if this is wrong, does it corrupt data, leak access, or break every turn?" If not, skip the council.

## Members

Two reviewers at high effort, each from a different model family, neither of them the author. The human who agrees to the council names the families; if they have not, ask in the same line as the request. Use the newest model of each family that is available, looked up when the council starts. Never write a model ID into a skill or a brief.

If a member is unavailable or out of usage, say so and run with the other alone. Do not substitute another family, and do not retry a member that hit its limit.

Reviewers need a shell to run git and focused tests. If one reports it cannot run commands, stop it and start it again with read and shell tools and no edit tools. Run both in the background, in parallel.

## Rounds

- **One round by default.** Both members run once. The author checks each finding and its severity against the code, fixes the real blockers and shoulds with the smallest change, and records in a line or two why the others are rejected. Notes go under Notes in the PR or into one follow-up issue.
- **A second round only for** a proven blocker, or shoulds whose fix is a redesign or a lot of new code. It reads only the fix: `git diff <commit round one saw>..HEAD`, plus the findings with what was done about each. Each member marks every finding `fixed` or `still open` and reports new breakage inside that diff.
- No round for notes, wording, test names, or a fix of a few lines that has a test failing without it.
- Three rounds at most. Say the count ("round 2 of at most 3"). If findings are still open, stop and show the human each one with both sides in two lines.

There is no score. A member ends with a verdict: ready, or the blockers and shoulds in the way. Never ask for a rating and never run a round to raise one.

## Running a round

- Each round is a fresh call, never a follow-up message to an earlier reviewer.
- Give the material, not your verdict: the request, the rules the change must keep, the design or the PR with base and head commit, the checks that ran, and earlier findings with the responses.
- Ask them to look past the brief: situations it does not cover, and what would break first in daily use. These still need proof to be more than a note.
- Check each finding against the code as it arrives. A finding about code the default branch already changed is not a finding.
- Keep scope. Findings outside the goal go to a follow-up issue. If fixes grew the diff more than the findings needed, cut.

Record it in the PR under `## Council review`: one row per round with each reviewer's verdict, and how many findings were fixed and declined. Label them Reviewer 1 and Reviewer 2, not by model.

## Briefs

Design or plan:

```text
You are one of two independent reviewers of a design for <repo>. Review only: no edits, commits, GitHub comments or subagents.
Request: <the request>
Design: <path>   Issue: <link>
Rules the change must keep: <list, or "none written">
Round <N> of at most 3. Earlier findings and responses: <files, or "first round">
Check against the code on the default branch: does it solve the request, does every piece of state have one owner, are the rules kept by structure, do the next known features fit, can the slices merge on their own, what is not covered.
Severity: blocker = the intended case is wrong, data is lost, or a permission check is skipped. should = a real bug a person hits in normal use. note = everything else.
Each finding: id, severity, one sentence, and proof (the file:line or the PR that shows it). A blocker or should without proof is a note.
Write findings, most severe first, to <file>, then what you would cut. No score. Last line exactly VERDICT: APPROVE or VERDICT: CHANGES REQUESTED.
```

PR, round one:

```text
You are one of two independent reviewers of a PR for <repo>. Review only: no edits, commits, GitHub comments or subagents.
Request: <the request>   Design: <path>
Rules the change must keep: <list, or "none written">
PR: <link>, base <sha>, head <sha>. Diff: git diff <base>...<head>
Checks that ran: <commands and results>
Check: the intended case, callers the change breaks, ways it gives more access than intended, security, concurrency and restart, Windows paths, tests that would pass with the fix removed, scope against the design.
Severity: blocker = the intended case is wrong, data is lost, or a permission check is skipped. should = a real bug a person hits in normal use of this change. note = everything else.
Each finding: id, severity, file:line, one sentence, the fix, and proof: a command you ran and its output, or the exact path through the code line by line. A blocker or should without proof is a note. "Could race" is a note until you show the interleaving.
Write findings, most severe first, to <file>, then what you would cut. No score. Last line exactly VERDICT: APPROVE or VERDICT: CHANGES REQUESTED.
```

PR, later rounds:

```text
You are re-checking fixes to a PR for <repo>. Review only: no edits, commits, GitHub comments or subagents.
Round <N> of at most 3. Read only the fix: git diff <commit the last round saw>..<head>
Findings and what was done about each: <file>
Mark every finding `fixed` or `still open: <reason, with proof>`. Report new breakage inside this diff under the same severity and proof rules. Anything outside this diff is a note.
Write to <file>. No score. Last line exactly VERDICT: APPROVE or VERDICT: CHANGES REQUESTED.
```
