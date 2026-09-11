# Sol review: browser worker installer resolution

Reviewed and fixed on integrated core `205fab2d3799b347f8709a32b4352933d68d83e0`.

The worker now resolves the production installer layout at `active.json` and `versions/<platform>-<version>/mousse-browser.json` before retaining the legacy `binaries/certified/metadata.json` fixture fallback. Active pointer and metadata files are bounded to 64 KiB, opened as identity-stable regular files, and validated for the current platform, exact four-part version, digest state, and the platform's canonical executable relative path. The executable path must remain under a real browser root through a symlink-free path walk and canonical containment check. A present but invalid active pointer fails closed instead of falling through to a different legacy binary.

The integration fixture hardlinks the existing immutable local Chrome tree into the reviewed installer directory shape. It proves worker capability readiness and a real session open/close without a download or live account. Adversarial coverage rejects an active version directory junction, traversal-like executable metadata, and oversized pointer JSON.

Validation:

- `npx vitest run tests/platformBrowserWorkerBinaryResolver.test.ts tests/platformBrowserWorker.lifecycle.test.ts --maxWorkers=1 --reporter=dot` — 2 files, 9 tests passed, including real Chrome.
- `npx vitest run tests/platformBrowserWorkerBinaryResolver.test.ts --maxWorkers=1 --reporter=dot` — 1 file, 2 tests passed after the final legacy-root containment tightening.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:browser-worker` — passed.

The worker snapshots binary availability in `SessionManager` construction. Installing after a broker/worker has already started in `setup_required` state does not refresh that instance. Production setup completion must close/reset the broker or use a new lazy broker before retrying session open; this review does not change `MmsBrowserService` ownership.
