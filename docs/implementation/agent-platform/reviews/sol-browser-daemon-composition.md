# Sol review: browser daemon composition

## Reviewed revisions

- Candidate: `380893f3bf38ba` (`feat/browser: compose daemon attached-browser registration and GUI viewer`)
- Core assembly merged for review: `773027f`
- Review merge: `4380366`
- Correctness fixes: `c5b2c5931db1ef1068350b1ae1c11adc6c6b762b`

The review covered `MmsBrowserService`, `AttachedBrowserConnectionBackend`, `registerBrowserMethods`, the browser assembly in `MmsProfilePlatform`, the shared browser host contract, and the focused daemon composition fixture. It did not review Electron main ownership, renderer integration, the managed worker/broker implementation, or model adapter behavior.

## Findings fixed

1. **A lost registration response could strand an attached guest without an authenticated close path.** Electron main now supplies a 256-bit opaque closure token in the registration request, before dispatch. The daemon retains only its SHA-256 digest. A replacement authenticated GUI connection for the same profile can call the private `browser.attachments.acknowledgeClosed` method after the old connection is disconnected. The method binds the proof to the exact registration and registration epoch, compares the token in constant time, and consumes it once. This contract survives an ambiguous registration response because main retains its pre-generated token.

2. **Replacing a live registration erased the prior guest-close obligation.** Replacement now revokes routing while retaining the old proof until main confirms that the prior raw guest has stopped. Disconnect also marks every proof owned by that connection, including superseded registrations, as eligible for a later authenticated acknowledgement.

3. **Registration retries and outstanding proof limits were unsafe.** An exact same-connection retry is idempotent only when the registration epoch, tab, thread, profile epoch, and closure-token digest all match. Conflicting reuse fails closed. The profile attachment bound counts all unproven registrations, so reconnect/replacement cannot accumulate unbounded close obligations.

4. **Unregister could clear a disconnected proof without validating the original owner connection.** Live unregister remains bound to the exact connection/profile epoch. Disconnected or rebound cleanup requires the private one-use closure proof.

5. **`LazyManagedBrowserBackend.close()` discarded its broker before close completed.** A failed close now retains the same broker for retry, and concurrent close callers share the active close operation. The fixture proves the first failure remains owned and the second call closes that owner.

6. **The workflow adapter bypassed `MmsBrowserService.dispatch()`.** Workflow calls now use a dispatcher facade through the service target resolver. A GUI workflow request with no selected attached tab fails with `setup_required`; it does not silently start the managed browser.

## Verified behavior

- Framed MMS registration and selection preserve connection, profile, profile epoch, thread, registration, and registration-epoch ownership.
- Host-selected attached targets cannot be overridden by model arguments and never fall back to managed routing.
- Sibling profile/connection requests, early acknowledgements, wrong tokens, conflicting retries, and consumed tokens fail closed.
- Attached and managed paths use the profile platform's single `BrowserArtifactService`; browser disposal precedes artifact-owner disposal.
- Mutation uncertainty remains non-retryable after dispatch.

## Qualification

- `npx vitest run tests/platformBrowserDaemonComposition.test.ts tests/platformBrowserBackendRouting.test.ts --maxWorkers=1 --testTimeout=30000` — 2 files, 13 tests passed.
- `npm run typecheck` — node and web TypeScript passed.
- `npm run build:cli` — passed.
- `git diff --check` — passed before commit (line-ending notices only).

The tests use temporary profile roots and a local fake attached executor. They do not start Chromium, use accounts, contact providers, or prove Electron guest termination.

## Remaining integration scope

- Electron main must generate and retain the closure token before registration dispatch, keep it private from renderer/model/logging surfaces, and send acknowledgement only after the actual raw guest and executor are drained. The daemon proof authenticates that main-owned completion statement; it cannot itself observe physical guest death.
- Production main/domain registration and the per-window attached command handler must be qualified together. This review branch intentionally stops at the daemon contract and does not merge later root glue.
- Profile drain remains correctly blocked while an unproven registration exists. Root composition must preserve that residual-inventory guard through connection loss and application shutdown.
- Full BrowserPanel-to-daemon-to-Electron execution, live attached guest shutdown, managed worker lifecycle, and release gate G5 remain open.
