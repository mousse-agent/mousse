# Applet runtime decision

Each running applet is a `<webview>` in the window's own page, drawn where its card or panel is. Its page runs in its own renderer process and its own session, which the main process owns and can stop. A plain sandboxed iframe in the main renderer would share the window's process, so a loop in an applet would freeze the window and nothing could stop it alone.

## Why a webview, not a native view

Applets used to be a native `WebContentsView` laid over the window at the card's position. A native view is not part of the page: it moves in a different compositor step from the page's own scrolling, and it draws above everything in the page. Following scroll events left it a frame behind the card, so scrolling flickered, and it covered the composer, menus, tooltips and the title bar (on macOS it drew over all of them). Keeping it in place took a cached picture of the applet shown while scrolling, a clip path, suspend and resume, and hand-off rules between the picture and the live view.

A webview's page is composited inside the window's page. The page's own scrolling, clipping, z-order and zoom place it, so none of that machinery exists any more: the applet moves with its card in the same frame, sits under the composer, menus and dialogs, and is clipped by the conversation like any other content.

## What a page may do

The renderer chooses nothing about an applet's page. `applets:mount` returns an address the main process minted for that mount, `mousse-applet://runtime/<uuid>`, and the card draws a webview with only that `src`. In `will-attach-webview` (`src/main/index.ts`) an `mousse-applet:` address is routed to `AppletRuntimeManager.attach`, which:

- refuses an address it did not mint, an address already claimed, and any webview that names its own `partition` or `preload`;
- removes every inherited preference except zoom and default fonts, then sets the applet's own: its slot partition (in memory, never persistent), `sandbox`, `contextIsolation`, no Node integration anywhere, `webSecurity`, no plugins or nested webviews, no popups, no dialogs, transparent, and background throttling.

`did-attach-webview` hands the guest to the manager, which marks it as an applet page and denies new windows, navigation, redirects and nested webviews, reports crashes and hangs, and ends it when its element goes. The Browser panel's webviews take a separate path that this does not change.

Each guest has no preload, Node integration, desktop bridge, persistent browser profile, external resources, popups, or granted device permissions. A session-local protocol serves only the current immutable source document. Its response includes `Content-Security-Policy: sandbox allow-scripts`, and the document adds a nonce-based resource policy. The response sandbox is essential: merely blocking iframe navigation with a meta CSP still leaves an initial about:blank child realm able to recover WebRTC constructors. The response sandbox makes that descendant a separate opaque origin; the probe verifies access throws `SecurityError`.

The public `window.mousseApplet` API reports bounded, untrusted state, size, errors, and explicit conversation requests. Host ownership comes from authenticated GUI IPC and durable bundle lookup, never generated source. Console transport is restricted to the private bounded bootstrap sender. Browser dialogs and printing are disabled.

## Stopping a page

Removing the webview ends its page. A visible guest that loses its heartbeat for five seconds is reported as stopped and its renderer is ended; guests out of sight, and guests in a hidden or minimized window, are exempt. A crashed or hung page is reported to its card as an error.

Three ephemeral partitions are reused per owning window across profile-manager recreation. At most three applets run per window. A card out of sight tells main (`applets:visible`), and a new mount may release the oldest of those; its card drops the webview and starts again from saved state when it comes back. Destroying a manager removes its document routes, guests, download and owner listeners, and owner-capturing request handlers. Stateless denial remains installed between managers. Old document URLs never become valid in a replacement manager.

## Scrolling and wheel

A card scrolled away keeps its webview and its page, with all its in-memory state; nothing is captured or suspended. Chromium chains a wheel turn the page cannot use (nothing in it left to scroll that way) to the conversation, so the conversation scrolls under the pointer as it would over any other content. The conversation's own wheel listeners (following the end of a streaming turn) do not hear a chained turn, so the page reports each one it could not use (`wheel`, bounded and rate-limited) and the card replays it as a wheel event on the webview element, which bubbles to the conversation. The replay only informs listeners; it does not scroll anything.

A long thread (over 40 turns) mounts only the turns near the screen. A turn it unmounts takes its card and page with it, and the page starts again from saved state when the turn comes back, as a released page does. Keeping such a turn mounted would mean splitting the transcript's spacers around it; since three running pages at most can be kept anyway, every applet must already come back well from saved state, so that restore is the one path.

For a guest that was released and must start again, the owner/profile manager keeps a bounded ephemeral cache of DOM scroll positions (32 revisions, 64 targets each) and restores them after generated DOM setup on remount. It does not write these positions to disk.

## Evidence

`node scripts/check-applet-runtime.mjs` runs the production manager in a window that draws applets in webviews, without a development server, and checks:

- isolation: an unminted, partitioned or preloaded webview is refused, a second claim is refused; the page has its own process and in-memory session, `top === window`, no `require`, `process` or host bridge, no network, file or storage access, no popups, WebRTC throws `SecurityError` in a child frame, device permissions are denied, it cannot navigate away, and Escape returns focus to the window;
- stopping: removing the element ends the process; a looping page is stopped by the watchdog and the window stays responsive;
- 120 wheel steps over the conversation with every frame captured: the card's name strip and its page never separate and the page is never blank;
- layering: the composer, a menu, a tooltip, a dialog and the title bar draw over the page;
- scrolling into view or focusing inside the page does not scroll the conversation;
- an unpainted page shows the window behind it;
- a page scrolled 5,000 px away and back is the same page with the same state;
- at window zoom 1.25 the page zooms with it and stays interactive.

`node scripts/check-in-thread-applets.mjs` runs the production card, preload and IPC: the minted address with no renderer session, a click saved through IPC, the page under the composer and a menu, an inner scroller taking the wheel before the conversation does, the same page and unsaved state after scrolling away, and a live theme change.

`tests/applet-runtime-input-electron.test.ts` covers which wheel turns the page reports and which scroll the conversation; `tests/renderer/appletWebview.test.ts` covers when a card starts, parks, restarts and closes its page.

Measured against the native view on macOS with three running applets: the same guest memory (about 275 MB together), the whole app within 5 MB, no idle CPU, and the same 50 to 90 ms from mount to ready.

## Appearance inheritance

I pass a validated, finite set of resolved visual tokens into each guest. Theme/accent colors, solid surfaces, typography, spacing, radii, semantic colors, controls, focus treatment and reduced-motion preferences update through an immutable bootstrap function without rerunning generated JavaScript. Acrylic settings never cross this boundary, and backdrop filters are disabled. In the app the page itself is unpainted (the webview is transparent), so the chat or panel behind it shows through, its theme surface or the acrylic window; surface tokens stay solid, so whatever an applet paints is opaque. Standalone exports keep the opaque theme surface as the page background. Token values are read on one line, and a value the guest would refuse is left out rather than rejecting the whole appearance.

The same shared document generator supplies standalone HTML exports. Thin scrollbars are enforced in the first important CSS layer, including nested scrollers, and reveal on hover, focus or scroll activity. The curated offline catalogue contains 51 actual Mousse Hugeicons, listed by name in the applet guidance; an unknown name draws a dotted placeholder instead of stopping the script. Applets can create safe SVG elements with `mousseApplet.icon` or declarative `data-mousse-icon` markers. Generated canvas content can redraw on `mousse-appearance-change`.

`node scripts/check-applet-appearance.mjs` checks guest controls, icon geometry, scrollbar cascade/autohide, live appearance, acrylic exclusion, reduced motion, isolation and export parity. `node scripts/check-in-thread-applets.mjs` checks the production renderer/preload/IPC path and that a theme change keeps the same page and its state.
