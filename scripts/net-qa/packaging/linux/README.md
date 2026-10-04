# Actual Linux Electron CLI ASAR qualification

I use these scripts only inside a disposable owned Linux arm64 container with a
separate dependency copy. The production package keeps `main:out/main/cli.js`.
`linuxProbe.js` is an inert supplemental entry in that same ASAR; it is never the
production main and never qualifies or starts a provider.

The Dockerfile starts from the immutable Node 24.20 arm64 image already used for
source qualification, then installs actual Electron display/libsecret libraries,
Xvfb, D-Bus and GNOME Keyring. `session.sh` creates only container-local display,
session bus and keyring state. Its disposable keyring password travels through
stdin. I remove `ELECTRON_RUN_AS_NODE` only from owned children. I retain all
package artifacts and public reports in this owned worktree; container profiles
and processes are removed when the container exits.

## Reproduction

Start with a new owned copy of Linux dependencies, never a symlink to macOS
modules or a write to the retained shared Linux cache. Check required lockfile
packages before packaging. The cache used in this run lacked ACP SDK and yauzl;
`refresh-dependencies.mjs` restored only missing/nonoptional version mismatches
from lockfile HTTPS URLs after verifying their SHA-512 integrity. It does not run
package scripts or replace the lockfile. Platform-specific optional dependencies
remain the Linux copy's responsibility; this qualification does not prove every
optional provider/runtime combination.

```sh
# Run environment setup against this OWNED directory only.
docker --context colima build --platform linux/arm64 \
  -t mousse-net-linux-electron-qa:dfabc2cb \
  -f scripts/net-qa/packaging/linux/Dockerfile .

# In a container mounted at /work, with the owned Linux dependency copy:
MOUSSE_OWNED_LINUX_DEPENDENCIES=yes node scripts/net-qa/packaging/linux/refresh-dependencies.mjs
node node_modules/electron/install.js
node scripts/build-net-native-reader.mjs
node node_modules/electron-vite/bin/electron-vite.js build \
  --config scripts/net-qa/packaging/linux/electron.config.ts
mkdir -p out/main
cp -R .mousse-dev/net-packaging/linux/main/. out/main/
node node_modules/electron-builder/cli.js --linux --arm64 --dir \
  --config electron-builder.cli.yml -c.electronDist=node_modules/electron/dist \
  -c.directories.output=.mousse-dev/net-packaging/linux/package-final
```

Installation needs network access. Execute the actual qualification with Docker
`--network none`, a bind mount of this owned directory at `/work`, and `/work` as
the working directory. All dialed MMS sockets and pinned TLS links are loopback
inside that container. Pass `MOUSSE_QA_SOURCE_SHA` explicitly to bind the public
report to the checked source commit.

```sh
scripts/net-qa/packaging/linux/session.sh \
  node scripts/net-qa/packaging/linux/production.mjs
node scripts/net-qa/packaging/linux/manifest.mjs

# Separate SAME-ASAR supplemental evidence, not the production CLI workflow.
export MOUSSE_PACKAGING_QA_DIRECTORY=/tmp/mousse-linux-probe
export MOUSSE_PACKAGING_QA_READER=/work/.mousse-dev/net-packaging/linux/package-final/linux-arm64-unpacked/resources/app.asar.unpacked/out/net-native/linux-arm64/reader.node
scripts/net-qa/packaging/linux/session.sh node_modules/electron/dist/electron \
  --no-sandbox .mousse-dev/net-packaging/linux/package-final/linux-arm64-unpacked/resources/app.asar/out/main/linuxProbe.js
```

`production.mjs` launches the actual packaged `mousse-cli` executable without an
entry override. Each command has a bounded child lifetime/output. It creates four
owned protected profiles: A/B share a Root after genuine enrollment; A/C/D are
independent Roots in one public Space. B exercises Bridge create/original retry,
result lookup, list/get and a completed CLI-decoded signed snapshot. A/C/D each
post an original message and read all three exact IDs/authors/positions. C is
disabled, restarted still off, explicitly unlocked while still off, then opted
in; SQLite outbox envelope/signature/state/attempt/position bytes must stay
identical. Disabled Bridge/Space/init commands must return stderr `cancelled`
and physical exit 130. Version/help must exit 0, missing/unknown domain arguments
must exit nonzero. Cleanup awaits actual foreground daemon exit and records any
forced fallback and remaining live package processes.

The container runs as root with `ELECTRON_DISABLE_SANDBOX=1`, which avoids leaking
`--no-sandbox` into application arguments. This is an explicit QA sandbox
condition. It does not qualify production sandboxing, SUID installation, x64,
AppImage distribution, signatures, full renderer/preload, Windows, private Spaces,
archive workflows, terminal execution, paid billing or production Native reader
activation. GNOME `gnome_libsecret` must be the actual selected safeStorage
backend; `basic_text` is not accepted by the probe. The probe verifies bounded
read, symlink and denied-root guards against the shipped unpacked N-API binary,
and a genuine encrypted FileKeyStore reopen. Its manifest and public result keep
`qualified:false`, `productionReaderQualified:false`, `billingQualified:false`.

I record the immutable artifact hashes, actual embedded runtime, reproduced
setup/exit failures and exact final evidence in [QA.md](QA.md).
