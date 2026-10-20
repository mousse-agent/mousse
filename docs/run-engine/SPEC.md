# Run Engine — engineering spec

Tracking: issue #79. Plan: [run-engine-plan-2026-10-12.md](../run-engine-plan-2026-10-12.md). Background: [catch-up](../catch-up-orchestration-2026-10-12.md), [ideation](../architecture-ideation-2026-10-12.md).

This spec is the contract for implementation. If code and spec disagree, fix one and say which.

## 1. Goal and scope

Every chat turn is a **run** with a durable ID. Nothing happens to a provider until the intent is saved. After a crash the daemon knows what was in flight and says so. Stop, Steer and Undo target a run, never a thread.

Module root: `src/mms/run/`. One profile-scoped SQLite database at `<profileHome>/run/run.db`. The engine is added **beside** `OrchestratorService` and takes over one responsibility per phase. Nothing in this spec requires the GUI to change in Phase 1; the protocol gains optional fields.

## 2. Invariants (enforced by code and checked by `fsck`)

1. A command is durable before any provider I/O.
2. Every control command (`stop`, `steer`, `respond`) names a `runId`. A mismatch is recorded as an `ignored` command with a reason; it never falls through to another run.
3. Run state changes by compare-and-set on `(run_id, epoch)`. Terminal states are final. A retry is a new attempt.
4. Every command commit carries `expectedSequence`; a stale write is rejected, not merged. (One write discipline only: locked full-row writes would clobber compare-and-set writes.)
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
- Phase 1 integration test (`tests/run/orchestratorRunEngine.test.ts`): wire a real `OrchestratorService` with a fake `streamSimple` (reuse the `streamOf()` helper pattern from `tests/steer.test.ts`), send a message, assert a `runs` row goes `queued→starting→running→finalizing→completed`, assert `stop` with the completed `runId` returns `ignored`, assert a duplicate `clientRequestId` replays.
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

## 12. Phase 2 — effects, leases, reconciler, uncertainty

Phase 1 records runs but the legacy loop still performs provider I/O inline. Phase 2 moves every provider-facing action behind a durable **effect** and adds a **reconciler** that keeps stored state and reality in agreement. The reconciler is not optional: it is what a lease-only design lacks: unchecked leases, no timeouts, undetected clean stream ends.

### 12.1 Tables (migration 2)

```sql
CREATE TABLE effects(
  effect_id     TEXT PRIMARY KEY,                 -- effect:<clientRequestId|runId>:<kind>:<n>, deterministic
  thread_id     TEXT NOT NULL,
  run_id        TEXT,
  kind          TEXT NOT NULL,                    -- see 12.2
  class         TEXT NOT NULL CHECK(class IN ('process_bound','replay_safe')),
  status        TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  payload       TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  timeout_ms    INTEGER NOT NULL,                 -- per-effect execution deadline; enforced
  available_at  TEXT NOT NULL,
  lease_owner   TEXT,                             -- "<daemonEpoch>:<pid>"
  lease_expires_at TEXT,                          -- checked on claim AND by the reconciler
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
) STRICT;
CREATE INDEX effects_claim ON effects(status, available_at, thread_id);
CREATE INDEX effects_thread ON effects(thread_id, status);

CREATE TABLE daemon_epochs(
  epoch         INTEGER PRIMARY KEY AUTOINCREMENT,
  pid           INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  ended_at      TEXT                               -- set on clean shutdown; NULL after a crash
) STRICT;

CREATE TABLE tool_invocations(
  invocation_id TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  idempotent    INTEGER NOT NULL,                 -- 0/1 from the tool registry
  status        TEXT NOT NULL CHECK(status IN ('started','committed','failed','outcome_unknown')),
  args_digest   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT
) STRICT;
CREATE INDEX tool_invocations_run ON tool_invocations(run_id, status);
```

### 12.2 Effect kinds and classes

| kind | class | timeout | what it does |
|---|---|---|---|
| `turn.start` | process_bound | 6 h | run the provider turn (legacy `executeTurn` body, later adapters) |
| `turn.interrupt` | process_bound | 30 s | abort the live turn; "not active" counts as success |
| `turn.steer` | process_bound | 30 s | deliver steer text to the live turn |
| `request.respond` | process_bound | 30 s | **reserved**: answer a pending user question / approval |
| `checkpoint.capture` | replay_safe | 2 min | **reserved**: post-turn git checkpoint (when enabled) |
| `title.generate` | replay_safe | 1 min | **reserved**: thread title (own lane; never blocks turns) |
| `workspace.cleanup` | replay_safe | 5 min | **reserved**: release leases, remove scratch worktrees |

**process_bound** effects die with the daemon; on boot they are `cancelled` and their run becomes `interrupted`. **replay_safe** effects are re-queued on boot. A kind's class is fixed in code, not per row.

**Reserved** kinds keep their class, lane and timeout but have no producer yet: `EffectOutbox.enqueue` refuses them at once with `bad_request('reserved effect kind')`, and the worker has no executor for them (a row that exists anyway fails with `'no executor'`). Questions and approvals are still answered in-process, checkpoints are taken inside the turn, titles are generated by the orchestrator, and worktree cleanup belongs to the lifecycle services.

### 12.3 Worker and lanes

- One in-process worker whose fibres (plain async loops) are grouped by lane class: **turn** fibres claim only `turn.start`, **control** fibres claim only `turn.interrupt|turn.steer|request.respond`, **replay-safe** fibres claim only the replay-safe kinds (`EffectOutbox.claimNext(owner, now, { lanes })`). Defaults 8 / 2 / 2 (`EffectWorker` option `fibres`, profile option `effectFibres`). A `turn.start` holds its fibre for the whole turn, so the turn-fibre count is the **per-profile concurrency cap: at most 8 concurrent turns**; a further send waits as a pending `turn.start` until a turn ends. Control fibres never run `turn.start`, so Stop and steer reach live turns however many are running. Wake sources: `afterCommit` notify, next `available_at` timer, 30 s safety poll.
- Claim is one `UPDATE … WHERE effect_id = (SELECT … LIMIT 1) RETURNING *` and is only valid when, for the same thread lane, there is **no `running` row whose lease has not expired** and no earlier `pending` row. `title.generate` is its own lane, and `turn.interrupt`, `turn.steer` and `request.respond` share a per-thread **control** lane so they reach a live turn instead of queueing behind its long-running `turn.start`.
- Lease = `timeout_ms + 15 s`. The worker renews the lease every `timeout_ms/3` while executing.
- Execution is raced against `AbortSignal.timeout(timeout_ms)` and against cancellation. On timeout: `failed` with `last_error='timeout'` if attempts exhausted, else `pending` with backoff `min(30 s, 100 ms·2^(n−1))`. An executor that cannot run its effect yet throws `EffectDeferredError(delayMs)`: the row goes back to `pending` at `now + delayMs` with the attempt not counted (`EffectOutbox.defer`). A row waiting out a backoff or a deferral still blocks every later row of its lane (lanes are FIFO).
- Settlement is CAS on `(effect_id, lease_owner)`; a lost lease aborts the local execution and writes nothing.
- `EffectWorker.stop()` aborts every execution and returns only once every executor promise it started has settled (an aborted turn may still be writing its terminal state). The profile writes the daemon's clean `ended_at` after that, after the channels shut down and the requests went idle (`MmsProfileServices.finishStop`); a stop that fails to drain leaves the epoch open, so the next boot reads it as a crash.
- A claimed `turn.start` can be aborted in flight (`EffectWorker.cancelInFlight`); the engine reaches it through `RunEngine.setInFlightCanceller`, which the orchestrator wires when a worker is attached.

### 12.4 Reconciler (every 5 s and after every commit)

A single loop; each rule is a pure function of stored state and produces commands/effects. Rules, in order:

1. **Expired lease on a `running` effect** → mark `pending` (or `failed` if attempts exhausted); the stuck fibre's result is discarded by the CAS.
2. **Run `running|finalizing` with no live effect and no heartbeat for > 2× heartbeat interval** (scaled by `CommandPolicy.heartbeatToleranceMs(caps, heartbeatMs)` for the thread's adapter: 6× for `events:'sparse'`) → `interrupted` with `interruptedBy:'provider'`, `outcome.error='no terminal event'`. This catches a clean stream end without a terminal event. Local-action runs (`source: 'undo'|'revert'`) whose heartbeat is fresh are exempt; they heartbeat while their action runs.
3. **Pending `stopRequested` on a run whose `turn.interrupt` effect is terminal but the run is still non-terminal after 10 s** → force `interrupted` (`interruptedBy:'user'`) and emit a warning event.
4. **Child run terminal while a parent waits** (Phase 4) → wake parent (§14.3). First, `delivered` inbox rows whose delivery failed or was cut off go back to `pending`; a thread that already has a `queued` wake run gets no second one.
5. **Queued run with no active run on its thread whose latest `turn.start` is `cancelled` and none is `pending|running`** (a stranded run: boot cancelled its process-bound effect) → when the dead effect's stored payload carries the send (`input`; image data is not stored, so images arrive empty), enqueue a fresh `turn.start` with it (next effect ordinal) and append `reconcile.restarted_queued_run`; with no payload (a pre-Phase-2b run), end the run `cancelled` with `outcome.error='no turn payload after restart'` and append `reconcile.cancelled_stranded_run`. A queued run that never had a `turn.start` waits on the message queue and is left alone, as are queue-item sends (`queueItemId`, re-drained by the queue's own recovery) and wake or integration payloads (settled at boot).
6. **`tool_invocations` at `started` whose run is terminal** → `outcome_unknown`.

Every repair appends a `reconcile.<rule>` event. The loop never calls a provider itself. Each rule runs on its own: a rule that throws leaves its part of the report empty, appends `reconcile.rule_failed` (`{ rule, error }`, thread `__reconciler__`) and the remaining rules still run.

### 12.5 Boot

`reconcileOnBoot()` (extends Phase 1):
1. Insert a new `daemon_epochs` row; find the previous row; if its `ended_at` is NULL the previous daemon crashed.
2. Cancel all `process_bound` effects in `pending|running` (reason `daemon_restart`).
3. Re-queue `running` `replay_safe` effects; leave `pending` ones. Revoke every live Mousse MCP credential row (§15.1: the tokens lived only in the previous daemon's memory).
4. Runs in `starting|running|finalizing`:
   - if the previous epoch ended cleanly → `interrupted`, `interruptedBy:'daemon_restart'`;
   - if it crashed and the run has any `tool_invocations` at `started` with `idempotent=0` → **`uncertain`**, `uncertainReason:'non_idempotent_tool_in_flight'`, listing the tools; the thread's worktree lease is kept (quarantine) until a user action; all other crashed runs → `interrupted`.
5. For each affected thread, record a `restart.note` event listing what was cut off. The next turn on that thread prepends a system note; the GUI shows a "Continue" affordance. **Nothing auto-resumes.** The note also lists runs the previous daemon's clean shutdown already interrupted (a turn aborted by the worker stop or the profile shutdown ends `interrupted` with `interruptedBy:'daemon_restart'` and the transcript line "Turn interrupted by a Mousse restart.", not a user Stop): those that started, completed since the previous epoch's `started_at`, are not in an earlier note, and have no later started run on their thread. Stranded queued runs (rule 5) appear as `queuedRunIds`.
6. Start the heartbeat (`heartbeat_at` every 10 s) and the reconciler.

### 12.6 Tool idempotency registry

`src/mms/run/tools/idempotency.ts` maps tool name → `idempotent: boolean`. Read-only tools (`read_file`, `list_dir`, `ls`, `git_status`, `git_diff`, `web_search`, `web_fetch`, `browser_observe/find/extract/screenshot/tabs`, `list_tasks`, `list_subagents`) are idempotent. `bash`, `run_command`, `write_file`, `edit_file`, `browser_act/open`, `create_task`, `update_task`, `create_subagent(s)`, `integrate_subagent`, `present_plan`, `ask_user` are not. MCP tools default to **not idempotent** unless the server annotates `readOnlyHint`. `LlmClient.executeToolCall` writes `started` before and `committed|failed` after; an `outcome_unknown` row is rendered back to the model on the next turn as a tool result saying the outcome is unknown and must be verified.

### 12.7 Protocol additions

- `orchestrator.send` takes `await: 'turn' | 'ack'`. With `'ack'` it returns as soon as the `send` command and its `turn.start` commit (`runId`, `sequence`); the turn result arrives through events. **The default stays `'turn'`** (the RPC awaits the turn, and `MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS` still applies) until the GUI's `runSend` adopts `'ack'`.
- `orchestrator.send`, `orchestrator.abort` and `orchestrator.steer` reject unknown keys and an empty `clientRequestId` with `invalid_params`, like the `runs.*` handlers; `acknowledgeUncertain` without `continuationOfRunId` is `invalid_params`. Engine refusals (continuation, fork, merge-back, `client_request_id_conflict`) surface as protocol errors whose code is the refusal reason.
- New read: `runs.effects(threadId, { limit ≤ 200, before? })` → the newest effects (oldest first within the page) with `cursor` (pass as `before` for older ones) and `hasMore`; new events `effect.status`, `reconcile.repair`, `run.uncertain`, `restart.note`.
- `engine fsck` adds: `effect_lease_expired_unclaimed`, `effect_running_for_dead_epoch`, `run_active_without_effect`, `tool_started_on_terminal_run`, `queued_run_without_effect_or_queue_item` (warning: a queued run with no `pending|running` `turn.start` that is not on its thread's queue; without queue access, one whose last `turn.start` ended and that is no queue item's) and, from Phase 4, `delegation_running_child_terminal` (a `running` delegation whose child run ended).

### 12.8 Tests

- Fault matrix like `tests/platformWorkflowDurabilityMatrix.test.ts`: kill between each pair of steps (`run.created`, `effect.pending`, `effect.running`, provider streaming, `tool.started`, `tool.committed`, `turn terminal`, `effect.succeeded`) by throwing at `checkpoint()` points, reopen, `reconcileOnBoot`, and assert the exact run/effect/tool states.
- Reconciler unit tests per rule with a seeded store and a fake clock.
- Worker: timeout fires and lease renewal keeps a long effect alive; lost lease discards a late result.
- Legacy bridge regression: all Phase 1 tests remain green with the drain timer replaced by rule 5.

## 13. Phase 3 — provider adapters and the capability manifest

Today `executeTurn` branches on `selectedModel.llmProvider` (`antigravity`, `claude-subscription`, else the pi-ai `LlmClient` loop) and each branch has its own compaction, steer, history and metrics handling. Phase 3 puts every provider behind one interface so the engine and the `turn.start` executor never see a provider name (invariant 8; the ratchet enforces it).

### 13.1 Interface (`src/mms/run/adapters/ProviderAdapter.ts`)

```ts
export interface ProviderAdapter {
  readonly driver: ProviderDriverKind               // 'pi' | 'claude' | 'antigravity' | 'codex'; instances map to it (§13.8)
  readonly capabilities: ProviderCapabilities        // static; may be refined per model via describe()
  describe(model: string): Promise<ModelInfo>        // context window, image input, reasoning levels
  startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl): Promise<TurnResult>
  steer?(sessionRef: ProviderRef, text: string): Promise<'delivered' | 'not_active'>
  interrupt(sessionRef: ProviderRef): Promise<'interrupted' | 'not_active'>
  compact?(sessionRef: ProviderRef): Promise<void>
  rollback?(sessionRef: ProviderRef, toTurnOrdinal: number): Promise<void>
  fork?(sessionRef: ProviderRef, atTurnOrdinal: number): Promise<ProviderRef>
}
export interface TurnInput { runId; attemptId; threadId; cwd; instanceId; model; prompt; images?; history: HistoryHandoff; mode: 'agent'|'plan'; tools: ToolHost; signal: AbortSignal }
export interface TurnSink { text(delta); thinking(delta); toolStart(ev); toolEnd(ev); usage(u); nativeRef(ref: ProviderRef) }
export interface TurnControl { drainSteer(): string | undefined; heartbeat(): void }
export interface TurnResult { text: string; aborted: boolean; usage?; providerRef: ProviderRef }
```

`ToolHost` is Mousse's tool registry (delegation, ask_user, tasks, browser…). In-process loops call it directly; vendor runtimes reach it over the Mousse MCP server (Phase 5). Phase 3 passes it to the pi adapter only; native adapters receive `tools: null` until Phase 5.

### 13.2 Capability manifest — every flag has a reader

```ts
export interface ProviderCapabilities {
  steer: 'native' | 'interrupt_restart' | 'queue_only'    // read by CommandPolicy.steerStrategy (see below)
  interrupt: boolean                                       // CommandPolicy.stopStrategy
  rollback: 'native' | 'none'                              // CommandPolicy.undoStrategy (Phase 6)
  fork: 'native' | 'portable'                              // CommandPolicy.forkStrategy (Phase 6)
  events: 'rich' | 'sparse'                                // Reconciler rule 2 heartbeat tolerance (sparse = 6×)
  containment: 'strong' | 'weak'                           // CheckpointRestoreSafety (Phase 6): weak → review diff, never auto-restore
  historyInjection: 'native' | 'prompt'                    // HandoffDelivery (Phase 6)
  mcp: boolean                                             // Phase 5: whether the Mousse MCP server can be attached
}
```

`steer` describes how steer text reaches a live turn. `native`: the text joins the live turn without cancelling in-flight work (a running tool call finishes and the model sees the text at its next step); only the pi loop does this. `interrupt_restart`: the provider delivers it by interrupting the turn and resuming or restarting the session with the text as a new user message, so a tool call in flight is cancelled (Claude Subscription: `query.interrupt()` then resume; Antigravity: `session/cancel` then a new prompt). `queue_only`: the text waits for the turn to end. User steers are delivered the same way whatever the value; the capability decides only whether reconciler rule 4 may push a delegation notice into a live run (§14.3).

Rule: `tests/run/capabilityReaders.test.ts` lists each key with its reader functions (`steer` → `steerStrategy`, `interrupt` → `stopStrategy`, `rollback` → `canUndoNatively`, `fork` → `forkStrategy`, `events` → `heartbeatToleranceMs`, `containment` → `restoreMode`, `historyInjection` → `handoffDelivery`, `mcp` → `mcpAttachable`) and asserts that each reader, defined under `src/mms/run/**` outside `adapters/**`, reads `caps.<key>`, and that some non-test source under `src/` outside `adapters/**` **calls** it (a `name(` call site other than its definition, comment lines excluded). Adding a flag without a called reader fails CI. (A flag nobody reads is documentation pretending to be behavior.) There is no `nativeSubagents` flag: every adapter's delegation goes through Mousse's own `delegate_task` (§14), so nothing would read it.

### 13.3 CommandPolicy (`src/mms/run/CommandPolicy.ts`)

Pure functions from `(capabilities, runState)` to a decision; the engine and executors call these instead of branching:
- `steerStrategy(caps, run)` → `native | interrupt_restart | queue` (and `late_steer_new_run` when the target run is finalizing/terminal).
- `stopStrategy(caps, run)` → `interrupt | settle_locally` (no live session). Read by the `turn.interrupt` executor (`OrchestratorService.interruptRun`): it aborts the in-process turn; for `interrupt` it also asks the adapter to interrupt the attempt's provider session. When nothing was live — no in-process turn (running, admitted or unwinding) and the adapter answers `not_active` (or there is no session to ask) — the run is settled right there, `interrupted` by the user with `outcome.stopStrategy`, instead of waiting for rule 3.
- `heartbeatToleranceMs(caps)`.

### 13.4 Adapters to build

| Adapter | Wraps | Caps (steer / interrupt / events / containment) |
|---|---|---|
| `PiLoopAdapter` | `LlmClient.chat` tool loop | native / yes / rich / strong (we run the tools) |
| `ClaudeSubscriptionAdapter` | `ClaudeSubscriptionProviderService.chat` | interrupt_restart (drainSteer, interrupt then resume) / yes (signal) / rich / weak |
| `AntigravityAdapter` | `AntigravityProviderService.chat` | interrupt_restart (cancel then re-prompt) / yes / sparse / weak |
| `CodexAdapter` | `CodexProviderService.chat` over `codex app-server` | native (`turn/steer` joins the running turn) / yes (`turn/interrupt`) / rich / weak |

There is no `terminalQuality` flag: every adapter's `startTurn` settles when its stream closes, and that settlement is the turn's terminal signal, so no code path would read a "stream closed without a terminal event" policy. A hung stream is caught by rule 2's heartbeat window (§12.4).

Shared builders in `src/mms/run/adapters/shared/` **before** the second adapter: streaming message assembly (text/thinking/tool start-end into `ChatMessage`s), usage recording, native history serialisation (`providers/nativeAgentHistory.ts`), steer draining. Without them, each adapter re-implements the same assembly.

### 13.5 `turn.start` executor

The executor lives in `src/mms/orchestrator/OrchestratorService.ts`: `effectExecutors()['turn.start']` → `executeTurnStartEffect` (wake and integration payloads branch to `executeWakeEffect` / `executeIntegrationEffect`) → `runTurnOnSession` → `executeTurn`, which resolves the adapter by the thread's provider instance (`thread.modelOverride.instanceId`, §13.8) via `AdapterRegistry`, builds `TurnInput` (prompt, images, history handoff from `nativeContext`, mode), calls `startTurn`, pipes `TurnSink` into the transcript/stream emitters and marks the run terminal. A separate `executors/turnStart.ts` was not split out: admission, workspace, checkpoint and transcript state are orchestrator-owned. The executor starts only a `queued` run: a claimed effect whose run is no longer queued returns before any workspace or provider work, and a run that cannot be marked `starting` (cancelled meanwhile, or held elsewhere) fails the turn before provider I/O.

### 13.6 Replay test kit (`src/mms/run/testkit/`)

- `ReplayTransport`: an adapter-boundary recorder/replayer. Record mode wraps the real adapter's provider calls and writes `tests/run/fixtures/<scenario>/<adapter>.ndjson` of `{ dir: 'out'|'in', frame }`; replay mode asserts outbound frames structurally and emits inbound ones.
- Boundary per adapter: pi = the `streamSimple` call/stream chunks; claude-subscription = SDK `query()` messages; antigravity = ACP JSON-RPC frames. Record at the wire where one exists (ACP); otherwise at the SDK call boundary and say so in the fixture header.
- `tests/run/scenarios/*.ts` each run against every adapter present in the fixture dir: plain turn; steer mid-tool; stop mid-stream; provider error; context-overflow compaction; restart mid-turn (reopen db, `reconcileOnBoot`).
- Recorder scripts under `scripts/run-record-*.mjs`, run by hand with real credentials; a nightly canary job is tracked separately (#79 follow-up).

### 13.7 Exit criteria

- `rg "llmProvider === '" src/mms/run src/mms/orchestrator/OrchestratorService.ts` → only inside `adapters/`; ratchet baseline lowered to 0 for the orchestrator.
- All three adapters pass the same scenario set.
- `capabilityReaders.test.ts` green.

### 13.8 Provider instances

A **driver** is a kind of runtime (`pi`, `claude`, `antigravity`, `codex`); an **instance** is one configured use of a driver with a stable id. Every caller that picks an agent — main chat, `delegate_task`, channel sessions, Bridge dispatch through a thread — selects `ProviderSelection { instanceId, model }` (`src/shared/providerInstances.ts`).

- **Instance map.** Per profile, `providers.instances` in the profile config: `Record<instanceId, { driver, enabled, config? }>`. `ProviderInstanceService` (`src/mms/providers/`) seeds it on load with `antigravity`, `claude`, `codex` and `pi:<provider>` for each credentialed pi-ai provider. Enabled only means the profile may pick an instance; whether it can run is its service's `configured()` (Codex: a ChatGPT sign-in from the terminal `codex login`). The profile also stores `providers.instancesSeedVersion` (1 is the first recorded seed set). An entry is only upgraded when the profile's recorded seed version proves it is the seed: the marker is at least 1 and below the version of the seed change, and the entry still equals the old seed. A profile without a marker is never upgraded. A store that cannot be read is never seeded or written: the service keeps the last map it read and reports the error (`providers.listConfigured` → `instancesError`). A stored entry is never rewritten; seeding only adds missing ids. A `pi:<provider>` id for a known pi-ai provider without an entry resolves as an implicit enabled pi instance (the pi loop reports missing credentials itself).
- **Resolution.** `AdapterRegistry` holds one adapter per driver and resolves instance id → entry → driver → adapter. An unknown id fails with `provider_instance_unknown`, a disabled one with `provider_instance_disabled`, both naming the id; nothing falls back to the pi loop. Stopping work already running on a disabled instance is still allowed. The one exception is the configured default when it names nothing (no default model configured): it runs on the pi driver so its loop resolves and reports the default as before. A blank explicit override (thread, channel or caller) is rejected like an unknown name.
- **Legacy names.** Wherever an older `llmProvider` string still arrives (GUI `threads.setModel`, stored thread and channel-session `modelOverride`, `delegate_task`'s `provider`, provider refs of earlier attempts), `instanceIdForLegacyProvider` maps `claude-subscription` → `claude`, `antigravity` → `antigravity`, `codex` → `codex`, a known pi-ai provider `p` → `pi:p`, and rejects anything else with `provider_instance_unknown`. Stored selections are migrated on read and written in the instance shape `{ instanceId, llmProvider, model }` on the next save, and the global default (`providers` in the profile config) keeps the `instanceId` it was picked with until a later default names only a provider; `llmProvider` is derived from the instance and kept only for older readers. `TurnInput.llmProvider` is likewise derived and deprecated.
- **Native continuations.** `ProviderRef.instanceId` names the instance that owns a provider session. Claude saved sessions record their instance and login policy and resume only when both match (a policy switch already drops them); Antigravity sessions and Codex threads record their instance. Mousse MCP credentials are per thread and instance (§15.1).
- **Delegation.** `delegate_task` takes `instanceId` (and still accepts `provider`, mapped as above). The host resolves it before the delegation transaction, so an unknown or disabled instance fails the tool call without creating a thread; the delegation row's `provider` column records the instance id. That column is a record, read as stored (older rows hold a provider name); the child is routed by its thread's selection, written when the child thread is created and migrated on read like any other.
- **Not yet.** One instance per driver in v1, and each driver has one adapter shared by its instances. A driver factory that builds an adapter per instance from its `config`, and a per-instance `status()`, come when a second instance of a driver is needed.

## 14. Phase 4 — one delegation path

Three spawn paths exist today: `spawn_agents` text blocks parsed from the reply (completion by polling `.mousse/task-progress.json`), named agents (`create_subagent*` tools, in-process Mousse runtime only, parent blocked inside the tool call), and workflow/definition agents. Phase 4 replaces the first two with one primitive and keeps workflow agents as a caller of it.

### 14.1 Model

- A **child is a thread** with `lineage { parentThreadId, parentRunId, relationship: 'subagent' }` persisted in a new `thread_lineage` table (migration 3). Its runs are ordinary runs on the same engine.
- A **delegation** row ties the parent run to the child thread: `delegations(delegation_id PK, parent_run_id, parent_thread_id, child_thread_id, child_run_id, provider, model, prompt_digest, wake: 'always'|'settled_only', status: 'running'|'result_available'|'acknowledged'|'cancelled'|'failed', result TEXT, created_at, completed_at)`; migration 6 adds `workspace: 'isolated'|'shared'` and `role`, so a child session rebuilt from storage keeps its workspace policy (a `shared` child stays a read-only observer of its parent's workspace).
- **Inbox**: `inbox(inbox_id PK, thread_id, run_id?, kind: 'child_result'|'restart_note'|'reconcile_notice', payload, status: 'pending'|'delivered'|'acknowledged', created_at)`. A child's completion writes one `child_result` row for the parent **in the same transaction** as the child's terminal write (invariant 5: child completion is a stored row). Notifications only speed up discovery.
- **Publication gate**: a child's result lands only if, in that transaction, the delegation is still `running` (whatever the parent run's state: a parent that already ended is woken by its inbox row, §14.3). A cancelled or superseded child can finish but cannot publish. The delegation becomes `result_available` when the child run ended `completed`, and `failed` when it ended `failed`, `interrupted`, `uncertain` or `cancelled`; either way the result (text or failure) and one `child_result` row are written, and reading it (`task_status`) makes it `acknowledged`.

### 14.2 Tools (`ToolHost`, Phase 3 §13.1)

```
delegate_task({ prompt, provider?, model?, role?, workspace: 'isolated'|'shared', wake?: 'always'|'settled_only' }) → { delegationId, childThreadId, childRunId }
task_status({ delegationId })  → { status, result?, childRunStatus }   // reading a result acknowledges it
task_cancel({ delegationId })  → stops the child run and its own delegations depth-first (idempotent: a repeat or a retry after a partial failure re-runs every stop still needed)
list_delegations()
```
Deleting a thread cancels what it still has in flight (`RunEngine.cancelThreadWork`): its delegations and their children depth-first, its queued runs and wakes with their effects (a claimed `turn.start` aborted in flight), a `stop` for its active run, and its pending or delivered inbox rows are acknowledged; its MCP credentials are revoked.

`provider`/`model` default to the parent's. `workspace:'isolated'` allocates a worktree through the existing `WorkspaceResolver` with a lease held by the child run; `shared` is allowed only for read-only roles (execution contract check, §13). Each tool call is a `delegation.*` command with a `clientRequestId` derived from `(parentRunId, toolCallId)` so retries are no-ops.

### 14.3 Wake-up (reconciler rule 4)

- Rule 4: for every `inbox` row `pending` whose thread has no active run and no `queued` wake run → enqueue a `turn.start` effect with payload `{ kind: 'wake', inboxIds }` (one wake per thread, batched). If the thread has an active run whose adapter `caps.steer === 'native'` and `wake === 'always'` → enqueue `turn.steer` with the formatted notice; otherwise leave `pending` until the active run ends (the rule fires again) and deliver it as a wake run. `wake: 'always'` means the parent may be told mid-run when that is free, not that its turn may be cut short: on an `interrupt_restart` provider a steer would cancel the parent's in-flight tool call, so those rows wait like `settled_only` ones. A delivered row records the effect that delivered it (`inbox.delivered_by`, migration 7).
- **Redelivery**: rule 4 (and boot) first returns `delivered` rows to `pending` when their delivering effect ended `failed|cancelled`, or when it is a wake whose run ended other than `completed` (a wake the user stopped excepted); at most 3 times per row, so a delivery that keeps failing cannot loop.
- **Busy thread**: channel turns are engine runs (a `send` with `source: 'channel'`), so the engine sees them. A wake claimed while the thread is still busy — with a turn the engine does not schedule (a workflow or legacy turn) — stays `queued` and its effect is deferred 5 s (`EffectDeferredError`), so rule 4 never cancels and recreates it in a loop; when another engine turn of the thread waits to start instead, the wake ends `cancelled` with its rows pending again so that turn goes first and rule 4 queues a new wake behind it.
- The wake turn's prompt is a server-authored notice: "Delegated task X finished: <result head>. Use `task_status` for the full result." Reading via `task_status` marks the inbox row `acknowledged`; if every task in a pending wake is acknowledged before the wake starts, the wake effect is cancelled.
- Child `failed`/`interrupted` also produce a `child_result` (with the failure), so a parent never waits forever.

### 14.4 Integration

`integrate_delegation({ delegationId })` runs the existing `ChildAgentIntegrationService.integrate` as its own `integration` run on the parent thread (a run, so it is undoable and visible). No automatic merging. A `plan` ceiling cannot integrate (`mousse_ceiling_exceeded`).

### 14.5 Retirements

- Delete `spawn_agents` action parsing, `TaskProgressMonitor`, progress-JSON completion, `delegationBatches`, `agentOwners`, `wakeQueues`/`wakeTimers`, `scheduleOrchestratorWake`.
- Named-agent tools become thin wrappers over `delegate_task` (`name` maps to a child thread title; `recall` sends a follow-up to the existing child thread).
- `AgentLifecycleService` transition table: remove `cancelled → running`.

### 14.6 Tests

Replay scenarios: parent delegates to a child on a different adapter; child completes while parent is mid-tool (steer wake) and while parent is idle (new turn wake); parent restarts mid-wait (inbox survives, wake fires after boot); `task_cancel` depth-first; publication gate rejects a late child result after cancel; duplicate `delegate_task` retry returns the same delegation.

## 15. Phase 5 — Mousse MCP server for every provider

Native-agent providers (Claude subscription, Antigravity) receive `mcpServers: {}` / `[]` today; CLI agents receive copies of the user's MCP servers. None can call Mousse's own tools.

### 15.1 Server

- `src/mms/run/mcp/MousseMcpServer.ts`: one in-process MCP server (streamable HTTP on `127.0.0.1`, random port, plus a stdio bridge binary `mousse-cli engine mcp-stdio` for runtimes that only speak stdio). Tools are the `ToolHost` registry from §13.1: `delegate_task`, `task_status`, `task_cancel`, `list_delegations`, `ask_user`, `present_plan`, `create_task`/`update_task`/`list_tasks`, `thread_read`, `queue_*`, later schedule and browser tools.
- **Credentials**: `credentials(token_hash PK, thread_id, run_id, provider, mode_ceiling, created_at, revoked_at, last_seen_at)` (migration 4; durable rather than in-memory; only the SHA-256 of a token is stored). One live token per (thread, provider): the `turn.start` executor calls `mintOrReuse`, which returns the thread's live credential for that provider (re-pointing `run_id` at the current run, refreshing `mode_ceiling` from the turn and touching `last_seen_at`) or mints one, so a runtime keeps one stable MCP configuration and its session resumes across turns. A call acts as the thread's *active* run (`getActiveRun(threadId)`); with no active run it fails `mousse_caller_not_live`. A turn's end aborts its in-flight calls but does not revoke. Revoked when the thread is deleted or trashed, when the thread switches provider, and after 24 h idle (`pruneExpired`, once per reconciler pass). Tokens live in daemon memory only, so boot (`reconcileOnBoot`, §12.5 step 3) revokes every live stored row and the next turn mints a fresh token.
- **Scoping**: a token acts as its run. `delegate_task` children inherit `mode_ceiling` and cannot exceed it; a plan-mode turn's ceiling is `plan`. The ceiling checks (no broader child, no integration under `plan`) live in the orchestrator's shared delegation dispatch, so the in-process pi loop and the MCP server refuse the same calls the same way. `thread_read` is limited to the caller's thread and its lineage ancestors/descendants; of another thread it returns only `run.*`, `attempt.*`, `command.ignored`, `restart.note` and `thread.lineage` events plus `delegation.status` rows whose `result` is redacted unless the delegation's child is the caller (inbox, effect and tool events carry prompts and sibling results). Writes to unrelated threads are refused.
- Every tool handler declares an access class (`reads | actsAsCaller | writesThreads | startsThreads`); a handler without one fails to register.

### 15.2 Attachment per adapter

| Adapter | How the server is attached |
|---|---|
| `PiLoopAdapter` | in-process `ToolHost`, no MCP needed |
| `ClaudeSubscriptionAdapter` | SDK `mcpServers: { mousse: { type:'http', url, headers:{ Authorization } } }` |
| `AntigravityAdapter` | ACP `session/new` `mcpServers: [{ name:'mousse', type:'http', url, headers }]`; fall back to the stdio bridge when the agent rejects http |
| CLI children (claude-code, codex, opencode, cursor) | `AgentConfigManager` materialises a `mousse` entry next to the user's servers, with the token in env |

`caps.mcp === false` adapters show the orchestration tools as unavailable; nothing is emulated.

### 15.3 Prompt guidance

One shared text (`src/mms/run/mcp/instructions.ts`) delivered per adapter (system prompt append for Claude; ACP first-prompt wrapper for Antigravity; developer instructions for Codex children): prefer `delegate_task` for any work on another provider; end the turn after delegating instead of polling; `clientRequestId` rules; never ask for secrets in chat.

### 15.4 Tests

Unit: credential mint/revoke/expiry; ceiling enforcement; access-class registration failure. Integration (replay): a Claude-subscription parent calls `delegate_task` for a pi child and reads the result; a child attempting a write above its ceiling is refused with a reason.

## 16. Phase 6 — handoff, fork and merge-back, continue after restart

### 16.1 Context handoff as an artifact

Today a provider switch inserts only a display marker (`orchestrator/contextHandoff.ts`). Phase 6 records a `ContextHandoff` row (migration 5):

```sql
CREATE TABLE context_handoffs(
  handoff_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, target_run_id TEXT NOT NULL,
  from_ref TEXT, to_ref TEXT NOT NULL,                    -- ProviderRef JSON
  strategy TEXT NOT NULL CHECK(strategy IN ('native_resume','delta','full_summary','legacy_import')),
  covered_from_ordinal INTEGER, covered_to_ordinal INTEGER,
  budget_tokens INTEGER NOT NULL, selected_items INTEGER NOT NULL, omitted_items INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')),
  created_at TEXT NOT NULL, delivered_at TEXT
) STRICT;
```

- **Strategy** comes from `featureGates.handoffDelivery(caps)` and the stored refs: same provider with a live native session → `native_resume` (nothing sent); the target provider was used earlier on this thread → `delta` (runs since its last turn); otherwise `full_summary`.
- **Budget** (`src/mms/run/handoff/budget.ts`): default 16k tokens (`MOUSSE_HANDOFF_TOKEN_CAP`, clamp 1k–64k), 1 byte ≈ 1 token, image 8k / other attachment 4k reservation, window = min(model window, 128k) minus a quarter reserve. Selection order: last user, last assistant, first user, then newest first; whole items only; each text item compacted to ≤240 chars when it does not fit intact; the current user message is never truncated. Omitted history gets a recovery pointer (`thread_read` tool, Phase 5) so the agent can fetch it.
- **Delivery**: `historyInjection === 'native'` adapters receive structured history (`TurnInput.messages`); others receive it as a `<handoff>` block prepended to the prompt. The marker message in the transcript links to the `handoff_id`; the UI shows "context rebuilt (N of M items)".
- A `pending` handoff on a thread blocks a second switch until delivered or failed.

### 16.2 Fork into a new thread; merge-back

Existing `actions.fork` creates an in-thread conversation branch. Phase 6 adds a **thread fork**:
- `thread.fork({ sourceThreadId, atRunOrdinal | 'latest_stable' })` creates a new thread with `thread_lineage(relationship:'fork', parentThreadId, forkRunOrdinal)` and a **pending** `fork` transfer row (`context_transfers`, migration 5). Forkable sources: runs in `completed|failed|interrupted|cancelled`; never `running` or `uncertain`.
- **Consumed once**: a fork or merge-back transfer is `consumed` (payload `consumedBy: <runId>`) as soon as a commit of the receiving turn's transcript holds its injected history, or when a turn that delivered it otherwise completes; a turn stopped before its first commit leaves it pending. Injected history messages carry a `contextHandoff: { handoffId, transferId }` marker (not content), and a turn that finds a pending transfer's marker already in the transcript consumes it instead of injecting it again.
- **Lazy**: nothing is sent to a provider until the fork's first message. `featureGates.forkStrategy(caps)` picks `native` (same provider, strong native ref, `fork:'native'`) or `portable` (a `full_summary` handoff from the source up to the fork point). The code checkpoint at the fork ordinal seeds the fork's worktree. When the source has a workspace but no checkpoint at the fork point, the fork is refused (`fork_point_unavailable`) unless the caller passes `seedFrom: 'current_head'`, which starts the fork from the source's current HEAD; the transfer payload records the choice (`seedFrom: 'checkpoint' | 'current_head' | 'none'`).
- **Merge-back** `thread.merge_back({ forkThreadId })` is allowed only into the direct parent and only when the fork's latest run is `completed`. It records a pending `merge_back` transfer; the parent's next turn receives a `fork_delta_summary` handoff (runs on the fork since the fork point). Code integration stays explicit through the existing child-integration path (§14.4). Queueing on a thread with a pending merge-back is refused with a reason until it is consumed.

### 16.3 Undo and restore safety

- `actions.undoLatest`/`revertCode` keep their Git mechanics but become `undo` runs so they appear in `runs.list` and are themselves recoverable.
- `featureGates.restoreMode(caps)`: `containment:'weak'` providers never get an automatic file restore; the UI shows the diff and asks. Unknown capabilities fail closed (review the diff). The review response carries the diff and its SHA-256 (`diffSha`); the confirmed retry passes `reviewedDiffSha`, which must equal the SHA-256 of the diff a restore would apply at that moment (a changed diff gets a new review; the bare `reviewed: true` is refused). File restore is refused unless the thread owns its worktree and no other thread's worktree or live cwd overlaps it (realpath check), mirroring `CheckpointRestoreSafety`. The gate runs under the thread's mutex right before the undo/revert run is created (`runLocalAction` `gate`), so no run starts between the check and the restore.
- An undo run records how it restored (`outcome.undoStrategy`, from `featureGates.canUndoNatively`): `native_rollback` for a provider that rolls its own session back, else `checkpoint`. No adapter declares `rollback: 'native'` yet, so every undo is a checkpoint restore.

### 16.4 Continue after restart

- Boot already writes `restart.note`. Phase 6 adds a `continue` affordance: the note's system message carries `{ runId }`; the GUI shows a "Continue" button that sends `orchestrator.send` with `{ content: 'Continue where you left off.', continuationOfRunId }` and `clientRequestId = continue:<runId>` so a double click is a replay. Never automatic (invariant 10). Not offered for `uncertain` runs until the user acknowledges the listed tools.

### 16.5 Tests

Replay scenarios per adapter: switch provider mid-thread (delta vs full summary, budget hit → compaction, pointer present); fork then first message (native vs portable); merge-back delivers a delta once and refuses a second pending one; undo refused on a shared checkout; continue after restart replays on double click.
