# Resource lifecycle Phase 1 qualification

I record the implemented Phase 1 contract and observed acceptance evidence here. Current-head Windows full-suite results, Linux CI results, exact counts and remaining gates are recorded on [PR #3](https://github.com/mousse-agent/mousse/pull/3) and [issue #2](https://github.com/mousse-agent/mousse/issues/2). This document does not authorize merging or later phases.

I qualified durable profile/task ownership, inventory and retention claims, stable generation admission, reversible trash/restore and interrupted move recovery with the focused checks below. Permanent purge remains unavailable. I have not enabled expiry, checkout retirement, ref release, physical cleanup, named recall or new workspace/access defaults.

## Independent acceptance

I exercise authenticated MMS sockets and the real profile composition against isolated temporary directories. I stub provider catalog initialization in those tests to avoid unrelated network discovery. The parent-turn test controls only the model response seam; task execution, persistence, admission and lifecycle operations remain real.

| Gate | Acceptance evidence | Current result |
| --- | --- | --- |
| Both deletion aliases preserve all payload bytes and restore identity | `resourceLifecycleAcceptanceProtocol.test.ts` | Focused integrated check passes. |
| Live physical leases, parent turns, terminal processes and workflow approvals prevent trash | Same file | Focused integrated checks pass. |
| Rejected deletion leaves admitted work able to finish/persist; restored task accepts a fresh turn | Same file | Focused integrated check passes. |
| Profile isolation | Same file | Focused integrated check passes. |
| Queued old-path acquisition, including restore to the same path | `resourceLifecycleAcceptanceAdmission.test.ts` | Focused integrated checks pass; retry timer held until both moves finish. |
| Cached queue/data callbacks cannot recreate trashed data | Same file | Focused integrated check passes. |
| Corrupt/future authority fails closed before metadata mutation | `resourceLifecycleAcceptanceCorruption.test.ts` | Focused integrated checks pass. |
| Concurrent restore/purge leaves one complete task | Same file | Focused integrated check passes. |
| Failed inventory and actual filesystem rename preserve pending user input | Corruption file and `resourceLifecycleAcceptanceRenameFailure.test.ts` | Focused integrated checks pass. |
| Retry the failed rename without restarting or supplying an operation ID; retain cancelled-input audit | Rename failure file | Focused integrated check passes. |
| Discover and restore valid legacy Trash; report malformed migration and preserve bytes | `resourceLifecycleAcceptanceMigration.test.ts`, existing `threadStorageMigration.test.ts` | Four focused upgrade tests pass. |
| Actual daemon crash after each trash/restore rename | `resourceLifecycleAcceptanceDaemon.test.ts` | Built daemon passes both forced SIGKILL boundaries and three-launch recovery smoke. |
| Shared/isolated child, generated workflow invocation and external resources inventory | `resourceLifecycleAcceptanceInventory.test.ts` through `threads.inventory` | Browser, legacy unknown, workflow/native resource closure and retained refs/bytes pass focused checks. |
| Parent trash/restore preserves an independently trashed child's own state | Same file | Focused integrated check passes, including later independent child restore. |
| Visible reorder and legacy order normalization retain hidden child index entries | `resourceLifecycleStoreProjection.test.ts` | I reviewed the fix and both public-protocol regressions; core reported six passing projection/inventory cases. Current-head suite evidence is on PR #3. |
| Duplicate/stale operation identity and generation | Same file | Focused integrated check passes. |

For the daemon crash test, I use a test-only Node preload to call the real filesystem rename and immediately kill the daemon before mapping/index publication. I verify the fault marker, restart the built CLI daemon, and check preserved bytes, blocked purge, external state and fresh metadata writes. This test does not add production failpoints. Network catalog fetch is denied by that fixture; no paid model call is part of qualification.

## Frozen contract and limitations

The lifecycle gate belongs outside movable thread directories. Admission precedes task/episode ownership, then a short repository mutation lease. A drain must not hold the locks its completion paths need. No ownership handoff is safe until descendants and callbacks are confirmed stopped; a conservative visible busy result is acceptable in Phase 1 if it leaves existing admitted work able to finish.

Later delegation retains one physical task lease with scoped logical descendant authority. Later context publication requires one context-writing episode, expected generation and idempotency identity; cancelled or stale completion cannot overwrite newer context. These contracts are specified now, not implemented as new Phase 2 behavior.

The irreversible boundary is a durable external `purge_started` record, written before any irreversible removal. Restore/cancel are unavailable after that point. Phase 1 never reaches this boundary and never treats inventory alone as cleanup authorization.

Previously shipped binaries cannot be forced to honor a marker they were never written to read. Supported daemon/protocol and current filesystem producer paths must reject incompatible authority before task writes; any old direct-filesystem writer limitation remains explicit. Windows qualification alone does not prove Linux symlink behavior.

I reviewed the ingress changes at these shared boundaries. Protocol dispatch validates managed task admission before task-scoped handlers. Execution-lease acquisition, queue/data locks and atomic persistence use the external gate. Queued acquisition, journal and generation handles retain the admission generation so a move-and-restore cannot revive them. Orchestrator sessions and workflow admission validate the task; generated workflow execution threads retain parent ownership. Profile runtime/request checks conservatively reject trash while unattributed work is active. Direct store trash/restore/purge methods refuse mutation outside the coordinator. The focused tests exercise these boundaries and representative real callers; they do not claim a separate end-to-end test for every provider or external adapter.

## Validation record

I ran the first two focused files with two workers: 10 tests, 1 passed and 9 failed against the pre-integration source. After integration and fixes, the complete independent source acceptance passed all 24 tests across six files in 48.43 seconds with two workers. This includes the independently trashed child regression, public legacy upgrade discovery and diagnostics, failed-rename retry, inventory and generation behavior. A separate legacy-upgrade check passed four tests across two files in 9.72 seconds, including the existing storage-migration regressions.

After root froze source candidate `73ff399`, I ran `npm run typecheck` and `npm run build`; both passed. The actual built CLI daemon crash test passed in 9.49 seconds. It killed the daemon after both real rename boundaries, restarted three times, verified exact payload preservation and blocked purge, confirmed the recovered mapping/generation and absence of movable locks, and accepted a fresh metadata write. This candidate includes the reviewed hidden-child index-projection fix and its public-protocol regressions. I keep subsequent full-suite and platform results on [PR #3](https://github.com/mousse-agent/mousse/pull/3), tied to the checked source revision.

I used these exact commands for the observed source, upgrade, typecheck, build and daemon checks. The final command is the required full-suite invocation; its outcome belongs to the revision-specific PR evidence.

```text
npx vitest run tests/resourceLifecycleAcceptanceProtocol.test.ts tests/resourceLifecycleAcceptanceAdmission.test.ts tests/resourceLifecycleAcceptanceCorruption.test.ts tests/resourceLifecycleAcceptanceInventory.test.ts tests/resourceLifecycleAcceptanceRenameFailure.test.ts tests/resourceLifecycleAcceptanceMigration.test.ts --maxWorkers=2
npx vitest run tests/resourceLifecycleAcceptanceMigration.test.ts tests/threadStorageMigration.test.ts --maxWorkers=2
npm run typecheck
npm run build
npx vitest run tests/resourceLifecycleAcceptanceDaemon.test.ts --maxWorkers=2
npm test -- --maxWorkers=2
```

No acceptance tests are disabled and no global timeout was raised. The native/workflow acceptance has a scoped 30-second budget for real temporary Git worktrees and a deterministic model seam. Its disposable Git repository enables `core.longpaths` for Windows revision-range path probes; this does not qualify default Windows path settings or modify the application repository. The application smoke exercised the built daemon and authenticated protocol on Windows, not a rendered Electron/browser interface. `MOUSSE_FOUNDATION_BROWSER_BIN` was unset for this qualification; the separate rendered Undo/Redo test is opt-in and its skip is not a UI pass. I made no live-provider or paid calls.
