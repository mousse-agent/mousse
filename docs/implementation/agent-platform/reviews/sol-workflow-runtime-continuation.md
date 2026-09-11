# Sol workflow runtime continuation review

Reviewed integration base: `df4f29b88c6991aca1f439c5d17deeb8976c9cb1`  
Reviewed candidate: `0423d96eda7474602fcaf4ef8c072330cf1e87f6`  
Candidate merge: `9e6b7af78de8fdcffd727e2d243f8efd104b0f53`  
Runtime/domain fix: `509841eed74f3172a7ef7848a85b88ffe1cf2857`  
Artifact fix: `e9208b784f4fb83f4abae35723414a332abff7d9`

## Findings fixed

- **Deferred controls could consume a decision and then fail on the run lease.** Two concurrent waits made this reproducible: approving one scheduled a driver, and immediately approving the second persisted its decision before `resume()` threw a lease conflict. Pause, resume, approve/deny and answer now wait for the owned driver lease to settle. The decision remains durable before deferred execution is scheduled, and sequential or concurrent valid controls converge on one driver.
- **Denial left sibling approval tokens live and could be replaced after a crash.** Denying one branch now revokes every other open approval for the run before marking it failed. Recovery recognizes a consumed denial for the same instance/digest as terminal denial instead of creating a new approval.
- **Concurrent waits stopped at the runtime boundary.** The public run DTO now carries bounded `pendingApprovals`, `pendingInputs`, and `pendingConditions` arrays with authoritative node/instance identities. The domain resolves every displayed approval from the profile-owned approval store, accepts a non-first wait, and the renderer displays every actionable approval/input. Existing singleton fields remain compatibility projections.
- **Child usage bypassed parent workflow limits.** Subworkflow token, cost and artifact usage is persisted into the parent and checked against the parent's compiled limits before the parent node can succeed.
- **Windows staging collisions could overwrite input.** Collision keys now follow host filesystem case behavior, so declarations that resolve to `A/report.txt` and `a/report.txt` under one destination fail on Windows.
- **Adapter output could forge authoritative artifacts.** Artifact-shaped output is no longer copied directly into the run snapshot. Candidate IDs are traversed with a bound and resolved through the profile-owned artifact store; only an integrity-checked reference belonging to the exact run is projected. A real write-artifact result remains visible and a forged agent result is ignored.

## Reviewed runtime behavior

The candidate keeps independent intent/result records and immutable serialized checkpoint snapshots per instance. Nested graph cursors persist their graph path, ready queue, outputs, retries and waits. External/write effects with a prepared but uncommitted result remain `unknown-effect`; durable completed results are promoted without redispatch. Pure/read retries keep their real attempt count and durable backoff. `foreach`, bounded repeat, parallel and try/catch/finally use those same fences rather than a separate unsafe executor.

Parallel execution honors compiled concurrency. `all-success`, `collect-results`, and `first-success` have distinct settlement, and first-success aborts and awaits the losing tasks before the parent advances. Step/token/cost/artifact/time limits are enforced at their dispatch/write boundaries. Shutdown aborts owned drivers into `interrupted`, waits for leases to settle, and a fresh service resumes without replaying completed effects.

Subworkflow recovery finds the same durable child by parent run and instance, restores parent cancellation linkage, and carries remaining policy budgets into the child. Parent cancellation settles recovered child leases. Script inputs retain declaration-relative paths below the run staging root; traversal, escaping symlinks, duplicate/case-colliding targets and bounds fail. Sandboxed scripts go only through `SandboxAdapter`, while trusted-local scripts retain shell-free `ScriptRunner` argv/env/cancellation and immutable hashed source snapshots. Pinned workflow instructions load from the copied run bundle.

The durability fixtures were inspected rather than accepted by name. They bundle and spawn the actual `WorkflowRunService` fixture process, kill that process at dispatch and nested result/checkpoint boundaries, restart a fresh service over the same durable files, assert one marker/idempotency dispatch, and settle the real child process. The first-success test keeps a real loser promise active until abort and verifies settlement before parent completion.

## Verification

```text
npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowDomains.test.ts tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowEvaluator.test.ts tests/platformWorkflowExample.test.ts tests/platformWorkflowInvocation.test.ts tests/platformWorkflowPaths.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowRunStore.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowSchema.test.ts tests/platformWorkflowUi.test.ts tests/platformWorkflowUiEditor.test.ts tests/platformWorkflowCoordinator.test.ts tests/platformWorkflowRunDomains.test.ts tests/workflowExecutionClient.test.ts tests/platformProductionComposition.test.ts --maxWorkers=2 --reporter=dot
  17 files, 143 tests passed

npx vitest run tests/platformWorkflowRuntime.test.ts tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowRunDomains.test.ts --maxWorkers=2 --reporter=dot
  final runtime/domain head: 3 files, 60 tests passed

npm run typecheck
  node and web TypeScript projects passed at the final source head

npm run build
  app and CLI builds passed at the final source head; existing mixed-import and generated-CSS warnings remain

npm run test:workflow-editor
  50 hidden Electron checks passed after the multi-wait renderer change
```

No live provider, account, channel, MCP server, browser session or external sandbox was used. The sandbox fixture verifies the real adapter dispatch envelope and absence of trusted-local fallback; it does not qualify a production isolation implementation.

## Remaining runtime and production work

- A child subworkflow that reaches approval, input, timer or unknown-effect state is still treated as a failed parent node because `runSubworkflow()` accepts only a terminal-success child snapshot. Completion needs a durable parent wait linked to the child run, restart-safe wakeup, and propagation of child terminal/unknown state. Acceptance should kill the host with a child waiting on each control type, restart, resolve the child through the public control domain, and prove the same child/run/effect continues once.
- Parent snapshots intentionally accept only artifacts owned by the exact parent run. Artifacts created by a child subworkflow remain on the child snapshot, while the public attempt projection does not yet expose an authoritative child run link. A follow-up should expose that link and either navigate to child artifacts or define a verified descendant projection; it must reject an unrelated same-profile artifact ID.
- `WorkflowRunSnapshot.attempts` represents one durable instance with its current real attempt number. Full retry-attempt history remains in the journal rather than separate attempt rows. If the debugger requires one row per retry, derive it from paired prepared/completed events with stable instance/attempt keys and test crash-truncated journal tails.
- Recovery diagnostics are populated only after inventory reads and are not emitted through the production run domain/UI. Corrupt checkpoint/policy/bundle handling remains fail-closed and needs an operator-visible recovery record rather than silent disappearance or profile-start failure.
- The catalog still names the script permission `script.trusted-local` for sandboxed and local modes. Sandboxed execution is more restricted and never falls back locally, so this is an over-restrictive authority label rather than an escalation. A new capability requires an explicit contract/migration decision and compiler/manifest compatibility tests.
- Production sandbox, Agent, Skill, MCP/tool and browser adapters, slash/CLI/main-agent ingress, schedules/channels and packaged recovery remain separately reviewed scope. This checkpoint does not close the implementation goal or a release gate.

