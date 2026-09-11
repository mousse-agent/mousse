# Handoff: managed Chromium owner-graph drain

Package: managed browser lifecycle (not G5, not full platform)
Branch / worktree: `feat/platform-canvas` / `C:/Users/bubbl/Documents/Projects/RYSPA/mousse-platform-worktrees/agents`
Base SHA: `e9b60c1` (`merge: refresh managed browser lifecycle base` from `d7c0c38`)
Implementation: `feat(browser): close managed Chromium owner lifecycle gaps` (this commit)

App/CLI composition, MMS/platform/protocol, shared browser contracts, BrowserSessionManager/router, existing CLI/terminal process helpers, deps/build config, and the Liquid Glass Orb were not modified. Root still wires the browser bridge, UI, model adapters, and drain composition.

## Behavior delivered

The managed Chromium owner now has an explicit admission/state/shared-close lifecycle. Profile shutdown cannot drop in-flight raw work, release a live workspace lock, or return while owned Chrome/file writers may still be running.

Public APIs on `BrowserBroker`:

| Method | Sync/async | Meaning |
|---|---|---|
| `beginShutdown(): void` | synchronous | Close admission; send cancel to admitted callers. Idempotent after `shutting-down` / `stopped`. |
| `getActiveCount(): number` | synchronous | Raw pending + live worker/host + disconnect cleanup. Caller timeout/cancel does not clear this. |
| `shutdown({ timeoutMs? }?): Promise<void>` | awaited | Calls `beginShutdown` if needed. Concurrent callers share one in-flight promise. Completed shutdown is idempotent. |
| `close(): Promise<void>` | awaited | Compatibility alias for `shutdown()`. |

Default `timeoutMs` is `DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS` (15_000). Timeout throws `BrowserBrokerShutdownError` (`code: 'shutdown_timeout'`) with `remaining` and **retains ownership**. `start()` / `call()` after shutdown throw `BrowserBrokerAdmissionError` (`code: 'admission_closed'`). Failed start is still retryable; permanent shutdown is not.

### Exact APIs root must call

```ts
import {
  BrowserBroker,
  DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS,
  BrowserBrokerAdmissionError,
  BrowserBrokerShutdownError
} from '../mms/browser'

broker.beginShutdown()
await broker.shutdown({ timeoutMs: DEFAULT_BROWSER_BROKER_SHUTDOWN_TIMEOUT_MS })
if (broker.getActiveCount() !== 0) {
  throw new Error('managed browser worker still owned after shutdown')
}
```

Catch `BrowserBrokerShutdownError` and do not move profile files. A later `shutdown()` retries the same owned set. Do not construct a new broker to "clear" a timed-out one.

`BrowserBackendRouter`'s `OwnedWorkBarrier` is not sufficient: it tracks `call()` promises. Caller timeout/cancel may settle `call()` while raw worker ownership remains. Root must also `beginShutdown` + `await shutdown()` on the managed broker.

## Raw vs caller ownership

Timeouts and abort send `cancel` and settle the **caller** promise. The **raw** pending entry stays until the worker ack/result or proven owned-process death. Dispatched `act` results keep `unknown-effect` and are never replayed. Duplicate request ids are not overwritten.

CDP `CdpConnection.send` does not enqueue a command that is already cancelled at admission. Wrapper abort after dispatch is not treated as Chrome completion (pending stays until Chrome responds or the pipe disconnects).

## Session / worker host

- `Session.start` takes a signal and checks it during launch, not only after full start.
- `tabs.new` enables before insert; late/failed tab start compensates with `Target.closeTarget`.
- OOPIF `enableFrame` work is tracked and awaited on close; target callbacks gate on `closing`/`closed`.
- `ManagedSession.close` joins in-flight close. Failed `stop` retains the workspace lock and owner lease. Retry can finish. No untracked 30s ephemeral timer: user-data is removed only after proven Chrome exit.
- `SessionManager.closeAll` includes opening sessions, refuses late insert, and compensates a late open with awaited close.
- Worker host tracks frame handlers, rejects re-init replacement, drops duplicate ids without replacing the first, aborts admitted handlers, `closeAll`, then one `shutdown_ok`. Stdin end awaits handlers.

## Process ownership

Windows `taskkill /PID <pid> /T` (and `/F` when forced) is awaited. The launched `ChildProcess` handle is captured before parent death. The parent is not `TerminateProcess`'d before `/T`. `taskkill` exit 128 (gone) is success if the PID is dead. Numeric PIDs are not retargeted after the launched parent handle has exited.

This worktree does **not** import `src/mms/terminals/processLifecycle.ts` (not assumed Electron-free). Design principles were reused in `src/browser-worker/lifecycle/ownedTree.ts`.

Job Object containment was not added (no dependency changes; Node spawn cannot create a job without a native helper). The same honest limit as the reviewed terminal helper applies: a hostile detached grandchild after the parent handle naturally exits cannot be recovered. Failed stop keeps the lock so another writer cannot start.

Never kill by process name. Never target the user's Chrome profile.

## Evidence

Certified Chrome for Testing was reused from `.mousse-dev/browser-binaries` via hard links into owned temp dirs. No browser download. Fixtures are localhost + bounded assets under `tests/fixtures/agent-platform/managed-browser-drain/**`. Cleanup is exact owned temp paths with Windows containment/reparse checks.

| Command | Result |
|---|---|
| `npx vitest run tests/platformManagedBrowserDrain.test.ts tests/platformBrowserWorker.framing.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.observation.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=180000 --hookTimeout=120000` | 5 files, **45 passed**. Includes real managed Chromium: owned Chrome pid/tree close, held act timeout preserves one POST, close vs held open/tab.new, injected stop-fail retains lock + retry, partial-frame worker replacement, deferred OOPIF enable drain, existing lifecycle/actions/observation regressions. The tautological wait-cancel assertion is now cancelled-code + post-cancel observe proof. |
| `npx tsc --noEmit -p tsconfig.node.json` | Passed |
| `npx tsc --noEmit -p tsconfig.web.json` | Passed |
| `npm run build:cli` | Passed after tests/typecheck; CLI-spawning tests were not run during the build. |
| `npx vitest run tests/platformWorkflowCli.test.ts` (after CLI build) | 10 tests passed. The two `out/cli` cases first failed when the harness `FORCE_COLOR` made Node print a `NO_COLOR` warning on stderr; they passed with `FORCE_COLOR` unset / `NO_COLOR=1`. That is harness env, not this owner-graph change. |

## Honest limitations / remaining composition

- This worktree ran on **Windows**. Linux `/proc` and Darwin `pgrep -P` descendant walks are implemented and **unexecuted** here.
- No Windows Job Object. Detached grandchild after parent-handle exit is reported (`DETACHED_GRANDCHILD_LIMIT`) and fails closed; the lock is retained.
- macOS/other POSIX without `/proc` fail closed for descendant inventory if capture is requested. Stop of the recorded parent still uses SIGTERM/SIGKILL of that PID only (never `kill(-pid)`).
- `getActiveCount()` counts broker/worker/raw ownership, not every Chrome grandchild PID. Chrome death is proven on session `stop` via the launched handle + awaited `taskkill /T`.
- Headless Chrome for Testing may expose only the browser PID to a parent walk; tests still require that recorded PID to die.
- Root must bind `beginShutdown` + `await shutdown()` next to profile/service/orchestrator barriers. `BrowserBackendRouter.shutdown()` only waits for its own `call()` barrier.
- Do **not** mark G5 or full platform done. In-app Electron attached reuse, UI, model adapters, and drain composition remain root-owned. A parallel browser worktree owns `cdp/transport.ts` and type-only attached-reuse interfaces; this change kept `connection.ts` edits in method/lifecycle bodies.
