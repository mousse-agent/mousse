# Managed browser setup composition review

## Reviewed baseline

- Root composition candidate: `06af7cf7805d8349f4b3c35bbbf7b1cccc771a81`
- Review implementation: `d8cd19e4e66438b0bc33fc276d7944c50848da7f`

## Findings and fixes

- `install()` was not counted while its serialized start awaited installer availability. Shutdown could therefore observe zero setup work, release the installation owner, and allow the pending call to create an install afterward. Pending starts are now counted from synchronous admission through settlement, and admission is checked again after the availability await.
- The shutdown loop raced an already-resolved promise whenever only a managed-launch admission remained. That microtask loop could starve the asynchronous launch completion that releases the admission and cause a false shutdown timeout. The loop now waits on its bounded timer when no raw install promise exists.
- Added production-composition evidence that a missing managed browser rejects `browser_open` before `BrowserBroker` construction, then succeeds in the same `MousseMainService` runtime after the injected installer reports ready.
- Reviewed the shared installation-scoped GUI/CLI registration, unbound multi-profile access, CLI validation/capability dispatch, setup panel, launch gate, active-profile accounting, and installation shutdown binding. No additional defects were found in those slices.

## Evidence

- `npx vitest run tests/platformBrowserSetup.test.ts tests/platformBrowserSetupCli.test.ts --maxWorkers=1 --testTimeout=30000`: 15 passed.
- `npx vitest run tests/platformBrowserDaemonComposition.test.ts --maxWorkers=1 --testTimeout=30000`: 3 passed.
- `npm run typecheck`: node and web TypeScript passed.
- `npm run build:cli`: passed.
- `git diff --check`: passed.

The tests use an injected installer and broker response. They perform no browser download and access no live account or user browser data.

## Remaining limits

- Installer availability has no cancellation parameter. A stuck availability check remains installation-owned; shutdown times out without releasing the owner, and a later shutdown retries the same drain after it settles.
- Installation is an explicit GUI/CLI action. Model and workflow execution only receive `setup_required`; they do not install automatically.
- Attached in-app tabs remain independent of managed Chrome setup.
