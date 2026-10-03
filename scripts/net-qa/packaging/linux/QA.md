# Linux arm64 production CLI ASAR evidence, 2026-10-03

I built and ran the production CLI package from source
`9a72843ad9119bd9360cb5cc70494c32748a0976` (rollback base
`dfabc2cb03209845407b9149c0f62b9096f4916c` plus the reproduced exit-status fix).
The metadata stayed `main:out/main/cli.js`. Every network workflow child launched
the packaged `mousse-cli` executable; I did not substitute Node or a QA main.

## Actual runner and immutable artifacts

| Evidence | Actual value |
| --- | --- |
| Host build/driver | Linux aarch64, Node 24.20.0 |
| Electron | Official Linux arm64 43.2.0, embedded Node 24.18.0, ABI 148/N-API 10 |
| Pinned Node base | `node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2` |
| Owned runner image | `sha256:5b76b6bdca21cb566ccb9a7a149c824fa8472cbdf3de0df1a2a633b294f987ca` |
| VM kernel | Linux 6.8.0-100-generic aarch64 |
| Final ASAR SHA-256 | `cafe84fbc70af41f2577bca5ee4ba4556e8687d7376934669168d1f61ad18519` |
| Executable SHA-256 | `9c668b8b83bd454b772eb85c301e95a231689b3da79e20f0e428b2519f83175c` |
| Shipped unpacked reader SHA-256 | `448775dee7b218a38e0d2b4256443c91f8ea9af00e98a61d8e08358465497bbe` |
| Reader ABI | Linux arm64 N-API 8, manifest `qualified:false` |
| Selected vault | GNOME Keyring 42.1, Electron backend `gnome_libsecret` |
| Runtime libraries | GTK 3.24.38-2~deb12u3; NSS 2:3.87.1-1+deb12u4; libsecret 0.20.5-3; Xvfb 2:21.1.7-3+deb12u13 |
| Sandbox | Root-owned isolated container, `ELECTRON_DISABLE_SANDBOX=1` for production children |
| Networking | Docker `--network none`; owned loopback framed MMS/pinned mutual TLS only |

The official installer verified the Electron ZIP against package checksums;
`electron-v43.2.0-linux-arm64.zip` SHA-256 was
`50e1cdefbf8590e0d89b0276314a99c7b98e8eed732204c6f1a1c2a38376ed87`.
The owned Linux dependency copy retained its native builds; I corrected the
verified missing nonoptional lock packages with integrity verification. I did
not modify the shared Linux cache or another worktree's outputs.

[asar-final.json](evidence/asar-final.json) includes executable, native, production
CLI entry and inert supplemental entry hashes, exact SDK versions, and unpacked
ASAR metadata. SDK runtime resolution also succeeded through the actual helper,
not just a package manifest inspection.

## Reproduced failures and correction

I first ran the actual Electron binary in the original bare Node image and got
`libnspr4.so` missing. The owned runner image supplies the required libraries.
Root without a sandbox opt-out was rejected; a nonroot bind-mounted launch was
rejected because `chrome-sandbox` was not SUID 4755. Passing `--no-sandbox` allowed
startup but reached the strict Net CLI validator as an unsupported application
flag. The actual Electron environment opt-out solved this container setup
without broadening CLI flag acceptance or changing package metadata.

The first package lacked `@agentclientprotocol/sdk`, and MMS startup reported the
missing package. I verified the old Linux cache lacked both that SDK and yauzl
required by the current lockfile, corrected only the owned dependency copy, then
rebuilt. That mismatch was setup evidence, not a production bundling diagnosis.

The matched original production package then completed protected Bridge/public
Space originals and rollback/restart checks, but all four disabled commands
printed `cancelled` on stderr and exited **0**. The production entry unconditionally
called `app.exit(0)` after `runCliMain`; those command handlers intentionally set
`process.exitCode=130`. I changed only that success continuation to preserve the
explicit exit code, retaining the existing rejection exit 1 and foreground
before-quit drain. [negative-exit-red.json](evidence/negative-exit-red.json) records
the real original ASAR hash, error bodies, physical exit statuses and cleanup.

Four focused actual-entry contract cases and two existing daemon lifetime cases
passed under Linux Node 24.20. Source TypeScript and scoped ESLint passed. I then
rebuilt once from the fixed source and verified the failure through the final
actual production ASAR.

## Final production workflow

[production-final.json](evidence/production-final.json) records **44 checks**, the
exact executed driver hash and unchanged package hashes.
[executed-driver.json](evidence/executed-driver.json) retains its original UTF-8
source bytes. The reusable driver differs only by trimming one whitespace-only
line after execution; I reviewed that nonsemantic difference and did not repeat
the unchanged payload checks. Version/help exited 0. Missing
Bridge rename arguments and an unknown Net subcommand exited 2. Four disabled
Bridge/Space/init/list commands each returned stderr `cancelled`, empty stdout,
and physical exit **130**.

A/B enrolled with one genuine Root and distinct protected nodes. B created one
remote thread with a stable RPC ID, repeated the original, queried its result,
listed/read it and received a complete CLI-decoded signed snapshot. The target
SQL alias table showed exactly one execution for `threads.create`. This snapshot
was provider-free and small; it does not qualify multipart GUI delivery or
provider execution.

A/C/D used three independent Roots in one public Space. Each posted one genuine
original, reaching `sent`; all three replicas matched exact event IDs, author
user/node identities and Host positions 1:1, 1:2, 1:3. I disabled C, verified
immediate mutation denial, restarted it still disabled, unlocked it while still
off, and explicitly opted in. Its outbox envelope/signature/state/attempt/position
bytes stayed identical, SHA-256
`2d9ee4c408b537e53a1fff5f79cb93cacd99ffce33cbecf44ff19ccb279a8bf9`.
The original three records remained readable after explicit opt-in.

All five actual daemon generations exited gracefully with status 0 within the
bounded cleanup wait. No SIGKILL fallback was used, no owned child remained, and
no live process command referred to this package executable before container
exit. The container then removed its owned profiles, display/bus/keyring state.

## Separate same-ASAR native/vault evidence and limits

[asar-runtime-final.json](evidence/asar-runtime-final.json) came from the inert
supplemental entry inside the exact final ASAR, launched by the same official
Electron distribution. Production metadata was not overridden. The actual SDK
helper resolved 0.85.1; the shipped unpacked reader performed a bounded read,
rejected a symlink escape and denied root, and the real safeStorage-backed
FileKeyStore encrypted/reopened with the same public node key. The selected
backend was `gnome_libsecret`; I did not accept the weak `basic_text` backend.
See Electron's [safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
for that backend distinction.

The probe reports `productionReaderQualified:false` and `billingQualified:false`,
and the resource manifest remains `qualified:false`. I did not activate a paid
provider, production Native adapter, or reader qualification. This evidence is
Linux arm64 `--dir`, root/sandbox-disabled, Xvfb/GNOME-session CLI and scoped
supplemental runtime evidence. It does not qualify Windows, Linux x64/AppImage,
production sandbox/signing, terminal native execution, private Spaces, archive
workflows, full renderer/preload, paid billing or the complete P9 release gate.

Exact retained logs on the task host:

- `/private/tmp/mousse-net-linux-electron-loader.log`
- `/private/tmp/mousse-net-linux-nonroot.log`
- `/private/tmp/mousse-net-linux-production-domains-2.log` (original exit red)
- `/private/tmp/mousse-net-linux-cli-exit-check.log` (six focused checks + TS/lint)
- `/private/tmp/mousse-net-linux-electron-final-build.log`
- `/private/tmp/mousse-net-linux-production-final.log`
- `/private/tmp/mousse-net-linux-final-vault.log`
- `/private/tmp/mousse-net-linux-asar-final-manifest.json`
