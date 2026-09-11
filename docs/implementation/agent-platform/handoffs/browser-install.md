# B04 managed browser installer

## Contract

The additive shared contract is in [`src/shared/browser/install.ts`](../../../..//src/shared/browser/install.ts). The node implementation is exported from `src/mms/browser/install` and `src/mms/browser/index.ts`:

- `createManagedBrowserInstaller(platformInfo?)` creates an installer service.
- `platform()` returns the supported platform/architecture, executable relative path, and an actionable unsupported reason.
- `resolveDownload({ channel, version, fetch, allowedOrigins })` resolves Chrome for Testing metadata from the official last-known-good or known-good catalogs.
- `install({ root, channel, version, expectedSha256, signal, onProgress, activeSessions, ... })` downloads, verifies, safely extracts, activates, and returns the executable path plus immutable install metadata.
- `availability(root, activeSessions)` reports `ready`, `setup-required`, `installing`, `unsupported`, or `blocked` with the active version and executable path where available.
- `rollback(root, version?)`, `cleanup(root, { activeSessions, keepVersions })`, and `resolveExecutable(root)` support version retention and session-safe cleanup.

The install root contains owned `versions/`, `active.json`, `.mousse-install-lock/`, and `.mousse-staging/mousse-*` paths. Activation uses a temporary pointer and rename. Downloads are origin checked, size limited, streamed with cancellation/progress, SHA-256 hashed, and extracted with `fflate` after rejecting absolute, parent, NUL, and escaped archive paths. Zip entries are materialized as regular files, so archive symlink metadata is never followed. The service never invents an upstream digest: `hashVerified` is true only when the caller supplies and matches `expectedSha256`; the computed digest remains in metadata in all cases.

## Verification

`tests/platformBrowserInstaller.test.ts` uses a real local HTTP server and generated zip archives to verify successful installation, progress, digest failure, traversal rejection, interrupted download cleanup, lock contention, rollback, active-session cleanup fencing, origin rejection, and unsupported architecture reporting. The deterministic fixture uses the Linux x64 CfT layout; no upstream Chrome or model/account is downloaded.

Passed:

- `npx vitest run tests/platformBrowserInstaller.test.ts --reporter=verbose` (6 tests)
- `npx vitest run tests/platformBrowserContracts.test.ts tests/platformBrowserWorker.lifecycle.test.ts tests/platformBrowserPackaging.test.ts --reporter=dot` (16 tests)
- `npx tsc -p tsconfig.node.json --noEmit`
- `npx tsc -p tsconfig.web.json --noEmit`

The package reports Windows x64/ia32 and macOS/Linux x64/arm64 mappings from the official CfT archive layout. The checked-in tests do not launch a downloaded Windows PE or macOS binary; executable validation currently requires an owned regular file with read access and the platform-specific executable path. The production browser manager still needs to compose this service with its existing launch/session lifecycle and should retain active-session counts when calling `cleanup`.
