# Run Engine — engineering spec

Tracking: issue #79. Plan: [run-engine-plan-2026-10-12.md](../run-engine-plan-2026-10-12.md). Background: [catch-up](../catch-up-orchestration-2026-10-12.md), [T3 deep assessment](../t3-orchestrator-v2-deep-assessment-2026-10-12.md), [ideation](../architecture-ideation-2026-10-12.md).

This spec is the contract for implementation. If code and spec disagree, fix one and say which.

## 1. Goal and scope

Every chat turn is a **run** with a durable ID. Nothing happens to a provider until the intent is saved. After a crash the daemon knows what was in flight and says so. Stop, Steer and Undo target a run, never a thread.

Module root: `src/mms/run/`. One profile-scoped SQLite database at `<profileHome>/run/run.db`. The engine is added **beside** `OrchestratorService` and takes over one responsibility per phase. Nothing in this spec requires the GUI to change in Phase 1; the protocol gains optional fields.

## 2. Invariants (enforced by code and checked by `fsck`)

1. A command is durable before any provider I/O.
2. Every control command (`stop`, `steer`, `respond`) names a `runId`. A mismatch is recorded as an `ignored` command with a reason; it never falls through to another run.
3. Run state changes by compare-and-set on `(run_id, epoch)`. Terminal states are final. A retry is a new attempt.
4. Every command commit carries `expectedSequence`; a stale write is rejected, not merged. (T3's locked full-row writes clobbered CAS writes; we do not have two write disciplines.)
5. Only the root attempt finishes a run. Child completion is a stored row, not a callback.
6. A `clientRequestId` seen twice returns the first receipt and performs nothing. Transient failures produce **no** receipt; only semantic rejections do.
7. Transcripts and events are never deleted automatically.
8. Provider names appear only under `src/mms/run/adapters/`. CI counts violations and fails if the count rises (Phase 0 ratchet).
9. Liveness is a lease with an expiry that the reconciler enforces, never "did the stream end".
10. After a crash, a run that was `running` becomes `interrupted` (if we know the provider process died with the daemon) or `uncertain` (if we cannot tell). Neither is ever auto-resumed.

## 3. Data model (Phase 1)

All tables `STRICT`. All IDs are strings. All timestamps ISO-8601 UTC strings. `payload` columns are canonical JSON (`src/mms/net/sync/codec.ts#canonicalJson`).

```sql
CREATE TABLE run_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;

-- One row per user-visible turn.
CREATE TABLE runs(
  run_id        TEXT PRIMARY KEY,                 -- run:thread:<threadId>:ordinal:<n>
  thread_id     TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,                 -- 1-based per thread
  status        TEXT NOT NULL CHECK(status IN ('queued','starting','running','finalizing','completed','interrupted','failed','cancelled','uncertain')),
  epoch         INTEGER NOT NULL DEFAULT 0,       -- bumped on every status write; CAS key
  active_attempt_id TEXT,
  source        TEXT NOT NULL,                    -- gui | cli | channel | schedule | wake | steer-followup | ...
  client_request_id TEXT,
  user_message_id   TEXT,
  requested_at  TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  outcome       TEXT,                             -- JSON: {error?, interruptedBy?, uncertainReason?}
  UNIQUE(thread_id, ordinal)
) STRICT;
CREATE INDEX runs_thread_status ON runs(thread_id, status);

-- One row per execution of a run. Steering restart or retry creates a new attempt.
CREATE TABLE run_attempts(
  attempt_id    TEXT PRIMARY KEY,                 -- attempt:<runId>:<n>
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  ordinal       INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK(reason IN ('initial','steer_restart','retry','recovery')),
  status        TEXT NOT NULL CHECK(status IN ('pending','running','completed','interrupted','failed','cancelled','superseded')),
  provider_ref  TEXT,                             -- JSON {provider, model, sessionId?, nativeTurnId?}; refs only
  started_at    TEXT,
  completed_at  TEXT,
  UNIQUE(run_id, ordinal)
) STRICT;

-- Idempotency receipts. One per clientRequestId. Only semantic rejections are stored as rejected.
CREATE TABLE receipts(
  client_request_id TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  command_kind  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('accepted','rejected','ignored')),
  result        TEXT,                             -- JSON: {runId?, sequence, reason?}
  created_at    TEXT NOT NULL
) STRICT;

-- Append-only per-thread event log. Source for client sync, Bridge, and fsck.
CREATE TABLE thread_events(
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL,
  run_id        TEXT,
  type          TEXT NOT NULL,                    -- run.created | run.status | attempt.created | attempt.status | command.ignored | ...
  payload       TEXT NOT NULL,                    -- full entity, not a delta
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX thread_events_thread_seq ON thread_events(thread_id, seq);
```

Phase 2 adds `effects` (outbox) and `leases`. Phase 4 adds `inbox` and `lineage`. Phase 5 adds `credentials`. Each phase ships its own migration.

**Why rows plus a log, not a projected event store.** Control state in CAS rows is simpler for coding agents to extend correctly than a projector that must stay deterministic. The log carries full entities so a projector can be added later if wanted. `fsck` cross-checks the two.

## 4. Commands and receipts

Every mutation enters as a `RunCommand`:

```ts
type RunCommand =
  | { kind: 'send';   threadId; clientRequestId; input: OrchestratorSendInput; source; forceQueue?: boolean }
  | { kind: 'stop';   threadId; clientRequestId; runId; clearQueue?: boolean }
  | { kind: 'steer';  threadId; clientRequestId; runId; text }
  | { kind: 'respond';threadId; clientRequestId; runId; requestId; answer }
```

`RunEngine.dispatch(command, { expectedSequence? })` returns `CommandResult`:

```ts
type CommandResult =
  | { status: 'accepted'; runId?: string; sequence: number; replayed: boolean }
  | { status: 'rejected'; reason: string; sequence: number }       // semantic; stored
  | { status: 'ignored';  reason: string; sequence: number }       // e.g. stop for a finished run; stored
```

Rules:
- `dispatch` runs under a **per-thread in-process mutex** (`src/mms/run/ThreadMutex.ts`, non-reentrant, FIFO, with a 30 s acquire timeout that throws rather than deadlocks).
- Inside the mutex: look up receipt → if found, return it with `replayed: true` and do nothing. Otherwise decide → one `db.transaction` writes rows + events + receipt. **No I/O inside `decide` or the transaction.**
- `expectedSequence`, when provided, must equal the thread's current max `seq`; otherwise `rejected` with `reason: 'stale_sequence'` and **no receipt** (the caller should re-read and retry).
- A thrown exception during decide or commit rolls back and surfaces as an error. It does **not** write a receipt (invariant 6).
- `stop`/`steer`/`respond` whose `runId` is not the thread's active run return `ignored` with `reason: 'run_not_active'` and append a `command.ignored` event with `{runId, activeRunId, kind}`.

## 5. Run lifecycle (Phase 1)

```
queued ──▶ starting ──▶ running ──▶ finalizing ──▶ completed
   │           │           │             │
   └──cancel───┴──interrupt┴─────────────┴──▶ interrupted | failed | cancelled
                                                    (crash) ──▶ uncertain
```

- `send` on an idle thread creates `run(queued)` and an `attempt(pending)`, then (Phase 1 only) hands the run to the legacy `OrchestratorService.executeTurn` through an adapter hook. The hook calls `engine.markStarting(runId, epoch)`, `markRunning`, `markFinalizing`, `markTerminal(status, outcome)`. Each is a CAS write; a CAS miss throws `StaleRunWriteError` and the legacy code must stop touching that run.
- **Active** means `starting|running|finalizing`; at most one per thread. Any number of `queued` runs may wait behind it (SPEC §2.3 applies to active runs only).
- **Active** means `starting|running|finalizing`; at most one per thread (`RunStore.getActiveRun`). Any number of `queued` runs may wait behind it (`listQueuedRuns`). Invariant 2.3 applies to active runs only.
- `send` on a busy thread creates `run(queued)` and enqueues into the existing durable `queue.json` with `runId` stored on the `QueuedMessage` (new optional field). When the legacy drain picks it up, it uses the existing `runId` instead of creating a new run.
- `stop` for the active run: CAS `running→interrupted` is **not** done by the command; the command sets `runs.outcome.stopRequested = true` under CAS (epoch bump) and signals the legacy abort controller. The terminal write comes from the hook when the turn actually ends. This keeps "who wrote the terminal state" single-sourced.
- Startup: `engine.reconcileOnBoot()` runs before any turn is admitted. Every run in `starting|running|finalizing` becomes `interrupted` with `outcome.interruptedBy = 'daemon_restart'` (Phase 1: we know the legacy loop died with us). Phase 2 introduces `uncertain` for out-of-process providers.
- `turn-state` events already emitted by `OrchestratorService` gain `runId`. `TurnState.turnId` is set to the `runId`.

## 6. Protocol changes (Phase 1, additive)

- `orchestrator.send` accepts optional `clientRequestId`. Response gains `runId` and `sequence`. **The RPC still awaits the turn in Phase 1** (changing that is Phase 2) but the `runId` is emitted immediately via a new `run.created` protocol event so clients can target it.
- `orchestrator.abort` and `orchestrator.steer` accept optional `runId`. When present, the engine path is used and `ignored` is a valid response (`{ok:false, ignored:true, reason}`). When absent, legacy behaviour is unchanged (deprecated, removed in Phase 2).
- New read methods: `runs.list(threadId, {limit})`, `runs.get(runId)`, `runs.events(threadId, {afterSeq, limit})`.
- New events on the ring: `run.created`, `run.status`, `command.ignored`.
- All params validated like existing handlers (`asString`, bounded lengths, reject unknown keys).

## 7. `fsck` (Phase 0 skeleton, Phase 1 real checks)

`mousse-cli run fsck [--profile]` and `RunFsck.check(db)` return a list of findings:
- a run in a non-terminal status whose daemon epoch is not the current one;
- an attempt whose run is terminal but attempt is not;
- `runs.active_attempt_id` pointing at a non-existent or non-running attempt;
- a `thread_events` sequence gap per thread;
- a receipt whose `result.runId` does not exist;
- (dual-write, Phase 1 only) in-memory `turnStates` disagreeing with `runs` for live threads.

## 8. Database layer

Extract from `src/mms/net/store/database.ts`:
- `src/mms/run/db/ProfileDatabase.ts`: `node:sqlite` `DatabaseSync`, `PRAGMA foreign_keys=ON; busy_timeout=5000; journal_mode=WAL; synchronous=FULL`, `quick_check` on open, `BEGIN IMMEDIATE` transactions, nested-transaction depth, `assertSynchronous` (a transaction callback returning a Promise throws), `afterCommit` deferred callbacks, `checkpoint(point)` fault-injection hook, 0o600 perms, symlink refusal.
- Do **not** import Net's `NetError`; define `RunStoreError` with codes `storage_full | storage_corrupt | stale_write | bad_request | internal`.
- One connection per profile. Transactions are synchronous and short; provider I/O never runs inside one.

## 9. Testing

- Every new module has unit tests in `tests/run/`.
- Phase 1 integration test (`tests/run/engineLegacyBridge.test.ts`): wire a real `OrchestratorService` with a fake `streamSimple` (reuse the `streamOf()` helper pattern from `tests/steer.test.ts`), send a message, assert a `runs` row goes `queued→starting→running→finalizing→completed`, assert `stop` with the completed `runId` returns `ignored`, assert a duplicate `clientRequestId` replays.
- Fault test: inject `checkpoint('transaction.beforeCommit')` to throw and assert no receipt and no partial rows.
- Boot test: write a `running` run, construct a fresh engine, `reconcileOnBoot`, assert `interrupted`.
- Use `TMPDIR=/private/tmp npx vitest run tests/run` locally (Node 24.18 on this machine; package wants ≥24.20).

## 10. Phase 0 deliverables (this commit series)

- Land the late-turn steer fix (already applied from the primary checkout's staged edit) and `tests/lateTurnSteer.test.ts`.
- Delete `src/mms/orchestrator/SpawnTransaction.ts` (no callers).
- `scripts/check-provider-branches.mjs` + `tests/run/providerBranchRatchet.test.ts`: count regex matches for provider literals (`'claude-subscription'|'antigravity'|'codex'|'claude-code'|'cursor-agents-cli'|'opencode'`) in `src/mms/orchestrator/**` and `src/mms/run/**`, compare with `scripts/provider-branch-baseline.json`, fail if higher. Baseline committed at current count.
- `src/mms/run/fsck/RunFsck.ts` skeleton returning `[]` plus CLI stub `run fsck`.
- This document.

## 11. Non-goals for the PR

- Changing the GUI composer or renderer beyond reading the new optional fields.
- Replacing `ThreadDataStore` transcript storage.
- Removing the 11 existing feature flags (decided separately; tracked in #79 comments).
- Effect-TS or any new runtime dependency.
