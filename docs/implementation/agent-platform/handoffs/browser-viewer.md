# M02 managed browser viewer handoff

Branch: `feat/platform-browser`

M02 adds a viewer facade over the existing M01 `BrowserSessionManager`; it does not create a second automation manager. The MMS service is `BrowserViewerService` in `src/mms/browser/viewer/BrowserViewerService.ts`, exported from `src/mms/browser`. The shared renderer contract is `BrowserViewerClient` and its related snapshot/context/history types in `src/shared/browser/viewer.ts`.

The client methods are:

```ts
snapshot({ sessionId?, context? }): Promise<BrowserViewerSnapshot>
subscribe(listener): () => void
observe({ sessionId, tabId?, context? }): Promise<BrowserViewerSnapshot>
takeControl({ sessionId, context? }): Promise<BrowserViewerSnapshot>
resumeAgent({ sessionId, context? }): Promise<BrowserViewerSnapshot>
close({ sessionId, context? }): Promise<BrowserViewerSnapshot>
history({ sessionId?, context? }): Promise<BrowserViewerHistoryEntry[]>
artifactUrl?(artifactId): string
```

Root composition should construct one `BrowserViewerService` beside the already-composed per-profile `BrowserSessionManager`, passing the authenticated `BrowserViewerContext` (immutable execution identity and policy snapshot) and the same manager instance. Expose that service through the root-owned preload/protocol bridge as `window.mousse.browserAutomation`; the renderer intentionally discovers only this typed client. The bridge must reject a context whose profile/thread/run does not match the active caller before reaching the service. `artifactUrl` should resolve only artifact IDs granted by the MMS artifact port.

`BrowserPanel` now has a Manual browser / Managed automation tab switch. Manual mode keeps the existing `browserTabs` store, `ownerThreadId` filtering, profile-specific Electron partition, picker, navigation, and cache controls. Managed mode renders `BrowserAutomationViewer` from `src/renderer/components/browserAutomation/BrowserAutomationViewer.tsx`; it never reuses manual webviews. The managed view shows connection state (`connected`, `reconnecting`, `disconnected`, `headless-waiting`), profile/thread/run linkage, current tab and URL, observation warnings/generation, screenshot artifact when the bridge supplies `artifactUrl`, history, reconnect/close, and human/agent control. Human takeover calls the manager control lease and fences in-flight agent actions. Resuming always obtains a fresh worker generation and observation. Screenshot clicks map image pixels to CSS coordinates through `viewerPointToCss`, which preserves explicit high-DPI/crop scale metadata.

Validation:

- `tests/platformBrowserViewer.test.ts`: 2/2 passed with the real managed Chrome worker and fixture site. The first test dispatches a delayed navigation, takes human control while it is in flight, asserts the dispatched operation settles as `unknown-effect`, rejects the stale agent action, resumes with a fresh observation and screenshot artifact, and verifies the high-DPI mapping helper. The second opens a real session in profile A, verifies profile B cannot see it, and checks the renderer takeover controls.
- `npx tsc -p tsconfig.web.json --noEmit`: passed.
- `npx tsc -p tsconfig.node.json --noEmit`: passed.

The fixture does not claim packaged renderer screenshot rendering: this repository has no renderer DOM test harness, so the screenshot display is covered by the real worker screenshot metadata and the component source contract, while the browser fixture verifies the underlying observation and artifact. `BrowserViewerService.artifacts` remains empty until root wires the artifact metadata lookup; screenshot IDs are retained in history and the observation. MMS/protocol/preload registration, artifact URL authorization, CSS styling, and production profile context selection remain root-owned.
