---
name: end-session
description: Wrap up repository work only when the user explicitly asks to end the session. Publish the selected WIP, review, or merge outcome and record a durable handoff. Ordinary implementation, commit/push requests, task completion, and casual goodbyes do not trigger this skill.
---

# End session

Use this skill only after an explicit request to end the session. Read [the shared team policy](../../../docs/team-workflow.md). Use the outcome already requested. If the user only says "end session," briefly offer WIP handoff, ready for review, or ready to merge. Do not ask again for commit/push/merge authority already given for this task.

## Inspect before publishing

- Run `node scripts/team-status.mjs --fetch` from the repository root. Identify this task's issue, branch, PR, diff, and relevant checks. Inspect unexpected changes and resolve ownership ambiguity before staging them.
- Review the task diff; stage explicit paths or hunks. Preserve unrelated edits. If there is no useful change, report that fact; create no empty commit or PR and delete nothing automatically.
- Run checks appropriate to the changed behavior and verify acceptance criteria directly. State failures and checks not run. WIP may be published without passing checks; it must not be presented as ready to merge.
- Commit useful task changes, push the task branch, and verify the published commit. Reuse an existing PR rather than opening a duplicate.

## Publish the selected outcome

### WIP handoff

Open or update a draft PR. Keep the issue open, record the handoff below, and identify the next action and its owner. This is the outcome for unfinished work, including failing checks.

### Ready for review

Open or update a non-draft PR with the outcome, verification evidence, and `Closes #123` for work that fully completes that issue. Use `Refs #123` for partial delivery. Keep the issue open until completion lands.

### Ready to merge

Proceed only with user authorization for this merge. Re-fetch and inspect the current PR head, base, required checks, reviews, and unresolved conversations. The verification must cover the current changes. Follow actual GitHub rules and the shared review policy; never force or administratively bypass a failed requirement.

Merge using an enabled repository merge method and guard against merging a newly changed head (for example, `gh pr merge --match-head-commit SHA` with the chosen method). If any gate fails, leave the PR open and explain the blocker.

Verify the merge succeeded and the intended acceptance criteria are complete before closing the issue. Confirm automatic closure or close it explicitly when appropriate. GitHub may automatically delete the merged remote head; move follow-up work to a new task branch before merging. For local cleanup, preserve branches with unpublished work or active worktrees. Do not delete abandoned, unmerged branches automatically.

## Leave a durable handoff

Post this information on the issue (or update an existing current handoff); keep detailed verification in the linked PR:

```text
Status: WIP / blocked / ready for review / merged
Owner / next actor:
Branch, published commit, and PR:
Completed:
Verification: passed, failed, and not run
Decisions and blockers:
Next action: concrete step or command, including relevant files
```

Use "none" where appropriate. A fresh teammate should be able to continue from this record and the remote branch without the original machine or private chat.

Report links and the published commit to the user. If publishing or GitHub updates fail, state exactly what remains local or unrecorded; follow the shared failure policy.
