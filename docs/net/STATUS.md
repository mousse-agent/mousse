# Mousse Net recovery status

Updated 2026-10-03. Tracking: [issue #44](https://github.com/mousse-agent/mousse/issues/44), [draft PR #45](https://github.com/mousse-agent/mousse/pull/45). Integration branch: `codex/issue-44-mousse-net`.

I recovered the interrupted Claude thread and continued its existing isolated worktree. I preserved the primary checkout's unrelated edits. The published recovery starts at `d3f9433`; the next checkpoint adds the reviewed contracts, codecs and fixtures described below. Bridge and Spaces are not yet application features.

## Phase gates

| Phase | Current evidence / next gate |
|---|---|
| P0 contracts | Astra and Sol 6.1, both at extra-high effort, found no remaining technical contract blocker. See [review record](reviews/p0-contract-review.md). Types, schemas, signed wire codecs, consumer contracts, state machines, threat model and fixture catalogues are present. |
| P0 coordination | Satisfied by the owner’s explicit adoption on 2026-10-03. I am proceeding with the reviewed binding; I do not claim teammate agreement. |
| P1 foundation | Identity, SQLite/file storage, accounting primitives, mux/routes/transports and authenticated sync services are implemented in the isolated task branch. Focused service and fault checks are listed below. Astra and Sol independently found no remaining concrete blocker in the final inspected foundation paths; see [P1 review](reviews/p1-foundation-review.md). This is a scoped foundation checkpoint, with later consumer conformance owned by its implementation phase. |
| P2 enrollment | Exporter-bound `mj1_` enrollment, durable retry receipts, quarantine gates, local CLI and profile-owned daemon composition are implemented in draft PRs #48/#49 and the integration branch. Real TLS/SIGKILL checks pass; independent review and encrypted headless protection/transfer/recovery composition are in progress. |
| P3–P4 Bridge | Remote operations, dispatch and add-on transports remain. |
| P5–P6 Spaces and bots | Host/member/private-stream services, execution accounting, approval enforcement and containment qualification remain. Every runtime profile is currently unqualified. Exact local `sj1_` container encoding is deferred to P5. |
| P7–P8 Chats and GUI | The reviewed §4.10 binding is adopted. The remaining UI/Chats integration is in draft PR #47 after the earlier PR #41; it is incomplete and unmerged. I must re-inspect the actual merged implementation before binding networking features into it. |
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

The P0 coordination decision is recorded. I started four P1 workstreams against these contracts: identity, durable storage/accounting, link/mux/transports, and sync/session/authorization. Their integration gate is two real services exchanging signed events over memory and loopback direct transport, then resuming correctly under the specified injected faults. Contract review and a TLS echo do not satisfy that gate.

I am keeping PR #45 draft and issue #44 open. Authentication/authorization changes require teammate review before merge under the repository workflow; no merge has been requested or performed.

## P1 implementation checkpoint

I implemented the foundation against the reviewed contracts without adding application UI or enabling Spaces/bot execution. The shared identity transaction coordinator lets later enrollment commit roster and invite consumption together. Historical replay sends bounded original signed-roster evidence before event batches; compact live rosters retain old leases locally without granting current authority.

| Area | Accumulated focused evidence |
|---|---|
| Identity, private keys and local transfer | 35 tests; real filesystem/SQLite reopen, two-profile handoff, frozen crypto, nonce rollback, old lease verification, archived key epochs, atomic hello-size limits, real SIGKILL lock recovery and live-owner exclusion |
| Durable store, accounting and blobs | 40 tests, then 2 selected convenience-snapshot regressions after its wrapper changed and 4 selected corruption checks after physically fencing the shared connection; real process crashes, bounded incremental snapshot carry/completion, immutable committed positions, constant metadata activation, global 32-reader bound, durable corruption fence covering coordinated and raw identity writes, previously prepared statements and dead-reference GC |
| Sync integration and receiver boundaries | 27 tests; real authenticated memory/loopback TLS replication, signed live 105/replay 104 cut at durable 89 and direct resume, expired historical lease supplied to a fresh subscriber, 500-record wire snapshot, RPC cancellation before admission and during a started send, supervisor reconnect without mutation replay, unsubscribe during in-flight delivery, snapshot/live handoff, RPC restart, half-open ping timeout, production-authority blob fetch and stalled duplicate transfer/resource cleanup. Six replay/staging cases exercise the receiver directly; the slot-error case injects decoded dispatch into an authenticated session. |
| Mux | 20 tests including three raw ECONNRESET boundary regressions preserving causes |
| Routes, direct and memory transports | 8 route, 5 direct and 3 memory tests; real loopback WebSocket carrying pinned mutual TLS and large fragmented messages |

The meta-snapshot validator is an incremental append/finish seam with persisted carry capped at 64 KiB. Each staging transaction holds at most 499 data rows plus one progress row and at most 1 MiB. The P5 authenticated projection supplies that validator; absence fails closed. Snapshot activation checks the captured generation/epoch/cursor/head/retained-prefix guard and changes only metadata. Ordinary replay is bounded separately.

The normal session rejects enrollment traffic, requires a pinned root and certificate-bound delegation, rechecks current authorization, and bounds subscriptions, RPCs, blob transfers and source snapshot jobs. Same-user node threads use the production authority. Space streams, artifact access and blob uploads remain closed until their domain guards exist. The durable RPC dispatcher stores request aliases and outcomes; cancellation or a result gap after an effect produces uncertainty instead of silently replaying it.

The identity archive remains a bounded 1 MiB checkpoint and fails before mutation when full. OS vault packaging, whole-profile rollback protection, live authority-transfer delivery and persisted route-version composition remain later qualification/composition work. The private-key service requires phase-owned controller/recipient validation; its body-only methods do not provide that authorization.

### Fixture ownership

P1 executes foundation codec/signature, identity, persistence, cursor, transport, session and durable RPC invariants. P0 froze consumer vectors before their implementations: full Space meta/participant/history authorization remains P5; per-bot admission, approval, adapter containment and runtime effects remain P6. Those vectors remain required at their own gates. Fixture loading and lower-layer tests do not prove those later services.

Node and web TypeScript checks and whitespace checks passed at this checkpoint. I kept the full test suite unrun. Independent scoped foundation review completed without remaining concrete blockers.

The final changed mux/sync run passed 47 checks (20 mux and 27 sync). The source Node typecheck and scoped strict test typecheck passed after the review fixes; the earlier web typecheck covers the unchanged browser/shared surface. I use the shared identity transaction coordinator in composed tests, and the physical SQLite fence additionally prevents raw writes on that connection.

## Whole-plan continuation and P2 checkpoint

I received authorization to implement every remaining phase and complete all testing, including use of subagents. I continue in isolated task worktrees and preserve the primary checkout. I have not merged into the default branch.

I verified supported macOS Node 24.20.0 and an isolated Linux Node 24.20.0 runtime with actual crypto/TLS/SQLite/PTY probes; see [environment evidence](qa/environment.md). These probes do not qualify packaged applications.

I implemented profile-owned NetService lifecycle, trusted local domain registration, bounded gateway handoff, signed route-version persistence and restart reconnection. Two real-profile tests pass. Eleven enrollment tests establish actual pinned TLS, same-exporter evidence, atomic one-use receipts, lost-response retries after restart, SIGKILL during redemption rollback, early-RPC rejection without registered effects and cumulative preauthentication limits. I reproduced and fixed revocation closing before roster propagation; the regression checks the follower adopted the exact signed roster. An independent review reproduced an active-RPC cancellation variant, which is being closed with a bounded revocation-only drain.

I am verifying the pasted-invite flow through separate actual daemon/CLI processes. CLI terminal interruption and actionable profile errors have independent findings under correction. Default headless key storage is plaintext with filesystem protections; I am enforcing the normative encrypted invitation-proof and transfer-secret requirement through explicit protect/unlock support. I do not describe plaintext storage as encrypted.

P2's final gate, P3–P9 implementation, real external transport qualification, packaged checks and the actual 24-hour soak remain. Tailscale/account prerequisites, a Cloudflare named-tunnel configuration and confirmation of shipped control clients are still requested; they do not block independent implementation work.
