# Sol review — child workflow recovery

Date: 2026-09-11

## Reviewed revisions

- Candidate: `e6100414cc55dac3f02d57aca13587705b9ad658`
- Reviewed implementation freeze: `fb2e1aae45ab4176f6c98d3dc37bcaf652585abd`

The candidate worktree was clean at the candidate SHA before review. The review changed only the workflow engine checkpoint/runtime implementation, run projection, and the focused child-recovery test. It did not change root composition, adapters, MMS platform wiring, preload/protocol aggregates, the Orb, or another worktree.

## Findings fixed

- Deferred child approval/input execution returned a `running` snapshot and the scheduled driver never refreshed the parent after it settled. Scheduled and blocking child resumes now refresh the durable parent cursor after releasing the child lease; internal parent-owned child resumes bypass the callback to avoid parent/child lease inversion.
- Parent wake refresh trusted any wait carrying the child ID. It now requires the child manifest's exact `parentRunId` and `parentInstanceKey` to match the parent and wait instance before mutation.
- A child with concurrent unlike waits projected the lexicographically first wait even when it did not match the child's aggregate state. Parent propagation now selects a wait with the same state, retaining the actionable approval/input/timer identity.
- Every return from a child wait charged the parent subworkflow boundary again. The instance checkpoint now durably records that this boundary consumed its tool-call slot once. Input, approval, and timer recovery assert stable parent usage.
- Parent unknown-child recovery appeared only as a condition. The run DTO now also exposes an `unknownEffect` linked to the child, so the public reconciliation path can direct the caller to the authoritative child run.
- A subworkflow node without an inline revision resolved the latest published child head at dispatch. It now requires either an inline immutable revision or a matching pinned parent dependency; mismatches fail closed. A fixture publishes a newer child head before execution and proves that the pinned revision is launched. Child capabilities are narrowed by both the inherited parent policy and the pinned child's declared permissions.

## Qualification

```text
npx vitest run tests/platformWorkflowSubworkflowRecovery.test.ts --maxWorkers=2 --minWorkers=1
12 passed, including four real process kill/restart cases

npx vitest run <all tests/platformWorkflow*.test.ts from rg --files> --maxWorkers=2 --minWorkers=1
16 files, 146 passed

npm run typecheck -- --pretty false
passed for node and web TypeScript projects

npm run build
passed for Electron main/preload/renderer and CLI
```

The build retained the existing mixed static/dynamic import warning for `daemonShutdown.ts` and the existing malformed `m-*/space-*` CSS comment warning. No live account, model, channel, push, or deployment was used.

## Required root integration

The engine's parent refresh is a durable cursor mutation, not a production scheduling loop. `MmsWorkflowCoordinator.scheduleWake` currently ignores every run with `parentRunId`, and its parent subscription is not notified when `wakeParents` rewrites the parent checkpoint. A top-level parent already mirrors the currently selected child timer and can wake that timer through its own `tick`, but approval/input/reconciliation can leave the refreshed parent ready with no timer and no automatic resume. Production control completion must therefore follow the child's verified `parentRunId`, re-read both manifests/checkpoints, verify `parentInstanceKey` against the parent's `childRuns`/wait record, then call parent `resume(..., { deferExecution: true })`. Coordinator recovery must also watch child runs and reschedule child deadlines when no valid mirrored parent deadline exists. Lease conflicts should use the coordinator's existing bounded re-read/retry path. This hook must run after the deferred child driver settles, rather than from its initial `running` control response.

Root's new `executionBindings` snapshot also needs an explicit child-admission path. `runSubworkflow` currently calls `WorkflowRunService.start` directly, so a child does not pass through the coordinator's top-level Skill/MCP binding snapshot. The composition hook should prepare child admission from the pinned child revision plus the parent's persisted binding snapshot, select only binding IDs/revisions declared by that child, verify the same profile/project ownership, intersect child permissions with the inherited parent policy, and persist the resulting child snapshot during admission. It must not resolve current integration heads or credentials during recovery. A practical seam is an injected `prepareChildAdmission` callback used immediately before the internal `start`, returning the additive child request fields and failing closed when a pinned binding is absent.

## Reviewed limitations

- The runtime still relies on root coordination to drive a ready parent after child control completion and to cover child deadlines that are not mirrored on the parent. The engine does not recursively schedule the parent.
- Skill/MCP execution bindings are not yet inherited by internal child admission. Until the root hook above is wired, children using those production adapters fail closed.
- Parent manifests aggregate a successful child's token, cost, tool-call, and artifact-byte usage. Failed, cancelled, and unknown children enforce the inherited remaining limits inside the child but do not copy their consumed usage into the terminal parent display totals.
- Only the selected child wait is mirrored into the parent. All concurrent waits remain authoritative and actionable on the child run; root/UI navigation must open that child rather than treating the parent projection as the complete child wait inventory.
- The real subprocess fixture qualifies the bundled Node runtime on this Windows host. Packaged cross-platform startup and browser/OOPIF child execution remain outside this review.

The worktree was clean after the implementation freeze commit; the review record is committed separately after that freeze.
