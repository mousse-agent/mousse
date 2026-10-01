# Profile admission and scheduler drain composition

Profile archive/removal now closes host admission before awaiting teardown and waits for admitted personal RPCs, initialization, orchestrator work and scheduler finalization. A timed-out profile retains the same runtime and closed admission fence; retry waits for that work rather than creating another writer. This checkpoint is a partial P04 composition, not complete process or channel teardown.

## Production changes

- `dispatchMethod` tracks all personal handlers, including registered platform domains. Installation-scoped profile/provider commands are outside the personal barrier so archive cannot wait on itself. Draining errors retain a structured protocol code.
- `MmsProfileServices` closes request/orchestrator/scheduler admission synchronously. It owns profile startup, awaits actual requests/turns/ticks, closes MCP after those users settle, and retains the pending stop operation across caller deadlines.
- `ProfileHost` gates new and already-awaiting service lookups while archive/removal drains. Composing services are awaited and stopped even before entering the live map. Concurrent lifecycle mutations are rejected. A metadata conflict after successful drain restores a fresh active runtime. A failed drain preserves the old one.
- Removal rechecks owned-root containment and filesystem identity after draining. Existing journal/rollback logic remains responsible for the move into installation trash.
- Installation stop retains its actual owner lease and shared providers until personal teardown succeeds. Failed platform disposers are retained for retry; repeated disposal cannot return early while the first call is pending.
- Scheduler permanent shutdown is distinct from temporarily stopping its timer. It awaits the whole tick through durable claim finalization and lock release, suppresses late output, and records exact-token interruption for the running and already-claimed queued jobs. Interruptions do not spend repeat counts or silently complete one-shot jobs.

## Evidence

- Combined `platformProfileDrain`, `platformProfileRuntime`, `scheduledJobs`, `platformOwnedWorkLifecycle`, and `platformProductionComposition`: 5 files / 44 tests passed before two additional fault cases.
- Final `npx vitest run tests/platformProfileDrain.test.ts --maxWorkers=1 --testTimeout=15000`: 7/7 passed, including real framed-MMS final-write-before-move, timeout/retry, composing-runtime race, archive revision conflict recovery and a real installation lease retained across disposer failure.
- Initial combined run exposed a generic `handler_error` where `profile_draining` was required. Production error mapping was fixed; the test expectation was preserved.
- Both TypeScript projects passed. CLI build result is recorded in the checkpoint ledger after completion.
- Controlled local model responses and owned temporary files only. No live accounts, channels or providers.

## Required remaining work

`finishStop()` still uses the old channel/control stop APIs and does not yet await PTY/headless process trees. Grok channel/control lifecycle and reviewed process lifecycle APIs must be bound here before full profile deletion safety can be claimed. MCP shutdown audit also found raw connect/OAuth promises and SDK stdio descendants can outlive the current manager close; a separate worker owns that fix. Browser/agent-definition production owners must join this barrier when composed. Full profile activity inventory, cancellation UI and packaged acceptance remain open. These limits are not waived by the seven passing fixtures.
