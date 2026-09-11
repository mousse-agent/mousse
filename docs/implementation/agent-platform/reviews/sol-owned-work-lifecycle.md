# Sol review: owned-work lifecycle prerequisite

Reviewed candidate: `58a8e8f266c48025a224faf365f3865ae72855ff`

Qualified implementation freeze: `38f34204b912579c94f87b63cc790a5bff8a48bb`

Disposition: accepted after the fixes below as the orchestrator/native-agent prerequisite API. This does not close P04 or prove the profile host removal sequence.

## Findings fixed

1. An in-flight native-agent send retained only the agent id for final cleanup. If `clearSessions()` followed by `restoreSessions()` installed a replacement with the same id and started a new turn, the old turn's `finally` block marked the replacement idle. Cleanup now requires object identity, so an old promise cannot mutate or persist a replacement session. A restart-style fixture holds both sends concurrently and proves the replacement stays running until its own cancellation settles.
2. Native-agent starts and retries deliberately launch sends in the background, but their promises were unobserved. A synchronous persistence failure before the original `try` also skipped session cleanup, leaving a running presentation state after lifecycle ownership had released. Setup and first persistence now participate in the send's `try/finally`, and background launches observe rejection through `background-send-failed`. Fault injection proves the session becomes failed/idle, ownership reaches zero, and shutdown completes without an unhandled rejection.
3. `retryLastConnection()` could report successful admission after shutdown began, and its detached turn promise had no rejection handler. It now rejects admission with `false` once the lifecycle is stopping and reports later turn rejection through the existing `queue-drain-failed` event.

## Lifecycle assessment

`OwnedWorkBarrier` closes admission synchronously, retains work after a caller timeout, supports independent waiters, and releases ownership only from promise settlement. Orchestrator ordinary sends, queue turns, channel turns, scheduled turns, spawning, readiness inspection, and bootstrap execution enter this barrier. Native-agent sends have their own barrier and a lifecycle abort listener that remains effective after presentation sessions are cleared.

Shutdown clears wake/startup queue admission, stops progress monitors, aborts active ordinary/channel/native-agent turns, rejects profile-owned pending questions, and awaits both barriers before the final synchronous persistence callbacks. A timed-out wait retains the active labels for a later shutdown attempt. The question service rejects future requests after stop and independent injected question services remain isolated.

Startup queue recovery checks the stop state before scheduling, before recovery, and before pumping; claimed turns enter the barrier. Deferred bootstrap and readiness-correction callbacks check the stop state before touching their captured session, and any execution they start is barrier-owned. Readiness validation itself is barrier-owned through its Git inspection, bounded grace loop, bookkeeping, and correction decision.

## Evidence

- `npx vitest run tests/platformOwnedWorkLifecycle.test.ts tests/mousseAgentDurableSessions.test.ts tests/questionPreemptSend.test.ts --maxWorkers=1 --testTimeout=15000` — 3 files, 27 tests passed.
- `npx vitest run tests/threadMessageQueue.test.ts --maxWorkers=1 --testTimeout=15000` — 1 file, 39 tests passed, including bounded multi-thread startup drain and durable claim recovery.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — CLI bundle passed.

Fixtures use local deferred promises, temporary profile homes, injected persistence failures, and mocked model responses. No live model, account, channel, credential, or external server was used.

## Remaining host seams

Root integration must bind this prerequisite to the profile host sequence. Profile ingress, scheduler/channel callbacks, workflow ownership, browser ownership, external agents, PTYs/process trees, and final profile-service persistence must all stop admission, cancel, and settle before archive/removal can proceed. `previewRemove` also needs the composed counts and must preserve the profile when any owner times out. Those integrations are outside this review.

The 2-second interactive bootstrap timer and zero-delay readiness-correction timer are guarded no-ops after shutdown rather than retained timer handles that shutdown clears. They cannot admit work after the barrier closes, but a pending bootstrap timer may keep the process event loop alive briefly. The readiness grace sleeps are bounded but do not wake immediately on lifecycle cancellation, so a short shutdown timeout can correctly return `profile_busy` until inspection settles.

Persistence callbacks in these prerequisite services are synchronous by contract. This review proves that their thrown errors retain cleanup and are observed; it does not add an asynchronous flush contract. Root lifecycle composition must await whichever host/store layer owns asynchronous durable writes.
