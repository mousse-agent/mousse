# Handoff: B01a Electron-attached existing-tab executor

Package: B01a (WG6 existing in-app tab executor)
Branch / worktree: `feat/platform-browser`
Base SHA: `3e35f9da1364acd99dda0d578cb857d7d553b880`
Implementation freeze SHA: `3b6c79318dc206e1a3bbd1917ba45a129e9b1c48`

This slice owns the Electron **main-process** attached backend for Mousse's existing BrowserPanel `<webview>` guests. It does **not** replace the managed Chromium worker, does not adopt `BrowserViewManager`, and does not implement a screenshot-only substitute browser. Root owns Liquid Glass Orb, `src/main/index.ts`, `GuiMmsController`, MMS/protocol/platform composition, preload, BrowserPanel, and package/build files.

G5 / full browser acceptance is **not** claimed. Root still owns the authenticated GUI bridge, UI control gating, and model binding.

## Exact APIs root must wire

Import from `src/main/browser/automation/index.ts`. Shared opaque DTOs live in `src/shared/browser/attached.ts` and are re-exported from `src/shared/browser/index.ts`. Electron native handles never appear in shared contracts.

```ts
import {
  ElectronAttachedBrowserBackend,
  TrustedGuestRegistry,
  wrapElectronWebContents,
  createFailClosedAttachedPolicy
} from '../../main/browser/automation'
import type {
  AttachedBackendConfig,
  AttachedCapabilityReport,
  AttachedControlState,
  AttachedThreadBinding,
  TrustedOwnerBinding
} from '../../shared/browser/attached'
```

Root observes `did-attach-webview` on the owning window (after existing `will-attach-webview` partition enforcement) and registers the **actual** guest `WebContents` plus its owner:

```ts
const registry = new TrustedGuestRegistry({
  expectedPartition: profileBrowserPartition,
  ownerBinding: ({ owner, guest, profileId, profileEpoch, uiTabId }) => {
    // Trusted main-only: window still bound to this profile/epoch/tab.
    return currentWindowBindingMatches(...)
  }
})

mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
  registry.registerGuest({
    guest: wrapElectronWebContents(guest),
    owner: wrapElectronWebContents(mainWindow.webContents),
    profileId,
    profileEpoch,
    uiTabId, // opaque BrowserPanel tab id, not webContents.id
    thread: threadId ? { kind: 'thread', threadId } : { kind: 'unbound' }
  })
})
```

A bare renderer-supplied `webContentsId` **cannot** establish ownership. There is no public `registerByWebContentsId`. `session.open` requires `uiTabId` of an already-registered guest; extra `webContentsId` params are ignored and never authorize.

### `ElectronAttachedBrowserBackend`

| Method | Meaning |
|---|---|
| `call(request, { signal?, timeoutMs? })` | `BrowserWorkerRequest` / `BrowserWorkerResponse` compatible. Validates envelope, injected policy, then guest owner/partition/epoch/thread binding **before every dispatch**. |
| `capabilities()` | Actual attached capability DTO. GUI-dependent. Unsupported methods are explicit. |
| `onControlStateChange(listener)` | Hook for root UI. Human keyboard/pointer/toolbar gating remains root responsibility. |
| `beginShutdown()` | Stop accepting new calls. In-flight work stays owned. |
| `getActiveCount()` | In-flight `call` promises still owned by this backend. |
| `shutdown({ timeoutMs? })` | Awaits owned operations, then detaches **our** debugger only. Wrapper timeout is **not** settlement of raw CDP; retry joins the same shutdown work. |
| `disconnectOwner(ownerId)` / registry revoke | GUI close: attached session disconnected. No claimed headless continuity. Human tabs are not destroyed. |

Constructor requires trusted injected `policy` and `journal`. `artifacts` is optional: missing writer → `observe` returns screenshot unavailable (warning, no file/data URL). No permissive production policy default; `createFailClosedAttachedPolicy()` denies everything.

### `session.open` params (attached)

```ts
{
  uiTabId: string
  threadId?: string
  runId?: string
  url?: string // navigate only when explicitly supplied AND policy allows
}
```

Opens against the **already loaded** guest page. Cookies, navigation, form values, and the profile partition are preserved. No new Chrome process, no remote-page preload, no `Target.setDiscoverTargets`. Unbound/pinned tabs require prior trusted `registry.assignThread(uiTabId, threadId)` — they are not universally accessible.

### Worker methods

Supported: `session.open`, `session.close`, `tabs.list`, `tabs.switch`, `observe`, `find`, `act`, `human.act`, `wait`, `extract`, `control.take`, `control.release`.

Clear `unsupported`: `tabs.new`, `tabs.close`, plus action types listed in the capability DTO (upload/download/OOPIF auto-attach are not certified here).

`session.close` releases the automation attachment (detach debugger we attached, revoke refs/leases, cancel waits/input). It does **not** destroy the human tab.

## Ownership paths

Writable here:

- `src/main/browser/automation/**`
- `src/shared/browser/attached.ts` (new) and additive export in `src/shared/browser/index.ts`
- narrow `src/browser-worker/cdp/transport.ts` plus type-only reuse in observation/action helpers
- `tests/platformElectronAttachedBrowser.test.ts`
- `tests/fixtures/agent-platform/electron-attached-browser/**`
- this handoff

Not touched: `src/main/index.ts`, `GuiMmsController.ts`, MMS/protocol/platform files, preload, BrowserPanel, package/dependency/build files, other existing shared browser contracts, Orb, `BrowserViewManager`.

## Debugger and revocation

- Attach `guest.debugger` only when `isAttached()` is false, or when this backend attached it.
- Never detach a debugger owned by another feature.
- Debugger detach, guest close, owner destroy, navigation (document change), and profile-epoch change revoke refs/leases, cancel waits/input, and classify already-dispatched actions as `unknown-effect`.
- Do not automatically retry consequential actions after disconnect.

## Honest limitations (not pretended)

| Item | Status |
|---|---|
| Existing live `<webview>` same-tab control | Required; this slice |
| Managed Chromium CLI/headless | Unchanged; not replaced |
| OOPIF / cross-process iframes | **unsupported** — no global Target discovery |
| Closed shadow DOM | **unsupported** |
| `tabs.new` / `tabs.close` | **unsupported** (would create/destroy pages; attached mode targets one existing tab) |
| Upload / quarantined download | **unsupported** in this backend (managed worker remains the certified path) |
| Device-metrics override | **not applied** — live tab viewport is preserved |
| Offscreen `Page.captureScreenshot` | Hidden-window fixtures may return `screenshot-unavailable`; viewport/DPR still recorded. No data/file URLs. |
| GUI close | Disconnects attached session; no headless continuation |
| Root authenticated bridge / BrowserPanel wiring / model tools | **not done** (WG0 / WG7) |
| G5 real-application acceptance | **not claimed** |

## Tests and evidence

```powershell
npx vitest run tests/platformElectronAttachedBrowser.test.ts tests/platformBrowserWorker.actions.test.ts tests/platformBrowserWorker.lifecycle.test.ts --maxWorkers=2 --reporter=dot
npm run typecheck
npm run build:cli
```

Local evidence (Windows, this freeze):

- Vitest: **3 files, 30 tests passed** (~65s, `--maxWorkers=2`)
  - `platformElectronAttachedBrowser.test.ts`: 9 fake-port races + 1 hidden Electron live-webview fixture
  - `platformBrowserWorker.actions.test.ts` and `.lifecycle.test.ts`: existing managed executor still passes
- `npm run typecheck`: `tsconfig.node.json` and `tsconfig.web.json` pass
- `npm run build:cli`: `out/cli/index.js` built after tests (not raced)

Fake-port races (no Electron): renderer `webContentsId` cannot own a guest; owner/partition/epoch/binding mismatch fail closed; unbound tab denied until trusted `assignThread`; takeover fences held input; shutdown timeout retains promise ownership and retry joins the same work; session close does not destroy the guest; foreign debugger is not detached.

Real hidden Electron fixture: existing `BrowserWindow` host (`show: false`) + live `<webview>` guest + loopback HTTP fixture. The page is opened on the guest first, then `session.open` attaches to that same guest. Observe/fill/click verified against live DOM (`name=Ada`, `saved:Ada:pwlen=0`) plus exactly one consequential POST (`/submit-once`), cookie `recovery=kept` and form value preserved. Takeover during a held click leaves POST count at 1. Human edit + release reject stale refs; a fresh observation is required. Stale navigation and profile-epoch revoke fail closed. `session.close` leaves the guest WebContents alive. Viewport/DPR metadata is recorded; `Page.captureScreenshot` on a hidden window is treated as `screenshot-unavailable` rather than a data URL (surface capture is not claimed for offscreen fixtures).

Windows fixture uses `windowsHide: true` and `show: false` BrowserWindows. Fixture roots are unique owned temp directories; loopback only; no user profile/account/network; no browser download.

## Downstream

Root composes:

1. `TrustedGuestRegistry` from `did-attach-webview` + profile epoch + `profileBrowserPartition`.
2. `ElectronAttachedBrowserBackend` beside `BrowserBroker` (managed).
3. Authenticated MMS bridge that never forwards raw CDP/evaluate or native handles.
4. BrowserPanel control gating from `onControlStateChange`.
5. M01 routing: explicit eligible in-app tab → attached; CLI/scheduled/headless → managed. No silent backend substitution.

## Freeze

Working tree is committed on `feat/platform-browser`. Implementation freeze: `3b6c79318dc206e1a3bbd1917ba45a129e9b1c48`. G5 / full browser / root bridge / BrowserPanel / model binding remain out of this slice.
