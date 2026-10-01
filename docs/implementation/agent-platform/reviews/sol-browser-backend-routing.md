# Sol review: browser backend routing

Reviewed integration base: `5023dca17cfd38ba25e871d05d378e3f34a341e5`

Merged core candidate: `976a2b8` (routing implementation `9131d69ddcdf641c2bbef7a991f8e28f0f3f7923`)

## Findings fixed

- A successful backend open response was trusted after checking only a few identity fields. The router now validates the complete session identity and bounded lifecycle metadata, rejects closed/disconnected open results, and rejects an initial observation for another session or generation.
- Shutdown could begin while a raw open was pending, then accept the backend's late success, publish a new route, and report the barrier idle. A late successful open is now followed by an awaited compensating close inside the same owned operation. Failure or non-settlement of that close keeps the drain from claiming completion.
- Host target objects relied only on TypeScript shape. Runtime validation now accepts exact managed or attached target shapes, validates opaque tab IDs, and rejects attached targets for CLI or other unattended execution. GUI execution still requires an explicit target, so no implicit managed fallback was introduced.
- Restored browser session records accepted malformed backend and lifecycle metadata, and duplicate IDs silently overwrote earlier records. Inventory validation now checks backend, generation, ownership, identifiers, timestamps, and session fields; duplicates fail closed. Valid live records restore as disconnected and cannot recreate a router route.

## Evidence

- `npx vitest run tests/platformBrowserBackendRouting.test.ts tests/platformBrowserContracts.test.ts tests/platformBrowserAutomation.test.ts tests/platformBrowserViewer.test.ts tests/platformBrowserModelAdapters.test.ts --maxWorkers=2 --minWorkers=1 --pool=forks`: 5 files, 31 passed. This includes real managed Chrome coverage from the existing automation/viewer/model suites and 10 bounded routing tests.
- `npm run typecheck`: node and web TypeScript projects passed.

## Remaining scope

- The Electron attached executor, trusted guest registry, targeted authenticated daemon/main command transport, artifact-byte authorization, and real existing-tab fixture remain pending in their owning packages.
- `BrowserBackendRouter.shutdown()` closes routing admission and waits for raw calls, but does not own or close the managed worker, attached guest/debugger, or already-open backend sessions. Production profile drain must close those owners separately and verify their active counts.
- A transport loss after an action dispatch must return the backend's `unknown-effect` result. The router preserves such responses and never falls back, but it cannot infer whether an arbitrary rejected port promise was dispatched; the targeted transport must make that distinction.
- Persisted sessions intentionally restore as disconnected. Attached sessions cannot survive GUI disconnect/restart, and no route is reconstructed without a new trusted registration.
