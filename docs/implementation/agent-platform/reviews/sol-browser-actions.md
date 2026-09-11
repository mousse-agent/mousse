# Sol browser actions and recovery review

Reviewed integration base: `d097ceb8517cd4f3227a12824ae967773dd5f2be`  
Reviewed candidate: `cc6ec7ff6afb2222ddd93d78896a1ff7bf48c456`  
Candidate merge: `af45cf5`  
Review fix: `27dff71`

## Findings fixed

- **Download completion and cleanup were racy.** The worker sampled the quarantine directory after a fixed delay without enabling CDP download events. A partial or late download could therefore escape the state checks, and aborted or oversize transfers could leave `.crdownload` data behind. Download events are now enabled, active transfers are bounded by the action deadline, incomplete transfers are canceled, and every failure and session-close path clears the complete quarantine. The fixture now requires exact failure codes and an empty artifact and quarantine scope for both aborted and oversize transfers.
- **Worker replacement could race old cleanup.** Duplicate `exit`/`error` callbacks from an old child could clear a newly installed child, and restart did not await cleanup of Chrome processes owned by the disconnected worker. Disconnect handling is now bound to the exact child and startup waits for its cleanup before launching a replacement.
- **Cancellation did not reach several CDP operations.** Navigation, history, target preparation, focus, key, select, scroll, dialog, control-read, and image-point calls omitted the request signal. These calls now use the action signal, preserving bounded cancellation and conservative unknown-effect classification after dispatch.
- **Broker request listeners leaked on close, timeout, and write failure.** These terminal paths now detach the caller abort listener.
- **Upload validation forwarded the original path after validating its real path.** The worker now receives the validated real path, preventing a staged symlink from being retargeted after grant resolution.
- **The child crash fixture could act on the initial pre-load observation.** It now obtains a real observation containing the target before dispatch. The test still waits for the actual loopback POST, kills the actual worker process, verifies its Chrome child exits, and checks recovery without replay.
- **The exact-byte download assertion was platform-dependent.** It now compares the published bytes with the fixture file bytes, retaining byte-for-byte, size, and SHA-256 verification on Windows line endings.

## Verification

The repository-managed Chrome for Testing binary was used with loopback-only fixture pages and temporary browser, artifact, and profile roots. No live account, provider, model, or everyday browser profile was used.

```text
npx vitest run tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserWorker.observation.test.ts tests/platformBrowserWorker.framing.test.ts tests/platformBrowserContracts.test.ts --maxWorkers=2 --reporter=dot
  5 files, 38 tests passed

npx vitest run tests/platformBrowserWorker.actions.test.ts --maxWorkers=1 --reporter=dot -t "publishes a local download|does not publish aborted"
  1 file, 2 passed, 11 skipped

npm run typecheck
  passed

npm run build:cli
  passed
```

The real fixtures cover CDP form actions and end-state checks, overlay refusal, takeover cancellation, repeated-action limiting, image coordinate mapping and stale geometry, pointer drag, staged upload, exact download bytes/hash/size, abort and oversize cleanup, profile and workspace fencing, child IPC, and actual worker/Chrome crash recovery with one external POST and no replay.

## Remaining scope

- OOPIF targeting and open-shadow traversal are outside this B03 checkpoint and are reviewed separately in the frozen B02 follow-on.
- The child-process composition still writes downloads through its scoped `ScopedArtifactWriter`; the declared `BrowserArtifactPort.publishDownload` host seam is not transported over worker IPC yet. Production composition must choose and wire the authoritative artifact publisher.
- The advertised no-progress limiter detects repeated action fingerprints. It does not compare successive page observations to prove lack of page progress.
- Headed mode, packaged executable discovery/install behavior, macOS, Linux, and full Electron-attached operation remain unqualified.
