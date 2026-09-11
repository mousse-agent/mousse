# Workflow workspace correction review

Candidate reviewed: `13a0e5e276d9be6aba47e26e4acbb7e54d546722` (parent `c89f835`)

The candidate now honors all three declared script working-directory modes. `thread-workspace` resolves the live profile/thread/project binding to a registered non-primary Git worktree; `run-staging` remains run-owned; `profile-sandbox` fails closed without a configured sandbox filesystem root. Declared file inputs remain separately staged in `MOUSSE_INPUT_DIR`.

Review fixes:

- Preserve a pinned Agent definition's `read_only` workspace policy when assigning a physically isolated child worktree. The prior candidate rewrote it to `dedicated_child_worktree`, which enabled write tools and widened authority.
- Validate thread workspace metadata against its deterministic thread, repository, branch, retained ref, worktree path and project subdirectory before running code. The resolved project cwd must remain canonically inside a registered worktree for the live repository and cannot be the primary checkout.
- Validate bounded, regular Agent workspace records and require exact deterministic repository, worktree, branch, retained ref and contained project cwd on reuse. Recovery of a registered worktree also checks its expected branch/repository and republishes the retained ref. Scratch paths receive the same canonical containment check.
- Mutating thread-workspace scripts now hold the existing cross-process thread execution and repository mutation leases for the raw script lifetime, with heartbeats and ownership-checked release. Same-cwd process ordering remains FIFO.
- Cancellation while queued for cwd occupancy now returns promptly without dispatching later. Cancellation after dispatch retains ownership until the underlying process settles, preserving process cleanup guarantees.
- Relocated the candidate handoff under `docs/implementation/agent-platform/handoffs`.

Verification:

- `npx vitest run tests/platformWorkflowRuntime.test.ts tests/platformWorkflowWorkspace.test.ts` — 32 passed.
- `npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowCoordinator.test.ts` — 30 passed.
- Root's exact `tests/platformWorkflowCrossFeature.test.ts`, copied temporarily and removed after execution — 1 passed through the real MMS protocol path.
- `npm run typecheck` — node and web TypeScript checks passed.
- `git diff --check` — passed.

The Agent provider transport remains fixture-mocked. External CLI Agent workspaces, a configured production sandbox backend, worktree retention/garbage collection, the full test suite, and application packaging were outside this bounded review.
