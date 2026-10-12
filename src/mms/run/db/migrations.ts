import type { Migration } from './ProfileDatabase'

/**
 * Run Engine schema. Version 1 is the Phase 1 data model in docs/run-engine/SPEC.md §3; version 2
 * is the Phase 2 outbox, daemon epochs and tool ledger (§12.1) plus `runs.heartbeat_at`; version 3
 * is the Phase 4 delegation model (§14.1): thread lineage, delegations and the inbox; version 4 is
 * the Phase 5 Mousse MCP server (§15.1): bearer credentials and the delegation mode ceiling.
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
  }
]
