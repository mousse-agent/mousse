# Browser human handoff and latest-observation review

## Reviewed baseline

- Candidate: `ef6d19ded5a5f8091fc68d4c1889ea3f0e2fe38d`
- Review implementation: `997a6192f2e2a7099e12149907fadc224ca42313`

## Findings and fixes

- Human handoff called the public control path after authorizing `browser_request_human`, charging the same request twice and potentially repeating host approval. The handoff and public control entry points now share a private dispatch path after each performs its own single authorization.
- A persisted `waiting-human` handoff reloads with a disconnected session. Retrying it could dispatch a duplicate control effect. Recovery now fails closed with `unknown_effect` unless the in-memory session is still proven human-controlled.
- A delayed observation from the same browser generation could replace a newer cached observation. Cache replacement now compares valid `capturedAt` timestamps within a generation.
- GUI viewer RPCs reused one durable turn budget per thread, so polling could exhaust the thread permanently. Each RPC now receives an isolated host-created budget identity, and its budget is retired in `finally`. An inert local signal prevents those ephemeral IDs from being resolved through the native run cancellation registry; the manager's elapsed-time deadline remains active.
- Profile-wide browser shutdown now records active handoffs as `closed` after a proven close and as `unknown` after an unproven close failure.
- The daemon composition fixture now uses the production browser method registration instead of registering the same methods a second time. It verifies more than 100 snapshot polls followed by a legitimate control action.

## Evidence

- `npx vitest run tests/platformMainBrowserE2E.test.ts`: 1 passed. This is the real Electron webview flow through MMS, native tools, GUI/main routing, human handoff, takeover, resume, and release.
- `npx vitest run tests/platformBrowserAutomation.test.ts tests/platformBrowserViewer.test.ts`: 9 passed.
- `npx vitest run tests/platformBrowserDaemonComposition.test.ts`: 3 passed, including 110 viewer snapshot polls followed by control takeover.
- `npm run typecheck`: node and web TypeScript passed.
- `git diff --check`: passed.

## Remaining limits

- Latest observations are deliberately bounded in memory and are unavailable after daemon restart. Persisted session and handoff state still prevents an uncertain handoff effect from being replayed.
- Recovery cannot prove whether a disconnected external browser completed an in-flight effect. Such cases remain `unknown_effect` and require explicit browser-control recovery.
- This review did not expand browser download, upload, or dialog support.
