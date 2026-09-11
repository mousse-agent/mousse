# M01 browser automation handoff

Branch: `feat/platform-integrations-ui`  
Reviewed baseline merge: `5a2444cc4849f05c762e9f0f8a710a2a6de4642a`  
M01 implementation: `c1fc3e269325667aef170130590d100acccec684`

M01 adds the MMS-owned automation seam under `src/mms/browser/automation/`. `createBrowserAutomation(options)` returns `{ sessions, tools, workflow }` and expects an injected `BrowserBroker`, profile root, profile ID, optional `CancellationRegistry` resolver, and optional host policy callback. The host retains ownership of model credentials, policy snapshots, approvals, and human handoff persistence.

`BrowserSessionManager` owns profile/thread/run checks, durable session inventory at `profileRoot/browser/automation-sessions.json`, per-turn tool-call and elapsed budgets, cancellation signals, session open/close, tab operations, observations, semantic finds, typed actions, waits, extraction, control lease changes, and shutdown cleanup. A session opened for a run is invisible to another run in the same thread; a context from another profile is rejected before the broker call. Worker session IDs, CDP targets, paths, and credentials never enter the model tool contract.

`BrowserToolDispatcher` exposes the bounded catalog `browser_open`, `browser_tabs`, `browser_observe`, `browser_find`, `browser_act`, `browser_wait`, `browser_extract`, and `browser_request_human`. It validates structured arguments, rejects image-point actions unless the caller explicitly marks the context vision-capable, preserves structured worker error codes, and refuses unconfigured human handoff. `ManagedBrowserWorkflowAdapter` maps `browser-session`, `browser-observe`, `browser-action`, `browser-extract`, and bounded `browser-task` nodes to the same dispatcher.

The worker remains the authority for live refs, generation/document checks, actionability, coordinate transforms, upload grants, quarantined downloads, and unknown-effect recovery. The manager does not expose arbitrary evaluate, selectors, raw file paths, or provider credentials. `BrowserBroker` remains the injected worker transport and artifact-grant boundary.

Real managed-Chrome fixtures in `tests/platformBrowserAutomation.test.ts` cover main, child-agent, and workflow ownership, semantic refs, stale navigation rejection, B2 vision gating, cancellation, and tool budgets. The suite passes all 3 tests with `npx vitest run tests/platformBrowserAutomation.test.ts --maxWorkers=2 --reporter=dot`; `npm run typecheck` and `npm run build:cli` also pass. The fixture uses a task-owned browser root with hard-linked immutable certified Chrome files from the existing `.mousse-dev/browser-binaries` cache, while profile data, journals, locks, and artifacts remain isolated. The first run was blocked before collection by the host's zero-byte C: drive; rerun after workspace cleanup. The managed Chrome for Testing cache is intentionally retained.

Root composition should pass the same manager/dispatcher/workflow object to app, CLI, agent, and workflow entrypoints. The host should implement `requestHuman` as a durable approval/control handoff and subscribe browser shutdown to profile disposal. This slice does not claim full app/CLI wiring, native provider adapters, viewer/takeover UI, or packaged-platform qualification.
