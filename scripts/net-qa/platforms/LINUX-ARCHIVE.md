# Linux signed-receipt archive qualification

I ran the focused archive checks at source
`6d67b65bd1a56805b228118282ac34c61d3d5a3e` in a separate owned worktree. I
cloned the existing Linux dependency installation; I did not update it or touch
other worktrees, running containers, or the ongoing soak. The current and
retained dependency lockfiles have the same SHA-256:

```text
d782ff76c282b915d976830fe833696a719dec3a2ee7ba5f10a0ed8ac7affbe9
```

I used the existing immutable Linux arm64 Node image:

```text
node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
```

An actual disposable container reported Node 24.20.0, Linux arm64, ABI 137,
SQLite 3.53.4, esbuild 0.25.12, a successfully loaded Linux PTY, and Native SDK
0.85.1 resolved from `/work/node_modules/@earendil-works/pi-coding-agent/dist/index.js`.
The SDK package manifest SHA-256 is
`f1738e4b42203e5f22bcb513f13fb2fb224f1e98d1f129ff042f87048665a94c`.
The cloned and retained installed `node_modules/.package-lock.json` also match:
`cad16946b09ff23a2d7609cf0d053cf4e8969a92e6afe6a96e85ddd5bc0bddbf`.
An initial probe used a non-exported SDK `package.json` subpath and failed before
testing. I corrected that probe to read the actual installed manifest while
retaining `import.meta.resolve` for the SDK entry; no production change was needed.

External networking was disabled using Docker `--network none`; actual loopback
TLS and local IPC remained available inside the isolated container.

## Focused scope

The committed runner uses the five files below with `--maxWorkers=1`. It records
source commit/tree, individual test input hashes, actual runtime/dependency
probe, exact image/network mode, test log hash, exit status, timeout, and cleanup.
It fails on changed tracked source/tests/configuration or mismatched runtime and
never installs dependencies or enables production qualification.

```sh
node scripts/net-qa/platforms/linux-archive-receipts.mjs
```

| File | Verified behavior |
| --- | --- |
| `bot-receipts.test.ts` | Four actual deterministic Native runs: public, sealed output, sealed trigger, and genuine foreign-user public trigger over TLS. Archived signed originals restore without another model call, execution, or budget change. |
| `multi-epoch.test.ts` | Successive composed private restores through three Space epochs preserve original bytes/signatures/placement while rotating genuine keys and nonce prefixes. Gapped, regressed, tampered, excessive, and wrong historical descriptor evidence denies. |
| `private-rotation.test.ts` | Real child SIGKILL after protected fresh bundle persistence, before SQL preparation; restart recovers identical key/control original and uses a fresh nonce namespace. |
| `private-activation.test.ts` | Higher-epoch activation atomically installs the original fresh control; injected transaction rollback preserves the frozen state, and refreshed signed routes reuse the exact prepared original. |
| `daemon.test.ts` | Two actual emitted Linux daemons move public/private history, retire the original authority, transfer Root authority, suffer physical prepared-bundle SIGKILL, restart locked, and explicitly activate/re-export/re-import exact originals. |

The bot cases each reject invalid signature, missing/substituted opening,
duplicate/missing/reordered acceptance, substituted trigger, missing mention,
missing historical bot delegation, and a genuinely Node-signed human-forged bot
receipt. A caller-supplied no-op bot verifier cannot bypass the mandatory proof.
Sealed cases additionally reject altered writer nonces/audience and unsupported
original permission/grant history. Foreign-public steering-policy substitution
also denies.

The public case makes a genuine deterministic Native call with missing charge
evidence. Its execution becomes `uncertain` after the provider task settles.
Import of the genuine earlier archive then denies `outcome_uncertain` before
changing the archive reference, generation count, frozen journal, execution,
stream list, or heads. This is actual persisted uncertainty, not a synthetic
caller boolean or an invented terminal receipt.

## Evidence and limits

All **8 tests in 5 files passed** in **86.90 seconds**, with exit code zero and
no timeout. Normal container cleanup completed without a forced removal and
left no owned container. I verified the tracked source/tests/build configuration
remained identical to the recorded source after the run.

For this run, evidence remains at
`.mousse-dev/net-qa/linux-archive-receipts/2026-10-03T12-15-44-419Z/`; the
selected-test log SHA-256 is
`1b7c05ae1dd3020341d5d19746435c681b4581bd4dcffce0e7be7417db0fa593`.
The convenience driver log is `/private/tmp/mousse-net-linux-archive-6d67b65b.log`.

The driver keeps a bounded run under
`.mousse-dev/net-qa/linux-archive-receipts/<timestamp>/`, ignored by Git. The
`evidence.json` points to `selected-tests.log`; both remain available in the owned
worktree. Exact owned container names are removed on completion/timeout, and
residual names are recorded. Existing containers and dependency installations
are preserved.

The deterministic local provider is immutable QA evidence only. These checks do
not establish paid-provider billing, reader approval/grant archive support,
foreign private-controller/current-proof support, Linux Electron/vault/ASAR,
Windows, full renderer behavior, or a complete P9/platform release. Unsupported
authorization and uncertain-effect denials remain in force. No macOS payload
gates or full suite were repeated.
