# Sol review — W02/W03 workflow runtime

Date: 2026-09-11

## Reviewed revisions

- Integration base before merge: `f381a605ee35c43d9fd18af7cb918e8e9944553c`
- Workflow handoff: `b378956` (`feat/platform-workflow-runtime`)
- Workflow implementation: `4d53c47041d2c4113fd22af0c331ca970e8434ea`
- Reviewed merge: `a9fb18b`
- Sol runtime fixes: `9c7f4735d30a2b876ba131c1c29e03eeb2aec4ef`

The merge retained the earlier W01 registry locks, safe draft replacement, semantic-versus-visual revision behavior, immutable revision checks, and archive coordination. No orb, control/auth, master-checkout, or live-account files were changed.

## Findings fixed

- Approval records now validate UUID paths and configured profile ownership. Decisions and revocations run under an exclusive file lock, bind to the expected run and request digest, reject invalid timestamps, and remain consume-once under competing processes.
- Run acquisition is serialized and no longer reuses one process token for concurrent service calls. Leases heartbeat during execution, release only when the token still owns the run, and fence writes. Cancellation can signal an active in-process run before waiting for its lease; terminal runs cannot be resumed into a different state.
- Fresh-process recovery restores the process-owned `AbortSignal` for the persisted cancellation ID. Recovery derives the next journal sequence from durable events, tolerates only a torn final NDJSON record, and journal appends now surface fsync failure instead of claiming best-effort durability.
- The dispatch fault hook now fires after the node body returns, so the unknown-effect fixture covers a dispatched effect. Non-retryable thrown effects become `unknown-effect`; a cancellation-induced process exit remains `cancelled`.
- Imported `effect` values cannot lower the catalog/runtime minimum. Scripts and approval nodes remain `unknown`; tool/MCP/browser remain at least `external`; artifact writes remain at least `write`. Tool-call, artifact-byte, and cumulative elapsed budgets are checked before the relevant dispatch/write.
- File artifacts validate UUID identity, profile ownership, byte length, and SHA-256 on read. Artifact IDs cannot traverse the profile root.
- Script execution rejects pre-aborted signals, kills on either stdout or stderr overflow, launches a POSIX process group, kills the group before the direct process, and enables Electron's documented Node mode when the Node interpreter is `process.execPath`. Compiler validation now bounds script timeout, argv, environment allowlist, and loop duration.
- ZIP import no longer strips and accepts absolute entry names. Existing compressed, expanded, per-entry, count, collision, and path limits remain in force.
- Bounded JSON Schema validation now rejects indirect local `$ref` cycles as well as direct recursion.
- `for-each` no longer silently truncates input beyond `maxIterations`; loop duration is enforced. A failing `finally` subgraph now propagates its failure.
- Nested effectful subgraphs now fail closed because the current single-intent checkpoint cannot recover them correctly. Pure loop, condition, and parallel fixtures continue to execute.

## Qualification evidence

Focused fixtures exercise the real `examples/workflows/summarize-files/scripts/collect.mjs`, declared file staging and a real escaping junction/symlink, approval and run fencing, an actual descendant process-tree cancellation, stdout/stderr bounds, pre-cancelled spawn, ZIP roundtrip and absolute paths, schema recursion, artifact tampering, unknown-effect no-replay, checkpoint/manifest crash recovery, active runtime cancellation, terminal-state recovery, condition selection, loop item bindings, and deterministic parallel branch collection.

Final commands and results:

```text
npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowEvaluator.test.ts tests/platformWorkflowExample.test.ts tests/platformWorkflowPaths.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowSchema.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowRunStore.test.ts tests/platformScript.test.ts tests/platformApproval.test.ts tests/platformArtifactStore.test.ts tests/platformExecutionPolicy.test.ts --maxWorkers=2
12 files / 70 tests passed

npm run typecheck
passed (node and web TypeScript)

npm run build
passed (renderer, Electron main/preload, and CLI)
```

No full test suite was run during this CPU-bounded review, as requested.

## Required follow-up and acceptance fixtures

`WorkflowRunService`, `RunCheckpoint`, and `WorkflowRunStore` still need a durable nested-execution model. Replace the single `lastIntent` with per-instance in-flight intent/result state and persist nested graph/path state. Acceptance must cover crash before dispatch, after dispatch, after durable result, and after checkpoint for effectful nodes inside `for-each`, `bounded-repeat`, `parallel`, `try-catch`, and `finally`; pure/read effects may resume at the correct nested successor, while write/external/unknown effects never replay without explicit reconciliation. Nested approval, ask-user, delay, and wait-for-condition must persist and resume instead of returning the current explicit failure.

`WorkflowRunService.runParallel` and join handling still implement only “launch all, wait all, sort results.” Implement and fixture `all-success`, `collect-results`, and `first-success`, including branch failure shapes, cancellation and settlement of losing branches, declared `maxConcurrency`, restart while branches are in flight, and no post-terminal writes. Top-level `limits.maxConcurrency` currently batches ready nodes but awaits them sequentially; qualify actual concurrent scheduling separately.

Compiled node `retry` settings are not executed. Add durable attempt counters, bounded backoff, restart during backoff, and journal outcomes. Automatic replay must be limited to proven `pure`/`read` effects; write/external/unknown requires adapter idempotency/reconciliation or must remain `unknown-effect`. Add fixtures proving a non-idempotent adapter is never duplicated.

Add end-to-end subworkflow recovery and policy/budget propagation fixtures. Adapter token/cost accounting cannot be completed until adapter results expose usage. Real agent, tool, MCP, skill, and browser adapters remain host injections and must be wired through the profile composition root. Protocol/IPC, slash command, CLI, composer, scheduler, and channel ingress are also pending; these are required before G3/W03 can be claimed.

The runtime review does not establish every-node graph semantics from catalog enumeration. The positive semantic evidence here is limited to the explicit condition, pure loop, pure parallel/join collection, delay, start/end, transform, real script, and collect workflow fixtures described above.
