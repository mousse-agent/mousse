# Sol review: profile drain composition

Reviewed candidate: `61857a1e2e71ac896c2168be9e89d75efdce5586`

Qualified implementation freeze: `f4e63d3b16bf44a1ec54448f908c958e38c65d01`

Disposition: accepted after the fixes below for the profile/RPC/orchestrator/workflow/scheduler drain slice. This remains a prerequisite checkpoint and does not close P04.

## Findings fixed

1. `ProfileHost.stopAll()` waited service drains but did not own an archive/remove operation that had already passed admission and was executing its metadata/filesystem action or rollback. Installation shutdown could therefore release its owner lease while that operation still wrote profile state. The host now retains each complete lifecycle-operation promise, rejects competing lifecycle mutations, and installation shutdown awaits already-admitted operations instead of draining the same profile concurrently. A delayed action fixture proves the lease remains held until its final write settles.
2. Scheduler interruption persistence errors were swallowed by the tick wrapper. Shutdown could report success after a due batch was claimed while one or more durable jobs still held this process's running claim. The scheduler now retains the exact job/token pairs it claimed, retries their interruption after the tick releases its lock, and rejects shutdown without discarding ownership when persistence still fails. Fault injection proves a failed first shutdown leaves the exact claim intact and a later retry records `interrupted` without spending a repeat or appending late output.
3. Nested drain deadlines were folded into `AggregateError`, which could surface through framed MMS as generic `handler_error`. `MmsProfileServices.stop()` now recognizes nested `profile_busy` failures and preserves the structured code and current activity details. The production test preserves that error across a failed nested disposer and then completes a retry.

## Composition assessment

Personal `dispatchMethod` calls enter the profile request barrier after binding resolution. The host gate checks both before and after an awaited cached/composing runtime, so a caller waiting on composition cannot acquire the service after drain begins. Installation/profile lifecycle methods stay outside the personal barrier and therefore cannot wait on their own archive/remove request.

`beginShutdown()` closes request, orchestrator, and scheduler admission synchronously. A failed or timed-out drain retains the original service promise, live service, closed admission fence, profile root, and installation lease. A successful drain removes that runtime from the cache. If a metadata compare-and-set loses after a successful drain, an active profile is composed again from current metadata; the stopped instance remains fenced.

Workflow platform disposal closes coordinator admission before awaiting queued admissions, recovery, subscriptions, wake timers, and runtime shutdown. Successful disposers are removed individually while failed disposers remain for retry. Scheduler shutdown owns the entire tick through claim completion/interruption and lock release. It suppresses post-shutdown thread output and uses exact claim tokens, so a stale owner cannot overwrite a replacement.

Removal rechecks canonical containment plus root device/inode identity after drain and before archive/journal/move. Existing pending-marker recovery and rollback remain responsible for transactional index/root recovery. Concurrent archive/remove calls for one profile fail with structured `profile_busy`; installation stop now waits an operation admitted first.

## Evidence

- `npx vitest run tests/platformProfileDrain.test.ts tests/platformProfileRuntime.test.ts tests/scheduledJobs.test.ts tests/platformOwnedWorkLifecycle.test.ts tests/platformProductionComposition.test.ts --maxWorkers=1 --testTimeout=15000` — 5 files, 48 tests passed.
- Final `npx vitest run tests/platformProfileDrain.test.ts --maxWorkers=1 --testTimeout=15000` — 10 tests passed.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — CLI bundle passed.

The added fixtures use local deferred work, injected scheduler persistence failure, real temporary profile roots, a real installation owner lease, framed local MMS, and mocked model responses. No live account, model, channel, browser, credential, or external server was used.

## Remaining guarantees

MCP teardown remains unsafe until its separate owner closes admission, retains raw connect/request/OAuth promises past timeout wrappers, and proves stdio process-tree death before releasing ownership. The current SDK transport close can return after sending a direct-child kill without observing final close or descendants.

Channel and control ingress need their reviewed `beginShutdown`/activity/awaited-shutdown APIs bound into `MmsProfileServices`. PTY and headless process lifecycle must prove exact owned-tree exit and handle close. Browser sessions and any Agent Editor execution owner must join the same host barrier. Root integration owns these bindings.

`previewRemove()` still exposes only ordinary active-turn count plus configured schedules/channels; it is not the complete composed activity inventory. Removal currently refuses a profile with an ordinary active turn before entering cancellation, while archive enters the drain path. UI cancellation/force semantics and packaged acceptance remain open.

The service persistence callbacks used by orchestrator shutdown are synchronous. Any future asynchronous profile-store flush must be an explicit awaited owner. Future `MmsProfilePlatform` disposers must close their own admission synchronously before yielding, because platform disposal and admitted personal-request settlement are intentionally initiated together to deliver cancellation without allowing a new operation.
