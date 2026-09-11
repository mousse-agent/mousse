# Sol browser panel lifetime review

## Reviewed revisions

- Browser lifetime implementation: `8fe03e6`.
- Core compatibility baseline: `27ea4e3`.
- Baseline merge in the review worktree: `a72dbb4`.
- Fixture qualification improvement: `3f98ab45b95d901bedc2182f0d5e2154fb440b37`.

## Assessment

No production source blocker was found in the bounded panel-lifetime changes. BrowserPanel remains mounted across main-view, managed/manual, thread, empty-thread, and collapsed-panel transitions. The same guest WebContents retains its document token, form value, cookie, scroll offset, and positive 1040 x 581 viewport. Inactive layout is absolute and outside flex sizing, with opacity zero, pointer events disabled, `inert`, `aria-hidden`, and focus blur. Existing non-preserving KeepMounted users retain `hidden` behavior.

The profile-keyed BrowserPanel child destroys the old profile's guests and transient picker/menu state. Browser tabs are excluded from installation-wide store hydration, so the always-mounted panel starts without a pre-binding guest; profile-local tabs enter only through profile activation. A reused UI tab ID in the next profile creates a distinct WebContents and partition with empty cookie/form state. Explicit tab close destroys it.

Picker cancellation is tied to active tab, thread, manual mode, panel visibility, and unmount. Its exact selection object fences late results, preventing attachment writes after cancellation. The floating menu is gated by manual visibility and closes on the same transitions.

## Evidence

- `node scripts/run-browser-lifetime-check.mjs`: 22 checks passed in hidden Electron using actual MainViewPanel, BrowserPanel, KeepMounted, appStore, two webview guests, a loopback document, and unique Electron userData.
- The fixture now derives coordinates from real guest controls, proves the visible location is a renderer hit target, and proves direct guest-native mouse and keyboard delivery changes the intended controls. It then hides the pane and verifies the same host coordinate no longer hits BrowserPanel and host-injected input leaves guest state unchanged.
- `npx vitest run tests/browserTabs.test.ts --maxWorkers=2`: 11 tests passed.
- `npm run typecheck`: node and web TypeScript passed in the combined tree.
- The diagnostic capture at `.mousse-dev/browser-lifetime-evidence/2a833265-9efb-4e26-8bc0-f67eeefeb772/browser-panel.png` was inspected. It contains a stale white guest frame, consistent with hidden compositor behavior, and is not visual acceptance.

## Remaining limits

The BrowserWindow stayed hidden. Direct guest-native positive controls establish valid element coordinates and input handling, while renderer hit testing establishes the active/inactive host target change; this does not qualify foreground OS focus or a visible native input route. The fixture does not qualify attached-executor leases, `did-attach-webview` registration, reverse transport, MMS profile epochs, screenshots, or model tools. KeepMounted is UI lifetime management and does not authorize automation or prove backend drain.
