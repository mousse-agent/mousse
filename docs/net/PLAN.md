# Mousse Net: Bridge and Spaces — implementation plan (draft 4)

Status: draft 4 (P0 recovery and review corrections; no P1 implementation yet). Two independent reviewers (Sol 6.1 and Astra, extra-high effort) reviewed draft 1 and draft 2; both rated draft 2 "ready after listed edits". Draft 3 applies those edits. Date: 2026-10-02. Owner: TheAnimatrix. Tracking issue: #44.

Change log is in §11 (draft 1 → 2), §12 (draft 2 → 3) and §13 (P0 recovery).

## 1. Goal

- **Bridge**: one user controls agents on several of their own machines from one place and fans agents out to them.
- **Spaces**: Discord-like group chats per project. Friends join. Each user adds their own bots, which run on the owner's machine with the owner's keys. Tagging a bot opens a work thread under the message. A side pane shows what each bot is doing.

Open-source friendly: everything needed is in this repo and runs on a VPS or home machine. A closed hosted relay can be added later as one more transport add-on.

## 2. Scope

### Built fresh
Identity and keys; signed versioned event streams; sync protocol for node↔node and member↔host; link layer with pluggable transports; enrollment without QR; Bridge; Spaces; bots with enforceable permission profiles; private streams; CLI; GUI surfaces; docs; tests; cutover of `src/mms/control/`.

### Not in v1 (the design leaves room)
- Replicated or federated hosts, and **live** host migration. v1 has one host per space with backup, restore and a quiesced stop-and-transfer move (§4.8.8).
- Web client for members without Mousse.
- End-to-end encryption of public channels. Private streams are sealed in v1.
- Queued delivery to offline bots (§4.8.5 defines exactly what "offline" means).
- `historyVisibility: sinceJoin`. Members see full channel history in v1.
- Sandboxed shell for restricted bots. v1 offers only permission profiles the runtime can actually enforce (§4.8.3).
- Sharing PR #41's local browser/PTY/file resources across the network.
- Loading add-ons from outside the repo; SSH bootstrap; short-code enrollment through a relay; Tailscale Funnel automation; the hosted relay add-on itself; `mousse://` deep-link registration (v1 uses pasted strings).
- Rewriting `ThreadDataStore` or the GUI↔daemon local protocol.

### Kept
The rest of the app; `src/mms/channels/` as an optional gateway; `src/mms/control/` untouched until P9.

## 3. Constraints

### 3.1 Team
- Issue #40 / draft PR #41 (bvsr365, `codex/local-micro-commits`) add the Chats UI and a local chat backend (`src/mms/chats/**`, `src/shared/chats.ts`): DMs, Groups, one backing thread and workspace per chat, unmentioned messages routed to the first agent, local GUI clients authenticated as person `self`, execution on the current device only.
- State of `master` on 2026-10-02: PR #43 merged the navigation rail, Projects/Chats organization and composer UI from #41. The chat backend (`src/mms/chats/**`) and the Groups UI are **not** on `master`.
- This plan builds network layers in new directories. The integration contract with the Chats domain is fixed in §4.10 and posted on #40 when P0 starts; objections still open at P0 exit are decided by the owner. The Chats binding (P7) needs the chat backend on `master`. The GUI (P8) builds in the merged navigation shell; if the Groups UI is still unmerged when P8 starts, P8 builds the Spaces views directly in the Chats mode of that shell.
- Auth, credential and permission changes need teammate review before merge to `master`. The agent merges nothing into `master`.
- Focused tests only.

### 3.2 Requirements adopted from prior art (each has a named test, §8)
L1 untrusted transports; L2 executor verifies the speaker; L3 private content sealed and context separated; L4 stable IDs, rotating keys, per-node revocation; L5 versioned envelope with criticality; L6 cursor advances only over a contiguous, durably stored prefix; L7 idempotent commands with explicit execution states; L8 blobs, byte-budgeted replay, bounded queues; L9 signed end-to-end liveness, three states; L10 credential refresh independent of connections, per-phase timeouts, jittered backoff; L11 multiple routes; L12 tunnels on the user's own account; L13 separate stores for local and shared data; L14 authenticated local IPC; L15 journal before send; L16 atomic, idempotent link and revoke; L17 error causes preserved end to end.

## 4. Architecture

### 4.1 Layers and layout

```
GUI / CLI ──(existing local protocol + new domain methods)── daemon (MMS)
  domain:    bridge/   spaces/   bots/
  sync:      streams, cursors, outbox, blobs, presence, rpc
  link:      routes → transport → TLS 1.3 secure channel → mux
  identity:  user / node / bot keys, delegation, roster, revocation, sealing
  storage:   node:sqlite (per profile) + content-addressed blobs
```

New directories:

```
src/shared/net/          wire types, ids, error codes, capabilities, JSON Schemas (no node imports)
src/mms/net/identity/    keys, keystore, delegation, roster, revocation, sealing
src/mms/net/store/       sqlite schema + migrations, stream store, blob store, outbox, executions, quotas
src/mms/net/link/        Transport interface, route manager, secure channel, mux
src/mms/net/transports/  memory, direct, tailscale, relay, cloudflared
src/mms/net/sync/        codec, session, authority and subscriber roles, presence, rpc
src/mms/net/relay/       self-hostable relay server
src/mms/bridge/          roster replication, remote API, stream adapter, hub, dispatch
src/mms/spaces/          host service, member client, meta projection, invites, backup/transfer
src/mms/bots/            registry, grants, admission pipeline, compartments, presence
src/cli/commands/        bridge.ts, spaces.ts, bots.ts, relay.ts, net.ts
tests/net/**             all tests (vitest only discovers tests/**/*.test.ts)
test-vectors/net/**      frozen wire and conformance fixtures
docs/net/**              protocol spec, threat model, state machines, operator guides, QA checklists
```

Existing files edited (seam list; owned by the integration owner only, never by a parallel workstream):
- `src/mms/MmsProfileServices.ts` (construct, start, shutdown-drain, activity counts)
- `src/mms/MousseMainService.ts` (register domain methods before the registry seals)
- `src/mms/events.ts`, `src/main/mms/protocolEventBridge.ts` (new event channels)
- `src/shared/platform.ts`, `src/main/ipc/registerGuiIpc.ts`, `src/preload/index.ts`, `src/preload/api.d.ts` (GUI method allow-list and typings)
- `src/cli/parseArgs.ts`, `src/cli/runCliMain.ts`, `src/cli/help.ts` (commands)
- `src/shared/featureFlags.ts` (`netBridge`, `netSpaces`, default off)
- `package.json`, `package-lock.json` (`ws`; dev: `fast-check`, `@types/ws`). No certificate library: `@peculiar/x509` was tried and rejected (it needs a global reflection polyfill); a small in-tree DER encoder for self-signed P-256 certificates passed the spike under Node and Electron.
- P7/P8 only: `src/mms/chats/**`, `src/shared/chats.ts`, renderer components (after PR #41)
- P9 only: `src/mms/control/**` and its callers

### 4.2 Identity

IDs are random 128-bit values with a type prefix (`usr_`, `nod_`, `bot_`, `spc_`, `str_`, `evt_`, `exe_`, `rpc_`), never derived from keys or paths. Blobs are `blb_<sha256 of stored bytes>`. Key encodings on the wire, all base64url: Ed25519 and X25519 public keys as raw 32 bytes; P-256 transport public keys as SPKI DER. A key fingerprint is SHA-256 over that encoding.

- **User**: root signing key (Ed25519). Used only to sign delegations, the roster and space descriptors.
- **Node**: one Mousse profile on one installation. Keys: signing (Ed25519), agreement (X25519, for sealing), transport (ECDSA P-256, for TLS).
- **Bot**: owned by a user, **placed on exactly one node** named in its delegation. Signing key lives on that node. Moving a bot is a stop-and-transfer: the old node stops and drains the bot's executions, hands its execution ledger for that bot (event IDs and payload hashes) to the new node, and acknowledges; only then does the authority issue the new placement (a higher `keyEpoch`) and the new node activates, refusing any mention received by the host before its activation time. If the old node is unreachable, the new placement activates when the old bot delegation expires (7 days), or earlier with an explicit `--force` that warns of possible duplicate execution.
- **Delegation**: `{ v, subject, subjectKeys, owner, hostNode? (bots), caps, issuedAt, expiresAt, keyEpoch }` signed by the user root key. Node delegations last **7 days** and auto-renew from the authority node; an unreachable peer stops trusting a revoked node at expiry at the latest.
- **Single roster writer (v1)**: exactly one node per user is the *authority* and holds the root private key. Only it signs. `roster = { owner, recoveryEpoch, version, authorityNode, nodes[], bots[], revoked[] }`, ordered by `(recoveryEpoch, version)`. Authority transfer is an explicit `authority.transfer` signed by the old authority, after which the old node deletes its copy of the root key. If the authority node is lost, the user imports the recovery file on one chosen node with an explicit `--become-authority`; that creates a roster with `recoveryEpoch + 1` and a fresh random `lineage` ID. Recovery does not make conflicts impossible (the file could be imported twice, or an old authority could come back), so they are detected and fail closed: a peer that sees two different rosters with the same `(recoveryEpoch, version)`, or two lineages at one recovery epoch, enters `roster_conflict`, keeps existing pinned sessions read-only, refuses enrollment, new sessions and execution for that user, and tells the user to issue a higher recovery epoch from the node they choose. Docs require retiring a replaced authority. Limitation stated in the threat model: whoever holds the root key is the user; a stolen root key or a network partition cannot be fenced by protocol alone.
- **Key epochs**: rotation issues a delegation with a higher `keyEpoch`. Past epochs are retained as *verify-only* so stored history still verifies; only the current epoch may author new events or open sessions.
- **Recovery**: root key export to a passphrase-encrypted file (scrypt + AES-256-GCM). Losing the authority node and the recovery file means a new identity; documented in the UI at setup.
- **Key storage**: follows the app's existing secret handling (`src/mms/providers/secretCodec.ts`, headless Electron vault via `src/cli/daemonHost.ts`): OS vault when the runtime offers it, otherwise a 0600 file with optional passphrase. Never derived from hostname or path. States: `unlocked`, `locked` (needs passphrase), `missing`.
- **Trust in a space**: `usr_ → root public key` is pinned at join (trust on first use, with a short fingerprint shown in the UI). A changed root key is accepted only through a valid recovery or rekey chain, else the member must be re-invited.

Signature rule: the signature covers the **entire serialized envelope bytes** exactly as transmitted. Verifiers check received bytes and never re-serialize.

Crypto primitives (all `node:crypto`, verified to work under Node 24 and Electron 43): Ed25519, X25519, ECDSA P-256, AES-256-GCM, HKDF-SHA256, scrypt, SHA-256. ChaCha20-Poly1305 is **not** available under Electron 43 and is not used.

### 4.3 Streams and events

A stream is the unit of ordering and access. It has exactly one authority node, which assigns `seq` (integer, ≤ 2^53−1) within an authority `epoch`.

| Stream kind | Authority | Readers | Writers |
|---|---|---|---|
| `node.thread` | node running the thread | the user's nodes with `read` | that node |
| `space.meta` | space host | all members | per the meta state machine (§4.8.2) |
| `space.channel` | host | all members | members |
| `space.thread` (work thread under a message) | host | all members, or `private` | the bot, and members allowed to steer it |
| `space.private` (asides, permission requests, owner-only threads) | host | named participants only; payload sealed | the participants |

Access to a non-private stream follows **current** membership: a member removed at meta position *m* cannot read or subscribe after the host applies *m*. Private streams have an explicit participant list that changes only by a signed `participants.changed` event, which also rotates the content key (§4.8.6). Sequences are dense within a stream, so there are no visibility holes.

Envelope (signed bytes; UTF-8 JSON; schema in `src/shared/net/schemas.ts`):

```
{ v: 1, id: "evt_…", stream: "str_…", type: "…", crit: boolean,
  author: { user?: "usr_…", bot?: "bot_…", node: "nod_…", keyEpoch: n },
  ts: <author clock ms>,
  auth?: { metaSeq: n, metaEpoch: n },        // author's applied space.meta position (required in space streams)
  refs?: { replyTo?, thread?, mentions?: ["bot_…"], command?: "exe_…" },
  body?: {…} | sealed?: { keyEpoch, nonce, ct },
  blobs?: [{ id, bytes, mime, sealed?: boolean }] }
sig (detached, Ed25519 by the author node key or bot key)
```

Stored record: `{ seq, epoch, recvTs, envelopeBytes, sig }`.

**Criticality**. `crit: true` marks events whose meaning a consumer must understand to stay safe (all `space.meta` events, policy changes, participant changes). An unknown **critical** type or a higher minor version on a critical event puts that space into `upgradeRequired` on that node. A member node keeps storing what it receives but **suspends all execution and all writes** for that space. A host in `upgradeRequired` **stops acting as authority for that space altogether**: no appends, no subscriptions, snapshots, blobs or fan-out, because it can no longer evaluate who may read. Criticality is determined by the type registry of the reader's version, not only by the sender's flag: every type in the `space.meta` family is critical regardless of the flag. Unknown non-critical types are stored, relayed and skipped. A higher major version is rejected with `unsupported_version`.

Limits: inline envelope ≤ 64 KiB; larger content in blobs; blob ≤ 25 MiB by default.

Event types v1: `space.created`, `space.descriptor`, `member.joined|left|removed|roleChanged`, `bot.added|removed|policyChanged`, `channel.created|renamed|archived`, `settings.changed`, `space.frozen`, `message.posted|edited|deleted`, `thread.opened|closed`, `participants.changed`, `bot.run.accepted|progress|toolSummary|waitingApproval|completed|failed|cancelled|uncertain|expired`, `bot.permission.requested|granted|denied`. Ephemeral (never stored): `presence.heartbeat`, `presence.activity`, `typing`, `delta` (token streaming).

### 4.4 Storage

- `node:sqlite`, WAL, one database per profile at `<profile>/net/net.db`. Decision is final for v1 (verified under Node 24 and Electron 43 run-as-node; P0 records the WAL/backup API spike; P9 qualifies the packaged daemon on each available OS). No alternate store.
- Every row that belongs to a space carries `space_id`; Bridge rows carry none. Tables: `streams`, `events(stream, epoch, seq, id UNIQUE per stream, recv_ts, bytes, sig)`, `cursors(stream, epoch, contiguous_seq)`, `outbox`, `meta_projection`, `members`, `roster`, `delegations`, `grants`, `invites`, `executions`, `budget_reservations`, `quotas`, `rate_windows`, `blobs(id, bytes, sealed)`, `blob_refs(blob, stream, event)`, `uploads(pending)`, `private_keys(stream, key_epoch, wrapped)`, `schema_migrations`.
- Transactions: storing events and advancing the contiguous cursor commit together. Admission of an execution and its `accepted` outbox record commit together. Work inside a transaction is bounded (≤ 500 rows or 1 MiB per transaction), and long replays yield to the event loop between transactions.
- Blobs: files at `<profile>/net/blobs/ab/cd/<sha256>`, temp file → fsync → rename. Reference-counted through `blob_refs`. Pending uploads expire after 1 hour. A garbage collector removes unreferenced blobs after a 24-hour grace period. Private blobs are encrypted **before** hashing and upload.
- Failure handling: disk full → writes fail with `storage_full`, the node goes read-only for net data and surfaces a recovery-required state; integrity check failure at open → database is quarantined, the user is told, and spaces resync from their hosts (a host restores from backup). Deduplication records (`events.id`, `executions`) are retained at least as long as the events they guard.
- Migrations: forward-only, transactional, tested from every earlier schema. A database with a schema newer than the binary refuses to open with `downgrade_unsupported`. An interrupted migration rolls back.
- Profile lifecycle: net services register with the existing shutdown barrier in `MmsProfileServices`; archive and removal drain sessions, executions and uploads before data moves. Listeners and child processes (tunnels) are owned by the profile and stopped with it. A session authenticated for one profile can never address another.
- Backup of the whole profile store uses the SQLite backup API plus blob copy under a blob-GC pause. **Space export** is different and space-scoped (§4.8.8).

### 4.5 Link layer

```
interface Transport {
  readonly id: string
  readonly traits: { canListen: boolean; canDial: boolean; readsPlaintext: boolean; needsAccount: boolean }
  provision(ctx): Promise<ProvisionResult>     // idempotent
  listen(onConnection: (duplex, info) => void): Promise<Listener>
  dial(route: Route, signal: AbortSignal): Promise<Duplex>
  status(): TransportStatus                    // state, detail, lastError with preserved cause
  onStatus(listener): () => void
  teardown(): Promise<void>                    // idempotent
}
```

- **Routes**: `{ transport, address, priority }`. A node's routes are published inside a node-signed `routes` record (so a relay or host cannot substitute them) and carried in the roster and in space member records. The route manager dials by priority with a stagger; per-phase deadlines (resolve 5 s, connect 10 s, TLS 10 s, hello 10 s); exponential backoff with jitter (1 s–60 s), reset after a session that lasted ≥ 30 s. Route health and peer liveness are reported separately.
- **Secure channel: TLS 1.3 from `node:tls`, mutually authenticated, run over the transport's `Duplex`** (verified in a spike under Node 24 and Electron 43). Each node presents a self-signed certificate for its transport key. Certificate chain validation is off (`checkServerIdentity` is not used, since it only runs after chain validation succeeds); instead, after the TLS handshake completes and **before any application byte is sent or accepted**, each side compares the peer certificate's public key with the expected transport key: the pinned fingerprint (invite, space descriptor) or the transport key in the peer's delegation, which is sent in `hello` and verified against the pinned user root key. A mismatch closes the connection. Session resumption and 0-RTT are disabled. No hand-written handshake. The certificate is produced by a small in-tree DER encoder.
- **Enrollment channel**: the joiner pins the inviter's transport key fingerprint from the invite; the inviter does not know the joiner yet. The invite token `T` is 256 random bits. The authority stores, encrypted in its keystore, `proofKey = HKDF-SHA256(T, "mousse-net/enroll/v1")` together with `tokenId = SHA-256(T)[0..16]` for lookup; it does not keep `T`. The joiner derives the same `proofKey` and sends `proof = HMAC-SHA256(proofKey, exporter ‖ inviteId ‖ SHA-256(enroll request without proof))`, where `exporter` is the TLS exporter value for the label `EXPORTER-mousse-net-enroll`. This binds the proof to this TLS session and to the exact request, so a relay in the middle cannot replay or alter it.
- **Mux**: frames ≤ 64 KiB, two lanes with independent credit windows: `control` and `bulk`. Control is always scheduled first. Messages larger than a frame are fragmented; a byte-progress watchdog (no progress for 30 s) aborts the message, not an absolute timeout.
- **Liveness**: sync-level ping answered by the peer's session code; three missed 20 s intervals close the session.
- **Abuse bounds** on listeners: unauthenticated connections ≤ 32 total and ≤ 4 per remote address, handshake deadline 10 s, pre-auth bytes ≤ 16 KiB; per session ≤ 256 subscriptions, ≤ 64 in-flight RPCs, ≤ 8 concurrent blob transfers.

Transports and order of delivery:
1. `memory` (tests; fault injection: stall, half-open, slow, cut, corrupt, tamper).
2. `direct`: WebSocket listener (off by default; binds loopback unless configured). Covers LAN and private networks.
3. `tailscale`: detects the `tailscale` CLI and the tailnet address or MagicDNS name and advertises a `direct` route on it; guided setup text when missing.
4. `relay`: outbound connection to a self-hosted relay (`mousse-cli relay serve`). The relay authenticates nodes by a signature challenge on the node signing key, admits only allow-listed user or node keys, pairs two connections addressed to each other and forwards bytes. For enrollment, the inviter registers a short-lived rendezvous ID (in the invite); the uncertified joiner may connect only to that ID. Bounded buffers; quotas persisted.
5. `cloudflared` (P4b, after Bridge is qualified on 2–4): supervises a user-installed binary for quick and named tunnels on the user's own account.

Add-on model: an in-tree module exporting `{ id, kind: 'transport', displayName, traits, settingsSchema, setupSteps }` and a factory, registered in a generic registry with per-profile enablement and settings validation. A future closed or third-party transport needs no core change. No stub modules ship.

### 4.6 Sync protocol

Normative spec: `docs/net/protocol.md` (P0). Encoding: one JSON object per mux message, with binary payloads (envelope bytes, blob chunks) carried as length-prefixed raw bytes after the JSON header. Field names, types and limits are JSON Schemas in `src/shared/net/schemas.ts`, validated with `ajv` on receipt.

Messages:
- Session: `hello { protoMajor, protoMinor, caps[], node, delegation, rosterHead, routes }`, `helloAck`, `ping`, `pong { echo, sessionTime }`, `goAway { code }`, `error { code, message, retryable, cause? }`.
- Streams: `subscribe { stream, after: { epoch, seq } }`, `subscribed { stream, head: { epoch, seq }, replayThrough: seq }`, `events { stream, records[], replay: boolean }`, `caughtUp { stream }`, `snapshotRequired { stream, reason }`, `snapshot.get`, `snapshot.chunk`, `unsubscribe`.
- Writes: `append { envelopeBytes, sig }`, `appendResult { id, epoch, seq } | { id, error }`.
- Blobs: `blob.put.begin/chunk/end`, `blob.get`, `blob.chunk`, `blob.have`.
- RPC (Bridge): `rpc.request { id: "rpc_…", method, params, idem?, deadlineMs }`, `rpc.progress`, `rpc.result { id, result | error }`, `rpc.cancel { id }`.
- Presence: `presence { subject, counter, ts, state, activity?, sig }`.
- Control: `revoked { subject }`, `rosterUpdate { roster }`.

Resume rules (fixes the skipped-history defect):
- A cursor is `(stream, epoch, contiguousSeq)`. It advances only when the record with the next sequence is durably stored.
- On `subscribe`, the authority replies `subscribed` with `replayThrough = head.seq` at that instant, replays `(after, replayThrough]` on the bulk lane in batches ≤ 1 MiB, and sends live records (`seq > replayThrough`) on the control lane.
- The subscriber buffers live records that are ahead of its contiguous cursor in a bounded overlap buffer (≤ 1,000 records or 4 MiB). On overflow it drops the buffer and relies on a fresh subscribe. Records are applied strictly in order.
- A cursor from another epoch, ahead of head, or older than retention gets `snapshotRequired`. A snapshot is `{ epoch, throughSeq, records needed to rebuild state }`; for `space.meta` it is the **full** signed event history (meta is never truncated), so authorization is always re-derived from signed evidence, never taken on the host's word. For other streams a snapshot is a non-executable projection: it can be displayed, and no bot run is ever admitted from snapshot content. Snapshot install and cursor move are one transaction.
- `append` is idempotent on `(stream, event id)` and bound to the payload hash: the same id with different bytes is `conflict`. A retry after a lost result returns the original position.

Authorization at the authority, before storing: session node is certified and not revoked; envelope signature valid for the author key epoch; author matches the session's user (or is a bot delegated by that user and placed on that node); `auth.metaSeq` not ahead of the host's head; write permitted by the meta projection at head; size and rate within limits. Reads: `subscribe`, `snapshot.get` and `blob.get` are checked against current membership or the private participant list; blobs are fetched by `(stream, blob id)` and only if referenced from an event the caller may read.

Version skew: majors must match (`incompatible_peer` otherwise, with a UX state); minors negotiate down; capabilities gate optional messages. A space records `minProto` in its settings; nodes below it can read but not write.

Stable error codes live in `src/shared/net/errors.ts` and map to the app's structured error providers.

### 4.7 Enrollment

First run: `mousse-cli net init` (or the GUI) creates the user root key, the node keys, makes this node the authority, and offers a recovery file.

Joining a node (Bridge):
1. Authority node: `mousse-cli bridge invite [--ttl 10m] [--name vps] [--caps read,chat,write]` prints `mousse-cli bridge join mj1_<payload>`. Payload: signed routes, inviter transport-key fingerprint, invite ID, 256-bit token, expiry, optional relay rendezvous ID. The authority keeps only the derived proof key (§4.5).
2. New node: runs that line (or `mousse-cli bridge join` and pastes the string at a no-echo prompt, so it stays out of shell history). It creates node keys, dials, verifies the fingerprint, and sends `enroll.request { nodeKeys, name, proof }`.
3. Authority: in one transaction, checks expiry and proof, marks the token consumed and bound to those node keys, signs the delegation, bumps the roster. A retry of the same request with the same keys returns the same delegation (lost-response safe); any other use of the token fails.
4. Joiner stores delegation and roster. Both sides print name and fingerprint.

Only the authority can invite. Revocation: `mousse-cli bridge revoke <node>` bumps the roster; every peer that receives it closes that node's sessions and cancels its in-flight RPCs. Guarantee stated precisely: connected peers enforce within one roster propagation (seconds); disconnected peers at the latest at delegation expiry (7 days). Tokens and proofs are redacted from logs and diagnostics.

Joining a space: `mousse-cli spaces invite <space> [--role member] [--uses 1] [--ttl 24h]` prints `sj1_<payload>` (signed host routes, host transport-key fingerprint, space descriptor, token). The joiner sends its user root public key, node delegation and roster; the host admits per invite policy (auto or owner approval) and appends `member.joined`.

### 4.8 Spaces

#### 4.8.1 Roles of nodes
- **Host** (`SpaceHostService`): authority for the space's streams. Admission, ordering, storage, fan-out, quotas, rate limits, retention, backup.
- **Member client** (`SpaceClient`): session to the host, local replica, durable outbox (journal, then send, resend under the same event ID). Message states: `pending`, `sent` (host position known), `failed` (terminal error), `unknown` (sent, no result yet; resolved by resubscribe).

#### 4.8.2 Meta state machine
`space.meta` is a deterministic state machine replayed by the host and by every member. State: owner, the host key and epoch from the owner-signed **space descriptor**, members with roles and pinned root keys, bots with owners and audience policy, channels, settings. Each event type has a rule for who may author it at the state just before it:
- `member.joined`: host-signed with a valid invite reference, or admin-signed.
- `member.removed`, `member.roleChanged`, `channel.*`, `settings.changed`: admin or owner.
- `bot.added|removed|policyChanged`: the bot's owner; `bot.removed` also by an admin.
- `space.descriptor`, `space.frozen`: owner only.
An event that violates its rule is rejected by the host and, if a host stored it anyway, is ignored by every replica (and flagged as host misbehaviour). All meta events are `crit`.

#### 4.8.3 Bots: profiles the runtime can enforce
The current runtime has no sandbox or network isolation (`src/mms/agentDefinitions/runtimePolicy.ts`, `src/mms/execution/SandboxAdapter.ts`). v1 therefore offers three profiles and rejects any other combination:

| Profile | Tools | Enforcement | Who may steer |
|---|---|---|---|
| `chat` | none; model replies from conversation context only | no tool is registered for the run | any policy |
| `reader` | built-in read-only file and search tools, confined to one bound project root | existing path-containment checks; no shell, no network tools, no MCP, no browser | any policy |
| `operator` | the owner's normal agent tool set, including shell and write | none beyond the owner's existing approval settings; UI states "runs with your full access" | **owner only** in v1 |

Rules: `chat` and `reader` runs have no tool that spawns a process or reaches the network, so they cannot read the environment, secrets or other compartments' state. An `operator` run has the owner's full machine access by definition; no isolation is claimed for it. `chat` and `reader` are offered only on runtimes with verified containment (no adapter is qualified yet; P6 must qualify the native candidate and every offered external operator adapter with actual enforcement/accounting tests). P0 writes the runtime qualification contract that states, per adapter, which profiles it can enforce and by which hook. Sub-agents and tools inherit the profile and can never widen it. **Bot-authored messages never trigger a run in v1** (no bot-to-bot handoff in a space), which removes privilege escalation through chained mentions and mention loops; the envelope reserves an `origin` field for a later, provenance-carrying design. Revoking a grant or pressing emergency stop cancels running executions. Spend: each run reserves its ceiling from the bot's daily budget in a transaction before starting and settles afterwards; a run that cannot reserve is refused. Limits: concurrent runs per bot (default 2), runs per member per hour (default 20). When a real sandbox adapter exists, a restricted `operator` for other members can be added without protocol change.

Permission request flow: when a member without rights mentions the bot or a run needs something outside the profile, the bot's node posts `bot.permission.requested` in a `space.private` stream to the owner. Nothing proceeds until `granted`. Pending requests are capped (20 per bot) and expire after 24 h.

Audience policy per (bot, space): `steer: owner | roles[] | everyone` and one `visibility: public | private`. With `private`, the work thread and the replies both live in a private stream between the owner (and the steering member, if different) and the bot. There is no mixed mode.

#### 4.8.4 Admission pipeline (on the bot's node)
For a `message.posted` that mentions one of this node's bots, in order:
1. The bot is placed on this node and its delegation is current.
2. The node asks the host for the current `space.meta` head (same epoch as the event's `auth.metaEpoch`) and has **applied** its replica through that confirmed head; the replica is not `upgradeRequired`; the event's `auth.metaSeq` is not ahead of it. A live socket or merely knowing the head number is not enough. Otherwise: do not run.
2a. The message's author is not a bot.
3. Envelope signature and author delegation verify against the pinned root key; the author key epoch is current, not verify-only.
4. The author is a member **in the replica's current state** (execution-time check), and the steer policy allows them.
5. The mention targets this bot.
6. Delivery window (§4.8.5).
7. Insert `executions (space, bot, event_id)` with the payload hash. Existing row with the same hash → stop (duplicate). Different hash → `conflict`, stop.
8. Reserve budget, then in one transaction mark `accepted` and enqueue `bot.run.accepted`.
9. Open the work thread, run under the profile in the right compartment (§4.8.7), post progress and result.

Execution states: `accepted → running → (waitingApproval ⇄ running) → completed | failed | cancelled`, plus `uncertain`. A process restart moves `accepted` runs to `failed (not started)` and `running` runs to `uncertain`; an uncertain run is never retried automatically, because external effects may have happened. The owner sees it and decides. A retry is always a new mention.

Residual risk, stated in the threat model: a malicious host can delay delivering a removal and so keep a just-removed member's steer working until the bot's node sees the removal. It cannot forge a steer from a non-member, alter content, or replay an executed mention.

#### 4.8.5 Offline bots (bounded delivery, no open-ended queue)
A mention is executed only if the bot's node receives it within the **delivery window**: `now − recvTs ≤ 30 s` (host receive time, corrected by the measured clock offset to the host; offsets above 60 s disable execution with a visible clock warning) **and** `recvTs − ts ≤ 120 s`. The same rule applies to live and replayed delivery. Stated consequences, which tests and UI follow exactly:
- A bot that was briefly disconnected and returns within 30 s of the host receiving a mention **does** run it.
- A message that waited in its author's outbox for up to 120 s (for example through a short host outage) **does** run when delivered.
- Anything later does not run, ever. A bot that comes back after a longer gap executes nothing from the gap.
For a mention it receives outside the window, the bot's node posts `bot.run.expired { event }` (a status marker, no model call), so the outcome is durable and unambiguous. Until such a marker or a `bot.run.accepted` exists, members' clients show "not delivered: bot offline" once 30 s have passed and the bot's presence is not online.

#### 4.8.6 Private streams
Used for asides, permission requests and bots with `visibility: private`.
- A stream content key (AES-256-GCM) per key epoch, wrapped to each participant **node's** agreement key (ephemeral X25519 + HKDF-SHA256 + AES-256-GCM), stored in `private_keys` and sent as `participants.changed`.
- A participant's new node gets the key re-wrapped by one of that participant's existing nodes. Removing or revoking a participant node triggers a **new key epoch** for future events; old content stays readable to nodes that already had the old key (stated in docs).
- Attachments: encrypted with the stream key, then hashed and uploaded; the host stores ciphertext.
- The host sees participants, timing and sizes. The UI says so.

#### 4.8.7 Compartments (context separation)
A bot has one **public compartment** per space and one **private compartment** per private stream **per participant set** (visibility epoch, distinct from encryption keyEpoch). A compartment owns: conversation history, memory, provider session, scratch notes, tool-output summaries. Rules:
- The context builder for a run in compartment C may read only C and the public channel history. A public run never reads a private compartment.
- Output of a run is posted only to the stream its compartment belongs to. Private-derived output is private.
- When a participant is **added** to a private stream, the bot starts a **fresh compartment**; earlier private history, memory and provider session are not carried over unless an existing participant explicitly re-shares specific messages.
- Declassification is only by a participant explicitly quoting text into a public message.
What v1 does **not** guarantee, stated in the bot setup UI and the threat model:
- These guarantees hold for `chat` and `reader` bots. An `operator` bot has the owner's full machine access and can read anything the owner can, including other compartments' stored state; it is owner-steered only, and what it reveals is the owner's responsibility.
- Files on disk are shared. If an `operator` bot is told privately to edit files, later runs of any bot that can read that project, including a public `reader`, can see those edits.
Presence for a private run shows only "working (private)"; notifications carry no private text.

#### 4.8.8 Backup, restore and moving a host
- **Space export** is space-scoped: an explicit allow-list of tables filtered by `space_id` (streams, events, meta projection, members, bots, blobs and refs, private-stream ciphertext and wrapped keys) into a new SQLite file plus the referenced blobs. Never exported: Bridge data, other spaces, the outbox, invites and their tokens, grants, budgets, any private key. Import **merges** into the destination profile store; it does not replace it.
- The authority epoch is pinned by the owner-signed **space descriptor** `{ space, hostNode, hostTransportKey, routes, epoch }`. A host can never change its own epoch; members accept only a descriptor signed by the pinned owner key with an epoch higher than the one they hold.
- **Restore** of a backup onto the same host: the restored space starts frozen and serves nothing until the owner signs a descriptor with a higher epoch for it. Members then detect the epoch change and resync by snapshot; events they hold from the abandoned epoch are kept locally and marked as not part of the restored history.
- **Move** (quiesced stop-and-transfer), as a state machine specified in P0: (1) owner posts `space.frozen`; the host stops accepting writes; (2) owner exports; (3) owner **retires** the old host (`spaces retire` deletes the space's authority data there after verifying the export); (4) import on the new host, which holds the space frozen; (5) owner signs the new descriptor with a higher epoch; its publication is the first event of the new epoch and activates the space; (6) members learn the descriptor from the old host's final events, if they received them, or from a re-shared `sj1_` string.
- Limitation, stated in docs and the threat model: a member who never received `space.frozen` and can still reach an old host that was **not** retired (or was restored from a pre-freeze backup) can keep using that stale copy until they see the new descriptor. Retirement in step 3 is what prevents this; the protocol alone does not. No claim is made about partition-safe live migration.

#### 4.8.9 Other rules
Roles: `owner`, `admin`, `member`. Members may add their own bots if `membersMayAddBots` (default on). Rate limits and quotas are per principal and persisted: 20 events / 10 s, 60 MiB of uploads / hour per member; space storage quota 5 GiB by default. Host offline: members see "space offline", posts queue in the outbox as `pending`; when delivered, a mention runs only if it still satisfies the delivery window in §4.8.5 (so only after outages shorter than about two minutes).

### 4.9 Bridge

Each node is the authority for its own threads; there is no shared log.

- **Remote API**: `rpc.*` messages between two nodes of the same user. A deny-by-default table maps every exposed MMS method to a capability in the caller's delegation (`read`, `chat`, `write`, `terminal`, `settings`). Defaults for a new node: `read, chat, write`. A test asserts every exposed method appears in the table. Mutations carry an idempotency key recorded durably before execution; `rpc.cancel` aborts the handler; results over 64 KiB go through blobs; every request has a deadline; a reconnect can fetch the result of an already-finished request by ID.
- **Stream adapter**: existing thread events are exposed as a `node.thread` stream via an adapter over the event bus and the snapshot API. The adapter keeps a bounded in-memory ring per subscribed thread; a gap yields `snapshotRequired`, served from the existing thread snapshot. The thread store stays the source of truth, so there is nothing to reconcile after a crash: subscribers resnapshot. Token deltas use the ephemeral `delta` message.
- **Hub**: the local daemon keeps sessions to the user's other nodes, merges project and thread lists, and exposes them to GUI and CLI through domain methods (`bridge.nodes.list`, `bridge.threads.list`, `bridge.thread.subscribe`, `bridge.send`, `bridge.steer`, `bridge.abort`).
- **Dispatch**:
  - *Repository identity* across machines: the set of normalized remote URLs plus the root commit hash. Each node keeps a user-confirmed binding `repoId → local path` (suggested automatically when a local repository matches). The existing `src/mms/git/RepositoryIdentity.ts` is local-only and is not used for this.
  - *Request*: `{ repoId, baseCommit, agent, prompt, limits }`. The target resolves the binding (`repo_not_bound` otherwise), ensures `baseCommit` exists (fetch from the shared remote, else request a git bundle of the missing range through the blob lane; the bundle is verified with `git bundle verify` and may only introduce the expected ref), creates a worktree through the existing workspace services, runs the agent.
  - *Result*: `{ dispatchId, node, baseCommit, headCommit, ref: "refs/mousse/dispatch/<id>" }`, signed by the target node. The ref is pushed with the target node's own git credentials if a shared remote exists, else returned as a bundle. Conflicts are not resolved automatically: the result is a branch. Worktree cleanup uses the existing lifecycle services.
  - Dispatch executions use the same state machine as bot runs, including `uncertain`.
  - Uncommitted local changes are not carried; the UI says so before dispatch.

### 4.10 Integration contract with the Chats domain (PR #41)

Fixed now so P5/P6 need no rework:
- A **Group** stays a local chat until its owner *publishes* it to a space. Publishing creates a `space.channel` and copies nothing automatically; earlier local history stays local.
- In a published Group: unmentioned messages go to no agent (the local "first agent" default applies only to unpublished chats), and bot-authored messages never trigger another bot (§4.8.3). Local agent-to-agent handoffs remain a feature of unpublished chats only.
- `ChatStore` on the teammate branch rejects person IDs other than `self`; the binding needs a storage adapter or schema change there, owned by P7.
- Each mention opens a `space.thread` backed by a **separate** backing thread and workspace on the bot owner's node. The Group's single shared backing workspace is not used for network runs.
- `ChatParticipant { kind: 'person' }` maps to `usr_`; `deviceId` maps to `nod_`; local GUI clients remain `self` and act as the profile's user.
- Shared browser, PTY and file resources stay local-only.
- `chats.assignDevice` becomes a Bridge dispatch target selection.
- The Chats UI is the only chat UI; Spaces adds states to it (pending, offline, private, bot presence).
This section is posted on #40 for bvsr365 when P0 starts. Agreement, or the owner's decision on any open objection, is part of the P0 exit gate.

### 4.11 Observability
Structured logs with a correlation ID per session, RPC and execution; tokens, keys, sealed content and message text are never logged. `mousse-cli net status` shows sessions, routes, queue depths, replay progress and last errors. `mousse-cli net doctor` runs reachability and clock checks and names the failing layer (route, TLS, identity, authorization, version). Counters: sessions, reconnects, replay bytes, outbox depth, rejected appends by code, executions by state.

### 4.12 UX states the GUI and CLI must represent
Keystore locked; no identity yet; node not enrolled; peer incompatible version; upgrade required (critical event); route down vs peer offline; space offline; message pending / unknown / failed; bot online / reconnecting / offline; run uncertain; clock skew warning; storage full / recovery required; revoked.

## 5. Phases

### P0 — Contract freeze (serial; one owner; blocks everything)
Deliverables, all reviewed before P1 starts:
1. `docs/net/protocol.md`: normative message catalogue, encodings, limits, resume rules, authorization rules, error codes, version rules.
2. `docs/net/state-machines.md`: session, subscription, outbox message, enrollment, roster/authority, meta projection, execution, private-stream keys, host freeze/move. Each with states, transitions, and failure handling.
3. `docs/net/threat-model.md`: assets, actors (malicious host, relay, member, removed member, stolen node), mitigations, residual risks. One row per security test.
4. `src/shared/net/**`: types, JSON Schemas, error codes, capability table skeleton.
5. Interfaces with documented transactional semantics: `KeyStore`, `IdentityService`, `StreamStore`, `BlobStore`, `Outbox`, `ExecutionLedger`, `BudgetLedger`, `MetaProjection`, `Transport`, `SecureChannel`, `Mux`, `SyncSession`, `RpcDispatcher`, `Clock`, `BotRuntimeAdapter`, `CompartmentStore`, `PrivateStreamKeys`.
5a. Consumer-side contracts that constrain P1 schemas, written and reviewed in P0 even though they are implemented later: `docs/net/bot-runtime.md` (per-adapter profile qualification and enforcement hooks, placement transfer), `docs/net/compartments.md` (compartment identity, visibility epochs, what is stored where), `docs/net/chats-binding.md` (§4.10 in full: ID mappings, publication, storage adapter). Settled inside these documents and fixtures rather than in this plan: exact codecs and minor-version representation; exhaustive meta role transitions including invite evidence and participant changes; key-wrap authentication and nonce rules; approval expiry; the atomic admission/budget/receipt transaction; ledger-loss recovery; RPC cancellation, result retrieval and crash reconciliation between the thread store and `net.db` (an RPC whose effect happened but whose result was not recorded resolves to `uncertain`); Bridge stream generations; large-snapshot staging; clock bounds; archive manifests; TLS authentication gates and exporter label.
6. **Conformance fixtures** in `test-vectors/net/`: signed envelopes (valid and invalid), meta event sequences with expected projections and rejections, cursor/overlap scenarios, admission cases with expected decisions. Workstreams implement against these.
7. Harness: `NetTestBed` (N nodes in one process), `MemoryTransport` with fault injection, `FakeClock`, real-path temp fixtures.
8. Spike write-ups, with the scripts committed under `scripts/net-spikes/` so reviewers can rerun them: TLS over Duplex with pinning and exporter (passed under Node 24 and Electron 43 run-as-node); in-tree DER certificate encoder (passed under both); `node:sqlite` WAL, uniqueness and backup (passed under both; the packaged daemon process is still to qualify); `ws` listener/stream API spike (MMS lifecycle integration is deferred to P2); a crypto self-test script runnable under `ELECTRON_RUN_AS_NODE`; a pinning-gate test showing a wrong peer key closes the connection before any application byte.
Exit: documents and contracts reviewed by two independent reviewers with no blocking findings; fixtures load; harness runs a two-node TLS echo; spikes recorded; §4.10 agreed or decided by the owner.

### P1 — Foundation (parallel A–D, each against P0 interfaces and fixtures)
- **P1-A identity**: keystore backends and states, key generation, delegations, single-writer roster, authority transfer, recovery export/import, verify-only epochs, sealing, transport certificates.
- **P1-B store**: schema and migrations, `StreamStore` with contiguous cursors and epochs, snapshots, `BlobStore` with refs and GC, `Outbox`, `ExecutionLedger`, `BudgetLedger`, quotas and rate windows, failure modes.
- **P1-C link**: TLS secure channel with pinning, mux with lanes and credits, route manager, `memory` and `direct` transports, listener abuse bounds.
- **P1-D sync**: codec and schema validation, session, authority and subscriber roles with the resume rules, idempotent append, blobs, rpc, presence, ping, version negotiation.
- Integration gate: the P0 conformance fixtures pass against the real modules together; two in-process nodes over `memory` and loopback `direct` exchange signed events and resume correctly under every injected fault.

### P2 — Enrollment and roster (after P1)
`net init`, invite/join with exporter-bound proof, atomic token consumption, lost-response retry, roster replication, revoke with session teardown, delegation auto-renewal, authority transfer, recovery. CLI: `net init|status|doctor`, `bridge invite|join|nodes|revoke|rename`.
Exit: a second real daemon process joins via pasted string on loopback, survives restarts of either side, and is cut off after revoke within one roster propagation while connected.

### P3 — Bridge (after P2; A and B parallel, then C)
- **P3-A** remote API: capability table, dispatcher, durable idempotency, cancel, deadlines, stream adapter.
- **P3-B** hub and CLI (`bridge threads|send|attach`), GUI-facing domain methods and events.
- **P3-C** dispatch (needs A and B merged): repo identity and bindings, bundle transfer and verification, worktree run, signed result, execution states.
Exit: from node A's CLI, list B's projects, start a thread on B, watch it stream, steer, abort; dispatch a task and receive a ref, with and without a shared remote.

### P4 — Transports (needs P1 and P2)
- **P4a** (parallel with P3): add-on registry and settings; `tailscale`; `relay` client and `relay serve` with enrollment rendezvous and persisted quotas.
- **P4b** (after P3 exit): `cloudflared` quick and named tunnels.
Exit: Bridge exit scenario passes through a locally run relay. Supervisor logic for `tailscale` and `cloudflared` is tested with fake binaries **and** each has an opt-in real-binary end-to-end script whose run is recorded in the QA checklist before release; fake-only evidence does not qualify a transport.

### P5 — Spaces core (after P2; A, B, C parallel)
- **P5-A** host: create, descriptor, meta state machine, invites and admission, ordering, fan-out, read/write authorization, quotas and rate limits, retention.
- **P5-B** member client: join, replica, outbox with states, resume, offline behaviour.
- **P5-C** private streams: keys, wrapping, re-wrap, key epochs, encrypted blobs.
CLI: `spaces create|invite|join|list|channels|post|tail|members|leave`.
Exit: three daemon processes hold a channel conversation in which each process is killed and restarted in turn. Acceptance boundary: every message that reached `sent` on its author's node is present exactly once, in the same order, on all three after reconnection; `pending` messages are either delivered once or reported `failed`.

### P6 — Bots (after P5; A then B)
- **P6-A** registry, profiles and their enforcement, grants, budgets with reservations, audience policy, permission requests over private streams, emergency stop.
- **P6-B** admission pipeline, delivery window, execution state machine and recovery, work threads, compartments, signed presence and activity.
Exit: in the three-node scenario member 2 tags member 1's `reader` bot; the run happens only on member 1's node within the profile; presence shows it; killing member 1's daemon shows the bot offline within 90 s; a mention received by the host more than 30 s before the bot returns is not executed and gets a `bot.run.expired` marker; a mention received less than 30 s before it returns is executed once.

### P7 — Chats binding (after PR #41 is on master and §4.10 is agreed)
Publish a Group to a space; participant and device mapping; mention work threads; `chats.assignDevice` through Bridge.

### P8 — GUI (after PR #41 is on master)
Devices page (init, invite, list, revoke, routes, status); add-ons page with guided setup and live status; device grouping and picker; remote thread view; Spaces in the Chats UI with all states in §4.12; bot add flow with profile and audience; private aside composer with an explicit marker; agents pane.

### P9 — Hardening, backup, cutover, release
- Space export/import, restore, quiesced move (§4.8.8) with restore drills.
- Mixed-version tests (current vs previous minor; unknown critical event), migration interruption, downgrade refusal.
- Packaged-daemon qualification on macOS and Linux (Windows where a runner exists): enroll, Bridge, a three-node space.
- 24-hour soak with fault injection; assert bounded memory, file handles, queue depth.
- Security review against the threat model.
- Operator docs: quick start, Tailscale, self-hosted relay, Cloudflare Tunnel, hosting a space on a VPS or Mac Mini, backup and move, key recovery, upgrade order.
- Rollout: flags default off → opt-in → default on. Rollback is switching the flag off; net data is left in place.
- Cutover: remove `src/mms/control/**` after the owner confirms no shipped client depends on it.

## 6. Parallel execution model

- Integration branch `codex/issue-<N>-mousse-net` from fresh `origin/master`; published as a draft PR to `master`.
- P0 is done by the integration owner and reviewed before any parallel work.
- Each workstream: own worktree and branch off the integration branch; touches only its own directories plus its own `tests/net/<area>/`; PR into the integration branch; reviewed and merged there by the integration owner. Seam files (§4.1) and `src/shared/net/**` are changed only by the integration owner; a workstream that needs a contract change files a note and waits.
- Waves: (1) P1-A, P1-B, P1-C, P1-D → gate. (2) P2. (3) P3-A, P3-B, P4a, P5-A, P5-B, P5-C. (4) P3-C, P6-A → P6-B, P4b. (5) P7, P8 (gated). (6) P9.
- Each workstream brief names its prerequisite artifacts (interfaces, fixtures, merged modules) and its integration gate.

## 7. Knobs (defaults)

| Knob | Owner | Default |
|---|---|---|
| Node delegation lifetime | fixed | 7 days, auto-renew |
| Invite TTL (node / space) | inviter | 10 min / 24 h |
| Space invite uses | inviter | 1 |
| New node capabilities | user | read, chat, write |
| Inline envelope size | fixed | 64 KiB |
| Blob max size | space admin | 25 MiB |
| Space storage quota | host operator | 5 GiB |
| Member rate limit | space admin | 20 events / 10 s; 60 MiB uploads / h |
| Retention (non-meta streams) | space admin | unlimited |
| Members may add bots | space admin | on |
| Bot profile | bot owner | `chat` |
| Bot steer / visibility | bot owner | owner / public |
| Bot daily budget, per-run ceiling | bot owner | required at setup |
| Bot concurrent runs / runs per member per hour | bot owner | 2 / 20 |
| Delivery window | fixed in v1 | 30 s after host receipt; author delay ≤ 120 s |
| Heartbeat / reconnecting / offline | fixed | 20 s / 45 s / 90 s |
| Replay batch / overlap buffer | fixed | 1 MiB / 1,000 records or 4 MiB |
| Route order | user | direct, tailscale, relay, cloudflared |
| `direct` listener | user | off |

## 8. Test strategy

All tests under `tests/net/**`, run focused.
- **Vectors and conformance**: RFC 8032; frozen envelope and message vectors; the P0 conformance fixtures.
- **Crypto under Electron**: a self-test script run with `ELECTRON_RUN_AS_NODE` covering every primitive and the TLS channel, because vitest runs under system Node.
- **Property and fuzz** (`fast-check`): store invariants (dense sequence, idempotent append, contiguous cursor never skips), decoder never throws on arbitrary bytes, mux never exceeds credit, meta projection is deterministic.
- **Harness scenarios** with `FakeClock` and fault injection, one named test per requirement L1–L17 and per review defect: live record arrives before replay finishes then the link drops; epoch change with reused sequence; two bots mentioned in one message; mention replayed after reconnect outside the window; unknown critical event; concurrent join on one token; lost enroll response; revoke during a session; removed member's later mention; host forges a steer; host withholds heartbeats; same event id with different bytes; crash between accept and run; crash after an external effect; budget exhausted; private attachment unreadable by host; public run cannot read a private compartment; export contains no Bridge rows, tokens or keys; frozen host rejects writes.
- **Multi-process integration**: real daemons over loopback, following the existing framed two-client daemon composition test.
- **Security suite**: one test per threat-model row.
- **Upgrade and skew**: previous-minor peer; schema migration from each earlier version; interrupted migration; downgrade refusal.
- **Soak and performance** (opt-in): 200 k-event replay under a time and memory bound; 24 h fault-injected run.
- **Qualification**: packaged daemon scenarios; real-binary transport scripts.
- **Manual QA checklists** per phase in `docs/net/qa/`.

## 9. Risks and decisions

| # | Item | Position |
|---|---|---|
| R1 | Integration with PR #41 | Contract fixed in §4.10; needs agreement before P5; P7/P8 wait for the merge |
| R2 | A shipped client may depend on `src/mms/control/` | Untouched until P9; removal needs owner confirmation |
| R3 | No sandbox in the runtime | Only enforceable bot profiles in v1; `operator` is owner-steered |
| R4 | Malicious host can delay a removal | Residual, documented; cannot forge, alter or replay |
| R5 | Single host per space | Accepted; backup, restore, quiesced move |
| R6 | Host sees public content and private-stream metadata | Accepted; stated in UI and docs |
| R7 | Root key on a stolen authority node | Vault or passphrase storage, recovery file, 7-day delegations |
| R8 | Prompt injection through group messages | Profiles, budgets, steer default `owner`, compartments |
| R9 | Scope | Bridge (P0–P4a) ships without Spaces; everything is behind flags |
| R10 | Uncommitted work not carried by dispatch | Stated before dispatch |
| R11 | Files on disk are not compartmentalized | Stated at bot setup; only `operator` bots can write |

## 10. Open questions for the owner (defaults in this plan apply until answered)
1. Does any shipped mobile or remote client depend on `src/mms/control/`?
2. Is §4.10 acceptable as the way Spaces plugs into the Chats UI?

## 11. Changes from draft 1 (review resolutions)

| Review defect | Resolution |
|---|---|
| Bot grants not enforceable | §4.8.3: three enforceable profiles; unsupported combinations rejected; env scrub; inheritance; budget reservations |
| Aside confidentiality limited to message body | §4.8.6 encrypted blobs and key epochs; §4.8.7 compartments; stated limit for files on disk |
| Space export leaks profile data | §4.8.8 space-scoped allow-list export; merge import |
| Authorization not verifiable from the event | §4.3 `auth` field and whole-envelope signature; §4.8.2 meta state machine; §4.8.4 execution-time check; criticality suspends execution |
| Concurrent authorities / unfenced restore | §4.2 single roster writer with recovery epoch; §4.8.8 owner-signed descriptor, freeze, quiesced move; no live migration |
| Cursor can skip history | §4.6 contiguous cursor with epoch, `replayThrough`, bounded overlap, atomic snapshot |
| Execution identity too coarse | §4.8.4 key `(space, bot, event)`, payload hash, bot placement, `uncertain` state |
| Offline bot vs replay contradiction | §4.8.5 delivery window on host receipt time, same for live and replay |
| Missing wire contracts, state machines | P0 now freezes protocol, state machines, schemas and conformance fixtures; §4.6 lists rpc, blobs, snapshots, authorization |
| Audience evolution | §4.3 current-membership access; `sinceJoin` cut; private participant changes rotate keys |
| Storage operations | §4.4 GC, uploads, disk full, corruption, bounded transactions, lifecycle draining |
| Upgrade, abuse, UX, release | §4.3 criticality; §4.4 migrations; §4.5 abuse bounds; §4.11–4.12; P9 rollout |
| Dispatch lifecycle | §4.9 repository identity, bindings, bundles, refs, provenance |
| PR #41 agreement too late | §4.10 integration contract fixed before P5 |
| Dependencies understated | §5–6: P4 needs P1+P2; private streams (P5-C) precede P6; P6-A before P6-B |
| Exit criteria overclaim | Acceptance boundaries defined; real-binary and packaged qualification required |
| Hand-written Noise | Replaced by `node:tls` TLS 1.3 with key pinning (spike passed) |
| Segment-file fallback, Plus stub, SSH bootstrap, Funnel, live migration | Cut |
| Wrong seam list, test location, safeStorage claim | §4.1, §8, §4.2 corrected |

## 12. Changes from draft 2 (second-round review edits)

Both reviewers rated draft 2 "ready after listed edits". Applied:

| Edit | Where |
|---|---|
| Enrollment proof was unverifiable from a token hash; now a derived proof key, bound to the TLS exporter and the request | §4.5, §4.7 |
| Key encodings corrected (P-256 is SPKI DER, not raw 32 bytes) | §4.2 |
| Single-writer claim replaced by conflict detection that fails closed; explicit recovery successor; stated limitation | §4.2 |
| Bot placement move is stop-and-transfer including the execution ledger | §4.2 |
| Freeze/restore fencing corrected: epoch pinned by owner-signed descriptor, old host retired before activation, limitation stated | §4.8.8 |
| Admission requires the meta replica to be applied through the freshly confirmed head | §4.8.4 |
| Delivery policy made coherent: bounded delivery with its consequences stated, `bot.run.expired` marker | §4.8.5, §4.8.9, P6 exit |
| Compartment guarantees corrected: scoped to `chat` and `reader`; fresh compartment on participant addition; private-derived output stays private; single `visibility` knob | §4.8.3, §4.8.7 |
| Handoff privilege escalation removed: bot-authored messages never trigger runs in v1 | §4.8.3, §4.8.4, §4.10 |
| Critical unknown events also suspend reads and fan-out on a host; criticality decided by the reader's registry | §4.3 |
| P0 scope expanded: runtime qualification, compartments, chats binding contracts; agreement gate moved to P0 exit | §5 P0, §4.10 |
| TLS pinning gate specified; certificate library dropped for an in-tree encoder; spikes to be committed | §4.1, §4.5, §5 P0 |
| State of `master` after PR #43 recorded | §3.1 |

## 13. P0 recovery and independent review corrections (2026-10-02)

I recovered the interrupted Claude session `3019b0a3-1e52-44a4-8465-43600dcbcee0`, continued the same issue/branch/PR, and preserved the primary checkout's unrelated work. The old session's remaining state-machine writer overwrote the recovery document; I verified its Write record, preserved its output separately, stopped that exact session process and reconciled the P0 documents before independent review.

The current normative contracts are protocol.md, state-machines.md, threat-model.md and the consumer documents; where this earlier design overview is less precise, those contracts govern implementation. The new work is still P0, not shipping Bridge/Spaces behavior.

- Envelope minor versions and sender-raised criticality are explicit; history verification is distinct from live authorization.
- Space invitation evidence and ordered invite-use receipts are signed; different-user joining has a bounded quarantined wire exchange. The exact local `mj1_`/`sj1_` CLI string container is deferred to P2/P5; current wire proof/envelope codecs are frozen in P0.
- Full meta snapshots retain original epoch/sequence positions and use bounded source/staging APIs with atomic generation activation.
- Qualified clock samples expose freshness/RTT/wall-delta evidence. RPC IDs are journalled by callers; lookup/cancel never silently execute unknown work.
- Bridge result/bundle blobs use request-bound node.artifact streams, signed publication references and the original method capability; they do not bypass stream-scoped blob authorization.
- Visibility and encryption epochs are distinct. Controller-authenticated cumulative rewraps preserve existing wraps/writer prefixes; encryption uses durable prefix/counter nonce allocation.
- Bot admission/expiry/terminal/restart accounting and receipt writes have explicit atomic callbacks. Transfer preserves execution identities and budget/call reservations. Approvals are exact-request/action/audience-bound and single-use.
- Runtime qualification is executor-local, not a deterministic meta input; every adapter remains unqualified until its P6 evidence exists. A public compartment is stable per bot/space while each mention has its own execution/workspace/output binding.
- A compromised owner-host node has that owner's delegated privileges in v1. Non-forgery guarantees apply to independently keyed members, not the host's own user; no separate human-intent signature is claimed.
- The committed self-test exercises actual TLS/crypto code and a loopback ws stream under Node and Electron. Full MMS lifecycle composition, packaged daemons, supported Node versions and other platforms remain phase-owned qualification work. A standalone API spike does not prove daemon integration.

The focused fixtures/tests establish encoding, artifact integrity and the test transport only. P1 and later phases must execute these vectors against real services and verify each stated exit scenario. `docs/net/STATUS.md` records actual completed checks and the remaining gate; the plan itself does not certify a passing implementation.
