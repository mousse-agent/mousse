# Sol channel/control lifecycle review

## Reviewed revisions

- Candidate: `9268991a9161c2cd6cc9ef561dd7524eec75be16` (`feat(channels): await channel and control shutdown`).
- Core baseline merged for compatibility: `db72e2ab62ec21e8535c6aa669b9ac501172ee98`.
- Reviewed merge before fixes: `9299d02b504e0edf32e9c0373f144cc09fb10a8c`.
- Initial review fixes: `fe74082c92bc2467c01529ae9d4537a2bac7027f`.
- Follow-up ownership fixes: `005c0025bc962704647449823fc48657fe3245ec`.

The original checkout and `master` were not modified or pushed.

## Findings fixed

1. A hosted pairing registration could settle after `beginShutdown()` and let `PairingManager` recreate the pending pairing which shutdown had cancelled. The server-registration callback now rechecks synchronous admission before the manager commits the pending attempt. The regression holds a registration transport through shutdown and verifies that no pending pairing or timer state returns.
2. Discord interaction callbacks were fire-and-forget. A delayed `deferReply`/`deferUpdate` could repopulate reply state and invoke inbound routing after disconnect, and a late connect could become current after a reversible disconnect. Discord connections now use an epoch and exact-client fence; interaction promises are retained and awaited; post-await routing and error replies are suppressed after disconnect.
3. `ChannelService` did not publish a connecting adapter until connection completed. A concurrent reversible disconnect could therefore return while the connection later became live. Connecting adapters are now visible to disconnect and stale completion disconnects itself. Snapshots after permanent shutdown no longer rebuild the on-disk channel directory, preventing an admitted late connect from writing derived state during drain.
4. `RelayClient.stop()` cleared `ws` without retaining socket-close ownership. `getActiveCount()`/`waitForIdle()` now include sockets from close request through the actual close event. Every socket callback is bound to its exact socket, so an old close event cannot close or change the status of a replacement connection.
5. A `RemoteSessionDispatcher` permanently registered anonymous listeners through `MmsEventBus.onAny`. Closed/revoked sessions remained retained and processed every later profile event. `onAny` now returns an idempotent disposer and dispatcher close invokes it. Drained dispatchers also leave `MmsControlService.drainingDispatchers` after their actual RPC work settles.
6. Failed adapter disconnects were swallowed and removed from retry inventory. Shutdown now propagates the close failure, retains and counts the adapter, and retries it on the next shutdown call.
7. Executor and relay handlers were invoked before their ownership maps and AsyncLocalStorage identities were installed. Registration now precedes invocation for synchronous and post-await nested shutdown paths.
8. Noise sessions waiting for local pairing approval left approval listeners (and, for `SecureSession`, session key material) alive across rejection, expiry, replacement, stop, and shutdown. The control service now owns and closes those pending approval sessions and suppresses lifecycle status events after shutdown begins.

## Ownership assessment

`ChannelService`, `ChannelRouter`, and `MmsControlService` close admission synchronously and retain ignored-abort work after timeout. A timeout leaves ownership intact for a later retry. Ordinary channel disconnect/`stopAll()` and control `stop()` remain reversible; `shutdown()` remains permanent.

The recursive executor/relay exception in `MmsControlService.shutdown()` avoids self-deadlock but does not make the skipped caller disappear: `getActiveCount()` continues to include it. A profile drain is safe only when the root personal-RPC barrier closes admission before awaiting service shutdown and refuses completion while its calling RPC remains active. That root composition remains required.

## Verification

- `npx vitest run tests/platformChannelControlLifecycle.test.ts --maxWorkers=2 --testTimeout=15000`: 1 file, 19 tests passed.
- `npx vitest run tests/platformChannelControlLifecycle.test.ts tests/channels.test.ts tests/controlMmsIntegration.test.ts tests/controlDispatcher.test.ts tests/controlAuth.test.ts tests/platformOwnedWorkLifecycle.test.ts --maxWorkers=2 --testTimeout=15000`: 6 files, 72 tests passed.
- `npm run typecheck`: node and web TypeScript passed.
- `npm run build:cli`: passed.
- `git diff --check`: passed before the fix commit.

Fixtures use owned temporary homes, fake adapters/transports for deterministic ignored-abort and stale-callback faults, and actual loopback HTTP for webhook and enrollment shutdown. They use no live accounts, credentials, models, or channel services.

## Remaining limits

- Root must compose `beginShutdown()` and awaited `shutdown()` into profile disposal, and the personal protocol request barrier must remain authoritative around the self-shutdown exception.
- Discord `Client.destroy()` is invoked before adapter drain completes, but discord.js does not expose an acknowledgement that proves the gateway TCP socket is closed. Live Discord and Telegram gateway/API teardown remain unqualified.
- Relay ownership now waits for its WebSocket close event and stale sockets are fenced. The close-event race is covered deterministically; a real external relay/TCP teardown is not qualified.
- Remote `cancel` aborts the dispatcher's controller, but `RemoteMethodExecutionHandler.execute(method, params)` has no signal parameter. Long underlying handler work therefore remains owned and suppresses its response after close, but it is not cooperatively cancelled through this API.
- The work does not implement profile-host/MMS wiring, OS service lifecycle, or live channel authentication.

