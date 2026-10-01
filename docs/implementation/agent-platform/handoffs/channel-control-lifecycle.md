# Channel and control awaited shutdown

This checkpoint adds a permanent, awaited shutdown path for one profile's channel and Plus/control work. Ordinary disconnect/stop UI behavior stays reversible. Profile archive/removal integration remains root work; this does not close P04.

## APIs

`ChannelService` and `MmsControlService` now expose:

- `beginShutdown(): void` — synchronous. Closes admission, cancels in-flight turns/connect/login/pairing/relay, and starts adapter/session teardown. Idempotent. Distinct from `stopAll()` / `stop()` / `disconnect()`.
- `getActiveCount(): number` — currently owned promises (connect/inbound/login/pairing/executor/relay handling/dispatcher RPCs/adapter drains). Clearing a map is not treated as completion.
- `shutdown(options?: { timeoutMs?: number }): Promise<void>` — default `timeoutMs` 30_000. Concurrent callers share the same shutdown and wait independently. A timeout rejects `{ code: 'profile_busy' }`, leaves the service stopped, and keeps retryable ownership until the work actually settles.

`ChannelRouter` has the same trio so inbound, slash, queued turns, typing, and `sendTest` stay owned through final send suppression. `RemoteSessionDispatcher` exposes `getActiveCount()` / `waitForIdle()` and skips the current RPC when that RPC calls shutdown. `RelayClient.getActiveCount()` / `waitForIdle()` track admission and lease promises.

Adapters accept `connect(signal?: AbortSignal)`. Webhook disconnect waits for in-flight local HTTP. Telegram disconnect aborts polls and awaits the poll loop.

## Behavior

Late inbound, connect, `sendTest`, login, pairing, config mutation, and new executor work reject with `profile_draining` after `beginShutdown()`. Active router turns are aborted and generation-bumped so queued same-session work is suppressed without a send. In-flight connect/login/executor promises stay owned until they settle, even when a fixture ignores abort. Timeout is fail-closed.

`MmsControlService.shutdown()` skips the calling executor and relay-handling promise so a forwarded RPC cannot deadlock against its own shutdown. Root should still wrap personal `dispatchMethod` requests in `OwnedWorkBarrier` and call `beginShutdown()` synchronously before the first await, without waiting those RPCs on themselves.

## Verification

- `npx vitest run tests/platformChannelControlLifecycle.test.ts --maxWorkers=1 --testTimeout=15000`: 1 file, 11 tests passed.
- `npx vitest run tests/channels.test.ts tests/controlMmsIntegration.test.ts tests/controlDispatcher.test.ts tests/controlAuth.test.ts tests/platformOwnedWorkLifecycle.test.ts --maxWorkers=1 --testTimeout=15000`: 5 files, 51 tests passed.
- `npx tsc --noEmit -p tsconfig.node.json` then `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npm run build:cli` passed.

Fixtures use actual `ChannelRouter` / `ChannelService` / `MmsControlService`, a controlled local adapter/runner, a hanging executor, `RemoteSessionDispatcher`, mocked fetch that ignores abort, and owned loopback HTTP (webhook + enrollment). No live channel, Plus account, provider, or credentials.

Covered: ignored-abort wait after cancel, no post-drain send/credential write, queued inbound suppression, cross-profile isolation, timeout then retry, simultaneous shutdown callers, reversible `stopAll`/`stop` vs permanent `shutdown`, late relay frames ignored, dispatcher send suppressed after close.

## Remaining integration

Root still needs to call `channels.beginShutdown()` / `control.beginShutdown()` from profile disposal before the first await, wait `shutdown({ timeoutMs })`, surface `getActiveCount()` to `ProfileHost.previewRemove`, and wrap personal dispatch methods in the existing `OwnedWorkBarrier`. Do not use `stopAll()` / `control.stop()` as the archive/remove path.

Out of scope here: orchestrator/native-agent binding (already a separate prerequisite), scheduler, protocol RPC admission, process trees, workflows, browser, MMS/ProfileHost wiring, live Telegram/Discord/Plus servers, and OS/TCP completion of Discord gateway or relay sockets. `RelayClient.waitForIdle()` waits tracked admission/lease promises; it does not claim kernel socket close from clearing `ws`.
