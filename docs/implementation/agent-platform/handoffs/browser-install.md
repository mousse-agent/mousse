# B04 managed browser installer

## Contract

The additive shared contract is in [`src/shared/browser/install.ts`](../../../..//src/shared/browser/install.ts). The node implementation is exported from `src/mms/browser/install` and `src/mms/browser/index.ts`:

- `createManagedBrowserInstaller(platformInfo?)` creates an installer service.
- `platform()` returns the supported platform/architecture, executable relative path, and an actionable unsupported reason.
- `resolveDownload({ channel, version, fetch, allowedOrigins })` resolves Chrome for Testing metadata from the official last-known-good or known-good catalogs.
- `install({ root, channel, version, expectedSha256, signal, onProgress, activeSessions, ... })` downloads, verifies, safely extracts, activates, and returns the executable path plus immutable install metadata.
- `availability(root, activeSessions)` reports `ready`, `setup-required`, `installing`, `unsupported`, or `blocked` with the active version and executable path where available.
- `rollback(root, version?)`, `cleanup(root, { activeSessions, keepVersions })`, and `resolveExecutable(root)` support version retention and session-safe cleanup.

The install root contains owned `versions/`, `active.json`, `.mousse-install-lock/`, and `.mousse-staging/mousse-*` paths. Every mutation checks resolved containment and rejects symlinked parents/trees. Activation uses a temporary pointer and rename. Downloads are origin checked, size limited, streamed with cancellation/progress, SHA-256 hashed, and extracted after inspecting ZIP central-directory counts and declared inflation sizes. Extraction rejects absolute, parent, NUL, duplicate/case-colliding, ADS/device, escaped, encrypted, ZIP64, and symlink entries; ZIP inflation occurs only after those bounds pass. The service never invents an upstream digest: `hashVerified` is true only when the caller supplies and matches `expectedSha256`; the computed digest remains in metadata in all cases. Install, rollback, and cleanup share the owned lock; dead owner PIDs and ownerless locks older than five seconds are recoverable.

`probeManagedBrowserExecutable` composes the existing `launchManagedChrome` CDP pipe launch and `Browser.getVersion` handshake. New installs and existing-version reuse run this bounded probe before activation/reuse and require the reported four-part version to equal the catalog candidate; tests inject a deterministic probe that echoes the requested candidate. A real Windows Chrome installation at `C:\Program Files\Google\Chrome\Application\chrome.exe` passed the same CDP probe without downloading another binary and returned `Chrome/153.0.8010.36`.

## Verification

`tests/platformBrowserInstaller.test.ts` uses a real local HTTP server and generated zip archives to verify successful installation, progress, digest failure, traversal/device-path rejection before extraction, interrupted download cleanup, lock contention, rollback, active-session cleanup fencing, origin rejection, and unsupported architecture reporting. The deterministic fixture uses the Linux x64 CfT layout; no upstream Chrome or model/account is downloaded.

Passed:

- `npx vitest run tests/platformBrowserInstaller.test.ts --reporter=dot` (7 tests)
- `npx vitest run tests/platformBrowserContracts.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserPackaging.test.ts --reporter=dot` (16 tests)
- `npx tsc -p tsconfig.node.json --noEmit`
- `npx tsc -p tsconfig.web.json --noEmit`

The package reports Windows x64/ia32 and macOS/Linux x64/arm64 mappings from the official CfT archive layout. The official current last-known-good catalog at `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json` lists `linux-arm64` for Stable 153.0.8010.36, so Linux arm64 remains supported when the catalog supplies it; resolution still fails closed if a selected channel/version omits the platform. The checked-in fixture tests do not launch a downloaded Windows PE or macOS binary, but the real existing Windows Chrome probe above exercises the production CDP validation path. The production browser manager should retain active-session counts when calling `cleanup` and `rollback`.
