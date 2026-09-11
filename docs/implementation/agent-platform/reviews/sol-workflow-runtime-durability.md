# Sol review — workflow runtime durability completion

Date: 2026-09-11

## Reviewed revisions

- Integration base before merge: `eb2b887c6c56a65ee29717408a631621615ade15`
- Runtime branch fork base: `7ea1c126e60a7031224a3fc14919a7fddea272be`
- Runtime candidate: `f24bb2ad980d7b5abf46ad968ad33be584dddea3`
- Reviewed merge: `331d0b0`
- Runtime review/fix commit: `0dcfd81`

The candidate changed only the workflow runtime contract, engine/store, durability tests, process fixture, and its handoff. This review did not change the workflow UI, root-owned orb, control/auth, browser implementation, original checkout, or master.

## Findings fixed

- An ambiguous external effect inside `try-catch` was treated as an ordinary failure, so catch/finally could execute more effects and the workflow could report success. Parallel `collect-results` and `first-success` had the same issue. Unknown external outcomes now propagate as `unknown-effect`; intentionally aborted first-success losers are settled without turning a known winner into an unknown run.
- Nested execution passed a nested-local checkpoint to durable writes. While an adapter was in flight, that snapshot could replace the root ready/instance shape and nested cursors also copied unrelated root instances. Nested effects now persist their intents/results into the root checkpoint while their isolated cursor remains under `checkpoint.nested`.
- Snapshot projection omitted nested attempts after cursor isolation and used an idempotency key as the input hash. It now aggregates unique root and nested instances, journals the real input hash/attempt, reports in-progress attempts as unknown rather than failed, and aggregates artifacts when each durable node result is committed.
- Parent cancellation linkage existed only in process memory. Manifests now persist `parentCancellationId`, and a fresh `CancellationRegistry` rebuilds and validates the parent-child link before a child driver resumes.
- Scheduled drivers attached cleanup with a discarded rejecting `finally()` promise. Success and rejection handlers now both remove the owned task without producing a second unhandled rejection.
- `resume`, `approve`, `answer`, and `tick` were blocking control calls. Their owner options now accept `deferExecution`; ownership and control-specific validation/persistence happen under the run lease, then the lease is released and an owned driver is scheduled. Existing blocking behavior remains the default. A real long-running script fixture proves deferred approval returns after the consumed decision is durable and can then be cancelled.
- Start admission had no durable request identity. Optional `requestId` now deterministically derives the profile-scoped run ID and persists a canonical request digest. Exact reuse after a fresh service returns the original run without dispatch; changed input/definition/actor/policy conflicts. Run creation is serialized by a durable admission lock, repairs a dead partial directory, writes the immutable bundle/input/policy, checkpoint, and initial `run-accepted` journal before exposing the manifest, and therefore has no response-cache/index crash gap.
- Pending input projection now carries the authoritative `nodeId` recorded by the engine alongside its instance key, schema, and prompt.
- The candidate tests described thrown external adapter errors as ordinary catchable/collectable branch failures. The fixtures now use deterministic pure failures for catch/collect semantics and separately assert fail-closed external ambiguity.

## Requirement-level evidence

- Per-instance nested intents: a blocked nested external adapter is inspected on disk while live; the root instances remain `start`/`loop`, the nested cursor contains the exact body instance, and its independent prepared intent is durable.
- Fault/no-replay: the matrix checks foreach, bounded repeat, parallel, and try at the available hooks. The real child fixture starts the actual bundled `WorkflowRunService`, records a nested external dispatch, is killed with `SIGKILL`, and a fresh process reaches `unknown-effect` with one marker and one prepared attempt.
- Result commit: the existing top-level after-result recovery fixture reaches success with one external invocation. Nested snapshots now retain exact attempts and hashes.
- Parallel policies: a three-way first-success case waits for its signal-aware loser to settle and observes no late journal writes; collect-results retains a deterministic known failure; all-success fails; external ambiguity propagates.
- Retry: a top-level pure condition persists `retryAt`, is shut down during backoff, and completes at exactly attempt 2 after a fresh service; external effects are not retried.
- Subworkflow: a fresh service resumes the same child selected by `parentRunId` plus `parentInstanceKey`, retains the child run ID, does not duplicate its external call, and preserves the tested tool budget. Parent cancellation identity is now durable.
- Admission/control: exact draft hash admission remains immutable and nonpublishing; durable `requestId` replay and mismatch are tested; deferred approval persists its consumed decision before returning while a real script remains active; shutdown/cancel settle the owned driver.
- Run store: a simulated dead partial admission directory is repaired under the admission lock, and the manifest becomes visible only after initializer data, checkpoint, and initial journal exist.

## Qualification commands

```text
npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowDomains.test.ts tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowEvaluator.test.ts tests/platformWorkflowExample.test.ts tests/platformWorkflowInvocation.test.ts tests/platformWorkflowPaths.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowRunStore.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowSchema.test.ts tests/platformWorkflowUi.test.ts tests/platformWorkflowUiEditor.test.ts tests/platformExecutionPolicy.test.ts --maxWorkers=2
14 files / 109 tests passed

npm run typecheck
passed (node and web TypeScript)

npm run build
passed (Electron main/preload/renderer and CLI)
```

Build retained the existing renderer CSS optimizer warning for the malformed `m-*/space-*` comment selector and the existing mixed static/dynamic import warning for `daemonShutdown.ts`; neither is introduced by the runtime files. No full repository suite was run, as requested.

## Required follow-up

- `runGraph` does not apply compiled node retry policy. The qualified persisted attempt-2 case is top-level only. Add nested pure/read retry and restart-during-backoff fixtures for foreach, repeat, parallel, try/catch/finally, and named subgraphs; external/write/unknown must remain nonreplayed.
- The injected `afterResult` and `afterCheckpoint` hooks execute in the top-level driver, not at each nested cursor transition. The current parameterized matrix therefore does not prove a process death after a nested adapter result is durable or after its nested successor checkpoint. Add real child-process kills at both boundaries, for successful and deterministic failed results, and verify the exact successor/catch/finally path without redispatch.
- A checkpoint has one `pendingApprovalId`, `pendingInput`, and `wakeAt`. Concurrent parallel branches that wait independently are not represented or qualified. Replace these singletons with per-instance wait records and test two approvals, two inputs, and unequal timers across restart and cancellation.
- Nested recovery locates a graph by node ID with `findGraphContaining`; duplicate node IDs in different subgraphs can select the wrong successor graph. Resolve by the durable instance path and add duplicate-ID branch/restart fixtures, including joins.
- The subworkflow restart fixture proves identity and tested tool-budget propagation, while actual cancellation of an active resumed child through its restored parent link is only covered at the cancellation-registry boundary. Add a real parent/child driver restart-and-cancel fixture and verify both leases settle.
- Approval snapshots still expose only `pendingApprovalId`; production projection must read the profile-owned `ApprovalService` record and bind run, revision, policy snapshot, digest, expiry, and consumed state. Real Agent, MCP, browser, skill, and other host adapters remain production composition work.

These gaps keep the complete workflow runtime/release gate open; the reviewed API and tested behaviors above are ready for the workflow run domain bridge.

