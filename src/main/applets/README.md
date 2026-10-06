# Applet runtime decision

I selected a sandboxed `WebContentsView` per active applet. A plain sandboxed iframe in the main renderer does not establish independent execution or termination. The native probe proves the selected guest has a separate renderer process, leaves the owner responsive during an infinite loop, and can be stopped independently by the main-process heartbeat watchdog.

Each guest has no preload, Node integration, desktop bridge, persistent browser profile, external resources, popups, or granted device permissions. A session-local protocol serves only the current immutable source document. Its response includes `Content-Security-Policy: sandbox allow-scripts`, and the document adds a nonce-based resource policy. The response sandbox is essential: merely blocking iframe navigation with a meta CSP still leaves an initial about:blank child realm able to recover WebRTC constructors. The response sandbox makes that descendant a separate opaque origin; the probe verifies access throws `SecurityError`.

The public `window.mousseApplet` API reports bounded, untrusted state, size, errors, and explicit conversation requests. Host ownership comes from authenticated GUI IPC and durable bundle lookup, never generated source. Console transport is restricted to the private bounded bootstrap sender. Browser dialogs and printing are disabled. A visible guest that loses its heartbeat is stopped; hidden and minimized guests are exempt from timeout.

A native clipping `View` contains the guest. Bounds arrive in host CSS pixels and are converted using the owning webContents zoom factor into native device-independent pixels. Guest zoom matches the host; OS display scaling remains Electron's responsibility. Clipping retains the guest's complete layout while preventing it from covering the composer. The probe verifies native compositor pixels, zoomed interaction, and geometry updates without waiting on guest JavaScript.

Three ephemeral partitions are reused per owning window across profile-manager recreation. Destroying a manager removes its document routes, guest views, download and owner listeners, and owner-capturing request handlers. Stateless denial remains installed between managers. Old document URLs never become valid in a replacement manager.

Run `node scripts/check-applet-runtime.mjs` on Linux with X11 and ImageMagick `import` available. It uses temporary Electron user data and production runtime modules without starting a development server. Cross-platform compositor and packaged-app qualification still require their respective environments.
