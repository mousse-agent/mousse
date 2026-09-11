# Production child workflow scheduling and pinned integration inheritance

Workflow-runtime implementation, 2026-09-11. This installs the required root integration from `reviews/sol-workflow-child-recovery.md`. It does not close W02, W03, or a release gate. `MmsProfilePlatform` was not edited; the coordinator injects the child-admission and deferred-settle hooks itself.

## Production behavior

`MmsWorkflowCoordinator` watches child runs as well as parents. After a deferred child driver releases its lease and `wakeParents` rewrites the parent cursor, `onDeferredDriverSettled` verifies the child's immutable `parentRunId` / `parentInstanceKey` against the parent's `childRuns` wait or attempt record, then resumes the parent with `deferExecution: true`. The engine still does not recursively drive the parent. Parent-owned internal `resumeInternal` of a child is unchanged and does not take this hook, so parent/child leases cannot invert.

Child timers are scheduled only when the parent does not already mirror that child's exact `wakeAt` on the linked wait. Mirrored parent timers keep the previous single-wakeup path. Lease conflicts reuse the coordinator's bounded re-read/retry (250 ms). Profile `dispose` cancels timers and subscriptions, then awaits in-flight scheduled nudges/wakes before `runtime.shutdown()`.

Recovery after process death watches non-terminal runs, resumes queued/running children only when their parent is not itself queued/running, and nudges a waiting parent once from a terminal child with the persisted linkage. Existing children are not re-admitted and effects are not replayed.

## Child admission

`WorkflowRunService.runSubworkflow` calls `prepareChildAdmission` immediately before the internal `start`. The default implementation is `inheritChildAdmission`: it copies only Skill/MCP pins declared by the child's pinned compiled graph from the parent's **persisted** `executionBindings`. It verifies the same profile, project, and thread, intersects `runPolicy.allowedCapabilities` with the child's compiled permissions, and does not resolve current MCP/Skill heads or credentials. Missing or duplicate pins fail closed.

Top-level `MmsWorkflowIntegrations.prepare` now walks transitive pinned child revisions (depth ≤ 8) and includes those Skill/MCP refs in the parent snapshot so the later child subset can be validated. Public run DTOs still reject caller-supplied `executionBindings`. Existing durable admission digests are unchanged; a new start pins the expanded snapshot, a repeated `requestId` replays the original record.

## Usage aggregation

Failed, cancelled, and succeeded children copy consumed token/cost/tool-call/artifact totals onto the parent exactly once via durable `subworkflowUsageCharged` on the parent instance. Unknown-effect children keep the recovery wait; their usage is copied when the child later fails or the parent is cancelled. Resume/retry of a terminal parent does not charge again.

## API

```ts
new WorkflowRunService({
  ...,
  prepareChildAdmission?: (request, parent, child) => Promise<{
    executionBindings: WorkflowExecutionBindings
    installationPolicy: ExecutionPolicyLayer
    runPolicy?: ExecutionPolicyLayer
  }>
  onDeferredDriverSettled?: (snapshot: WorkflowRunSnapshot) => void
})

inheritChildAdmission({ parent, child, request })
collectTransitiveWorkflowRecords(record, registry)
MmsWorkflowIntegrations.prepareChildAdmission(request, parent, child)
```

`MmsWorkflowCoordinator` always supplies both engine hooks. Optional `prepareChildAdmission` on coordinator options overrides the default inherit helper.

## Qualification

```text
npx vitest run tests/platformWorkflowCoordinator.test.ts tests/platformWorkflowSubworkflowRecovery.test.ts tests/platformWorkflowIntegrations.test.ts --maxWorkers=2 --minWorkers=1
3 files, 40 passed
  coordinator: parent->child deferred input/approval, timer reconstruction, parent cancel
  recovery: four process-kill cases plus failed/cancelled usage once and missing-pin fail-closed
  integrations: framed MMS local stdio MCP/Skill parent->child pin inheritance after current Skill head change; one MCP call; same requestId replay

npx vitest run tests/platformWorkflowDurabilityMatrix.test.ts tests/platformWorkflowRuntime.test.ts tests/platformWorkflowRunDomains.test.ts --maxWorkers=2 --minWorkers=1
3 files, 60 passed

npm run typecheck -- --pretty false
passed for node and web TypeScript projects

npm run build
passed for Electron main/preload/renderer and CLI
```

The build retained the existing mixed static/dynamic import warning for `daemonShutdown.ts` and the existing malformed `m-*/space-*` CSS comment warning.

No live provider, account, channel, or browser download was used. The Skill/MCP case uses the existing local stdio fixture.

## Remaining limits

- Concurrent child waits remain authoritative on the child run; the parent still mirrors only the selected wait.
- Child MCP nodes may not require a second approval when child `installationPolicy` does not copy parent `approvalEffects`; adapters still require the admitted pin, `mcp.invoke`, and `external`.
- Packaged cross-platform startup and browser/OOPIF child execution are outside this slice.
- Agent/tool/browser adapters, slash ingress, schedules/channels, and visible app/packaged acceptance remain separate work.
- `MmsProfilePlatform` still wires only `prepareExecution`; child admission is coordinator-injected rather than a new platform constructor argument.

Source: `MmsWorkflowCoordinator.ts`, `MmsWorkflowIntegrations.ts`, `childAdmission.ts`, `WorkflowRunService.ts`, `runStore.ts`. Tests: `platformWorkflowCoordinator.test.ts`, `platformWorkflowSubworkflowRecovery.test.ts`, `platformWorkflowIntegrations.test.ts`.
