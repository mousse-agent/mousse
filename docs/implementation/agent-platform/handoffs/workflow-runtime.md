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

The W02 durability continuation adds these additive APIs and limits:

- `WorkflowRunSnapshot.pendingWaits` and `RunCheckpoint.waits` carry independent approval, input, and timer records keyed by durable instance path; singleton `pendingApprovalId`, `pendingInput`, and `wakeAt` fields remain compatibility projections.
- `WorkflowFaultHooks.afterNestedResult(instanceKey)` and `afterNestedCheckpoint(instanceKey)` are test-only crash seams after the nested result and successor checkpoints. `WorkflowRunService.recoveryDiagnostics()` reports corrupt/orphan run manifests skipped by `list()`.
- `WorkflowRunService.cancel()` settles owned child subworkflow runs after the parent state transition, including stale leases recovered after a host restart. Nested cancellation uses the persisted `parentCancellationId` link.
- `compiled.instructionsFile` is loaded from the immutable per-run bundle and passed to agent adapters with revision provenance. `limits.maxSteps`, `maxTokens`, `maxCost`, `timeoutMs`, and `maxArtifactBytes` are enforced at their dispatch or write boundaries; loop iteration and concurrency limits remain compiled controls.
- Sandboxed scripts submit the complete `ScriptSpawnRequest` directly to `SandboxAdapter`; no sandbox adapter means `SANDBOX_UNAVAILABLE` and no trusted-local fallback. Script snapshots retain their source extension and include a content-hash suffix. File inputs preserve declaration-relative paths under run staging, so equal basenames and multiple declarations cannot overwrite each other.

Verification for this continuation:

```text
npm run typecheck
npx vitest run tests/platformWorkflowRuntime.test.ts --maxWorkers=2 --reporter=dot  # 20 passed
npx vitest run tests/platformWorkflowDurabilityMatrix.test.ts --maxWorkers=2 --reporter=dot  # 29 passed
```

The matrix now includes actual bundled child-process kills at nested result/checkpoint boundaries, nested pure retry after shutdown, independent concurrent approval/input/timer waits, duplicate graph-node path recovery, immutable instruction assets, compiled step/token/cost limits, same-basename file staging, sandbox adapter routing, tolerant inventory, and parent/child process recovery cancellation with both leases settled. The real fixture covers the supported Node workflow runtime; browser/OOPIF, host policy intersection, production approval projection, and coordinator startup policy remain root-owned or separate platform work. No host, compiler, registry, definition, invocation, UI, or orb files were changed here.

## Child wait continuation

The child-wait continuation adds an authoritative `childRunId` to `WorkflowNodeAttempt`, `WorkflowPendingWait`, and the renderer-facing pending approval/input/condition/unknown-effect DTOs. A subworkflow instance persists the link before returning its parent wait, and the snapshot attempt projection exposes the same ID for child artifact/run navigation. A checkpoint child pointer is accepted only when the child manifest has the exact parent run and parent instance link; replacing it with an unrelated same-profile run fails closed.

When a child is waiting for approval, input, or a timer, `runSubworkflow` returns a durable parent wait with the child ID and the child wait details. Child `approve`, `answer`, and `cancel` actions refresh the linked parent checkpoint after the child public control completes, so a fresh service can resume the exact child and continue the parent without creating another child or dispatch. A child `unknown-effect` is surfaced as a parent recovery wait with `childState: 'unknown-effect'`; the parent cannot reconcile that effect on the child's behalf. Public parent approval/input/reconcile methods return `child_run_required` for child-owned controls, directing the caller to the child run. Parent snapshots retain parent-owned artifacts only; child artifact references remain navigable through the child run.

The real subprocess fixture and `tests/platformWorkflowSubworkflowRecovery.test.ts` cover fresh-service and killed-host recovery for child input, approval, timer, and unknown external effect. They assert the exact child ID, parent/child linkage, terminal propagation, no duplicate unknown dispatch, public wait projection, and rejection of an unrelated same-profile child pointer. Timer wakeup remains driven by the existing public resume/tick path after its durable deadline; no background scheduler is introduced here.

Final verification for this continuation:

```text
npm run typecheck -- --pretty false                         # passed
npx vitest run tests/platformWorkflowSubworkflowRecovery.test.ts --maxWorkers=2 --minWorkers=1  # 9 passed
npx vitest run tests/platformWorkflow*.test.ts --maxWorkers=2 --minWorkers=1                   # 16 files, 143 passed
```

The root composition still owns production registration and any execution binding fields added to the manifest initializer. This candidate changes only the workflow engine/store, runtime and run-view contracts, run-domain child-control fencing, the workflow crash fixture, and the focused child recovery test/handoff.
