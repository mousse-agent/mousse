# Mousse Net spikes

Throwaway scripts that back decisions in `docs/net/PLAN.md`. Each runs under system Node and under Electron's Node:

```sh
node scripts/net-spikes/<name>.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/net-spikes/<name>.mjs
```

| Script | Decision it supports | Result (2026-10-02, Node 24.18 and Electron 43.2 run-as-node, macOS) |
|---|---|---|
| `tls-pinned-der-cert.mjs` | Secure channel is TLS 1.3 from `node:tls` over any `Duplex`, mutually authenticated by pinned transport keys, with certificates from an in-tree DER encoder | Passed under both |
| `sqlite-wal-backup.mjs` | Storage is `node:sqlite` in WAL mode with online backup | Passed under both |

Also established by ad-hoc probes: Ed25519, X25519, ECDSA P-256, AES-256-GCM, HKDF-SHA256 and scrypt are available under both runtimes; ChaCha20-Poly1305 is not available under Electron 43, so it is not used. `@peculiar/x509` was rejected because it requires a global reflection polyfill.

Not yet qualified: the packaged daemon process, Linux and Windows.
