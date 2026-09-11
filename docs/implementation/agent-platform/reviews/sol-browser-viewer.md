# Sol review: managed browser viewer and takeover

Reviewed base: `c1fc3e269325667aef170130590d100acccec684`

Candidate head: `58542ea46812448abd31e9d1d294cd89de0d4a11`

Integration merge: `82e7e22`

Review fix: `f06d9a1`

## Findings fixed

- Merging M02 with the reviewed M01 manager shifted the `humanAct` authorization arguments: `browser.action` occupied the tool-name slot and the effect was missing. Human actions now authorize the exact capability/effect/request through the current manager contract.
- `observe`, human input, takeover, resume, and close caught policy/worker failures and resolved with a normal snapshot. The renderer consequently displayed success for rejected actions. Service methods now record the error and reject their promise; a stale post-resume human action fixture proves the failure remains visible and does not falsely mark the worker disconnected.
- Async refresh and action completions could replace state after the renderer switched client/session or unmounted. A monotonically fenced scope now guards subscriptions, polling, success, catch, and busy state. Session-filtered subscription updates also avoid displaying a different session from the same service.
- Resolved screenshot artifacts were accepted without checking their authoritative profile/run identity. The service now rejects mismatched artifact metadata; the real-worker test covers this boundary.
- The viewer emitted an empty-string thread link when a session had no thread. The DTO makes the link optional and omits absent identities.
- The claimed narrow fixture ran at 760 CSS pixels and lacked the named container required by its 520-pixel container query, so it never exercised the responsive rule. It now runs at 480 CSS pixels inside a `browser-panel` container and asserts the human input controls use column layout.
- M02 fixture profile names no longer passed the stricter reviewed M01 UUID identity check. The test now uses valid profile UUIDs, exposing and then resolving this integration-only regression.

## Evidence

```text
npx vitest run tests/platformBrowserViewer.test.ts --maxWorkers=2 --reporter=dot
  1 file, 2 tests passed against the real managed Chrome worker
$browserTests = Get-ChildItem tests/platformBrowser*.test.ts | ForEach-Object FullName
npx vitest run $browserTests --maxWorkers=2 --reporter=dot
  10 files, 61 tests passed
npm run typecheck
  passed
node scripts/run-browser-viewer-visual-check.mjs
  passed all desktop, 480-pixel narrow, high-DPI, takeover, pointer, keyboard, navigation, reconnect, and artifact-history checks with zero renderer errors
npm run build
  passed; Vite reported the pre-existing generated-CSS warning
```

I inspected fresh `desktop.png` and `narrow.png`. The dark-theme controls and text are legible, the 480-pixel view keeps the graph screenshot and history visible without horizontal overflow, and the navigation/key controls stack with full-width actions.

## Remaining work and limits

- Production MMS/protocol/preload registration is absent. The TypeScript renderer contract alone does not validate hostile wire values; the root-owned bridge must reject unknown fields, invalid action unions, oversized strings/arrays, and forged context fields before calling this service.
- `artifactUrl` authorization is still a root bridge responsibility. The renderer fixture uses a controlled data URL and does not qualify a production artifact scheme/handler.
- The hidden Electron fixture uses an in-memory client. The separate service fixture uses real managed Chrome, so the evidence covers both halves but not their final production bridge in one process.
- Viewer history is bounded in memory and is not durable across service restart.
- Headed/package/platform browser coverage remains open. The worker is headless managed Chromium in this checkpoint.
- The renderer click fixture dispatches through its typed client; the real worker fixture exercises human navigation, key input, and a reference-target click. It does not prove operating-system mouse injection into a headed browser.

No production browser viewer or release gate is claimed from this checkpoint.
