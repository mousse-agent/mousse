# Workflow runtime handoff

Branch: `feat/platform-workflow-runtime`

This worktree started from reviewed core `7ea1c12`. The runtime contract is in `src/shared/workflows/runtime.ts` and the implementation is `src/mms/workflows/engine/WorkflowRunService.ts` with durable checkpoint additions in `runStore.ts`.

## Root integration API

`WorkflowRuntimePort.admit(request)` is the preferred RPC path for nonblocking durable admission. It validates the definition and input, persists the verified bundle, input, policy, run manifest, checkpoint, and journal acceptance record, releases the admission lease, schedules a supervised driver, and returns a `queued` snapshot. `start({ ...request, deferExecution: true })` is equivalent. Existing `start(request)` remains blocking unless `deferExecution` is set.

`StartWorkflowRequest.expectedDraftSemanticHash` enables draft execution. It requires `definitionId`; the current draft is read and its semantic hash must match exactly. The immutable draft bundle is copied into the run directory, and the manifest records `draftSemanticHash`. No publish or registry mutation occurs.

`WorkflowRuntimePort.shutdown()` aborts active drivers with a pause boundary, waits for their leases to settle, and leaves them `interrupted` for later `resume()`.

Subworkflow admission passes the parent cancellation id through the internal `parentCancellationId` field, so cancellation propagates across nested runs while preserving the public request shape.

## Durable behavior

Checkpoint state now keeps nested graph cursors under stable instance paths, nested outputs, aggregate artifact references, and adapter token/cost usage. Nested loop, parallel, try/catch/finally, and named subgraph execution uses the cursor and resumes nested approval/input/wait results through the parent checkpoint. Effectful nested nodes use the same intent journal and idempotency fence as top-level nodes; unknown external/write effects remain `unknown-effect` until explicit reconciliation.

Top-level batches and parallel branches honor bounded concurrency. Parallel policy handling supports `all-success`, `collect-results`, and `first-success` settlement. Retry/backoff is durable through the instance attempt counter and is restricted to pure/read effects. Snapshot attempts are reconstructed from checkpoint instance state plus the prepared/completed journal records, including paths, real attempt counts, outcomes, errors, and output hashes. Artifact references are aggregated from node results instead of being discarded.

Pause and shutdown cancel the active cancellation signal, wait for the driver to release its lease, and persist `interrupted`; resume can safely reacquire the lease. Crash boundaries distinguish retryable pure/read work from unknown external/write work at intent, dispatch, result, and checkpoint boundaries.

## Verification

```text
npx tsc --noEmit --pretty false
npx vitest run tests/platformWorkflowRuntime.test.ts tests/platformWorkflowRunStore.test.ts --maxWorkers=2
```

The focused run passes 15 tests. The added admission test verifies queued return and draft hash fencing. Existing fixtures cover real scripts, staged file inputs, cancellation while a lease is held, unknown external recovery, loops, parallel branch ordering, delay checkpoints, profile fencing, artifact policy, and output budgets.

Root still owns host/RPC composition and should bind the production client to `admit()`; no host, compiler, registry, definition, invocation, UI, or orb files were changed here.
