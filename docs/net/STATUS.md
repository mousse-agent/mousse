# Mousse Net recovery status

Updated 2026-10-02. Tracking: [issue #44](https://github.com/mousse-agent/mousse/issues/44), [draft PR #45](https://github.com/mousse-agent/mousse/pull/45). Integration branch: `codex/issue-44-mousse-net`.

I recovered the interrupted Claude thread and continued its existing isolated worktree. I preserved the primary checkout's unrelated edits. The published recovery starts at `d3f9433`; the next checkpoint adds the reviewed contracts, codecs and fixtures described below. Bridge and Spaces are not yet application features.

## Phase gates

| Phase | Current evidence / next gate |
|---|---|
| P0 contracts | Astra and Sol 6.1, both at extra-high effort, found no remaining technical contract blocker. See [review record](reviews/p0-contract-review.md). Types, schemas, signed wire codecs, consumer contracts, state machines, threat model and fixture catalogues are present. |
| P0 coordination | Pending: §4.10 agreement or the owner's explicit decision. I checked issue #40; the original request is posted, but no teammate reply follows it. Silence does not establish agreement. |
| P1 foundation | Not implemented as integrated services. The certificate, pinned TLS channel, codec and test harness are available; identity/storage/mux/session/authorization implementations and conformance gates remain. |
| P2–P4 Bridge | Enrollment CLI, daemon lifecycle, remote operations and add-on transports remain. Exact local `mj1_` invite container encoding is deferred to P2. |
| P5–P6 Spaces and bots | Host/member/private-stream services, execution accounting, approval enforcement and containment qualification remain. Every runtime profile is currently unqualified. Exact local `sj1_` container encoding is deferred to P5. |
| P7–P8 Chats and GUI | The local Chats backend PR #41 is still unmerged. I must re-inspect the merged implementation before binding it. §4.10 remains a separate decision gate. |
| P9 release | Packaged daemon, supported Node version, other operating systems, migrations, restore drills, soak and feature rollout remain. |

## Verification actually completed

I ran focused checks only; I did not run the full suite. These are accumulated targeted runs, not a claim that one final command exercised all modules together:

| Area | Passing focused checks |
|---|---|
| Memory transport, fake clock and TLS test bed | 7 tests |
| Actual pinned TLS channel | 10 tests, including no outbound I/O without a pin and wrong-pin rejection before queued attacker bytes reach a consumer |
| Actual certificate encoder/extractor | 10 tests, including rejection of a non-P256 peer certificate |
| Wire schemas and signed codecs | 18 tests, including bounded decoding, exact signed bytes, invite/join proofs, mixed-epoch snapshots and request-scoped artifacts |
| Admission fixture integrity | 5 tests; edit references and distinguishable multi-bot inputs were corrected |
| Resume fixture integrity | 2 tests; the epoch-change case includes its authenticated prior frozen prefix |

The 52 focused tests establish their specific codec, TLS, harness and fixture behavior. Fixture loaders do not implement session, admission or crash recovery. P1+ must execute their expected decisions against real modules and reproduce the phase exit scenarios.

I ran `crypto-selftest.mjs` against the actual TypeScript channel/certificate modules under Node 24.18.0 and Electron 43.2.0 run-as-node on macOS. All 13 checks passed under each, including an actual loopback WebSocket stream carrying pinned TLS. Earlier TLS and SQLite WAL/backup spikes also passed under both runtimes. The package requires Node >=24.20.0; these runs do not qualify that supported version, packaged daemon composition, Linux or Windows. WebSocket daemon integration belongs to P2; P9 verifies packaging.

Node and web TypeScript checks passed, all committed JSON fixtures loaded, and whitespace checks passed. Independent review evidence and limits are recorded separately.

## Next implementation wave

After the P0 coordination decision, I can start four P1 workstreams against these contracts: identity, durable storage/accounting, link/mux/transports, and sync/session/authorization. Their integration gate is two real services exchanging signed events over memory and loopback direct transport, then resuming correctly under the specified injected faults. Contract review and a TLS echo do not satisfy that gate.

I am keeping PR #45 draft and issue #44 open. Authentication/authorization changes require teammate review before merge under the repository workflow; no merge has been requested or performed.
