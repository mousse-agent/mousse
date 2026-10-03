# Mousse Net recovery status

Updated 2026-10-03. Tracking: [issue #44](https://github.com/mousse-agent/mousse/issues/44), [draft PR #45](https://github.com/mousse-agent/mousse/pull/45). Integration branch: `codex/issue-44-mousse-net`.

I recovered the interrupted Claude thread and continued its existing isolated worktree. I preserved the primary checkout's unrelated edits. The published recovery starts at `d3f9433`. Bridge and public Spaces now have profile-bound daemon/CLI composition in this draft branch; the remaining gates below still prevent a release claim.

## Phase gates

| Phase | Current evidence / next gate |
|---|---|
| P0 contracts | Astra and Sol 6.1, both at extra-high effort, found no remaining technical contract blocker. See [review record](reviews/p0-contract-review.md). Types, schemas, signed wire codecs, consumer contracts, state machines, threat model and fixture catalogues are present. |
| P0 coordination | Satisfied by the owner’s explicit adoption on 2026-10-03. I am proceeding with the reviewed binding; I do not claim teammate agreement. |
| P1 foundation | Identity, SQLite/file storage, accounting primitives, mux/routes/transports and authenticated sync services are implemented in the isolated task branch. Focused service and fault checks are listed below. Astra and Sol independently found no remaining concrete blocker in the final inspected foundation paths; see [P1 review](reviews/p1-foundation-review.md). This is a scoped foundation checkpoint, with later consumer conformance owned by its implementation phase. |
| P2 enrollment | Protected pasted-invite enrollment and authority transfer/recovery pass actual separate daemon-process restart, SIGSTOP/SIGKILL and lost-response checks on supported Node 24.20. |
| P3–P4 Bridge | Actual profile/CLI composition, multipart attachment, local rename display and original receipt recovery after killing both daemons pass. Composed deterministic native send/steer/abort and Dispatch through both shared remote and uploaded Git bundle pass, including signed downloadable results. Quick/named Cloudflare encrypted links and the composed Bridge quick-tunnel workflow pass; separate packaged/application transport exits remain. These native fixtures do not qualify paid billing. |
| P5–P6 Spaces and bots | Three actual independent protected daemons pass public conversation, original-ID/FIFO delivery and forced restart checks. Actual private discovery, incremental delivery, replay and retention snapshots pass with original foreign human/bot recipient leases and explicit scoped current proofs. Three independent profile/TLS Native bot execution and owner-approved safe reader continuation pass. Durable bots.add passes emitted CLI and crash/restart checks. The emitted protected three-owner reader/receipt-expiry gate passes at its clock checkpoint. Historical roster replay and protected restart heartbeat failures have separately reproduced red-to-green fixes; the combined emitted three-owner gate passes in 146.51 seconds. An earlier intermittent join setup cancellation remains unexplained. Production runtime profiles remain unqualified. |
| P7–P8 Chats and GUI | The reviewed §4.10 binding is adopted. I prepared a gated candidate combining the frozen PR #47 shell with Net in draft PR #50. Explicit publication, joined conversation pages, authorized public/private bot work and Chat-bound verified Bridge tasks pass their focused actual daemon/TLS checks. The default branch still lacks the prerequisite; candidate work does not satisfy that merge gate. Renderer integration and private aside composition remain in progress. |
| P9 release | Supported macOS/Linux Node 24.20 probes and macOS Electron/actual CLI ASAR reader+vault checks pass. Owner-local public/private restore and emitted macOS/Linux two-daemon MOVE with physical prepared-key crash/restart and multi-epoch private re-export pass. Owner-local deterministic Native public/private receipt archives pass isolated verification and restore without provider replay, including rejection of genuinely signed human-forged bot receipts and uncertain destinations. Foreign private recovery, approval histories, paid-provider archive qualification, full packaged workflows, Linux Electron, Windows and final GUI control cutover remain. A real 24-hour public-only soak is running on frozen checkpoint `0071fb41`, still unqualified. |

## Verification actually completed

At the latest checkpoint I integrated owner-local archive IPC/CLI and the actual
per-Space lifecycle ports. Nine composed facade, CLI and foreign reader checks
pass, including held-grant ownership, foreign-recipient denial and actual TLS
publication cancellation before awaiting the Space task. The archive workstream
also passed the macOS and Linux emitted two-daemon MOVE gate: protected enrollment, exact
export/retirement, Root handoff, hidden import, physical SIGKILL after protected
key preparation before SQL, locked restart, refreshed routes and identical
original higher-epoch activation. Its subsequent private-content probe uses a
serialized actual MMS lifetime; it is not a private-post CLI qualification.
See [operator limits](space-archive-operations.md) for unsupported recovery cases.

I reproduced private re-export failures after both an epoch reset and actual
Root/Host handoff. Archive replay now carries verified private controls across
Space epochs and checks each original Root-signed historical Host placement.
The macOS focused regressions pass 19 checks; the isolated Linux Node 24.20
snapshot at `1745b57b` passes 20 checks, including actual two-daemon MOVE,
re-export, hidden restore and fresh epoch-3 activation. These checks preserve
original ciphertext/signatures and do not qualify packaged archive workflows.

The emitted bot restart gate reproduced missing correlated clock evidence during
immediate receipt replay. Meta refresh now queues an authenticated ping before
its control request. Four concurrent actual TLS pongs retain their correlations;
a pong delayed past the actual five-second RTT bound is consumed and rejected.
I also reproduced a full probe map throwing from the periodic heartbeat callback
and reserved its slot. All 35 focused clock/sync checks and source Node TypeScript
and lint pass. The exact emitted restart and real three-owner expiry gate pass at that clock
checkpoint. I subsequently reproduced historical roster replay invalidating an
identical scoped current proof and protected restart failing to install periodic
bot heartbeat watches. Both exact regressions pass after their narrow fixes. The
heartbeat check observes an actual periodic counter update after 20 seconds at
both Host and sender without another model call. The combined emitted three-owner gate passes in 146.51 seconds: both Host and
sender recover working presence at original signing epoch 1/counter 5; the old
mention expires once at 92.791 seconds of Host-receipt age, while the fresh
mention starts at 2.849 seconds and completes without replaying the original run.
Earlier setup runs stopped with `spaces.join` cancelled; the new gate preserves
bounded daemon stderr and command timing. Their original cause remains unknown. These results do not claim P6 exit.

The earlier evidence below consists of accumulated focused runs. I subsequently ran the full suite at `662c2c13`: 2,556 passed, 58 failed and 13 skipped. Exact failures and the ongoing focused investigation are recorded in the final checkpoint below; I do not claim a passing full suite.

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

## Earlier foundation implementation wave

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

The P2 actual daemon enrollment/restart/rename/revocation gate now passes on supported Node 24.20.0, including protected invitation issuance and explicit unlock after restart. Authority transfer/recovery daemon orchestration is being completed; the core passed independent review after closing proof/request escapes across enclosing transaction rollback. P3–P9 implementation, application transport qualification, packaged checks and the actual 24-hour soak remain.

The owner authorized Cloudflare tests and deprecation of existing control clients. I verified Cloudflare account authentication and an actual quick-tunnel HTTPS request returning the exact loopback server response. See [probe evidence](qa/environment.md). I have not qualified Mousse over that transport yet. Tailscale's authenticated network remains unavailable; independent implementation continues.


## Current implementation checkpoint

I have added the P2 protected enrollment/authority-transfer services, P3 deny-default
remote API/display adapter and request-bound artifacts, the durable verified Git
Dispatch engine, P4 transport add-ons, and the P5 authenticated host/meta service.
These are implementation checkpoints; complete MMS/Hub/Space composition and
phase exit scenarios still remain. P5 member/private services are being integrated
from their separately tested owned checkpoint.

Actual protected daemon enrollment/restart/rename/revocation passes on supported
Node 24.20.0. I also verified composed-profile protected authority transfer, restart,
read-only acknowledgement reconciliation, and encrypted same-identity recovery;
separate daemon-process transfer qualification remains.

Actual quick and task-owned named Cloudflare encrypted WebSocket links pass,
including exporter equality, a 918,400-byte control payload, and wrong-key
rejection. I reproduced/fixed the named ingress origin-path error and captured a
transient 530/1033 response before the pre-payload readiness retry succeeded. I
verified deletion of each task-created tunnel, DNS record, and credential file.
I retain the narrower transport evidence in scripts/net-qa/transports/QA.md;
full application transport gates are not established by a link test.

Dispatch tests exercise actual Git/worktrees, durable result publication, actual
SIGKILL recovery in child processes, and the MMS native definition/resolver/tool
lifecycle with a deterministic provider response. I reproduced repository checkout
hook execution and configured filter execution, then added a trusted safe checkout
which disables hooks/fsmonitor and rejects external clean/smudge/process filters
before admitting a model effect. Local repository/worktree paths remain local
recovery metadata; root must choose the external Dispatch query DTO.

The isolated native bot runtime and compiled macOS reader backend are implemented,
with 15 focused tests. Production billing bounds and packaged reader loading remain
unqualified. Independent review reproduced an additional runtime blocker: one
execution invalidates qualification while an already-running sibling proceeds to
another provider call. I am fixing and verifying that exact failure before any
production activation. Operator/CLI/worker runtimes remain unavailable.

P3 Hub/profile composition, P4 application transports, P5 member/private integration,
P6 admission and compartments, P7/P8 published UI binding, P9 cutover/packaging, and
the actual 24-hour soak remain. I am continuing these authorized phases; this
checkpoint does not mark the plan complete or qualify a release.

## Integrated service and packaging checkpoint

I verified protected authority transfer through separate real daemons and their
CLI, including an ambiguous response, daemon suspension/kill, restart and exact
receipt resumption. Encrypted same-identity recovery retains the greater recovery
epoch. I have not changed the primary checkout or merged a PR.

I reproduced three integration failures and verified their fixes against the
same failures: a supervised Space replica stayed offline after link recovery;
a supervised artifact download dropped its abort signal; and a real 5 MiB MMS
thread snapshot hit a 1 MiB document parser. The reconnect now restores verified
meta state and delivers original queued bytes once. Download cancellation closes
the link and releases its slots. Bounded assembled-document parsing allows the
complete snapshot while retaining strict small wire-message limits.

The new actual MMS connection-lane check delivers 5 MiB with a paused reader,
waits for writer flush/drain, and resumes without queueing the entire snapshot.
Neither another client of the same profile nor another profile receives display
parts. The lane has no event-ring sequence or replay; changing the binding from
A to B and back rejects the old producer. Original local IPC/profile checks pass
(24 selected tests) with canonical `TMPDIR=/private/tmp`. Their older fixtures
fail under this machine's aliased temporary path before server creation in the
unchanged profile migration path check; I do not attribute that setup failure to
the new connection lane.

Actual composed direct TLS joins a foreign Space and imports an earlier member's
original public history into a third independent profile. Historical roster
evidence is verify-only: it does not pin that user or authorize new work. Altered
signatures and independently signed outsiders without membership are denied.
Public bot stream registration commits the signed acceptance, immutable binding
and parent opening together; an injected failure rolls all three back.

I reproduced same-millisecond bot receipt inversion and a later message leaving
before an uncertain acknowledgement while the TLS link remained open. The
outbox now preserves insertion order for timestamp ties, and an uncertain append
stops that stream until its original receipt is acknowledged or reconciled.
The two exact regressions and affected Space client checks pass (9 tests).

I reproduced the missing native reader in an actual CLI app ASAR and added the
host-native build/resource paths. SDK 0.85.1, the shipped bounded reader,
symlink/denied-root checks and Electron app-ready safeStorage roundtrip pass in
the updated macOS CLI ASAR. Standalone macOS Node/Electron and isolated Linux
arm64 Node probes also pass. The manifest still says `qualified:false`; these
checks do not establish paid provider billing bounds, full GUI/network workflows,
Linux Electron or Windows qualification.

Native bot tests now recheck admission's delivery window at its SQL boundary,
fence concurrently invalidated qualification before another provider call, retain
unknown reservations and capacity when a provider ignores abort, and refuse a
false stop acknowledgement. Bounded nonsecret over-limit evidence is retained.
Complete bot/private transport composition and independent security review remain.

I rechecked draft PR #47 at `71780b2d8048b5ef034e0589d9cd9a73a65a6ffd`:
it is open and unmerged. P7/P8's merged Chats/backend prerequisite remains unmet.
I continue the authorized integration work while keeping that gate explicit.

## Integrated Bridge, public CLI and private authority checkpoint

I integrated real `BridgeProfileService` and public Spaces local methods into the
actual MMS profile and emitted CLI. The separate two-daemon CLI test passes
create/get/list, a roughly 2.5 MiB attachment, target-local rename display,
SIGINT detach, and original receipt reconciliation after both processes are
SIGKILLed and explicitly unlocked/reconnected. The composed deterministic native
provider tests pass send/steer/abort, stale abort isolation, and Dispatch using
both an actual shared remote and an uploaded incremental Git bundle. Each
Dispatch result is downloaded over authenticated artifact subscription/blob
serving, hash-checked and imported with actual Git. I made no paid provider call.

The actual three-daemon public Space test passes in 53.65 seconds under supported
Node 24.20 with canonical `TMPDIR=/private/tmp`. Three independent protected
identities agree on dense conversation order after the host and members are
killed/restarted in turn, including killing the host and a pending author
together. Original IDs remain exactly once at their original positions; pending
originals remain FIFO and reach sent. A separate real-TLS rejoin regression
retains the leave fence until its original receipt is terminal, rejects cached
old invitation receipts and permits a fresh verified rejoin. This does not
qualify private discovery or bot execution through those daemons.

I reproduced owner-local private publication first failing `peer_offline`, then
`forbidden` at the existing-descriptor parent guard, and finally `not_member`
before first-control adoption. The corrected actual composed profile accepts
only the exact durable prepared opening/controller bytes, retains all creator
and current parent checks, commits its first control and marks both original
receipts sent. Substituted validly signed opening/control records are denied
without adopting keys. I also reproduced a private bot accepted receipt denied
without an immutable host binding. The authority now registers a private
execution binding in the same transaction as the ordinary guarded append,
including rollback at the last checkpoint, a single original accepted ID,
cross-public/private execution/trigger uniqueness and multiple independent
executions on one aside. The directly affected private/host run passes 28 tests;
source Node TypeScript, scoped strict test TypeScript and source ESLint pass.
ESLint does not configure these test files, so I do not report them as linted.

A reproduced oversized authoritative Bridge source update previously left a
stale attached view without an error. The fix retires that source and sends the
existing bounded stream error only to a currently served attachment. Actual
composed source-event and snapshot tests receive `too_large`, while an unrelated
attachment still updates on the same open session. Forty-two directly affected
profile/remote/sync checks pass in the workstream.

All of this remains a draft implementation. Private proof-carrying discovery,
complete bot composition/qualification,
archive/restore/move, the unmerged Chats/UI prerequisite, full packaged platform
workflows, control cutover, full-suite verification and real 24-hour soak remain.


## Cloudflare, owner delivery and qualification checkpoint

The actual composed Bridge quick-tunnel gate passes with direct transport disabled
and Cloudflare as the only advertised route. It joins through real authenticated
enrollment and pinned mutual inner TLS, verifies 2,640,000 display bytes, observes
target-local rename and exercises deterministic native send/steer/abort. Owned
tunnel children and directories were removed; no extra login was needed. The QA
resolver fallback and readiness attempts occur before application payload; this
is not mutation replay. Evidence is in `scripts/net-qa/transports/QA.md`. It does
not qualify paid providers, a separate packaged-daemon Cloudflare workflow,
Tailscale or a release.

I reproduced owner-host public bot acceptance being rejected after local outbox
preparation, then verified exact original-byte registration, signed-substitution
denial and stable duplicate positions. I also reproduced nested public human
reply continuation being denied. Actual host/TLS tests now accept that continuation
and reject cross-space, private, cyclic and over-depth ancestry. Private output
continuation and proof-carrying discovery remain separate gates.

Validated, generation-scoped bot placement/policy history is integrated. Private
historical audience validation consumes exact historical bot evidence and never
substitutes a current bot. The profile now exposes a trusted original-only append
port and bounded owner outbox flush, with a separate executor/replica proof gate.
Three actual profile checks verify signed-byte substitution denial, a real host
commit followed by lost acknowledgement preserving the next original, FIFO
reconciliation without duplication, and the private controller publication fence.
The directly affected history/private tests, source Node TypeScript and source
ESLint pass. The first new test run had two incorrect fixture accesses to
`self.delegation`; I corrected those to derive the genuine signed roster lease.

The full suite ran at fixed source `662c2c13` on supported Node 24.20 with canonical
`TMPDIR=/private/tmp`: 391 files, 2,556 passing tests, 58 failing tests and 13 skipped.
The three network daemon failures reproduced against the preserved stale CLI
bundle, whose source map lacks current command routing. Rebuilding only isolated
output at that same source made all three unchanged fixtures pass (93.47 seconds).
The root CLI output has also been rebuilt. I reproduced two cleanup fixture
failures caused by omitting the new network service, added that owned service to
the fixture and verified both now pass. Remaining failures include macOS process
tree support, browser fixture symlinks, application build prerequisites and older
UI/error assertions; their baseline comparison is ongoing. The suite is not green.

I integrated the real elapsed three-daemon public soak harness. Its final smoke
passed 152,970 ms of established conversation, 36/36 originals sent, eight faults,
identical cursors, healthy SQLite checks and owned-process cleanup. The actual
24-hour run started conversation at 2026-10-03 09:15:13 UTC; earliest completion is
2026-10-04 09:15:13 UTC plus final drain/integrity checks. It remains running and
`qualified:false`. Frozen app source is `0071fb41`, harness is `d224e1d5`; this
public-only run does not qualify subsequent root changes, private streams, bots or
external transports. Run and cleanup instructions are in
`scripts/net/qa/public-daemon-soak.md`; current report is
`/private/tmp/mnqa-pub24-3774e302b7/report.json`.

Bot profile composition and bounded archive/restore/move continue in isolated
worktrees. Chats/backend prerequisites remain unmerged. I preserve the primary
checkout and keep PR #45 draft with no merge performed.

## Bot composition, current proof and shutdown checks

I integrated the actual Native bot facade, retained foreign bot history proofs,
authority presence relays and qualified heartbeat lifecycle. Production adapters
remain inactive without actual qualification. Historical bot verification requires
the original independently signed bot roster and the exact historical bot/member
registration; it remains verify-only and does not pin a foreign owner. The three
actual-profile proof regression passes, including missing roster, altered signature,
wrong node/key epoch and new-work denial. It is a signature-proof check, not a
stored bot-output transport qualification.

The central workstream now passes actual protected TLS public and encrypted private
Native output, snapshot verification without admission, and ordinary own-host
presence fanout, using a deterministic provider only. I reproduced an actual
provider ignoring cancellation: NetService previously reported successful shutdown,
closed SQLite and left an owned Space timer accessing that closed database. The
fix retains stores and propagates the domain's `outcome_uncertain`. The same provider
regression now passes concurrent and repeated shutdown denial, observed terminal
usage and an explicit owner reconciliation before a successful database-close
retry. The local synchronous/asynchronous domain-drain checks also pass.

I reproduced an owner outbox receipt staying pending when it was queued after a
flush pass completed but before the pass finalizer removed its shared promise.
Coalesced owner flushes now drain that receipt while retaining the same blocked-stream
uncertainty fence and page budget. The exact failure and the three original owner
outbox checks pass.

A real three-user executor test still exposed a current-author authorization gap:
the executor has retained history evidence for the sender, while its global identity
correctly refuses new work from that unpinned sender. I added explicit optional
admission/client authorization ports and a separate bounded current Space identity
ledger, using the actual identity validator in an isolated database. Explicit
current proofs do not change profile identity; expiry, restart, authority/meta
changes and signed-byte substitutions deny. The two local real-Host proof checks
pass. Actual purpose-specific identity-query transport and three-user execution/
presence qualification are still being integrated. Historical delivery never
populates the current proof cache.

I rebuilt desktop output and reran the four checks affected by the missing build:
the main-bundle import and Chat Undo full-shell checks pass. Git Foundation and
Resource Lifecycle full-shell checks still fail with `profile_mismatch` and missing
expected UI states. I rebuilt both desktop and CLI output at default-branch baseline
`8729d0c4` and reproduced both unchanged failures there with the same UI transcript
patterns. The retained logs are `/private/tmp/mousse-net-built-shell-20261003.log`
and `/private/tmp/mousse-net-baseline-built-shell-20261003.log`. This establishes
the baseline failures, not their root cause or a full GUI qualification.

Private proof-carrying discovery and archive recovery continue in their own
worktrees. The elapsed public soak remains running and unqualified; no release or
whole-plan completion is claimed.

## Scoped current identity, private recipients and owner approvals

I verified private child discovery and live/replay/snapshot controls across actual independent protected profiles, including a newly enrolled receiving node. Original recipient rosters are retained as bounded historical evidence. I reproduced and fixed same-key bot lease renewal, a full meta snapshot leaving a root pin without an adopted current roster, and a relayed third-user historical roster being incorrectly promoted to global current identity. The exact current/history promotion regression and affected private discovery checks pass (45 tests across three files). Explicit current proofs remain Space-, session-, head-, purpose- and freshness-bound; historical evidence never provides current authority.

Three independent actual profile/TLS Native instances now execute one original mention only at its configured bot placement, with local thread/workspace isolation, signed original Host acceptance and terminal receipts, and exact private output decryption by the original requester. These deterministic provider fixtures do not qualify paid billing.

I added durable owner-local `bots.add` with one original registration/key/lease, exact retry binding, protected key persistence, original outbox bytes, and receipt reconciliation. Actual emitted CLI/daemon registration and physical SIGKILL recovery pass. I reproduced the foreign reader approval failure and fixed owner-local grants to refresh exact scoped current proofs, recheck after asynchronous refresh and inside the grant journal, and never fall back after a scoped denial. The integrated actual TLS/Native reader continuation and membership-removal race pass with 13 affected permission/local checks; no foreign global current roster or preapproval file bytes are required.

The trusted code-only Native factory is now wired through actual MMS profile composition. Its default remains inactive; no received DTO selects definitions, module paths, credentials, runtime qualification or reader roots. The emitted protected-owner smoke passes real lease/IPC, cooperative stop, restart/unlock and exact reader artifact loading. Full three-owner emitted CLI reader, original receipt expiry and real presence death qualification is underway.

I am composing archive/move/restore with durable startup fences, actual per-Space lifecycle drains and protected fresh-key/control recovery. The transport drain regression holds an actual snapshot send beyond cancellation, keeps the database open and another Space usable, and completes only after the actual send settles. An actual unscoped durable upload denies archive until it is aborted; an ignored-abort RPC after carrier closure denies shutdown until its actual effect settles. I also reproduced the synchronous carrier-close registration race and a Host-committed original becoming terminally failed after archive cancellation; their exact regressions now pass, including original receipt/FIFO reconciliation. The integrated transport drain/sync/service run passes 39 checks, and the integrated private rotation/activation/lifecycle/reader run passes six checks. These are focused drain checks, not completed archive/restore qualification. Foreign-controller/foreign-recipient private recovery remains explicitly unsupported by the first concrete recovery adapter.


## Production CLI packaging and isolated bot archive checkpoint

I packaged the actual production `out/main/cli.js` entry in a macOS arm64 CLI
ASAR with the unpacked Native reader. Three protected packaged daemon processes
completed 29 original messages with equal final cursors, zero pending/failed
receipts and all four restart/fault paths exercised. Established conversation
lasted 95,676 ms; owned processes stopped. The repeatable gate is
`scripts/net-qa/packaging/production-cli.mjs`. The driver uses Node 24.20.0 and
the app uses Electron 43.2.0's embedded runtime; they are reported separately.
This is a packaging smoke check, not a 24-hour soak or Linux/Windows qualification.

I integrated the mandatory isolated bot archive receipt verifier. Original
public/private outputs and foreign public bindings from deterministic Native
runs restore as history without new SDK calls or budget effects. Unsupported
approval histories fail closed. I reproduced a genuinely signed human-authored
`bot.run.completed` being accepted and fixed the actor check; its exact negative
and directly affected archive checks pass. An actually uncertain destination
execution now denies import before references or live stores change. The
verifier does not enable a production runtime, adopt old private keys, or replay
an execution. Source Node TypeScript and changed-source lint pass.


The actual retained production CLI ASAR also carries protected enrollment,
Bridge snapshot/listing and a foreign public Space original through Cloudflare
as the only route using normal system DNS. No additional login was needed. I
verified final owned process/directory cleanup independently, but the app did
not meet the ten-second graceful-cleanup deadline. Switching an existing direct
connection to a newly restarted quick tunnel also reproduces a stale peer route.
Both gaps remain recorded in `scripts/net-qa/packaging/CLOUDFLARE.md`; payload
success does not make that full packaged gate pass.

I separately reproduced a deterministic Space join diagnostic error using a real
TLS peer that withholds hello: the deadline abort listener won the error race and
returned `cancelled`. I reordered rejection before abort; the exact deadline
case now returns `deadline_exceeded`, while actual caller abort still returns
`cancelled`, without leaving admission state. This does not identify the earlier
intermittent setup cancellation. Four client-service fixture failures reproduced on the unchanged diagnostic
baseline. I traced their first connection failure to missing mandatory signed
roster-evidence retention in the fixture, added the actual bounded evidence
port with exact Host/root guards, and kept the original quota, freeze,
reconnect and lost-ACK assertions. All eight focused checks now pass; production
protocol code is unchanged.

At `6d67b65b`, eight actual archive checks in five files also pass on isolated
Linux arm64 / Node 24.20 with networking disabled: genuine signed bot receipts,
uncertain destination fences, emitted two-daemon MOVE, physical private-key
crash/restart, atomic activation, and multi-epoch recovery. Cleanup has no forced
or residual containers. This is source/daemon archive qualification, with no
Linux Electron, paid-provider, Windows, or complete release claim. See
`scripts/net-qa/platforms/LINUX-ARCHIVE.md`.

The candidate real Electron front-door checks independently pass protected
Net/Chats publication and foreign-user joined original delivery, plus a
2,970,426-byte authenticated Bridge snapshot through the production preload.
I reproduced missing Bridge connection-event forwarding before adding a
window/profile-epoch-bound lane; foreign, disposed, and stale-epoch delivery stay
zero. These checks cover the IPC/preload path; renderer layout and packaged GUI
qualification remain pending. I retain these checks in the isolated UI candidate.

I subsequently reproduced both packaged Cloudflare gaps against the exact
retained application. Unrelated transport configuration recreated an unchanged
quick tunnel; I now retain unchanged transport instances. Electron SIGTERM
exited before the Node foreground shutdown handler; I now prevent its
`before-quit` exit until the owned shutdown finishes. The actual production
package at source `5eaad179` passes the direct-to-quick transition with unchanged
hostname and one child, normal DNS, authenticated Bridge listing/snapshot, and
foreign Space original receipt/readback. All three SIGTERM exits finish without
escalation in 388/30/24 ms, with awaited shutdown logs and no remaining owned
tunnel, directory, runtime, owner or profile resources. This supersedes the
Cloudflare-only failed gate above; named tunnels and broader P9 qualification
remain separate. See `docs/net/qa/cloudflare-lifecycle.md`.
