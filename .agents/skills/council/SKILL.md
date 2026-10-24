---
name: council
description: Run a two-member review council (Fable 5.1 and Sol 6.1) as the plan gate before implementation and the code gate before merge, with fixes delegated to Sonnet 5.5 or Opus 5.5 subagents until both members approve. Use when the user asks for the council or a council-gated change. Not for local-only experiments, discussion, or quick questions; it does not by itself authorize implementation or merge.
---

# Council

The council adds two review gates on top of [work](../work/SKILL.md) and [the shared team policy](../../../docs/team-workflow.md). Everything in those still applies: scope rules, task branch, checkpoints, local `npm test` before the PR, PR write-up, GitHub-required checks, the sensitive-change rule, and merge authorization. Council approval is the review gate; it never overrides any of them.

## Members

| Member | How to run | Provider instance | Model |
| --- | --- | --- | --- |
| Fable 5.1 | native Agent tool with `model: "fable"`, or T3 `delegate_task` | `claudeAgent` | `claude-fable-5-1` |
| Sol 6.1 | T3 `delegate_task` only | `codex` | `gpt-6.1-sol` |

Confirm instance ids and model ids with T3 `orchestrator_capabilities` before the first round; catalogs change. If a member cannot run, stop and tell the user; do not substitute a model or run a one-member council.

## Rules for every round

- Run both members in parallel in the same turn. Neither sees the other's answer in that round. Launch async and end the turn; completions arrive as notifications.
- Each round is a new `delegate_task` call (or a new Agent call) with `role: "review"` and a distinct `clientRequestId`, for example `council-plan-r2-sol`. Keep that id stable when retrying the same round. Never continue a review through `t3_thread_send` on the child thread.
- Each brief is self-contained: the original request, the plan or diff, all prior findings from both members, what was done about each (fix commit or argument), and any objection still open. The child has no conversation history.
- Give reviewers the material, not your conclusions: the plan text, the files, the PR link, base and head SHA. Do not tell them what you think the verdict should be. Reviewers read and run; they do not edit.
- Require the verdict as the last line: `VERDICT: APPROVE` or `VERDICT: CHANGES REQUESTED`, with numbered findings above it. A reply without that line is not a verdict; ask that member again with a new `clientRequestId` (for example `council-plan-r2-sol-retry1`), since reusing the id returns the same reply.
- A finding stands until the member who raised it withdraws it in a later round. If you believe a finding is wrong, say so in the next brief with your reasoning and let the member answer; never drop it silently.

## Gate 1: plan

1. Establish scope per the work skill. Write a short plan: goal, approach, files to touch, tests, risks, out of scope. Put it on the issue or PR when one exists.
2. Send the plan brief below to both members.
3. If either requests changes, revise the plan yourself (planning is not a fix), answer each finding in the next brief, and rerun. Do not start implementation until both approve the same plan text.

## Gate 2: code

1. Implement per the work skill. Run the tests relevant to the change (the full `npm test` only for very large multi-module changes), push, and open or update the PR as usual.
2. Send the code brief below to both members with the PR link and the head SHA under review.
3. Triage each finding. Do not fix it yourself. Dispatch a subagent per independent finding or cluster; run them in parallel only when they touch different files:
   - Sonnet 5.5 (`model: "sonnet"`, `claude-sonnet-5-5`): routine or mechanical fixes with a clear target, such as a missed null check, a test gap, a rename, a doc fix.
   - Opus 5.5 (`model: "opus"`, `claude-opus-5-5`): cross-cutting or design-level fixes, concurrency, anything that needs judgment about more than one module.
   Give the fixer the finding verbatim, the files, the expected behavior, and the focused tests to run. Review its diff before committing.
4. Commit the fixes, rerun the relevant tests when code changed, push, and reconvene with the new head SHA. Findings you dispute go back in the brief as arguments, not as fixes.
5. Repeat until both members return `VERDICT: APPROVE` on the same head SHA.

## When it does not converge

Stop and ask the user, with both members' positions and your own, when any of these happen: a gate reaches three rounds without both approving; the two members contradict each other on the same point for two rounds; a member asks for something outside the task's scope; or a fix would touch a sensitive area listed in the shared policy. Do not keep spending rounds on the same disagreement.

## Merge

Merge only when all of these hold on the current head: both approvals name that SHA, the relevant local tests passed on it, GitHub-required checks and reviews are green, conversations are resolved, and the merge is authorized under the shared policy. Any commit after approval, including a rebase, sends the PR back to Gate 2. Sensitive changes still need the other teammate regardless of the council's verdict. Record the final approvals (round count, head SHA) in the PR's Verification section; do not log every round.

After the merge, follow "Local availability after merge" and "Cleanup after merge" in the shared policy.

## Plan brief

```text
You are one of two independent reviewers of a plan for the Mousse repo. Review only; do not edit files.
Request: <the user's request, verbatim>
Issue/PR: <links or "none">
Plan:
<plan text>
Round <N>. Prior findings and responses:
<per finding: who raised it, text, what was done or argued, open/withdrawn; or "first round">
Check: does the plan solve the request, fit the codebase (read the files it names), keep scope tight, cover tests and risks? Report numbered findings with file references. End with exactly one line: VERDICT: APPROVE or VERDICT: CHANGES REQUESTED.
```

## Code brief

```text
You are one of two independent reviewers of a PR for the Mousse repo. Review only; do not edit files.
Request: <the user's request, verbatim>
Approved plan: <plan text or link>
PR: <link>, base <branch> at <sha>, head <sha>. Diff: git diff <base-sha>...<head-sha>
Round <N>. Prior findings and responses:
<per finding: who raised it, text, fix commit or argument, open/withdrawn; or "first round">
Check: correctness, regressions, test coverage for the changed behavior, scope creep, and whether the code matches the plan. Run focused tests if useful. Report numbered findings with file:line. End with exactly one line: VERDICT: APPROVE or VERDICT: CHANGES REQUESTED.
```
