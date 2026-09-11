# M02 managed browser viewer handoff

Branch: `feat/platform-browser`

M02 adds a viewer facade over the existing M01 `BrowserSessionManager`; it does not create a second automation manager. The MMS service is `BrowserViewerService` in `src/mms/browser/viewer/BrowserViewerService.ts`, exported from `src/mms/browser`. The shared renderer contract is `BrowserViewerClient` and its related snapshot/context/history types in `src/shared/browser/viewer.ts`.

The renderer client is deliberately serializable and authority-free. It never accepts `ExecutionContext`, policy snapshots, cancellation signals, or control leases. The root-owned bridge binds those values to the service instance before exposing the client. The client methods are:

```ts
snapshot({ sessionId? }): Promise<BrowserViewerSnapshot>
subscribe(listener): () => void
observe({ sessionId, tabId? }): Promise<BrowserViewerSnapshot>
humanAction({ sessionId, tabId, generation, observationId, action }): Promise<BrowserViewerSnapshot>
takeControl({ sessionId }): Promise<BrowserViewerSnapshot>
resumeAgent({ sessionId }): Promise<BrowserViewerSnapshot>
close({ sessionId }): Promise<BrowserViewerSnapshot>
history({ sessionId? }): Promise<BrowserViewerHistoryEntry[]>
artifactUrl?(artifactId): string
```

Root composition should construct one `BrowserViewerService` beside the already-composed per-profile `BrowserSessionManager`, passing the authenticated `BrowserViewerContext` (immutable execution identity and policy snapshot) and the same manager instance. Expose that service through the root-owned preload/protocol bridge as `window.mousse.browserAutomation`; the renderer intentionally discovers only this typed client. The service's `artifactResolver` must use the authenticated MMS artifact port, and `artifactUrl` should resolve only artifact IDs granted by that port.

`BrowserPanel` now has a Manual browser / Managed automation tab switch. Manual mode keeps the existing `browserTabs` store, `ownerThreadId` filtering, profile-specific Electron partition, picker, navigation, and cache controls. Managed mode renders `BrowserAutomationViewer` from `src/renderer/components/browserAutomation/BrowserAutomationViewer.tsx`; it never reuses manual webviews. The managed view shows connection state (`connected`, `reconnecting`, `disconnected`, `headless-waiting`), profile/thread/run linkage, current tab and URL, observation warnings/generation, screenshot artifact when the bridge supplies `artifactUrl`, history, reconnect/close, and human/agent control. Human takeover calls the manager control lease and fences in-flight agent actions. While the human lease is active, click/key/navigation controls send `humanAction` with the current generation and observation ID. The worker validates the human lease and rejects stale inputs; agent actions remain fenced. Resuming always obtains a fresh worker generation and observation. Screenshot clicks map image pixels to CSS coordinates through `viewerPointToCss`, which preserves explicit high-DPI/crop scale metadata.

Validation:

- Final candidate includes the bounded oversize fixture correction `07da9c1`.
- Full browser platform suite (`tests/platformBrowser*.test.ts`, `--maxWorkers=2`): **10 files, 56 tests passed** after truncating two confirmed stale owned `.crdownload` payloads. No new Chrome download was performed.
- `tests/platformBrowserViewer.test.ts`: 2/2 passed with the real managed Chrome worker and fixture site. The first test dispatches a delayed navigation, takes human control while it is in flight, asserts the dispatched operation settles as `unknown-effect`, rejects the stale agent action without falsely marking the session disconnected, performs a real generation-fenced human navigation, resumes with a fresh observation and screenshot artifact, and verifies the high-DPI mapping helper. The second opens a real session in profile A, verifies profile B cannot see it, and checks the renderer takeover controls.
- `node scripts/run-browser-viewer-visual-check.mjs`: passed the hidden Electron fixture. It rendered and interacted with takeover/resume, pointer click, keyboard input, navigation, disconnect/reconnect, artifact history, responsive narrow layout, and high-DPI screenshots; `desktop.png`, `narrow.png`, and `hidpi.png` were captured and inspected. `result.json` reports `passed: true` with no renderer errors.
- `npx tsc -p tsconfig.web.json --noEmit`: passed.
- `npx tsc -p tsconfig.node.json --noEmit`: passed.

The visual fixture uses an in-memory typed client for renderer interaction and a controlled SVG artifact URL; the manager/service test separately exercises the real managed Chrome worker, screenshot capture, artifact resolver, and human action path. MMS/protocol/preload registration, root artifact URL authorization, and production profile context selection remain root-owned. No new browser download was performed.
