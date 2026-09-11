# Sol review: browser artifact ownership and composition

Reviewed base: `4f2cde8ed0a3795597549bf1cd638ab64602431c`

Candidate head: `cc737a552b7b42907b5c6faa6f9614ae23ac2ee9`

Disposition: accepted after the fixes recorded in this commit.

## Findings fixed

- The artifact index trusted mutable JSON after validating only its path. Index entries now carry a canonical SHA-256 integrity value, reject unknown or missing fields and malformed JSON, and validate the complete scope and artifact metadata before revealing a reference. The digest detects corruption and inconsistent rewrites; it is not an authentication key against a privileged local writer.
- The service retained the index pathname but did not retain either storage directory's filesystem identity. It now pins the canonical path, device, and inode for the index and worker staging roots and checks them around reads and writes, rejecting a renamed/replaced root for the service lifetime.
- A cached or concurrent worker import compared only PNG pixel dimensions. It now compares both declared CSS-to-image scales as well, so a reused artifact cannot inherit changed coordinate geometry.
- Construction now validates the profile identity and creates and retains the injected profile-owned worker staging root. Metadata rejects empty display names, and persisted metadata is bounded and checked before it can be described.
- The adversarial fixtures now cover an internally rewritten index, malformed index shapes, retained-root replacement, changed cached scale claims, and shutdown while the shared-store callback is still pending.
- The production pipeline fixture can use an already certified local browser root through `MOUSSE_TEST_BROWSER_ROOT`. The qualifying run exercised managed Chromium without downloading a browser. A separate failure fixture proves a dispatched and verified browser action remains verified when screenshot publication fails; the observation retains its semantic result with a warning and no image.

## Authorization and composition boundary

`BrowserArtifactScope` is trusted host input derived only after `BrowserSessionManager` admits the caller and verifies that the returned observation belongs to the selected session. It must not become an RPC payload or bearer authorization claim. The viewer resolver receives the selected session ID and must derive the same profile/thread/run/session scope from the admitted host context before calling `describe` or `read`.

The attached or managed writer may stage only `workerArtifactRoot/profileId/sessionId/art_UUID.png` under the injected profile root. The importer opens that exact bounded regular file, verifies the PNG signature and IHDR dimensions, publishes it through `FileArtifactStore`, and exposes only the UUID artifact reference. This supports the Electron main/daemon same-filesystem design without carrying image bytes or local paths through reverse-RPC frames.

## Evidence

```text
$env:MOUSSE_TEST_BROWSER_ROOT='C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\core\.mousse-dev\browser-binaries'
npx vitest run tests/platformBrowserArtifactService.test.ts tests/platformBrowserArtifactPipeline.test.ts tests/platformBrowserViewer.test.ts --reporter=dot
  3 files, 14 tests passed; the pipeline used the existing certified managed Chromium

$env:MOUSSE_TEST_BROWSER_ROOT='C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\core\.mousse-dev\browser-binaries'
npx vitest run tests/platformBrowserArtifactService.test.ts tests/platformBrowserArtifactPipeline.test.ts tests/platformBrowserViewer.test.ts tests/platformBrowserBackendRouting.test.ts tests/platformAgentProductionExecution.test.ts tests/platformProfileDrain.test.ts tests/platformArtifactOwnership.test.ts --reporter=dot
  7 files, 49 tests passed

npm run typecheck
  both node and web TypeScript projects passed

npm run build
  main, preload, renderer, and CLI builds passed; only the existing generated-CSS and Vite chunk warnings were emitted
```

The combined run includes the corrected native `ask_user` deadline fixture: it waits until the run-owned question exists, allows a realistic 5000 ms setup window, and proves an unrelated thread's pending question survives cancellation.

## Remaining work and limits

- Root must still compose one service instance into the session observation decorator, the selected-session viewer resolver, profile begin/count/dispose, and the trusted attached/managed staging-root producer. This review did not change root-owned browser bridge or UI lifetime code.
- Future renderer or model access must authorize through `BrowserSessionManager`; `describe` and `read` are trusted internal resolver methods and must not be exposed as calls accepting a claimed scope.
- The importer verifies PNG signature, IHDR length/type, and declared dimensions. It does not fully decode PNG chunks; the shared store supplies byte digest/integrity after import.
- Per-call byte and pixel bounds are enforced. Aggregate profile quota, retention, garbage collection, and durable source-to-artifact deduplication across restarts remain separate work.
- Filesystem identity checks materially close replacement of retained roots during a service lifetime, but portable hostile-filesystem race guarantees remain limited by platform support for no-follow file opens.
- Broker/worker shutdown, attached command transport, authenticated artifact URL serving, and final in-app BrowserPanel acceptance remain separately owned integration work.
