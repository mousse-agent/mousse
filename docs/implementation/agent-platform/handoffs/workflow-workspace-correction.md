# Workflow workspace correction handoff

## Scope

This integration slice makes workflow script and agent workspace bindings authoritative:

- `thread-workspace` resolves through the owning profile, live thread/project binding, and the registered `ThreadWorkspaceManager` worktree. It rejects a missing, stale, mismatched, or primary checkout workspace.
- `run-staging` always uses the run-owned staging directory. Declared `fileInputs` remain independently staged below `MOUSSE_INPUT_DIR`; the script CWD is never inferred from that environment variable.
- `profile-sandbox` requires a configured sandbox adapter with a published filesystem root and fails closed otherwise.
- Script CWD occupancy is serialized by canonical workspace path and cancellation is checked before dispatch and while waiting.
- Project-backed mutating workflow agents create separate registered Git worktrees with stable profile/thread/invocation identities, repository and thread leases, durable ownership records, and idempotent reuse. Standalone agents use profile-owned scratch directories; non-Git projects fail closed.
- Concurrent agent invocations use separate durable execution thread sessions so their native provider histories cannot interleave on one workflow thread.
- The compiler validates the advertised working-directory values and adds the required `workspace.read` capability for `thread-workspace` nodes. The reviewed ancestor-scope compiler correction is included from `c89f835`.

## Validation

From `C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\integration`:

```text
npm test -- --run tests/platformWorkflowRuntime.test.ts tests/platformWorkflowWorkspace.test.ts
Test Files  2 passed (2)
Tests       27 passed (27)

npm test -- --run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowCoordinator.test.ts
Test Files  2 passed (2)
Tests       30 passed (30)

npm run typecheck
exit code 0

git diff --check
exit code 0
```

The frozen `tests/platformWorkflowCrossFeature.test.ts` from the core worktree was copied temporarily as a local qualification test and passed 1/1 through the real MMS protocol path. The copied file was removed before commit.

The workspace suite uses real local Git repositories, `git worktree add`, native Node scripts, staged file inputs, profile/thread/project spoof checks, stale-worktree denial, cancellation, and repeated idempotency identity. Provider I/O is the only fixture-mocked boundary.

The full application build, full test suite, paid/live providers, browser downloads, and irreversible worktree cleanup were intentionally not run.
