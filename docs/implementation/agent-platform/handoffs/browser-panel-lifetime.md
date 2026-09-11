# Existing in-app browser guest lifetime

Root implemented this prerequisite for B01a. It does not yet install the attached
executor, private command receiver or model tools in the app, and does not close G5.

## Behavior

`MainViewPanel` keeps BrowserPanel mounted beside terminal and agent destinations.
The manual surface stays mounted while the managed viewer is selected. Each thread
guest remains mounted when another thread or a thread with no visible tabs is selected.

`KeepMounted` has an opt-in `preserveLayout` mode. Active surfaces remember positive
dimensions using ResizeObserver. Inactive surfaces retain that size outside flex
layout, with opacity zero, pointer events disabled, `inert`, and `aria-hidden`.
The app's collapsed main area uses the same mechanism. Existing terminal/editor
panes retain the default hidden behavior. A pane never displayed falls back to its
container dimensions; this is not a requested automation viewport override.

BrowserPanel has a profile-keyed child, so changing the active profile destroys old
guests and clears transient state even when the next profile reuses a UI tab ID.
Explicit tab closure still destroys the guest. Overflow portals close when hidden;
the element picker cancels on tab/thread/mode/view changes and ignores late results
from a cancelled selection. The Electron popup attribute is emitted as a string
because React drops boolean attributes on the native webview tag.

## Evidence

- `node scripts/run-browser-lifetime-check.mjs`: 19 assertions in real hidden
  Electron against actual MainViewPanel, BrowserPanel, KeepMounted and appStore.
  Only unrelated destination panels are stubbed to avoid PTY/MMS/provider activity.
- The same real WebContents retains its document token, unsaved form value, cookie,
  scroll offset and 1040 × 581 CSS viewport across main-view, managed-viewer, thread,
  empty-thread and collapsed-panel transitions.
- Real injected element-picker cleanup, profile guest destruction, separate new
  profile cookies/form state, and explicit tab closure are verified.
- Inert ancestry and renderer hit testing exclude the hidden page. Injected input
  leaves state unchanged; full visible-window native focus/input qualification is
  still required alongside the attached executor's lease/takeover integration.
- `npx vitest run tests/browserTabs.test.ts --maxWorkers=1`: 11 existing tests pass.
- Node TypeScript passed; web TypeScript passed after correcting the Electron/React
  popup-attribute type mismatch.

Evidence is in `.mousse-dev/browser-lifetime-evidence/<unique-run>/result.json`.
The hidden-window capture is diagnostic: the compositor can return a stale frame.
It is not visual acceptance or proof of attached screenshot capture. This fixture
uses a unique owned Electron userData root and loopback page, with no browser download.

## Integration still required

Trusted did-attach-webview registration, per-window/profile-epoch revocation,
agent lease input fencing, authenticated artifacts, private reverse transport,
model tools and visible full-app tests remain separate. KeepMounted is UI lifetime
management, not a security boundary or proof that an automation backend has drained.
