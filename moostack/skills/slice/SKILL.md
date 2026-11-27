---
name: slice
description: Plan work that needs more than one PR as slices that each merge on their own within a day. Use before starting tier 4 or 5 work that will not fit one PR, and when a PR in progress has grown past one goal. It produces the plan; it does not implement.
---

# Slice

A chain of PRs built on each other is slow twice. Every fix to an early PR is carried into the ones on top of it, and each PR stays open long enough for the default branch to move under it. Plan slices that merge alone, the same day they start.

## 1. Write the rules first

For work on state, ordering, retries, spend or permissions, write the rules the code must keep before cutting anything: five to ten sentences, each one checkable. "A result is marked as told only after the turn that read it ends." "A hold that is never used is never charged."

The rules go in the tracking issue. The implementer lists inputs against them ([test-the-claim](../test-the-claim/SKILL.md) section 4), and the reviewer checks the diff against them. Edge cases found one review at a time are almost always a rule nobody wrote down.

## 2. Cut the slices

- One slice is one thing a person can notice, or one enabling change (a migration, a shared type, an extraction with no behavior change) that is safe to merge unused.
- Each slice merges to the default branch on its own and leaves it working. Behavior that is not finished is not reachable yet; it is never half-working.
- Enabling changes go first.
- A slice fits one sitting: one implementer, one review pass, merged the day it starts. If its verification takes more than two lines to describe, cut again.
- "One PR, one goal" in [the policy](../../../docs/team-workflow.md) still holds: a part that only makes sense with the rest stays with it. Do not split by size alone.

## 3. Order them

For each slice write: what it depends on, the files it will change, and how it is verified (named tests and the direct check).

- Slices that share no files and no dependency run in parallel. Two slices that change the same file run one after the other.
- No stacking. A slice branches from the default branch after the slices it depends on have merged. If it must start earlier, it branches from that one slice's branch, the PR says so, and nothing is built on top of it.
- Shared counters (a migration number, a contract version) are assigned in the plan, so two parallel slices never take the same one.

## 4. Keep the plan in the issue

The plan is a checklist in the tracking issue: slice, depends on, files, verification. Not a file in one machine's scratch folder, and not the conversation. Tick slices as they merge and rewrite the list when the plan changes. Start each slice from the issue, in a fresh session when the previous one is long.

## 5. Check the plan once

Run [check-related-work](../check-related-work/SKILL.md) on the plan's paths. A tier 5 plan gets one read by someone who did not write it ("Reviewing a plan" in [review](../review/SKILL.md)). Work that has no settled architecture yet goes through [design](../design/SKILL.md) before it is sliced. Other plans need none. No rounds, no scores.
