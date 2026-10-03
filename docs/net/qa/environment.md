# Qualification environment prerequisites

I checked these prerequisites on 2026-10-03. These checks establish runtime availability; they do not certify any phase, packaged application, transport account, or release.

## Supported standalone Node on macOS

I downloaded Node **24.20.0** for Darwin arm64 from the [official release directory](https://nodejs.org/dist/v24.20.0/), after checking the [official release index](https://nodejs.org/dist/index.json). The downloaded archive's SHA-256 matched its entry in the official `SHASUMS256.txt`:

```text
node-v24.20.0-darwin-arm64.tar.gz
40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8
```

The task-owned installation is `/tmp/mousse-net-runtime-l9dp7l_5/node-v24.20.0-darwin-arm64`. The archive, checksum file, and `metadata.json` are in `/tmp/mousse-net-runtime-l9dp7l_5`. This temporary installation does not alter the user's global Node executable and must be recreated if the temporary directory is removed.

From the task worktree, I verified:

- The actual executable reports `v24.20.0`, Darwin arm64, Node module ABI 137.
- All 13 checks in `scripts/net-spikes/crypto-selftest.mjs` pass, including actual certificate/channel code, pinned mutual TLS, exporter equality, pinning rejection and loopback WebSocket TLS echo.
- The existing macOS `node_modules` loads `ws`, `esbuild`, `typescript` and `node-pty`; the Vitest CLI reports version 4.1.11 under Node 24.20.0.
- An actual `node-pty` child runs `/bin/sh`, produces the expected bytes and exits zero. `node:sqlite` opens a database and reports SQLite 3.53.4.

For subsequent process tests, launch the explicit executable so `process.execPath` inherits the supported runtime:

```sh
/tmp/mousse-net-runtime-l9dp7l_5/node-v24.20.0-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/net/<selected-test>.test.ts
/tmp/mousse-net-runtime-l9dp7l_5/node-v24.20.0-darwin-arm64/bin/node scripts/build-cli.mjs
/tmp/mousse-net-runtime-l9dp7l_5/node-v24.20.0-darwin-arm64/bin/node out/cli/index.js --home <task-owned-home> service run
```

If a build script launches tools by name, prepend this installation's `bin` directory to that command's `PATH`; do not change global Node.

## Electron host

The worktree's Electron distribution reports Electron **43.2.0**, bundled Node **24.18.0**, Darwin arm64, module ABI 148. Its bundled Node is distinct from the standalone Node engine requirement.

I ran:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/net-spikes/crypto-selftest.mjs
```

All 13 checks pass. An actual run-as-node `node-pty` child also emits the expected bytes and exits zero; `node:sqlite` reports SQLite 3.53.1. This is a development runtime probe, not packaged-daemon qualification or OS-vault encryption evidence. The production credential-capable daemon uses Electron main mode after `app.whenReady()`; run-as-node alone does not establish `safeStorage` availability.

## Linux runtime

I pulled the [official Node Docker image](https://github.com/nodejs/docker-node/blob/main/README.md), selected Linux arm64, and recorded its immutable digest:

```text
node:24.20.0-bookworm
node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
```

An actual disposable task-owned container reports Node 24.20.0, Linux arm64, module ABI 137 and SQLite 3.53.4, and generates an Ed25519 key. The Docker host is Colima on Ubuntu 24.04.4 LTS aarch64, with six CPUs and about 8 GB RAM. I did not alter existing containers or images.

```sh
docker run --rm --name mousse-net-runtime-probe --platform linux/arm64 \
  node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2 \
  node --version
```

The macOS `node_modules` is **not** a Linux dependency installation. I reproduced `esbuild`'s platform mismatch and missing Linux arm64 `pty.node` when mounting it into this container. Linux application checks need their own dependencies/build. Colima cannot bind-mount the task's `/tmp` directory; the task-owned Linux dependency workspace is instead `/Volumes/xt1/code/RYSPA/mousse-net-qa-runtime/l9dp7l_5/linux-workspace`, outside the Git worktree.

I installed 1,042 packages there with `npm ci --ignore-scripts --no-audit --no-fund`, then ran `npm rebuild node-pty` in the pinned Linux container. I verified an actual Linux PTY child emits `mousse-net-linux-pty` and exits zero. The crypto self-test passes all 13 checks under Linux Node 24.20.0 with the isolated dependencies, including actual loopback pinned TLS over WebSocket.

The workspace contains a source copy from this prerequisite check; it must be refreshed from the current task worktree before later phase testing. Preserve its Linux `node_modules` when refreshing source. The Linux Electron binary/package, display libraries and production build are not installed or qualified by this step.

```sh
docker run --rm --name mousse-net-linux-selected-check --platform linux/arm64 \
  --mount type=bind,source=/Volumes/xt1/code/RYSPA/mousse-net-qa-runtime/l9dp7l_5/linux-workspace,target=/work \
  --workdir /work \
  node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2 \
  node <selected-script>
```

## Remaining external or duration-dependent qualification

- `cloudflared` 2026.3.0 is installed; the authenticated account and quick-tunnel HTTPS path are verified below. Mousse WebSocket/TLS and isolated named-tunnel scenarios remain.
- I found no Tailscale executable or installed application. Real qualification needs an installed, authenticated tailnet; fake supervision checks alone do not qualify it.
- Existing hosted CI includes Ubuntu Node 24.20.0 application checks and Windows focused tests. Neither presently certifies packaged networking. Linux and Windows package qualification scripts exist, but need the network scenarios and actual artifacts/runners.
- The P9 24-hour soak requires actual elapsed execution and measured resource bounds. Accelerated clock tests do not satisfy it.
- The Chats integration still depends on the published UI/backend. The owner authorized deprecating control clients; the replacement/cutover checks remain.

## Cloudflare probe and control cutover decision

I ran the installed cloudflared 2026.3.0 against an isolated loopback HTTP test server on 2026-10-03. Cloudflare created a quick tunnel and registered an HTTP/2 edge connection in Mumbai without authentication. The first HTTP probe failed in the local hostname resolver; direct DNS queries returned the public A records. I repeated the test with those measured DNS answers and hostname/SNI certificate verification retained: curl exited zero, HTTPS returned 200, and the body matched the unique local-server challenge exactly. I stopped both temporary processes after the check. This establishes the quick-tunnel HTTP path, not yet Mousse mutual-TLS/WebSocket or named-tunnel application qualification.

I also verified the existing account certificate with a successful cloudflared tunnel list. I did not print credentials or alter existing tunnels/DNS. No authentication action is currently required. A later named-tunnel test must use an isolated test resource.

The owner authorized Cloudflare tunnel testing and stated that existing control clients may be deprecated while this is a work in progress. I will carry out the P9 control cutover after verifying replacement paths; I no longer treat shipped-client confirmation as an unresolved owner decision.
