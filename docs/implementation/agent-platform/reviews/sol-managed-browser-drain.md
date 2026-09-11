# Sol review: managed browser owner-graph drain

Reviewed candidate: `0d540d5caa4e8d1c6aaa4549bb05dc46a2a0003f`

Refreshed core: `eb0d9ed` (merge `167870c`)

Disposition: accepted after the fixes recorded in this commit.

## Findings fixed

- `BrowserBroker.runShutdown` always raced against an already-resolved disconnect-cleanup promise (and often an absent in-process host represented by another resolved promise). With live raw work or a child process this formed a hot microtask loop until force escalation, delaying timers and I/O needed to drain. The wait set now contains only active ownership promises plus a bounded poll timer.
- Unexpected worker exit started process-record cleanup, but per-record stop failures were swallowed and the owner PID was forgotten. The broker now retains failed owner PIDs in its active count, propagates cleanup failure, and retries the same recorded owner set on later start/shutdown attempts.
- Windows graceful `taskkill /T` failure aborted tree cleanup before `/F`, and the graceful wait consumed the entire stop deadline so force escalation was unreachable. Graceful refusal now proceeds to a bounded midpoint and forced tree termination still has the remainder of the deadline. A nonzero taskkill result receives a short proven-exit window before becoming a retained-owner failure.
- A pre-aborted broker request allocated an untracked raw promise and timer before rejecting admission. Abort is now checked before those resources are created.
- Chromium launch registered a fire-and-forget async abort callback whose deliberate `cancelled` throw became an unhandled rejection and raced the tracked launch cleanup. CDP admission already observes the signal, so launch cancellation now follows one awaited catch/stop path.
- After proven Chrome exit, one immediate Windows recursive delete could fail while handles were still being released; the error was swallowed and a late-open session directory remained after a reported successful drain. Ephemeral cleanup now retries for a bounded second and fails closed, retaining the session for a later close retry if the directory still exists.

## Evidence

```text
npx vitest run tests/platformManagedBrowserDrain.test.ts -t "does not insert a session or tab that finishes after shutdown began" --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=180000 --hookTimeout=120000 --reporter=dot
  1 passed, 10 skipped; no unhandled rejection and no late session directory

npx vitest run tests/platformManagedBrowserDrain.test.ts tests/platformBrowserWorker.framing.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.observation.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=180000 --hookTimeout=120000 --reporter=dot
  5 files, 45 tests passed, including actual managed Chromium process-tree shutdown

npm run typecheck
  node and web TypeScript projects passed

npm run build:cli
  passed after the browser tests completed
```

The first review run exposed the late ephemeral directory and an unhandled Windows taskkill/abort rejection. That failing run is not counted as evidence; the targeted reproduction and complete focused suite passed after the fixes.

## Remaining limits

- Windows Job Object containment is unavailable without a native helper. A hostile detached descendant after its recorded parent identity is lost remains the documented fail-closed limit.
- Linux `/proc` and Darwin descendant inventory paths are implemented but were not exercised by this Windows review.
- A shutdown timeout or failed process/directory cleanup retains ownership and must block profile movement. Callers must retry the same broker rather than construct a replacement.
- `BrowserBackendRouter` tracks wrapper calls only. Production profile shutdown must also begin and await the managed broker, and separately await attached-browser guest/transport ownership.
- This review does not claim the root-owned MMS/main/preload/renderer composition, attached browser acceptance, or G5 completion.
