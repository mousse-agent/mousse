# Sol review: attached browser main integration

Reviewed root candidate `eb0d9ed7be9a06ae211e04c8908f12d020258005`, then integrated root production composition `9be1772` and reviewed daemon closure-proof contract `60a3a7ad79d7267c84124625bc0fa1b0101104e4`. Main implementation freeze before this report: `8b7930a83592dd96af38ac204276ec2fa9e6d1a9`.

## Corrections

- Guest destruction and window release permanently close admission, revoke the trusted registry entry, await the affected tab's raw command promises, close retained backend sessions, and only then send private unregister. Late session-open success is closed locally before a denial is returned.
- Registration, selection, command dispatch, and shutdown are tracked per tab. Selection cannot overtake registration, overlap another selection, or change a pinned thread. Registration replies must echo every ownership ID and the main-only closure token exactly.
- Main generates the 256-bit closure token before registration dispatch. If the old connection disappears after an ambiguous register, the locally drained proof is retained and sent through a newly authenticated window connection bound to the same profile/epoch using `browser.attachments.acknowledgeClosed`. Tokens stay in main memory and are never sent to renderer/model/log output.
- `GuiMmsController` serializes concurrent opens for one sender, drains a disconnected session before replacement, retains failed close ownership for retry, and handles sender destruction during an in-progress open. Normal rebind drains/unregisters before `profiles.bind`.
- GUI connections request the exact `browser.viewer.v1` capability. The Electron controller imports the protocol client and protocol DTOs directly, avoiding the server/orchestrator barrel and its daemon-only provider dependencies.
- Main establishes the exact window MMS connection/profile binding before loading its renderer, so the first `will-attach-webview` cannot race an absent binding.

## Evidence

- `platformAttachedBrowserHost.test.ts` plus the reviewed real Electron executor: **2 files, 14/14 passed**. The host fixture proves trusted registration and command routing, a held raw input remains owned after guest destruction, unregister occurs only after unknown-effect settlement/backend close, control state is emitted, and an ambiguous disconnected registration is acknowledged with the retained proof on a same-profile replacement binding.
- Focused `GuiMmsController` live local-protocol connect/stop regression: **1/1 passed** (9 filtered).
- `npm run typecheck`: passed for node and web projects after final source changes.

The existing browser daemon composition test currently manually registers browser methods after root production composition began registering them automatically, so it fails at setup with `Duplicate domain method: browser.attachments.register`; the older command-capability fixture also assumes a server without the new automatic router. These fixtures require root-owned normalization and do not exercise the main host code. An actual full GuiMmsController + named-pipe daemon + hidden Electron webview + native provider E2E remains root-owned and is not claimed here.

## Remaining limits

- A hard main-process crash loses the in-memory closure token; socket close alone is intentionally not accepted as raw CDP settlement. Graceful release and in-process reconnect are covered.
- Replacement acknowledgement requires a window client bound to the original profile/epoch. There is no base-client or cross-profile acknowledgement path.
- Root still owns renderer/preload/IPC UI behavior and the final application E2E. The host remains limited to one registered existing guest per attached session and does not claim headless continuation after GUI loss.
