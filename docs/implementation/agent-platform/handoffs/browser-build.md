# Browser worker build and Electron launch

Root adds the managed browser worker to normal CLI/daemon builds and watch mode. `scripts/build-browser-worker.mjs` exports reusable esbuild options and enforces an Electron-free owned browser engine at build time. CLI builds produce both `out/cli/index.js` and `out/browser-worker/index.mjs`; the existing full app build already invokes the CLI build. Watch mode watches both graphs and disposes both contexts.

The app packaging includes `out/**/*`; the separate CLI packaging now explicitly includes the worker. Both unpack `out/browser-worker/**` from ASAR. `browserWorkerModulePath(applicationRoot)` accepts only an absolute trusted application root and resolves the unpacked location for packaged builds, or the normal output for development. Missing output reports `setup_required`.

`BrowserBroker` now sets `ELECTRON_RUN_AS_NODE=1` for its child. MMS runs inside Electron in the app, so spawning `process.execPath` without that flag would launch another Electron application instead of the Node worker. No browser session or user data is taken from the regular browser installation.

Verification: the actual CLI build produced both artifacts; full node/web typecheck passed. `platformBrowserPackaging.test.ts` launches a real hidden Electron host, which uses the actual broker to spawn the bundled worker from an unpacked package-style directory and complete its framed handshake. With an intentionally empty browser cache the worker correctly reports `setupRequired: true`, proving the launch path without claiming browser capability or downloading another binary. The fixture verifies development and unpacked path resolution and uses isolated temporary homes.

This is build/launch qualification. Final packaged installer execution, download/update/rollback, full B03 actions, platform matrix, and MMS/browser/model/viewer composition remain required. Grok browser core `7042be6` is present in core but still awaits Sol review.
