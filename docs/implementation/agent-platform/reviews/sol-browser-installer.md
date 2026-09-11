# Sol managed browser installer review

Reviewed integration base: `c9e0abbdf72a7858c0d671b50926ac68307f5954`  
Reviewed candidate: `e138f2d601e81cda60d9718913c4113a0c94b457`  
Candidate merge: `01cdfb1`  
Review fixes: `cdd7cb9`, `353ae02`  
Bounded browser fixture correction: `fca7c41` (cherry-picked from root `e94144f9dcd0b384b4e6b6d61231c213c1f515c8`)

## Findings fixed

- **The managed root itself could be a directory link.** Containment checks walked only descendants, so a junction or symlink supplied as `root` could redirect installer creation and recursive cleanup outside the intended physical root. Creation, mutation, and availability inspection now reject a linked or non-directory root. A real directory-link fixture removes the link explicitly before recursive fixture cleanup.
- **ZIP extraction retained every inflated file in memory.** The original extractor collected chunks per file and then allocated another full buffer, allowing a valid archive near the 2 GiB extracted-size limit to exhaust the process before the configured bound helped. Central-directory validation now completes first, directories are prepared through symlink-safe walks, and inflation writes each validated entry directly to an exclusive file while enforcing actual per-entry and aggregate byte counts. File handles close on every error and successful files are flushed before activation.
- **Download buffering transiently held two complete compressed archives.** Downloads now stream into an exclusive file in the owned staging directory. The installer hashes during receipt, flushes and closes the file, then reads one bounded archive buffer for central-directory inspection and verifies its exact length and digest against the received stream before extraction.
- **Catalog JSON was unbounded.** Both declared and actual Chrome for Testing catalog bodies are now capped at 16 MiB and remain abortable.
- **The active-session callback was captured before lock acquisition and catalog resolution.** It is now read immediately before a same-version replacement. A delayed-catalog fixture proves a session admitted during resolution blocks replacement.
- **A failed same-version replacement could destroy the active version.** The old version directory was deleted before the new metadata and active pointer committed. Replacement now moves the old directory to an owned backup, restores it if any later commit step fails, and reports an aggregate error if restoration itself fails. A deliberate archive/metadata collision proves the prior executable remains active and readable.
- **The oversized-download HTTP fixture could write forever under backpressure.** The bounded root correction decrements bytes before observing `write()` backpressure and stops when the response is destroyed. Its independent fixture consumes exactly 51 MiB.

## Verification

All network activity used loopback fixture servers. Real browser checks used the repository-managed Chrome for Testing binary and temporary profiles. No live account, provider, model, or everyday browser profile was used.

```text
npx vitest run tests/platformBrowserInstaller.test.ts tests/platformBrowserContracts.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserPackaging.test.ts --maxWorkers=2 --reporter=dot
  4 files, 27 tests passed

npx vitest run tests/platformBrowserInstaller.test.ts tests/platformBrowserFixtureBounds.test.ts --maxWorkers=2 --reporter=dot
  2 files, 11 tests passed

npx vitest run tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.observation.test.ts --maxWorkers=1 --reporter=dot
  2 files, 18 real Chrome tests passed

npm run typecheck
  passed

npm run build:browser-worker
  passed

npm run build:cli
  passed
```

An earlier parallel action/observation run produced one startup observation containing only `RootWebArea` in the download test; the exact test passed immediately alone, and the complete 18-test real Chrome set passed when run sequentially. This is treated as fixture startup contention rather than installer behavior.

## Remaining scope

- Session admission must be coordinated by the production browser manager with install, rollback, and cleanup. The installer accepts an `activeSessions` callback for replacement, while rollback and cleanup accept counts; none can prevent a host from admitting a new session immediately after the installer checks the count.
- The official catalogs do not supply a digest through this contract. `hashVerified` remains false unless the trusted caller supplies `expectedSha256`; the computed transport digest alone is recorded without claiming upstream authenticity.
- The compressed ZIP is held once in memory for random-access central-directory validation, bounded by `maxDownloadBytes` (512 MiB by default). Extracted bytes are streamed to disk and bounded separately (2 GiB by default).
- A hostile local process with permission to mutate the managed tree could race a path check and the following filesystem operation. The owned lock coordinates Mousse installer actors, but it is not an operating-system directory capability.
- Actual official download and activation on every advertised OS/architecture, packaged-app discovery, installer UI/progress integration, and headed browser operation remain unqualified. The candidate's CDP probe validates executable version and cleanup, but the deterministic install fixtures use a Linux-layout archive and an injected probe.
