# Mousse Net spikes

Reproducible scripts that back decisions in `docs/net/PLAN.md`. Each runs under system Node and under Electron's Node:

```sh
node scripts/net-spikes/<name>.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/net-spikes/<name>.mjs
```

| Script | Decision it supports | Result (2026-10-02, Node 24.18 and Electron 43.2 run-as-node, macOS) |
|---|---|---|
| `tls-pinned-der-cert.mjs` | Secure channel is TLS 1.3 from `node:tls` over any `Duplex`, mutually authenticated by pinned transport keys, with certificates from an in-tree DER encoder | Passed under both |
| `crypto-selftest.mjs` | All required crypto primitives, the actual in-tree certificate/channel code, TLS exporter equality, wrong-pin rejection of queued attacker bytes, and a real loopback `ws` stream carrying a pinned TLS echo | Passed under both |
| `sqlite-wal-backup.mjs` | Storage is `node:sqlite` in WAL mode with online backup | Passed under both |

The committed crypto self-test verifies: Ed25519, X25519, ECDSA P-256, AES-256-GCM, HKDF-SHA256 and scrypt are available under both runtimes. ChaCha20-Poly1305 is not required. `@peculiar/x509` was rejected because it requires a global reflection polyfill.

Not yet qualified: the packaged daemon process, Linux and Windows.

`crypto-selftest.mjs` bundles the actual TypeScript certificate/channel modules in memory with the existing build dependency `esbuild`. Run it from the repository root after installing development dependencies. Node 24.18 is the observed local runtime; the package declares Node >=24.20. Supported-version and packaged-daemon qualification remain required before release.

The loopback `ws` check qualifies the transport API under both runtimes. It does not claim that net services are already integrated into the MMS daemon; that lifecycle/composition check belongs to P2 and packaged qualification to P9.
