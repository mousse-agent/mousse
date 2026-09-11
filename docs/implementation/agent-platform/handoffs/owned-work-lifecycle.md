# Owned work shutdown prerequisite

This checkpoint tracks actual promise settlement for native agents and orchestrator work. Requesting cancellation, clearing a session from the UI, or reaching a shutdown timeout does not release ownership. Profile archive/removal integration remains open.

## Changes

- `OwnedWorkBarrier` synchronously closes admission, broadcasts cancellation, and waits for tracked work with a bounded deadline. Timeouts preserve ownership for another wait.
- `MousseAgentService` tracks complete sends through final persistence and retains cancellation ownership even after session maps are cleared.
- `OrchestratorService` tracks ordinary, channel and scheduled turns, spawning, readiness checks and delayed bootstrap work. Shutdown stops queue/timer admission, cancels questions and turns, then awaits actual completion before final persistence.
- `UserQuestionService.shutdown()` rejects pending and future questions without inventing answers. Each profile retains its own question service.

## Verification

- `npx vitest run tests/platformOwnedWorkLifecycle.test.ts tests/mousseAgentDurableSessions.test.ts tests/questionPreemptSend.test.ts --maxWorkers=1 --testTimeout=15000`: 3 files, 25 tests passed.
- `npx vitest run tests/threadMessageQueue.test.ts --maxWorkers=1 --testTimeout=15000`: 39 tests passed. An earlier combined invocation hit the default five-second timeout in startup concurrency; the isolated run completed that case in 2.7 seconds.
- Both TypeScript projects passed before a final bookkeeping-only change to await settled readiness checks. `npm run build:cli` passed after that change.
- Fixtures use controlled local model responses and owned temporary files; no live provider or user account calls.

## Remaining integration

These APIs are not yet bound to `MmsProfileServices.stop()`. Profile host admission, pending RPCs, scheduler completion, channel delivery, external process trees, workflow runs and browser sessions must all participate before P04 can close. Process termination is being implemented separately. The new two-profile fixture proves orchestrator isolation and final-write ordering, not end-to-end archive safety.
