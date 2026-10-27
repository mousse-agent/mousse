import type { Migration } from './ProfileDatabase'

/**
 * Run Engine schema. Version 1 is the Phase 1 data model in docs/run-engine/SPEC.md §3; version 2
 * is the Phase 2 outbox, daemon epochs and tool ledger (§12.1) plus `runs.heartbeat_at`; version 3
 * is the Phase 4 delegation model (§14.1): thread lineage, delegations and the inbox; version 4 is
 * the Phase 5 Mousse MCP server (§15.1): bearer credentials and the delegation mode ceiling;
 * version 5 is Phase 6 (§16): context handoffs and fork/merge-back transfers; version 6 stores a
 * delegation's workspace policy and role so a shared read-only child keeps them across restarts;
 * version 7 records which effect delivered an inbox row; version 8 is the Stop fence (thread stop
 * generations); version 9 stores each attempt's execution binding (harness gateway); version 10
 * rebuilds `runs` so a run can be `paused` until a usage limit resets; version 11 records the agent
 * access level on credentials, delegations and runs.
 */
export const RUN_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
`
  },
  {
    version: 2,
    sql: `
CREATE TABLE effects(
  effect_id     TEXT PRIMARY KEY,                 -- effect:<clientRequestId|runId>:<kind>:<n>, deterministic
  thread_id     TEXT NOT NULL,
  run_id        TEXT,
  kind          TEXT NOT NULL,                    -- see SPEC 12.2
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

-- Liveness for the reconciler (SPEC 12.4 rule 2). Not a status write: no epoch bump, no event.
ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
`
  },
  {
    version: 3,
    sql: `
-- A child thread and the run that created it (SPEC 14.1).
CREATE TABLE thread_lineage(
  thread_id        TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  parent_run_id    TEXT NOT NULL,
  relationship     TEXT NOT NULL CHECK(relationship IN ('subagent','fork')),
  created_at       TEXT NOT NULL
) STRICT;

-- Ties a parent run to one child run on a child thread.
CREATE TABLE delegations(
  delegation_id    TEXT PRIMARY KEY,
  parent_run_id    TEXT NOT NULL,
  parent_thread_id TEXT NOT NULL,
  child_thread_id  TEXT NOT NULL,
  child_run_id     TEXT NOT NULL,
  provider         TEXT,
  model            TEXT,
  prompt_digest    TEXT NOT NULL,
  wake             TEXT NOT NULL CHECK(wake IN ('always','settled_only')),
  status           TEXT NOT NULL CHECK(status IN ('running','result_available','acknowledged','cancelled','failed')),
  result           TEXT,                          -- JSON: {runStatus, text?, error?}
  created_at       TEXT NOT NULL,
  completed_at     TEXT
) STRICT;
CREATE INDEX delegations_parent_run ON delegations(parent_run_id);
CREATE INDEX delegations_child_thread ON delegations(child_thread_id);

-- Stored notifications for a thread; a child's result is written with its terminal run write.
CREATE TABLE inbox(
  inbox_id   TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  run_id     TEXT,
  kind       TEXT NOT NULL CHECK(kind IN ('child_result','restart_note','reconcile_notice')),
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK(status IN ('pending','delivered','acknowledged')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX inbox_thread_status ON inbox(thread_id, status);
`
  },
  {
    version: 4,
    sql: `
-- Bearer tokens of the Mousse MCP server (SPEC 15.1): one live row per (thread, provider), reused
-- across the thread's turns; run_id and mode_ceiling follow its latest turn. Only the SHA-256 of
-- the token is stored; the token itself exists in memory and in the provider runtime's config.
CREATE TABLE credentials(
  token_hash    TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  mode_ceiling  TEXT NOT NULL CHECK(mode_ceiling IN ('plan','default')),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  last_seen_at  TEXT NOT NULL
) STRICT;
CREATE INDEX credentials_run ON credentials(run_id);
CREATE INDEX credentials_thread ON credentials(thread_id, provider);

-- The most a delegated child may do (SPEC 15.1 scoping); NULL for delegations made before Phase 5.
ALTER TABLE delegations ADD COLUMN mode_ceiling TEXT CHECK(mode_ceiling IN ('plan','default'));
`
  },
  {
    version: 5,
    sql: `
-- What a turn was told about earlier turns when its provider changed (SPEC 16.1). The strategy
-- list adds 'fork_delta_summary': the merge-back handoff of SPEC 16.2.
CREATE TABLE context_handoffs(
  handoff_id    TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  target_run_id TEXT NOT NULL,
  from_ref      TEXT,                             -- ProviderRef JSON
  to_ref        TEXT NOT NULL,                    -- ProviderRef JSON
  strategy      TEXT NOT NULL CHECK(strategy IN ('native_resume','delta','full_summary','fork_delta_summary','legacy_import')),
  covered_from_ordinal INTEGER,
  covered_to_ordinal   INTEGER,
  budget_tokens  INTEGER NOT NULL,
  selected_items INTEGER NOT NULL,
  omitted_items  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')),
  created_at    TEXT NOT NULL,
  delivered_at  TEXT
) STRICT;
CREATE INDEX context_handoffs_thread ON context_handoffs(thread_id, status);

-- Lazy context transfers between threads (SPEC 16.2): a fork's first message and a merge-back
-- into the fork's parent consume them.
CREATE TABLE context_transfers(
  transfer_id   TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK(type IN ('fork','merge_back')),
  source_thread_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL,
  source_run_ordinal INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('pending','consumed','superseded','failed')),
  payload       TEXT NOT NULL,                    -- JSON
  created_at    TEXT NOT NULL,
  consumed_at   TEXT
) STRICT;
CREATE INDEX context_transfers_target ON context_transfers(target_thread_id, status);
CREATE INDEX context_transfers_source ON context_transfers(source_thread_id);
`
  },
  {
    version: 6,
    sql: `
-- The child's workspace policy and role (SPEC 14.2); NULL for delegations made before version 6.
ALTER TABLE delegations ADD COLUMN workspace TEXT CHECK(workspace IN ('isolated','shared'));
ALTER TABLE delegations ADD COLUMN role TEXT;
`
  },
  {
    version: 7,
    sql: `
-- The effect that delivered an inbox row (a wake turn.start or a turn.steer, SPEC 14.3), so a row
-- whose delivery failed or was cut off can go back to pending. NULL for older delivered rows.
ALTER TABLE inbox ADD COLUMN delivered_by TEXT;
`
  },
  {
    version: 8,
    sql: `
-- The Stop fence (issue #142): each Stop of a thread (and of every subagent below it) raises that
-- thread's generation. Work that starts something on behalf of a parent (a delegation, a follow-up
-- to a subagent, a wake, a queued steer) records the generation it was admitted at and is refused
-- at execution once the thread's generation is higher. Both live in the run database so a bump and
-- an admission check serialize in one transaction.
CREATE TABLE thread_stop_generations(
  thread_id  TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The generation of the run's own thread when the run was created; 0 for runs from before version 8.
ALTER TABLE runs ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0;
`
  },
  {
    version: 9,
    sql: `
-- The immutable execution binding of an attempt (instance, driver, account generation, home,
-- config revision, model, effort, policy), JSON. NULL for attempts made before version 9.
ALTER TABLE run_attempts ADD COLUMN execution_binding TEXT;
`
  },
  {
    version: 10,
    // SQLite cannot change a CHECK in place: `runs` is rebuilt (SQLite's "other kinds of ALTER TABLE"
    // procedure) with foreign keys off, so dropping it does not touch `run_attempts`. `migrate()`
    // checks every reference before the commit and turns foreign keys back on afterwards.
    foreignKeys: 'off',
    sql: `
-- A run can be paused until a usage limit resets (SPEC §5): 'paused' joins the status CHECK.
-- Columns are listed in the same order in the new table and in the copy: version 1's, then
-- heartbeat_at (version 2) and stop_generation (version 8).
CREATE TABLE runs_new(
  run_id        TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('queued','starting','running','finalizing','paused','completed','interrupted','failed','cancelled','uncertain')),
  epoch         INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT,
  source        TEXT NOT NULL,
  client_request_id TEXT,
  user_message_id   TEXT,
  requested_at  TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  outcome       TEXT,
  heartbeat_at  TEXT,
  stop_generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE(thread_id, ordinal)
) STRICT;
INSERT INTO runs_new(run_id, thread_id, ordinal, status, epoch, active_attempt_id, source,
    client_request_id, user_message_id, requested_at, started_at, completed_at, outcome,
    heartbeat_at, stop_generation)
  SELECT run_id, thread_id, ordinal, status, epoch, active_attempt_id, source,
    client_request_id, user_message_id, requested_at, started_at, completed_at, outcome,
    heartbeat_at, stop_generation
  FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_thread_status ON runs(thread_id, status);
`
  },
  {
    version: 11,
    sql: `
-- The agent access level a credential was granted for its latest turn (SPEC 15.1), kept for audit;
-- the call-time check also reads the profile setting. Existing rows read as 'lineage'.
ALTER TABLE credentials ADD COLUMN access_level TEXT NOT NULL DEFAULT 'lineage' CHECK(access_level IN ('lineage','read','manage'));

-- The access level a delegation passes to its child; NULL for delegations made before version 11.
ALTER TABLE delegations ADD COLUMN access_level TEXT CHECK(access_level IN ('lineage','read','manage'));

-- The access level a run's turn was granted when it started; NULL until recorded (and on runs from before
-- version 11). A run that continues it is never granted more.
ALTER TABLE runs ADD COLUMN access_grant TEXT CHECK(access_grant IN ('lineage','read','manage'));
`
  },
  {
    version: 12,
    sql: `
-- A provider's, the Pi agent's or a Mousse tool's approval request, saved so it survives a client
-- reconnect and a daemon restart (SPEC §17). A request is settled once: 'pending' becomes
-- 'answered' or 'cancelled'.
CREATE TABLE approval_requests(
  request_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  instance_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('command','edit','tool')),
  permission_key TEXT NOT NULL,
  fingerprint TEXT,
  questions TEXT NOT NULL,
  reason TEXT,
  answer_path TEXT NOT NULL CHECK(answer_path IN ('live','continue')),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
  uncertain_tools TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled')),
  answers TEXT,
  decision TEXT CHECK(decision IS NULL OR decision IN ('allow','reject')),
  decision_scope TEXT CHECK(decision_scope IS NULL OR decision_scope IN ('once','always')),
  feedback TEXT,
  answered_by TEXT,
  cancel_reason TEXT,
  continuation_run_id TEXT,
  grant_consumed_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;
CREATE INDEX approval_requests_thread ON approval_requests(thread_id, status);
CREATE INDEX approval_requests_run ON approval_requests(run_id, status);
-- Read at every turn start: the requests a run was started to deliver.
CREATE INDEX approval_requests_continuation ON approval_requests(continuation_run_id);
`
  },
  {
    version: 13,
    // SQLite cannot change a CHECK in place, so `inbox` is rebuilt (SQLite's "other kinds of ALTER TABLE"
    // procedure). Nothing references it, and its index goes with the dropped table and is made again. It touches only
    // `inbox`, so it applies the same on a database at version 11 and on one that another change has taken to 12.
    sql: `
-- A watched pull request tells its thread about finished checks and new reviews (issue #176): the
-- kind list adds 'pr_update'. Columns are those of version 3 plus delivered_by (version 7).
CREATE TABLE inbox_new(
  inbox_id   TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  run_id     TEXT,
  kind       TEXT NOT NULL CHECK(kind IN ('child_result','restart_note','reconcile_notice','pr_update')),
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK(status IN ('pending','delivered','acknowledged')),
  created_at TEXT NOT NULL,
  delivered_by TEXT
) STRICT;
INSERT INTO inbox_new(inbox_id, thread_id, run_id, kind, payload, status, created_at, delivered_by)
  SELECT inbox_id, thread_id, run_id, kind, payload, status, created_at, delivered_by FROM inbox;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
CREATE INDEX inbox_thread_status ON inbox(thread_id, status);
`
  },
  {
    version: 14,
    sql: `
-- "Always for this thread" (SPEC §17.8): a standing rule that answers one exact request again, in one
-- thread. It is keyed by the request's fingerprint (instance, directory, key, tool, whole input), so it
-- never widens to another command, folder or tool; a request without a fingerprint cannot match. Only a
-- user creates one. It is ignored while the thread's permission mode is stricter than the one it was
-- granted under, and goes with the thread.
CREATE TABLE approval_rules(
  thread_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('command','edit','tool')),
  summary TEXT NOT NULL,
  granted_under TEXT NOT NULL CHECK(granted_under IN ('ask','accept_edits','full')),
  source_request_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, fingerprint)
) STRICT;

-- The permission mode the request was asked under: what a rule created by answering it is granted under.
-- NULL on requests saved before version 14 (they create no rule).
ALTER TABLE approval_requests ADD COLUMN permission_mode TEXT CHECK(permission_mode IS NULL OR permission_mode IN ('ask','accept_edits','full'));
`
  }
]
