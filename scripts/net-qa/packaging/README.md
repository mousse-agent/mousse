# Scoped packaging qualification

I use this probe to check the emitted production build and, on macOS, an unsigned
task-owned `--dir` app. It makes no provider requests and prints only public
versions and fixture booleans. It does not activate NativeBotRuntime, reader
qualification, or paid billing. Complete Hub/Space/GUI packaging remains a
separate gate.

The QA electron-vite config retains the production main and CLI entries and adds
one probe entry. `mac-app` selects that probe through isolated app metadata. Its
SDK check uses the actual `nativeSdkVersion()` implementation and its reader
check loads the binary shipped in `app.asar.unpacked`. Its Electron vault check
waits for `app.whenReady()`, creates an isolated FileKeyStore, and reopens it using
the actual safeStorage codec. Keys and ciphertext are never printed. Temporary
profiles and the QA package are removed when the runner exits normally.

```sh
# Use the pinned Node 24 runtime and installed dependencies.
node scripts/net-qa/packaging/run.mjs node
node scripts/net-qa/packaging/run.mjs electron
# macOS only; uses installed Electron and disables signing of the QA app.
node scripts/net-qa/packaging/run.mjs mac-app
```

Each run builds the standalone CLI, verifies its `--version`, and builds the
production main/CLI entries with the probe. The probe checks SDK version
resolution, actual bounded file reads, symlink escape rejection, and denied-root
rejection. Electron modes additionally require a successful safeStorage
roundtrip. `electron` on Linux requires an installed Electron runtime, display
environment, and working vault; a Node-only result is not Electron evidence.

`scripts/build-net-native-reader.mjs` builds only the current host's N-API 8
reader at package time. It requires a C++ compiler and installed Node headers;
`NODE_HEADERS` may name their `include/node` directory. It never downloads
headers. It emits `out/net-native/<platform>-<arch>/reader.node` and a manifest
containing source/artifact hashes and `qualified:false`. Both CLI and desktop
package configurations include and unpack that directory. Cross-architecture
packages need a matching native artifact and actual runner qualification;
this host build does not establish that evidence. Unsupported platforms do not
receive a reader binary.

## Evidence recorded on 2026-10-03

I reproduced missing native reader resources in the original macOS CLI package:
its ASAR contained zero `net-native` entries. The app itself ran
`mousse-cli 0.1.1` with `ELECTRON_RUN_AS_NODE` unset. After adding the build/resource
step, its ASAR contained the host reader and manifest, marked unpacked. I ran the
probe from the packaged app against that shipped binary, rather than the source
artifact. The probe main override is scoped QA; it is not a full application
startup qualification.

| Actual runner | SDK | File read / symlink / denied root | Vault roundtrip |
| --- | --- | --- | --- |
| macOS arm64, Node 24.20.0, emitted ESM | 0.85.1 | Passed | Node codec unavailable, no vault claim |
| macOS arm64, Electron 43.2.0 / embedded Node 24.18.0, emitted ESM | 0.85.1 | Passed | Passed after app ready |
| macOS arm64, actual unsigned CLI app ASAR, Electron 43.2.0 | 0.85.1 | Passed using shipped unpacked reader | Passed after app ready |
| Linux arm64, Node 24.20.0, emitted ESM, network disabled | 0.85.1 | Passed | Node codec unavailable, no vault claim |

The Linux check used the existing isolated Colima workspace with Linux-built
dependencies and Node image
`node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`.
The image already had a compiler and `/usr/local/include/node` headers. I
refreshed source/scripts/configuration while retaining its installed Linux
dependencies and ran the probe with Docker `--network none`.

I verified current standalone CLI and electron-vite main/CLI production outputs
are ESM (`package.json` has `type:module`). A forced CJS compatibility probe failed
on the import-only `@earendil-works/pi-ai` package exports before running. I have
not qualified CJS and did not change the production module format.

At the checked source checkpoint, the normal profile service did not import
NativeBotRuntime, and its ordinary CLI chunks did not include the reader or SDK
version helper. The additional QA entry exercises those actual implementations
in the production bundler/package, but does not prove production bot activation.
Every probe reports `billingQualified:false` and
`productionReaderQualified:false`. Linux Electron/vault, Windows, paid provider
billing, full GUI workflows, and complete packaged network domains remain
unqualified by this scoped evidence.
