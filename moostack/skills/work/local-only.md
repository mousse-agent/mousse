# Local-only work

Read this only when the outcome is local testing or an experiment: checking out or combining existing PRs, resolving conflicts for a trial, temporary instrumentation.

- Inspect the relevant source PR and target commits, perform the requested integration or experiment, run focused verification (`node scripts/verify.mjs <files>`), and report the local result.
- Keep the result where the user asked, including the primary checkout when requested. Preserve the user's edits.
- Use local branches, commits or a worktree for recovery when useful.
- Do not create an issue or PR, push a checkpoint, claim a task, or post routine GitHub updates unless asked. Permission to comment on an existing PR authorizes that comment only. A request for a backup push authorizes that push only.
- If an experiment later becomes work meant to ship, return to "Shared work" in [the work skill](SKILL.md); earlier local-testing permission is not publish or merge permission.
- Stop when the local outcome is complete.
