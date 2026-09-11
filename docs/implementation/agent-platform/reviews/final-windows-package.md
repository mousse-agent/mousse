# Final Windows directory-package verification

Date: 2026-09-11

Reviewed source freeze: `5e45d1eefcc2b17d6d5f2b94f858842883216c8d`

## Result

The corrected Windows x64 directory package passes isolated packaged CLI smoke checks. The candidate is at:

`C:\Users\bubbl\Documents\Projects\RYSPA\mousse\orchestration\windows-candidate-20260911\win-unpacked`

Its installed `resources/app.asar` is 209,336,240 bytes with SHA-256 `EFB718E613ABC85767FE961FAD9D1E0ECCF07144280FE1335EFF5D48B18F48AB`.

## Packaging and blocker found

After the original checkout passed typechecking and the full app/CLI build, I ran:

```powershell
.\node_modules\.bin\electron-builder.cmd --win --dir --publish never --config.directories.output=orchestration/windows-candidate-20260911
```

Electron Builder 26.15.3 completed a Windows x64 Electron 43.2.0 directory package using the configured local Electron distribution, with native rebuilding disabled and without signing, publishing, credentials, or downloads. The generated GUI executable has PE subsystem 2 and the CLI executable has subsystem 3. The archive contains the main, CLI, preload, and browser-worker entry modules; the browser worker and configured native dependencies are represented in `app.asar.unpacked`.

The first packaged CLI smoke exposed a production load failure: the generated main chunk imported `highlight.js/lib/core.js` and language paths ending in `.js`, while highlight.js 11.11.1 exports those subpaths without the extension. Help, version, and service status all failed before CLI dispatch.

Commit `5e45d1eefcc2b17d6d5f2b94f858842883216c8d` fixes the main-bundle normalization for the known `index`, `core`, `common`, and language subpaths and adds a regression that imports every generated highlight.js main-bundle specifier through native Node resolution. I reviewed the source diff and the generated specifiers against the installed package exports. Root then reported the following verification on the rebuilt source:

- Node and web TypeScript checks passed.
- Full app and CLI builds passed.
- The generated-main-import and real-Electron browser-worker packaging regressions passed: 2 files, 2 tests.
- The final full suite passed: 211 files, 1,528 tests passed, 1 skipped, and no unhandled errors.

The supporting logs are `orchestration/original-final-build.log`, `orchestration/original-packaging-fix-build.log`, and `orchestration/original-packaging-fix-tests.log` in the original checkout.

## Corrected archive construction

To avoid repeating Electron Builder's completed dependency traversal, I retained the original package and rebuilt only its ASAR payload with the installed official `@electron/asar` API:

1. Extracted the successfully packaged archive.
2. Replaced only `out` with the output rebuilt from source freeze `5e45d1e`.
3. Excluded the two source-map files that Electron Builder excludes.
4. Used `createPackageFromStreams` with exact per-file unpack flags derived from the original physical `app.asar.unpacked` tree.
5. Replaced `resources/app.asar` only after validating the reconstructed archive.

The official ASAR CLI's brace-glob packing path was unusable under the preserved dependency overlay because its minimatch dependency received an incompatible `brace-expansion` export (`expand is not a function`). That attempt did not produce the installed archive. The streams API avoided glob interpretation while retaining the same official ASAR implementation.

The original and reconstructed unpacked sets each contain 211 files with zero path differences. Every non-browser-worker unpacked file has the same hash. The browser-worker file also has the same SHA-256 because the source fix changed only a main-process chunk. The final archive contains 43,921 entries and no generated highlight.js import with an invalid `.js` subpath. The physical unpacked native files were preserved in place.

## Packaged smoke evidence

I ran the packaged `mousse-cli.cmd` from `win-unpacked` with `MOUSSE_HOME` set to the isolated task-owned directory `orchestration/windows-candidate-20260911/smoke-home-fixed`. Processes were hidden and no service was started.

| Check | Exit | Evidence |
| --- | ---: | --- |
| `--help` | 0 | Printed the complete CLI usage, including browser, agent, channel, service, control, and workflow commands; stderr was empty. |
| `--version` | 0 | Printed `mousse-cli 0.1.1`; stderr was empty. |
| `service status` | 0 | Reported `running: false`, `ready: false`, no PID, startup not installed, Windows platform, and the exact isolated home; stderr was empty. |

These checks also establish that replacing the archive did not trigger Electron's packaged-ASAR integrity rejection. Root independently ran the rebuilt installed Electron entry with `--cli --version` against another fresh home; it exited 0 and printed `mousse-cli 0.1.1`.

## Limits

This is a Windows x64 unpacked directory candidate. It does not qualify an NSIS installer, code signing, publishing, an installed upgrade, Linux, or macOS. The final candidate was reconstructed with the official ASAR streams API from a successful Electron Builder directory package rather than produced by a second complete Electron Builder traversal. Qualification did not access live accounts, models, browser downloads, credentials, or user state, and it did not start the MMS service or exercise PTY behavior at runtime.
