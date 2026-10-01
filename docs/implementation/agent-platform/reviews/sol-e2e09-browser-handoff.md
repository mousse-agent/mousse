# Sol review: E2E09 browser human handoff completion

Date: 2026-09-11

Baseline: `34fc693a9d2aa3036b7089fa63a5c3588fccada4`

## Result

The real Electron fixture now proves a native main-agent can continue on the same attached guest after human takeover and resume. The sequence is:

1. The native model opens the selected in-app tab and requests human control without changing the form.
2. The human takes control and changes the input.
3. Resume rotates the generation, reference set, and control lease and captures a fresh structured observation.
4. A model action using the old generation, observation, lease, and element reference fails with `stale_generation`.
5. `browser_observe` returns the current already-authorized session record with the fresh observation, allowing the model to use the rotated lease and new element reference.
6. The model fills the input and clicks the freshly observed Submit button.
7. The local HTTP fixture receives the real `POST` body `name=Mousse+pipeline` with the original guest cookie, and the same webview renders the submitted state.

The test also retains the existing workflow navigation proof after automation release. The guest remains alive, its cookie persists, and the managed-browser fallback is never attempted.

## Corrections found by the test

`BrowserSessionManager.observe` previously returned only an observation. Human resume rotates `controlLeaseId`, while GUI snapshots intentionally remove that credential. A model therefore had no authorized way to act after resume. Observe now returns a copy of the current session record after the existing exact profile, thread, run, policy, and session ownership checks. This matches the credential behavior of `browser_open` and does not broaden GUI viewer output, where `publicSnapshot` still removes the lease.

`BrowserViewerService.resumeAgent` previously forced a screenshot into the control-recovery operation. In the hidden Electron fixture, `Page.captureScreenshot` timed out and the raw CDP safety fence detached the debugger. The screenshot failure was optional and swallowed, so resume appeared successful although all later commands failed as disconnected. Resume now establishes the new semantic generation with a structured observation and no screenshot. A viewer may request a screenshot separately after control recovery; the managed-browser viewer regression verifies that path.

## Evidence

- `npm exec vitest run tests/platformMainBrowserE2E.test.ts -- --reporter=verbose`: 1 passed; real Electron fixture passed in 5.382 seconds.
- `npm exec vitest run tests/platformBrowserAutomation.test.ts -- --reporter=verbose`: 7 passed, including exact post-resume stale-generation fencing and refreshed owned-session credentials.
- `npm exec vitest run tests/platformBrowserViewer.test.ts -- --reporter=verbose`: 2 passed, including takeover/resume and a separate explicit screenshot observation.
- `npm run typecheck`: Node and web TypeScript passed.
- `git diff --check`: passed.

## Limits

The provider is scripted and the form server is local; no live model, account, credential, or external website is used. Hidden Electron screenshot capture remains platform-dependent. E2E09 relies only on the structured post-resume observation; optional screenshot capture remains separately requested and separately tested against the managed browser.
