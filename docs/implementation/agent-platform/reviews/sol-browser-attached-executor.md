# Sol review: Electron attached browser executor

Reviewed candidate `9832c82428b9b9c2a2c46a8a2f03d8f141521537` (implementation `3b6c79318dc206e1a3bbd1917ba45a129e9b1c48`) after merging core baseline `7c9f5314d961b923cbdb4240b1c6da04766b7b6e`. The reviewed implementation fix is `d6ee61c213df3b38225302d09aa6099cc7470134`.

## Corrections made

- Raw `webContents.debugger.sendCommand` remains owned after caller cancellation, takeover, or wrapper timeout. The public operation settles only after the raw Electron promise settles. An internal CDP timeout detaches only a debugger attached by this backend, Electron's available way to force settlement; a dispatched action remains `unknown-effect` and is never retried automatically.
- Every existing-session method except idempotent `session.close` now rechecks the trusted guest owner, partition, profile epoch, and thread binding before dispatch.
- Top-level navigation renews the document generation and control lease, clears observations/references, emits the new control state, and fences a dispatched non-navigation action as `unknown-effect`.
- A process-global `uiTabId` collision from another owner window fails closed. The shared contract now states that per-window IDs must be host-namespaced. An already pinned tab cannot be rebound to another thread without trusted revoke and registration.
- Shutdown rejects invalid timeout values without closing admission. Timed-out shutdown retains the original operation/session ownership for retry.
- The fake transport gained deterministic raw-command entry synchronization. The hidden Electron fixture uses that synchronization instead of a timing sleep.

## Evidence

- `platformElectronAttachedBrowser.test.ts`: **13/13 passed**, including the hidden real Electron `<webview>` fixture. It attaches to the preloaded guest, preserves its form state and cookie, produces exactly one POST, fences takeover, accepts a fresh observation after human editing, and leaves the human guest alive on close. Hidden surface capture remains allowed to report `screenshot-unavailable`; viewport/DPR evidence is still checked.
- Attached + managed action/lifecycle combined run: attached and action suites passed, for **32 passed / 1 failed**. The failure was the existing managed Chromium ephemeral-directory immediate-deletion assertion. It reproduced with both two workers and one worker when run after the other files; the unchanged lifecycle file passed alone **7/7**. No managed worker implementation was changed in this review.
- Browser routing and artifact regressions: **3 files, 19/19 passed**.
- `npm run typecheck`: passed (`tsconfig.node.json`, `tsconfig.web.json`).
- `npm run build:cli`: passed, run after tests.

## Remaining host guarantees and limits

- Root must build the registry only from actual `will-attach-webview` / `did-attach-webview` ownership, enforce the profile partition, validate the live window/profile epoch in `ownerBinding`, and namespace BrowserPanel tab IDs across windows. Renderer numeric WebContents IDs are never authorization.
- Root still owns the authenticated bridge, BrowserPanel control gating, artifact writer injection, application lifecycle composition, and routing between attached and managed backends.
- An internal Electron command timeout conservatively disconnects that attached automation session because Electron has no per-command cancellation. It does not destroy the human tab. Caller cancellation can remain pending until raw settlement or the internal transport timeout.
- Cross-window tab switching is unsupported; an attached session controls one registered guest. OOPIF, closed shadow DOM, upload/download, and headless continuity on GUI close remain unsupported.
- Hidden-window `Page.captureScreenshot` may not settle successfully; the backend times it out, releases its own debugger, and returns structured observation with `screenshot-unavailable`. Surface capture is not claimed.
- This is the executor prerequisite, not full application or G5 acceptance.
