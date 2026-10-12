# Applet runtime decision

I selected a sandboxed `WebContentsView` per active applet. A plain sandboxed iframe in the main renderer does not establish independent execution or termination. The native probe proves the selected guest has a separate renderer process, leaves the owner responsive during an infinite loop, and can be stopped independently by the main-process heartbeat watchdog.

Each guest has no preload, Node integration, desktop bridge, persistent browser profile, external resources, popups, or granted device permissions. A session-local protocol serves only the current immutable source document. Its response includes `Content-Security-Policy: sandbox allow-scripts`, and the document adds a nonce-based resource policy. The response sandbox is essential: merely blocking iframe navigation with a meta CSP still leaves an initial about:blank child realm able to recover WebRTC constructors. The response sandbox makes that descendant a separate opaque origin; the probe verifies access throws `SecurityError`.

The public `window.mousseApplet` API reports bounded, untrusted state, size, errors, and explicit conversation requests. Host ownership comes from authenticated GUI IPC and durable bundle lookup, never generated source. Console transport is restricted to the private bounded bootstrap sender. Browser dialogs and printing are disabled. A visible guest that loses its heartbeat is stopped; hidden and minimized guests are exempt from timeout.

A native clipping `View` contains the guest. Bounds arrive in host CSS pixels and are converted using the owning webContents zoom factor into native device-independent pixels. Guest zoom matches the host; OS display scaling remains Electron's responsibility. Clipping retains the guest's complete layout while preventing it from covering the composer. The probe verifies native compositor pixels, zoomed interaction, and geometry updates without waiting on guest JavaScript.

Three ephemeral partitions are reused per owning window across profile-manager recreation. Destroying a manager removes its document routes, guest views, download and owner listeners, and owner-capturing request handlers. Stateless denial remains installed between managers. Old document URLs never become valid in a replacement manager.

Run `node scripts/check-applet-runtime.mjs` on Linux with X11 and ImageMagick `import` available. It uses temporary Electron user data and production runtime modules without starting a development server. Cross-platform compositor and packaged-app qualification still require their respective environments.


## Scrolling presentation

Native views and Chromium's scrolling DOM do not move in one compositor transaction. Following scroll events alone can leave the native preview briefly covering a moving card header. I prepare a captured frame in the host DOM while the guest is stationary. Passive wheel input hides the native surface without waiting for a capture, IPC reply or image decode. After 300ms of idle time, current bounds restore the same guest. Guest scroll positions and visual invalidations are coalesced into bounded batches with trailing updates, so sustained document scrolling cannot exhaust the event budget and leave an older scroll image. Input notifications invalidate stale frames and refresh the cache while stationary; an immediate transcript gesture uses an empty fallback until a fresh frame is available. This preserves in-memory interaction state and avoids native positioning work during scrolling. Offscreen previews park their live guests without rerunning generated code. The three-guest owner limit remains: a new mount may release the oldest parked guest, with a non-error release event clearing its renderer handle. Temporary scroll suspension never makes a guest eligible for eviction. For evicted guests that must close, the owner/profile manager keeps a bounded ephemeral cache of DOM scroll positions (32 revisions, 64 targets each) and restores them after generated DOM setup on remount. It does not write these positions to disk. Source-panel scrolling and control-wheel zoom retain their default behavior.

`node scripts/check-in-thread-applets.mjs --document-scroll-only` verifies sustained root scrolling, the final cached frame, clipping, and retained live DOM/scroll state on an offscreen return. The runtime check verifies bounded oldest-parked eviction.

`node scripts/check-in-thread-applets.mjs --scroll-only` verifies actual header wheel input, DOM frame presentation, native surface suppression, retained guest identity/state, resumed bounds, and composer clipping.


## Appearance inheritance

I pass a validated, finite set of resolved visual tokens into each guest. Theme/accent colors, solid surfaces, typography, spacing, radii, semantic colors, controls, focus treatment and reduced-motion preferences update through an immutable bootstrap function without rerunning generated JavaScript. Acrylic settings never cross this boundary; applet surfaces remain opaque and backdrop filters are disabled.

The same shared document generator supplies standalone HTML exports. Thin scrollbars are enforced in the first important CSS layer, including nested scrollers, and reveal on hover, focus or scroll activity. The curated offline catalogue contains 25 actual Mousse Hugeicons; applets can create safe SVG elements with `mousseApplet.icon` or declarative `data-mousse-icon` markers. Generated canvas content can redraw on `mousse-appearance-change`.

`node scripts/check-applet-appearance.mjs` checks guest controls, icon geometry, scrollbar cascade/autohide, live appearance, acrylic exclusion, reduced motion, isolation and export parity. `node scripts/check-in-thread-applets.mjs --appearance-only` checks the production renderer/preload/IPC path and preserved guest identity/state.
