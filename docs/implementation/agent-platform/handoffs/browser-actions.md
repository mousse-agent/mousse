# Browser actions and recovery handoff

Branch: `feat/platform-browser`  
Baseline merge: `9a75bbb` (`ce53e6a93980410f2ea984a2e74201f8c616163f` plus the prior browser core)  
B03 implementation commits: `5c7736d` (`feat(platform): complete managed browser actions and recovery`), `ae98f40` (`test(platform): prove browser crash recovery and download bounds`), and `e0884de` (`fix(platform): preserve unknown effects across worker crashes`).

This slice owns the managed Chromium worker, the MMS browser broker, additive browser DTOs, real browser fixtures, and the browser worker tests. It keeps the worker Electron free and uses Chrome for Testing over the private remote debugging pipe.

The public additions are:

- `BrowserArtifactPort.resolveReadOnly({ profileId, sessionId, runId?, artifactIds })` resolves opaque MMS grants. `BrowserBroker.call()` validates returned IDs, absolute paths, realpath/stat regular-file status, byte lengths, and a 100 MiB upload bound before injecting private `resolvedArtifacts` into the worker action. The model-facing action contains only artifact IDs.
- `BrowserArtifactPort.publishDownload(...)` is available as an additive MMS seam. The current managed worker publishes completed downloads through its scoped `ScopedArtifactWriter` under `artifactRoot/<profile>/<session>`, returning only artifact IDs and metadata. Root can replace this with its quarantine publisher when composing the artifact store.
- `BrowserActionResult.artifacts` carries `{ artifactId, byteLength, sha256, mediaType, displayName }`; download paths never cross the worker response.
- `CapabilityReport.capabilities.actions` advertises the verified coordinate target, bounded pointer drag, grant upload, quarantined download, no-progress limiter, and persistent workspace recovery operations. OOPIF and closed shadow DOM remain explicitly unsupported.

The action implementation maps cropped screenshots and device-scale coordinates back to CSS viewport coordinates, checks the bound observation/generation/document, resolves the DOM node at the mapped point, and runs the same stable-geometry and overlay hit test as a reference action. Drag uses a bounded maximum-40-step CDP mouse path with cancellation checks. The certified fixture verifies a real drop result. HTML5 `dragstart` semantics are not claimed; the supported fixture uses pointer/mouse drag semantics and the handoff keeps that limitation explicit.

Uploads require an observed `INPUT` with `type=file`, a trusted grant resolver, real staged files, and an accept/multiple check before `DOM.setFileInputFiles`. Downloads use a session quarantine directory, sanitize names, ignore partial `.crdownload`/`.tmp` files, enforce a 50 MiB completed-file bound, hash and publish into the profile/session artifact scope, then remove the source. Session close removes partial files. There is no auto-open or execute path.

Persistent sessions take a single-writer workspace lock. A lock owned by a prior process bumps the session generation on relaunch, and the new reference store invalidates old refs and leases. The broker shares concurrent startup, resets failed initialization state, cleans process records owned by a crashed worker, and resolves an interrupted dispatched action as `unknown-effect` with `worker_disconnected` cause. The child-process fixture uses a fixture-only response-delay seam, waits for a real POST side effect, kills the actual worker, verifies the managed Chrome PID is gone, reopens the same profile/workspace, and confirms the external submit count remains exactly one. Reconnect is caller initiated; the unknown-effect action is never replayed.

Evidence run on Windows 11 with the repository-managed Chrome for Testing binary and loopback fixture pages, no live accounts or everyday browser profiles:

```text
npx vitest run tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.observation.test.ts tests/platformBrowserWorker.framing.test.ts --maxWorkers=2 --reporter=dot
  4 files, 29 tests passed
npm run typecheck
npm run build:cli
```

The real fixture coverage includes device-scale-2 cropped image targeting and stale geometry rejection, overlay refusal through the shared hit test, pointer drag end state, accepted staged upload and selected filename, exact local attachment bytes/size/SHA-256 plus quarantine cleanup, aborted and oversize transfers without publication, no-progress, cancellation/takeover fencing, profile isolation, persistent lock ownership, concurrent/failed startup, and an actual child-process crash/recovery with stale lease/ref rejection. Linux, macOS, packaged installer paths, and Electron-attached browser mode remain unqualified. The fixture-only response delay is test fault injection and is not a product control. Cancellation and oversize download handling are fail-closed cleanup/error paths; only completed local fixture downloads are published by the acceptance fixture.

