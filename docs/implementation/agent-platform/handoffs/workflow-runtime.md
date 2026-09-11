# Workflow runtime handoff

Branch: `feat/platform-workflow-runtime`

This worktree started from reviewed core `7ea1c12`. The runtime contract is in `src/shared/workflows/runtime.ts` and the implementation is `src/mms/workflows/engine/WorkflowRunService.ts` with durable checkpoint additions in `runStore.ts`.

## Root integration API

`WorkflowRuntimePort.admit(request)` is the preferred RPC path for nonblocking durable admission. It validates the definition and input, persists the verified bundle, input, policy, run manifest, checkpoint, and journal acceptance record, releases the admission lease, schedules a supervised driver, and returns a `queued` snapshot. `start({ ...request, deferExecution: true })` is equivalent. Existing `start(request)` remains blocking unless `deferExecution` is set.

`StartWorkflowRequest.expectedDraftSemanticHash` enables draft execution. It requires `definitionId`; the current draft is read and its semantic hash must match exactly. The immutable draft bundle is copied into the run directory, and the manifest records `draftSemanticHash`. No publish or registry mutation occurs.

`WorkflowRuntimePort.shutdown()` aborts active drivers with a pause boundary, waits for their leases to settle, and leaves them `interrupted` for later `resume()`.

Subworkflow admission passes the parent cancellation id through the internal `parentCancellationId` field, so cancellation propagates across nested runs while preserving the public request shape.

## Durable behavior

Checkpoint state now keeps nested graph cursors under stable instance paths, nested outputs, aggregate artifact references, adapter token/cost usage, and independent per-instance/per-attempt intent and result records. Checkpoint writes are serialized from immutable snapshots, so overlapping branches cannot overwrite another branch's in-flight effect. Nested loop, parallel, try/catch/finally, and named subgraph execution uses the cursor and resumes nested approval/input/wait results through the parent checkpoint. Effectful nested nodes use the same intent journal and idempotency fence as top-level nodes; unknown external/write effects remain `unknown-effect` until explicit reconciliation. Completed durable results are promoted after a restart, including external results observed before an after-result crash, without replaying the adapter.

Top-level batches and parallel branches honor bounded concurrency. Parallel policy handling supports `all-success`, `collect-results`, and `first-success` settlement; first-success aborts losing branch signals and waits for their settlement before the parent continues. Retry/backoff is durable through the instance attempt counter and persisted `retryAt`, and is restricted to pure/read effects. Snapshot attempts are reconstructed from checkpoint instance state plus the prepared/completed journal records, including paths, real attempt counts, outcomes, errors, and output hashes. Artifact references are aggregated from node results instead of being discarded.

Pause and shutdown cancel the active cancellation signal, wait for the driver to release its lease, and persist `interrupted`; resume can safely reacquire the lease. Crash boundaries distinguish retryable pure/read work from unknown external/write work at intent, dispatch, result, and checkpoint boundaries.

## Verification

```text
npm run typecheck
npx vitest run tests/platformWorkflowRuntime.test.ts tests/platformWorkflowRunStore.test.ts --maxWorkers=2
npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowDomains.test.ts tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowEvaluator.test.ts tests/platformWorkflowExample.test.ts tests/platformWorkflowInvocation.test.ts tests/platformWorkflowPaths.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowRunStore.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowSchema.test.ts tests/platformWorkflowUi.test.ts tests/platformWorkflowUiEditor.test.ts --maxWorkers=2
```

The focused runtime/store run passes 18 tests. `tests/platformWorkflowDurabilityMatrix.test.ts` passes 16 restart and fault-boundary tests. The matrix asserts exact dispatch counts for foreach, bounded-repeat, parallel, and try/catch/finally at after-intent, after-dispatch, after-result, and after-checkpoint faults; failed collect-results settlement; all-success and first-success loser cancellation; exact pure retry attempts across a shutdown/restart; active shutdown/resume without replay; nested approval, delay, and condition waits; parent restart after a completed child result with one durable child id and propagated policy/budget usage; and a real bundled child `WorkflowRunService` process killed after its nested external adapter signals durable dispatch. The 13 workflow suites pass 98 tests with `--maxWorkers=2`; `npm run typecheck` passes for both node and web projects. Fixtures cover real scripts, staged file inputs, cancellation while a lease is held, unknown external recovery, per-instance after-result recovery, bounded overlap for effectful parallel branches, nested cursor recovery, loops, parallel branch ordering, delay checkpoints, profile fencing, artifact policy, and output budgets.

Remaining work is integration wiring: root owns host/RPC composition and should bind the production client to `admit()`, while real external adapters remain injection ports. The process fixture proves restart behavior for a nested foreach external effect; the subworkflow restart case uses a fresh service against the same on-disk parent/child store and verifies child identity, no duplicate dispatch, and persisted budget accounting. No host, compiler, registry, definition, invocation, UI, or orb files were changed here.
