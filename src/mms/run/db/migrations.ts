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
 * access level on credentials, delegations and runs; version 17 binds a remote subagent's task to the
 * run on another computer that does it (issue #469); version 18 lets that task's mode be Full access; version 19
 * records whether a remote subagent's calls carry the agent mark; version 20 keeps the watches of the settle notice (an
 * agent that sent a message with `notify` is told when the work it started settles, SPEC §15.1); version 23 keeps the
 * questions an agent asked without waiting (`open_questions`, issue #1372).
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
  },
  {
    version: 15,
    sql: `
-- An agent's change to a thread's queued messages (issue #184), written before the queue file changes. 'pending':
-- the change may not be in the file yet; 'effects_pending': it is, but a side effect (cancelling the item's queued run,
-- giving its notice rows back) did not commit and is retried; 'applied': done, and the stored result is what a retry of
-- the same request returns. The intent holds the complete change so an unfinished one is finished from it alone; once
-- applied it is cut down to what tells a reused request id from a retry, and its result holds no message text. An entry
-- that cannot be finished after a few tries becomes 'failed' and is left alone; old finished entries are pruned.
CREATE TABLE queue_commands(
  command_key TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  intent      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','effects_pending','applied','failed')),
  result      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  applied_at  TEXT
) STRICT;
CREATE INDEX queue_commands_thread_status ON queue_commands(thread_id, status);
`
  },
  {
    version: 16,
    // SQLite cannot change a CHECK in place: both tables are rebuilt (SQLite's "other kinds of ALTER
    // TABLE" procedure). Neither has a foreign key, and nothing refers to them.
    sql: `
-- The Auto permission mode (issue #419) joins the mode CHECKs of approval rules and requests, between
-- 'accept_edits' and 'full'. Columns are listed in the same order in each new table and its copy:
-- approval_requests has version 12's, then permission_mode (version 14).
CREATE TABLE approval_rules_new(
  thread_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('command','edit','tool')),
  summary TEXT NOT NULL,
  granted_under TEXT NOT NULL CHECK(granted_under IN ('ask','accept_edits','auto','full')),
  source_request_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, fingerprint)
) STRICT;
INSERT INTO approval_rules_new(thread_id, fingerprint, permission_key, action, summary, granted_under, source_request_id, created_at)
  SELECT thread_id, fingerprint, permission_key, action, summary, granted_under, source_request_id, created_at
  FROM approval_rules;
DROP TABLE approval_rules;
ALTER TABLE approval_rules_new RENAME TO approval_rules;

CREATE TABLE approval_requests_new(
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
  settled_at TEXT,
  permission_mode TEXT CHECK(permission_mode IS NULL OR permission_mode IN ('ask','accept_edits','auto','full'))
) STRICT;
INSERT INTO approval_requests_new(request_id, thread_id, run_id, instance_id, provider, action, permission_key,
    fingerprint, questions, reason, answer_path, uncertain, uncertain_tools, status, answers, decision,
    decision_scope, feedback, answered_by, cancel_reason, continuation_run_id, grant_consumed_at, delivered_at,
    created_at, settled_at, permission_mode)
  SELECT request_id, thread_id, run_id, instance_id, provider, action, permission_key,
    fingerprint, questions, reason, answer_path, uncertain, uncertain_tools, status, answers, decision,
    decision_scope, feedback, answered_by, cancel_reason, continuation_run_id, grant_consumed_at, delivered_at,
    created_at, settled_at, permission_mode
  FROM approval_requests;
DROP TABLE approval_requests;
ALTER TABLE approval_requests_new RENAME TO approval_requests;
CREATE INDEX approval_requests_thread ON approval_requests(thread_id, status);
CREATE INDEX approval_requests_run ON approval_requests(run_id, status);
CREATE INDEX approval_requests_continuation ON approval_requests(continuation_run_id);
`
  },
  {
    version: 17,
    sql: `
-- A remote subagent's task (issue #469): its child run here is a stand-in that stays 'queued' while
-- another of the user's computers (node) does the work in remote_thread_id; RemoteSubagents starts that
-- run, follows it, and writes the stand-in's terminal status from it. One row per delegation.
--   starting: this computer has not yet had the far run accepted (create, mode, send);
--   running:  the far run is accepted and followed;
--   stopping: the task ended here first (a Stop, a cancel, the time limit) and the far run is told to stop;
--   done:     nothing is left to do on the other computer.
CREATE TABLE remote_subagents(
  delegation_id    TEXT PRIMARY KEY,
  child_thread_id  TEXT NOT NULL,
  child_run_id     TEXT NOT NULL,
  node             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  permission_mode  TEXT NOT NULL CHECK(permission_mode IN ('ask','accept_edits','auto')),
  chat_mode        TEXT NOT NULL CHECK(chat_mode IN ('agent','plan')),
  worktree         INTEGER NOT NULL CHECK(worktree IN (0,1)),
  project_id       TEXT,
  instance_id      TEXT,
  model            TEXT,
  remote_thread_id TEXT,
  remote_run_id    TEXT,
  deadline_at      TEXT,
  state            TEXT NOT NULL CHECK(state IN ('starting','running','stopping','done')),
  waiting_input    INTEGER NOT NULL DEFAULT 0 CHECK(waiting_input IN (0,1)),
  last_error       TEXT,
  last_seen_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX remote_subagents_state ON remote_subagents(state);
CREATE INDEX remote_subagents_child ON remote_subagents(child_thread_id);
`
  },
  {
    version: 18,
    // SQLite cannot change a CHECK in place: the table is rebuilt (SQLite's "other kinds of ALTER TABLE"
    // procedure). It has no foreign key, and nothing refers to it.
    sql: `
-- A remote subagent may run in Full access when the computer that runs it allows this one Full access
-- (issue #1160): the mode CHECK takes 'full'. Rows written before keep the mode they were started with, and
-- their rowids, which order a subagent's tasks.
CREATE TABLE remote_subagents_new(
  delegation_id    TEXT PRIMARY KEY,
  child_thread_id  TEXT NOT NULL,
  child_run_id     TEXT NOT NULL,
  node             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  permission_mode  TEXT NOT NULL CHECK(permission_mode IN ('ask','accept_edits','auto','full')),
  chat_mode        TEXT NOT NULL CHECK(chat_mode IN ('agent','plan')),
  worktree         INTEGER NOT NULL CHECK(worktree IN (0,1)),
  project_id       TEXT,
  instance_id      TEXT,
  model            TEXT,
  remote_thread_id TEXT,
  remote_run_id    TEXT,
  deadline_at      TEXT,
  state            TEXT NOT NULL CHECK(state IN ('starting','running','stopping','done')),
  waiting_input    INTEGER NOT NULL DEFAULT 0 CHECK(waiting_input IN (0,1)),
  last_error       TEXT,
  last_seen_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
INSERT INTO remote_subagents_new(rowid, delegation_id, child_thread_id, child_run_id, node, prompt, permission_mode, chat_mode,
    worktree, project_id, instance_id, model, remote_thread_id, remote_run_id, deadline_at, state, waiting_input,
    last_error, last_seen_at, created_at, updated_at)
  SELECT rowid, delegation_id, child_thread_id, child_run_id, node, prompt, permission_mode, chat_mode,
    worktree, project_id, instance_id, model, remote_thread_id, remote_run_id, deadline_at, state, waiting_input,
    last_error, last_seen_at, created_at, updated_at
  FROM remote_subagents;
DROP TABLE remote_subagents;
ALTER TABLE remote_subagents_new RENAME TO remote_subagents;
CREATE INDEX remote_subagents_state ON remote_subagents(state);
CREATE INDEX remote_subagents_child ON remote_subagents(child_thread_id);
`
  },
  {
    version: 19,
    sql: `
-- The form a remote subagent's calls take on its computer (issue #1160): 1 when they carry the agent mark (that
-- computer knows it), 0 when they go unmarked (an older computer), null until the first call decides. A task never
-- changes form mid-flight: the other computer's replay ledger is keyed by method, so a switch would send it twice.
ALTER TABLE remote_subagents ADD COLUMN marked INTEGER CHECK(marked IS NULL OR marked IN (0,1));
`
  },
  {
    version: 20,
    sql: `
-- The settle notice (SPEC §15.1): one row per message an agent sent with notify (thread_send, thread_create's first
-- message). It follows the message, not a run: run_id is the run that carries it now (a re-queue, a steer handed
-- back or a pause continuation moves it) and queue_item_id the queue item that carried it, when it was queued.
-- target_node is null for a thread on this computer; how a watch learns about its run is not stored here, so a
-- follower for another computer adds no column.
--   active:  still followed;
--   ended:   the work ended (end_status says how) and the end notice is written;
--   expired: 24 h passed first (expires_at) and the sender was told once that the work is still going.
-- needs_input and end_notice: 'due' once Mousse decided to tell the sender, 'sent' once the notice is in the sender's
-- queue, so a restart in between delivers it.
CREATE TABLE thread_watches(
  watch_id                TEXT PRIMARY KEY,
  message_key             TEXT NOT NULL UNIQUE,
  watcher_thread_id       TEXT NOT NULL,
  watcher_run_id          TEXT NOT NULL,
  watcher_stop_generation INTEGER NOT NULL,
  target_node             TEXT,
  target_thread_id        TEXT NOT NULL,
  run_id                  TEXT,
  queue_item_id           TEXT,
  state                   TEXT NOT NULL CHECK(state IN ('active','ended','expired')),
  needs_input             TEXT CHECK(needs_input IN ('due','sent')),
  end_notice              TEXT CHECK(end_notice IN ('due','sent')),
  end_status              TEXT,
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
) STRICT;
CREATE INDEX thread_watches_state ON thread_watches(state, target_thread_id);
CREATE INDEX thread_watches_watcher ON thread_watches(watcher_thread_id);
`
  },
  {
    version: 21,
    sql: `
-- A thread an agent here launched on another of the user's computers (thread_create with computer, issue #1160):
-- this computer's record of the launch. The thread there is that computer's own. One row per launch, keyed by
-- the thread_create receipt's key, and written with it before any call, so a launch cut off by a lost link or a
-- restart is finished from this row.
--   starting:  nothing is confirmed there yet; the next attempt creates the thread (the same key finds the first);
--   created:   the thread exists there (remote_thread_id); its model, mode and first message are not all set;
--   launched:  the thread is set up there; first_message_state says what became of the first message;
--   abandoned: refused for good before a thread existed, or the thread there was archived (last_error says why).
-- first_message_state: none (the launch has none), pending, sent, failed (refused for good, the thread is kept),
-- uncertain (that computer did not confirm it; the next attempt asks again under the same key).
CREATE TABLE remote_launches(
  creation_key        TEXT PRIMARY KEY,
  launcher_thread_id  TEXT NOT NULL,
  launcher_run_id     TEXT NOT NULL,
  node                TEXT NOT NULL,
  computer_name       TEXT NOT NULL,
  title               TEXT NOT NULL,
  remote_project_id   TEXT NOT NULL,
  worktree            INTEGER NOT NULL CHECK(worktree IN (0,1)),
  instance_id         TEXT,
  model               TEXT,
  permission_mode     TEXT NOT NULL CHECK(permission_mode IN ('ask','accept_edits','auto','full')),
  remote_mode         TEXT CHECK(remote_mode IS NULL OR remote_mode IN ('ask','accept_edits','auto','full')),
  first_message       TEXT,
  first_message_mode  TEXT CHECK(first_message_mode IS NULL OR first_message_mode IN ('agent','plan')),
  mark                TEXT NOT NULL,
  remote_thread_id    TEXT,
  remote_run_id       TEXT,
  state               TEXT NOT NULL CHECK(state IN ('starting','created','launched','abandoned')),
  first_message_state TEXT NOT NULL CHECK(first_message_state IN ('none','pending','sent','failed','uncertain')),
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX remote_launches_launcher ON remote_launches(launcher_thread_id);
CREATE INDEX remote_launches_remote ON remote_launches(node, remote_thread_id);
CREATE INDEX remote_launches_open ON remote_launches(state, first_message_state);
`
  },
  {
    version: 22,
    sql: `
-- A person's Stop of a launcher, its deletion or its expiry reaches the threads it launched on other computers
-- (issue #1160): a marked orchestrator.abort there, which stops only runs this computer's agents started. A Stop that
-- could not be delivered is kept here, survives a restart and is sent when that computer answers, until stop_deadline.
--   pending: not delivered yet (stop_key is the idempotency key every attempt uses, so it acts once there);
--   sent:    that computer answered (stop_result says what it stopped, or why it left the run);
--   expired: stop_deadline passed first.
-- stop_reason: stopped (a person's Stop), deleted or expired (the launcher's).
ALTER TABLE remote_launches ADD COLUMN stop_state TEXT CHECK(stop_state IS NULL OR stop_state IN ('pending','sent','expired'));
ALTER TABLE remote_launches ADD COLUMN stop_key TEXT;
ALTER TABLE remote_launches ADD COLUMN stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ('stopped','deleted','expired'));
ALTER TABLE remote_launches ADD COLUMN stop_deadline TEXT;
ALTER TABLE remote_launches ADD COLUMN stop_result TEXT;
CREATE INDEX remote_launches_stops ON remote_launches(stop_state);
`
  },
  {
    version: 23,
    sql: `
-- A question an agent asked without waiting (ask_user with wait false, issue #1372). The agent keeps working; the
-- answer reaches it through the inbox (inbox_id), written in the same transaction as the answer.
--   open:      waiting for the person;
--   answered:  answered (answers, answered_by);
--   dismissed: closed by the person without an answer (the agent is told, as for an answer);
--   withdrawn: the agent no longer needs it;
--   closed:    the thread was stopped, archived or deleted (close_reason).
CREATE TABLE open_questions(
  request_id   TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  run_id       TEXT,
  questions    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('open','answered','dismissed','withdrawn','closed')),
  answers      TEXT,
  answered_by  TEXT,
  close_reason TEXT,
  inbox_id     TEXT,
  created_at   TEXT NOT NULL,
  settled_at   TEXT
) STRICT;
CREATE INDEX open_questions_thread ON open_questions(thread_id, status);
`
  },
  {
    version: 24,
    sql: `
-- A remote subagent's limit (issue #685, maxMinutes): the minutes of running time its task may use. The computer that
-- runs it counts them when it takes the limit; deadline_at stays the stop this computer makes for an older one.
ALTER TABLE remote_subagents ADD COLUMN limit_minutes INTEGER CHECK(limit_minutes IS NULL OR limit_minutes >= 1);

-- The expiry a remote subagent's thread there must have (issue #685): its root thread's here, kept until that
-- computer took it, so a change made while it is offline reaches it when it answers. One row per subagent.
--   pending: expires_at (null: no expiry) is not yet set there; generation rises with each change;
--   sent:    that computer took it, or its thread there is gone.
CREATE TABLE remote_expiry(
  child_thread_id  TEXT PRIMARY KEY,
  root_thread_id   TEXT NOT NULL,
  node             TEXT NOT NULL,
  remote_thread_id TEXT,
  expires_at       TEXT,
  stops_run        INTEGER NOT NULL DEFAULT 0 CHECK(stops_run IN (0,1)),
  generation       INTEGER NOT NULL DEFAULT 1,
  state            TEXT NOT NULL CHECK(state IN ('pending','sent')),
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX remote_expiry_root ON remote_expiry(root_thread_id);
CREATE INDEX remote_expiry_state ON remote_expiry(state);

-- A run's running-time limit on the computer that runs it (an agent on another computer gave one, issue #685).
-- used_ms counts the time the run was starting, running or finalizing and nothing in its thread waited on a person;
-- the run is stopped once it reaches limit_ms. The row goes when the run ends.
CREATE TABLE run_time_limits(
  run_id     TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  limit_ms   INTEGER NOT NULL CHECK(limit_ms > 0),
  used_ms    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`
  },
  {
    version: 25,
    sql: `
-- Proof that the owner wrote the run's message themselves (JSON), once read by a rule that let Antigravity run only
-- the owner's own messages. That rule was removed: nothing writes or reads the column now; it is kept, unused.
ALTER TABLE runs ADD COLUMN owner_proof TEXT;
`
  },
  {
    version: 26,
    sql: `
-- Whether the thread an agent launches on another computer stays out of that computer's sidebar (Thread.hidden), sent
-- with every attempt of the create: 1 for an agent's thread unless it started it as independent (thread_create with
-- hidden: false), 1 for a remote subagent's. NULL for a launch from before this column, and for a bot's: its attempts
-- send no hidden, as they always did, so a retry repeats the very same create and that computer shows the thread.
ALTER TABLE remote_launches ADD COLUMN hidden INTEGER CHECK(hidden IS NULL OR hidden IN (0,1));
ALTER TABLE remote_subagents ADD COLUMN hidden INTEGER CHECK(hidden IS NULL OR hidden IN (0,1));
`
  },
  {
    // A personal bot's work subagents are delegations (issues #1454, #1369): the bot, the work's activation at the root
    // of the tree (whose counts and spend in bots.db the subagent shares), and what the subagent inherits from that
    // turn: the limit of the device its owner wrote from, and whether it may only read the owner's threads. Written in
    // the delegation's own transaction (`RunEngine.commitDelegation`); NULL on every thread's delegation.
    version: 27,
    sql: `
ALTER TABLE delegations ADD COLUMN bot_id TEXT;
ALTER TABLE delegations ADD COLUMN root_activation_id TEXT;
ALTER TABLE delegations ADD COLUMN bot_access TEXT;
ALTER TABLE delegations ADD COLUMN bot_read_only INTEGER;
CREATE INDEX delegations_by_root_activation ON delegations(root_activation_id) WHERE root_activation_id IS NOT NULL;
`
  }
]
