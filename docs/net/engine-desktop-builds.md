# The new networking's desktop builds

Every packaged app carries the release network helper (`mousse-helper` of mousse-net) for its own target, built
from the engine commit in `native/net-helper/ENGINE_COMMIT`. This is what the owner check
`phase1b.desktop-builds` judges, on six targets.

| Target | Rust target triple | Packaged on | Unpacked app (under `release/`) |
|---|---|---|---|
| windows-x64 | `x86_64-pc-windows-msvc` | `windows-latest` | `win-unpacked` |
| windows-arm64 | `aarch64-pc-windows-msvc` | `windows-11-arm` (GitHub-hosted) | `win-arm64-unpacked` |
| macos-arm64 | `aarch64-apple-darwin` | `macos-15` | `mac-arm64/Mousse.app` |
| macos-x64 | `x86_64-apple-darwin` | `macos-15-intel` | `mac/Mousse.app` |
| linux-x64 | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | `linux-unpacked` |
| linux-arm64 | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `linux-arm64-unpacked` |

## Building

Each target packages on a computer of its own architecture, or under emulation (macos-x64 under Rosetta, with an
x64 Node): the package carries the Electron and the native modules that npm installed there. The `dist:win`,
`dist:linux` and `dist:mac` scripts all build the helper (`node scripts/build-net-helper.mjs --require`) for the
computer's architecture; electron-builder's targets follow it too, or `--x64` / `--arm64`. Under Rosetta, run
`npm ci` with `npm_config_arch=x64`: without it Electron's installer fetches the arm64 Electron even for an x64 Node.

- `node scripts/build-net-helper.mjs [--require] [--arch x64|arm64 | --target <triple>]` builds the helper into
  `native/net-helper/target/package` with `cargo build --release --locked --target <triple>`, honouring
  `CARGO_TARGET_DIR`. A target other than the computer's own needs `rustup target add <triple>`.
- The helper names its build in `--version` (`mousse-helper <version> build <commit>+release control none`), from
  the commit it was built from. The script does not pass `MOUSSE_BUILD_ID` to the build, and stops when a helper it
  can run here names anything else.
- Next to the helper, the package has `ENGINE_COMMIT` and `TARGET`.
- `.github/workflows/package.yml` packages all six and checks each app's helper.

## For the build smoke

`tools/build-smoke.mjs` in mousse-net runs, for each target:

    node scripts/check-packaged-net-helper.mjs <unpacked app> [--expect <build>] [--start]

- It finds the helper in the unpacked app (`resources/net-helper/mousse-helper[.exe]`, or
  `Contents/Resources/net-helper/mousse-helper` in `Mousse.app`) and runs its `--version`.
- The build must match `--expect`, or `MOUSSE_BUILD_ID` when it is set (the kit sets it to the build under test),
  or `<ENGINE_COMMIT>+release`. The commits may be abbreviated. A dirty build, another profile or a must-fail control
  fails.
- `--start` starts the packaged app headless as a startup entry does: `<executable> --cli service run` in a new
  `MOUSSE_HOME`, with `--ozone-platform=headless --disable-gpu` and no sandbox on Linux. It waits for
  `Mousse MMS running (headless)` (at most `--start-wait-ms`, 120000 by default), then runs `service stop`.
- It prints `helper=`, `helper_build=` and `helper_target=` (then `app_started=<ms>` with `--start`) and ends with
  `net helper: ok`. On failure it exits 1 with `net helper: FAIL reason=<word>`: `no_app`, `missing_helper`,
  `helper_does_not_run`, `stale_helper` or `app_not_started`.

The `stale-helper` control sets `MOUSSE_BUILD_ID=0000000+release`, which this check fails as `stale_helper`.

An installed app also checks its helper: when the helper's hello names a build other than `ENGINE_COMMIT` beside it,
the switch turns off and reads "Networking helper doesn't match this app".
