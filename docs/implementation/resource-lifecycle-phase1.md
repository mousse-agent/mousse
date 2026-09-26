# Resource lifecycle Phase 1 qualification

Status: implementation and independent qualification in progress. I have not declared the Phase 1 gates complete. This document records only Phase 1 evidence; it does not authorize merging or later phases.

I am qualifying durable profile/task ownership, inventory and retention claims, stable generation admission, reversible trash/restore and interrupted move recovery. Permanent purge remains unavailable. I am not enabling expiry, checkout retirement, ref release, physical cleanup, named recall or new workspace/access defaults.

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
| Actual daemon crash after each trash/restore rename | `resourceLifecycleAcceptanceDaemon.test.ts` | Drafted; requires the frozen build. |
| Shared/isolated child, generated workflow invocation and external resources inventory | `resourceLifecycleAcceptanceInventory.test.ts` through `threads.inventory` | Browser, legacy unknown, workflow/native resource closure and retained refs/bytes pass focused checks. |
| Parent trash/restore preserves an independently trashed child's own state | Same file | Focused integrated check passes, including later independent child restore. |
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

These are intermediate source checks, not a passing release gate. I have not run a build, typecheck, full suite or actual built application smoke; the root has reserved those until implementation freeze. No tests are disabled and no global timeout was raised. The native/workflow acceptance has a scoped 30-second budget for real temporary Git worktrees and a deterministic model seam. Its disposable Git repository enables `core.longpaths` for Windows revision-range path probes; this does not qualify default Windows path settings or modify the application repository.
