# Worktree Readiness Investigation

## Status

Investigation paused at the user's request. No implementation changes were made to the worktree code.

## Findings

- `src/mms/worktree/WorktreeManager.ts` currently has `validateAgentReadiness()` and merge-boundary validation through `GitStateInspector`.
- The current implementation does **not** contain the `prepareForReady()` method expected by `tests/worktreeReadiness.test.ts`.
- The current `mergeAndRemove()` accepts only a worktree argument, while the readiness test passes an expected `{ commit, diffFiles }` claim.
- The readiness test therefore exposes a likely merge-conflict regression: the earlier implementation had dirty-change finalization and immutable ready-commit/diff validation, but those pieces are absent from the current merged version.
- The completed-worktree flow intentionally keeps the worktree and branch after a successful merge; cleanup is a separate explicit operation via `cleanupValidatedAgentWorktree()`.
- Repository selection is now explicit through `repositoryRoot` / `RepositoryContext`; worktrees are stored under the Mousse home repository-specific worktree directory.
- The working tree already contained unrelated modified files and an untracked `NUL` before this report was created. Those changes were not inspected or modified.

## Suggested next step

Restore `prepareForReady()` and optional expected-commit/diff validation in `mergeAndRemove()`, adapting both to the current explicit `RepositoryContext` design, then run the focused worktree tests.
