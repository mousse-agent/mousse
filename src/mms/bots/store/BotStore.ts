import { heldCalls } from '../actions/lifecycle'
import type { ActionRow } from '../actions/BotActions'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileDatabase, type Migration, type ProfileDatabaseFault } from '../../run/db/ProfileDatabase'
import type { BotActivationStatus, BotActivationTrigger, BotLane, BotManifest, BotModelOverride, BotModelPick, BotSchedule } from '../../../shared/bots/personal/definition'
import { canonicalManifest } from '../../../shared/bots/personal/manifest'
import type { ActivationLimits } from './scopes'
import type { BotThreadRole } from '../../../shared/bots/personal/authority'
import type { BotAskMode, BotAskRequest, BotEscalationStatus, BotPermissionRequest, BotWallKind } from '../../../shared/bots/personal/escalation'
import type { BotChatApplet, BotChip, BotError, BotMessageKind } from '../../../shared/bots/personal/chat'
import type { ProviderSelection } from '../../../shared/harness/types'
import type { BotStuckRows } from '../../../shared/bots/personal/modelSlots'
import type { BotQuestionAnswer, BotQuestionFollow, BotQuestionLateAnswer, BotQuestionSpec, BotQuestionStatus } from '../../../shared/bots/personal/questions'
import { keptCardOf, type BotCard } from '../../../shared/bots/personal/cards'
import { WAKE_LINE_PREFIX, type BotWakeEvent, type BotWakeFired } from '../../../shared/bots/personal/wakes'
import { BOT_JOB_ENDED, THREAD_MESSAGE_KEY_PREFIX, type BotJob, type BotJobAsker, type BotJobState } from '../../../shared/bots/personal/jobs'
import { BOT_MEMORY_SCHEMA_SQL } from '../memory/schema'
import { runProvenance } from '../activation/turnKinds'
import { narrowPermissionMode, type PermissionMode } from '../../../shared/permissionMode'

/**
 * `<profileHome>/bots/bots.db` (PR 6 §4): personal bots' grants, threads, activations, dispatches
 * and their shared counters and spend. A database of its own, so the run database needs no
 * migration and an older build never opens it.
 */

export const BOTS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE bot_registry(
  bot_id TEXT PRIMARY KEY,
  revision TEXT,
  home_thread_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE TABLE bot_grants(
  grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX bot_grants_by_bot ON bot_grants(bot_id, revoked_at);
CREATE TABLE bot_threads(
  thread_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('home','activation','context')),
  key TEXT NOT NULL,
  activation_id TEXT,
  ended_at TEXT
) STRICT;
CREATE TABLE bot_activations(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_grant','paused','blocked','done','failed','cancelled')),
  thread_id TEXT,
  scratch TEXT,
  auto_restarts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
) STRICT;
CREATE INDEX bot_activations_by_bot ON bot_activations(bot_id, status, created_at);
CREATE TABLE bot_dispatches(
  activation_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('start','continue','consult')),
  main_n INTEGER,
  client_request_id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  thread_id TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  deadline_ms INTEGER,
  prepaid_ms INTEGER,
  used_ms INTEGER,
  checkpoint_at INTEGER,
  child_pid INTEGER,
  child_token TEXT,
  child_group INTEGER,
  started_at INTEGER,
  exit_at INTEGER,
  ended_at TEXT,
  outcome TEXT,
  settled_by TEXT CHECK(settled_by IN ('run','startup')),
  PRIMARY KEY(activation_id, n)
) STRICT;
CREATE INDEX bot_dispatches_by_run ON bot_dispatches(run_id);
CREATE TABLE bot_counters(
  activation_id TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  limits_json TEXT NOT NULL
) STRICT;
CREATE TABLE bot_spend(
  activation_id TEXT PRIMARY KEY,
  committed_input INTEGER NOT NULL DEFAULT 0,
  committed_output INTEGER NOT NULL DEFAULT 0,
  committed_usd_micros INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE bot_spend_reservations(
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL,
  run_id TEXT,
  input_bound INTEGER NOT NULL,
  wire_cap INTEGER NOT NULL,
  usd_micros INTEGER NOT NULL,
  cost_limited INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;
CREATE INDEX bot_spend_open ON bot_spend_reservations(activation_id, settled_at);
CREATE TABLE bot_unknown_calls(
  activation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('main','consult')),
  found_at TEXT NOT NULL,
  acknowledged_at TEXT,
  PRIMARY KEY(activation_id, invocation_id)
) STRICT;
`
  },
  {
    // 6c-2: walls and their answers, the overlays "Allow this time" adds to one activation, and the
    // generation of each context thread ("Reset context" starts a new one).
    version: 2,
    sql: `
CREATE TABLE bot_escalations(
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL,
  dispatch_n INTEGER NOT NULL,
  tool_call_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('escalate','gate','budget')),
  permission_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','allowed_bot','allowed_once','denied','expired','cancelled')),
  amount REAL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT,
  applied_at TEXT
) STRICT;
CREATE INDEX bot_escalations_by_activation ON bot_escalations(activation_id, status);
CREATE TABLE bot_overlays(
  activation_id TEXT NOT NULL,
  escalation_id TEXT NOT NULL,
  permission_json TEXT NOT NULL,
  amount REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(activation_id, escalation_id)
) STRICT;
ALTER TABLE bot_dispatches ADD COLUMN send_json TEXT;
ALTER TABLE bot_registry ADD COLUMN cleaned_at TEXT;
-- Bots deleted before this version kept their threads on purpose: their cleanup counts as done.
UPDATE bot_registry SET cleaned_at = deleted_at WHERE deleted_at IS NOT NULL;
CREATE TABLE bot_contexts(
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  gen INTEGER NOT NULL,
  PRIMARY KEY(bot_id, key)
) STRICT;
`
  },
  {
    // 6d: when each schedule of a bot runs next (the schedule as it was read, so an edit restarts
    // it), and `reply_status`, which only the removed Channels feature used.
    version: 3,
    sql: `
CREATE TABLE bot_schedule_state(
  bot_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  next_run_at TEXT,
  last_skip_at TEXT,
  last_skip_reason TEXT,
  PRIMARY KEY(bot_id, schedule_id)
) STRICT;
ALTER TABLE bot_activations ADD COLUMN reply_status TEXT;
`
  },
  {
    // Bot Phase 1 (§5.1.2): the chat, schedules owned by bots.db, pause and failures on the
    // registry, lanes and model overrides on activations, and asks that never expire (one open ask
    // per permission). Open escalations of the form editor are withdrawn. The memory tables
    // (bot-context.md §3) are created by the same migration, so the journal starts with the chat.
    version: 4,
    sql: `
CREATE TABLE bot_messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  at TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('owner','bot')),
  kind TEXT NOT NULL CHECK(kind IN ('text','run_report','notice','error')),
  text TEXT NOT NULL,
  chips_json TEXT NOT NULL DEFAULT '[]',
  ask_id TEXT,
  error_json TEXT,
  activation_id TEXT,
  attachments_json TEXT,
  client_request_id TEXT UNIQUE
) STRICT;
CREATE INDEX bot_messages_bot ON bot_messages(bot_id, seq);
CREATE INDEX bot_messages_ask ON bot_messages(ask_id);
CREATE TABLE bot_schedules(
  id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  when_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('owner','bot')),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(bot_id, id)
) STRICT;
ALTER TABLE bot_registry ADD COLUMN paused_reason TEXT;
ALTER TABLE bot_registry ADD COLUMN paused_until TEXT;
ALTER TABLE bot_registry ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_registry ADD COLUMN error_json TEXT;
ALTER TABLE bot_registry ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_registry ADD COLUMN model_json TEXT;
ALTER TABLE bot_activations ADD COLUMN lane TEXT NOT NULL DEFAULT 'run' CHECK(lane IN ('chat','run'));
ALTER TABLE bot_activations ADD COLUMN model_override_json TEXT;
ALTER TABLE bot_activations ADD COLUMN reload_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_activations ADD COLUMN selection_json TEXT;
CREATE INDEX bot_activations_by_lane ON bot_activations(bot_id, lane, status, created_at);
CREATE TABLE bot_escalations_v4(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  dispatch_n INTEGER NOT NULL,
  tool_call_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('escalate','gate','budget')),
  permission_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','allowed_bot','allowed_once','denied','expired','cancelled','withdrawn')),
  amount REAL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  answered_at TEXT,
  applied_at TEXT,
  mode TEXT NOT NULL DEFAULT 'wall' CHECK(mode IN ('wall','ask')),
  fingerprint TEXT NOT NULL,
  title TEXT,
  note TEXT,
  message_id TEXT,
  cooldown_until TEXT
) STRICT;
INSERT INTO bot_escalations_v4(id, bot_id, activation_id, dispatch_n, tool_call_id, kind, permission_json, reason, status, amount, created_at, expires_at, answered_at, applied_at, mode, fingerprint)
  SELECT e.id, COALESCE(a.bot_id, ''), e.activation_id, e.dispatch_n, e.tool_call_id, e.kind, e.permission_json, e.reason,
    CASE WHEN e.status = 'open' THEN 'withdrawn' ELSE e.status END, e.amount, e.created_at, e.expires_at,
    CASE WHEN e.status = 'open' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE e.answered_at END, e.applied_at, 'wall', e.permission_json
  FROM bot_escalations e LEFT JOIN bot_activations a ON a.id = e.activation_id;
DROP TABLE bot_escalations;
ALTER TABLE bot_escalations_v4 RENAME TO bot_escalations;
CREATE INDEX bot_escalations_by_activation ON bot_escalations(activation_id, status);
CREATE INDEX bot_escalations_by_bot ON bot_escalations(bot_id, status);
CREATE UNIQUE INDEX bot_escalations_open ON bot_escalations(bot_id, fingerprint) WHERE status = 'open';
-- An activation that waited on a withdrawn wall would wait forever: it ends with the upgrade.
UPDATE bot_activations SET status = 'cancelled', end_reason = 'bots_upgraded', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'waiting_grant';
${BOT_MEMORY_SCHEMA_SQL}
`
  },
  {
    // Path step 3 ("One scheduler"): a bot's schedules move to the shared scheduled-job store. Each row is copied
    // there once and marked here with the job it became; nothing is deleted, so an older build's copy
    // (`bots.db.pre-v5`) and `unmigrateBotSchedules` can undo the move.
    version: 5,
    sql: `
ALTER TABLE bot_schedules ADD COLUMN migrated_at TEXT;
ALTER TABLE bot_schedules ADD COLUMN migrated_job_id TEXT;
`
  },
  {
    // A bot that stays free while it works (docs/plans/bot-always-free.md): a message names the message it answers,
    // and a bot keeps one-off reminders of its own (repeating ones stay schedules in the shared store).
    version: 6,
    sql: `
ALTER TABLE bot_messages ADD COLUMN reply_to TEXT;
CREATE TABLE bot_reminders(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  text TEXT NOT NULL,
  work_title TEXT,
  work_brief TEXT,
  reply_to TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting', 'delivered', 'cancelled')),
  delivered_at TEXT,
  message_id TEXT,
  activation_id TEXT
) STRICT;
CREATE INDEX bot_reminders_due ON bot_reminders(status, due_at);
CREATE INDEX bot_reminders_bot ON bot_reminders(bot_id, status);
CREATE TABLE bot_work_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  applied_at TEXT,
  from_message TEXT
) STRICT;
CREATE INDEX bot_work_notes_pending ON bot_work_notes(activation_id, applied_at);
`
  },
  {
    // The owner's reaction on a bot's message (one per message, an emoji) and when it was set: the bot's next chat turn
    // is told the reactions set since its last one. An older build refuses this bots.db (downgrade_unsupported).
    version: 7,
    sql: `
ALTER TABLE bot_messages ADD COLUMN owner_reaction TEXT;
ALTER TABLE bot_messages ADD COLUMN owner_reaction_at TEXT;
CREATE INDEX bot_messages_reactions ON bot_messages(bot_id, owner_reaction_at) WHERE owner_reaction IS NOT NULL;
`
  },
  {
    // A bot's questions to its owner, with answers to tap (issue #1123): their own table, apart from permission asks,
    // since a question grants nothing. `follow_json`, `next_at`, `nudges` and `read_at` are for follow-ups and work that
    // waits on an answer; `cards_json` is for small cards on a message. A message carries a question's bubble, or is the
    // owner's answer to one (`question_id`). An older build refuses this bots.db (downgrade_unsupported).
    version: 8,
    sql: `
CREATE TABLE bot_questions(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  dispatch_n INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('chat','run')),
  spec_json TEXT NOT NULL,
  follow_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','answered','defaulted','moved_on','withdrawn')),
  answer_json TEXT,
  answer_message TEXT,
  answered_at TEXT,
  read_at TEXT,
  next_at TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX bot_questions_due ON bot_questions(status, next_at);
CREATE INDEX bot_questions_bot ON bot_questions(bot_id, status);
CREATE INDEX bot_questions_activation ON bot_questions(activation_id);
ALTER TABLE bot_messages ADD COLUMN question_id TEXT;
ALTER TABLE bot_messages ADD COLUMN cards_json TEXT;
CREATE INDEX bot_messages_question ON bot_messages(question_id);
`
  },
  {
    // Wakes (a bot's follow-ups to itself): a reminder that starts a chat turn of the bot's own (`wake`), maybe once an
    // event happens (`event_json`, with `due_at` as the time it gives up), what happened (`fired_json`) and how many wakes
    // in a row led to it (`chain`). An older build refuses this bots.db (downgrade_unsupported).
    version: 9,
    sql: `
ALTER TABLE bot_reminders ADD COLUMN wake INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_reminders ADD COLUMN event_json TEXT;
ALTER TABLE bot_reminders ADD COLUMN fired_json TEXT;
ALTER TABLE bot_reminders ADD COLUMN chain INTEGER NOT NULL DEFAULT 0;
CREATE INDEX bot_reminders_wakes ON bot_reminders(bot_id, wake, created_at);
`
  },
  {
    // All columns for always-on bots phase 1. Behavior is added by later items; old rows keep their meaning.
    // bot_registry.tell_json held the removed Tells you setting; nothing reads or writes it any more.
    version: 10,
    sql: `
ALTER TABLE bot_reminders ADD COLUMN snoozed_from TEXT;
ALTER TABLE bot_reminders ADD COLUMN owner_set INTEGER CHECK(owner_set IN (0, 1));
ALTER TABLE bot_messages ADD COLUMN tell TEXT CHECK(tell IN ('now', 'soon', 'later'));
ALTER TABLE bot_messages ADD COLUMN tell_at TEXT CHECK(tell IS NULL OR tell_at IS NOT NULL);
ALTER TABLE bot_messages ADD COLUMN told_at TEXT;
CREATE INDEX bot_messages_tell_due ON bot_messages(bot_id, tell_at) WHERE tell IS NOT NULL AND told_at IS NULL;
ALTER TABLE bot_registry ADD COLUMN tell_json TEXT;
`
  },
  {
    // Storage for always-on bots phases 2 and 3; later items supply the writers.
    version: 11,
    sql: `
CREATE TABLE bot_actions(
  id TEXT PRIMARY KEY,
  call_key TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('chat','run')),
  kind TEXT NOT NULL CHECK(kind IN ('mcp','secret_fetch')),
  target_json TEXT NOT NULL,
  exec_args TEXT CHECK(exec_args IS NULL OR status IN ('open','approved','running')),
  args_json TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  place_json TEXT,
  card_json TEXT,
  bot_note TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','approved','declined','expired','withdrawn','running','done','failed','uncertain')),
  result_json TEXT,
  message_id TEXT,
  next_at TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  answered_at TEXT,
  answered_device TEXT,
  created_at TEXT NOT NULL,
  ran_at TEXT,
  CHECK(status <> 'open' OR expires_at IS NOT NULL)
) STRICT;
CREATE INDEX bot_actions_due ON bot_actions(status, next_at);
CREATE INDEX bot_actions_bot ON bot_actions(bot_id, status);
CREATE INDEX bot_actions_activation ON bot_actions(activation_id);
ALTER TABLE bot_reminders ADD COLUMN work_id TEXT;
`
  },
  {
    // What each main turn of a bot cost and carried (docs/plans/bot-context.md, phase 0): one row per dispatch, which
    // its runtime's usage reports add to. `context_gen` names the runtime context the turn ran in; `started_by` what
    // started it; `fresh_context` whether it began from a cleared context. Measurements only: nothing reads it to decide.
    version: 12,
    sql: `
CREATE TABLE bot_turn_usage(
  activation_id TEXT NOT NULL,
  dispatch_n INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('chat','run')),
  started_by TEXT NOT NULL,
  instance_id TEXT,
  model TEXT,
  context_gen TEXT NOT NULL,
  fresh_context INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  gap_ms INTEGER,
  system_chars INTEGER NOT NULL,
  preamble_chars INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  tools INTEGER,
  tools_chars INTEGER,
  reports INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  last_prompt INTEGER,
  context_window INTEGER,
  cache_ttl_ms INTEGER,
  last_request_at INTEGER,
  compactions INTEGER NOT NULL DEFAULT 0,
  quota_json TEXT,
  PRIMARY KEY(activation_id, dispatch_n)
) STRICT;
CREATE INDEX bot_turn_usage_by_bot ON bot_turn_usage(bot_id, lane, started_at);
`
  },
  {
    // The ledger (docs/plans/bot-context.md §16): one row per job a bot handed to one of its owner's threads, with the
    // request that caused it, who asked, how it stands and a one-line result. `notices`: how many notices the bot had.
    version: 13,
    sql: `
CREATE TABLE bot_jobs(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  project TEXT,
  request TEXT NOT NULL,
  asked_by TEXT NOT NULL CHECK(asked_by IN ('owner','schedule','bot','self')),
  state TEXT NOT NULL CHECK(state IN ('running','needs_input','done','failed','stopped','gone')),
  line TEXT,
  notices INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX bot_jobs_by_bot ON bot_jobs(bot_id, updated_at);
CREATE INDEX bot_jobs_open ON bot_jobs(thread_id) WHERE ended_at IS NULL;
`
  },
  {
    // What started each activation (`BotActivationProvenance`), written with the row. An older row keeps NULL and reads
    // it from its idempotency key and trigger (`deriveBotProvenance`). An older build refuses this bots.db
    // (downgrade_unsupported).
    version: 14,
    sql: `
ALTER TABLE bot_activations ADD COLUMN provenance TEXT;
`
  },
  {
    // A work's subagents are delegations in the run database, which keeps their lifecycle, lineage and results. Here is
    // only each one's place on its work's counts and spend, keyed by (work activation, child run): reserved before its
    // turn runs, its running time charged once (`charged_at`), and its end recorded as told to the work once
    // (`delivered_at`), before the run database's inbox row is acknowledged. Older subagents (`bot_dispatches`) are
    // settled at startup and never written again.
    version: 15,
    sql: `
CREATE TABLE bot_subagent_runs(
  activation_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  main_n INTEGER,
  spec_json TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  started_at INTEGER,
  used_ms INTEGER,
  charged_at TEXT,
  outcome TEXT CHECK(outcome IN ('done','failed','stopped')),
  why TEXT,
  delivered_at TEXT,
  told_at TEXT,
  child_pid INTEGER,
  child_group INTEGER,
  child_token TEXT,
  exit_at INTEGER,
  PRIMARY KEY(activation_id, child_run_id)
) STRICT;
CREATE INDEX bot_subagent_runs_by_run ON bot_subagent_runs(child_run_id);
`
  }
]

/** The `end_reason` of a queued notice a chat turn took in and answered (`BotDispatchRow.prompt.merged`): it never ran. */
export const MERGED_END_REASON = 'merged'

/** The `end_reason` of a running activation that waits for the internet. */
export const BOT_OFFLINE_REASON = 'waiting_for_internet'

/**
 * Work the owner asked for that stopped short and goes on later in the same thread is `blocked` (it does not hold the
 * run lane) with one of these end reasons, like the internet wait, so an older build still reads `bots.db`:
 * `budget_exhausted` waits for the owner's answer to its limit ask, `room_allowed` was allowed more and goes on when
 * the run lane is free, `usage_limit` goes on when the bot's usage pause ends, `question` waits for the owner's answer
 * to the question it asked (`question_ask`), and `question_answered` was answered and goes on when the run lane is free.
 */
export { BOT_WORK_WAIT_REASONS, workWaits } from '../activation/workWaiting'

/** The `bots.db` schema version this build writes. */
export const BOTS_DB_VERSION = BOTS_MIGRATIONS.at(-1)!.version
/** How many `bots.db.pre-v<n>` copies are kept beside the database. */
const KEPT_MIGRATION_COPIES = 2

/** Why a bot's schedules are paused: the owner's Pause, three failed runs, or a usage limit until `pausedUntil`. */
export type BotPauseReason = 'owner' | 'failures' | 'usage_limit'

/** The stuck error a bot shows, with what caused it (internal, never in a payload). */
export interface BotStoredError {
  code: string
  error: BotError
}

export interface BotRegistryRow {
  botId: string
  revision: string | null
  homeThreadId: string | null
  createdAt: string
  deletedAt: string | null
  pausedReason: BotPauseReason | null
  pausedUntil: string | null
  failureStreak: number
  error: BotStoredError | null
  readSeq: number
  /**
   * The last resolved selection (internal; never in a UI payload), and each row's last one (#673): a `model_change`
   * journal row is written when a row's model changes, not when Talk and Work take turns. Older builds rewrite it without
   * `rows`; each row then journals its model once more.
   */
  model: BotModelState | null
}

/**
 * A provider's usage limit on one of a picked bot's entries (#673): until when, and for which models. `family`: a limit
 * the provider names for one family only (Claude's weekly Opus or Sonnet window), else the whole entry. `said`: the
 * chat has said it once.
 */
export interface BotEntryLimit {
  instanceId: string
  until: string
  family?: string
  said?: boolean
}

/**
 * What the engine keeps about a bot's models in `model_json` (internal; never in a UI payload). `selection` and `rows`:
 * the last resolved selection and each row's last one; a `model_change` journal row is written when a row's model
 * changes, not when Talk and Work take turns. `stuck`: rows whose pick can't run (#673), each held until it runs again
 * or the owner picks again for it. `limits`: usage limits on a picked bot's entries, by entry (and family). Older
 * builds rewrite it with `selection` and `activationId` only; the rest is then forgotten.
 */
export interface BotModelState {
  selection: ProviderSelection
  activationId: string
  rows?: Partial<Record<string, ProviderSelection>>
  stuck?: BotStuckRows
  limits?: Record<string, BotEntryLimit>
}

function registryOf(row: Row): BotRegistryRow {
  return {
    botId: row.bot_id as string,
    revision: str(row.revision),
    homeThreadId: str(row.home_thread_id),
    createdAt: row.created_at as string,
    deletedAt: str(row.deleted_at),
    pausedReason: str(row.paused_reason) as BotPauseReason | null,
    pausedUntil: str(row.paused_until),
    failureStreak: num(row.failure_streak) ?? 0,
    error: json<BotStoredError>(row.error_json),
    readSeq: num(row.read_seq) ?? 0,
    model: json<BotRegistryRow['model']>(row.model_json)
  }
}

/** One row of `bot_messages`. */
export interface BotMessageRow {
  seq: number
  id: string
  botId: string
  at: string
  author: 'owner' | 'bot'
  kind: BotMessageKind
  text: string
  chips: BotChip[]
  askId: string | null
  error: BotError | null
  activationId: string | null
  /**
   * The message's files, then the applets its reply shows (each with `applet`, an empty `path` and its title as `name`),
   * so a file's index never moves and `bots.db` keeps its version; an older build shows an applet as its title. A picture
   * a gallery card shows is also one of its files (`card`), so another device or an older app reads it as any file.
   */
  attachments: Array<{ name: string; path: string; applet?: BotChatApplet; card?: true }> | null
  clientRequestId: string | null
  /** The message this one answers (a reply to the owner, or the owner's reply to the bot); null for none. */
  replyTo: string | null
  /** The owner's reaction on a bot's message (an emoji) and when it was set; absent for none. */
  ownerReaction?: { emoji: string; at: string }
  /** The question this bot message carries, or the one this owner message answered (v8); absent for none. */
  questionId?: string
  /** A bot message's cards (`show_card`, a question's card), as the bot made them (`cards_json`, v8); absent for none. */
  cards?: BotCard[]
  /** Telling class (v10); null means this row is never told. Unused until telling is implemented. */
  tell?: 'now' | 'soon' | 'later' | null
  tellAt?: string | null
  toldAt?: string | null
}

/** One of a bot's questions to its owner (`bot_questions`, v8). */
export interface BotQuestionRow {
  id: string
  botId: string
  /** The chat turn (or work) that asked. */
  activationId: string
  dispatchN: number
  lane: BotLane
  spec: BotQuestionSpec
  status: BotQuestionStatus
  /** `sent`: work's answer went out with dispatch `n`, as `line` in its prompt (`markAnswerSent`); a forget drops it. */
  answer: (BotQuestionAnswer & { redacted?: true; sent?: { n: number; line: string } }) | null
  /** The owner's message that answered it, or that moved past it (`moved_on`). */
  answerMessage: string | null
  answeredAt: string | null
  /** A continuation told the turn about it (a question withdrawn at a wall: "ask it again"). */
  readAt: string | null
  /** The bubble that carries it; null until the turn's reply is posted. */
  messageId: string | null
  createdAt: string
  /** What happens if the owner doesn't answer (`follow_json`); null for a question an earlier build kept with none. */
  follow: BotQuestionFollow | null
  /** When the next nudge, or the default, is due; null when none is (it is not open, or it nudged all it may). */
  nextAt: string | null
  /** How many nudges were posted for it. */
  nudges: number
}

/** A question's follow-up as kept, or null for none (`{}`, an earlier build's). */
function followOf(value: unknown): BotQuestionFollow | null {
  const follow = json<Partial<BotQuestionFollow>>(value)
  if (!follow || (follow.kind !== 'nudge' && follow.kind !== 'default') || typeof follow.afterMs !== 'number') return null
  return { kind: follow.kind, afterMs: follow.afterMs, ...(typeof follow.default === 'string' ? { default: follow.default } : {}) }
}

function questionOf(row: Row): BotQuestionRow {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    activationId: row.activation_id as string,
    dispatchN: num(row.dispatch_n) ?? 0,
    lane: (str(row.lane) ?? 'chat') as BotLane,
    spec: JSON.parse(row.spec_json as string) as BotQuestionSpec,
    status: row.status as BotQuestionStatus,
    answer: json<BotQuestionRow['answer']>(row.answer_json),
    answerMessage: str(row.answer_message),
    answeredAt: str(row.answered_at),
    readAt: str(row.read_at),
    messageId: str(row.message_id),
    createdAt: row.created_at as string,
    follow: followOf(row.follow_json),
    nextAt: str(row.next_at),
    nudges: num(row.nudges) ?? 0
  }
}

/** One one-off reminder (`bot_reminders`): a message at a time, or work started then. */
export interface BotReminderRow {
  id: string
  botId: string
  dueAt: string
  /** What the reminder says (for work: a one-line summary of it). */
  text: string
  /** Work to start at the time, instead of only saying `text`. */
  work: { title: string; brief: string } | null
  /** The owner's message that asked for it. */
  replyTo: string | null
  createdAt: string
  status: 'waiting' | 'delivered' | 'cancelled'
  deliveredAt: string | null
  messageId: string | null
  activationId: string | null
  /**
   * A wake (v9): at its time the bot carries on in its own chat, a turn no person started; `text` is the brief it wrote
   * for itself. False for a reminder.
   */
  wake: boolean
  /** What a wake waits for; `dueAt` is then the time it gives up. Null: a time alone. */
  event: BotWakeEvent | null
  /** What happened to a wake on an event (its event, or why it ended), kept until it is said. */
  fired: BotWakeFired | null
  /** How many wakes in a row, with no owner's message between them, this one ends (1 for one the owner's turn set). */
  chain: number
  /** The reminder this one was snoozed from (v10); null for none. */
  snoozedFrom?: string | null
  /** Whether the owner's message or tap started the turn that set it (v10); null preserves pre-v10 behavior. */
  ownerSet?: boolean | null
  /** The work this timer wakes (v11); existing writers leave it null. */
  workId?: string | null
}

function jsonOf<T>(value: unknown): T | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function reminderOf(row: Row): BotReminderRow {
  const title = str(row.work_title)
  const brief = str(row.work_brief)
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    dueAt: row.due_at as string,
    text: row.text as string,
    work: title !== null && brief !== null ? { title, brief } : null,
    replyTo: str(row.reply_to),
    createdAt: row.created_at as string,
    status: row.status as BotReminderRow['status'],
    deliveredAt: str(row.delivered_at),
    messageId: str(row.message_id),
    activationId: str(row.activation_id),
    wake: num(row.wake) === 1,
    event: jsonOf<BotWakeEvent>(row.event_json),
    fired: jsonOf<BotWakeFired>(row.fired_json),
    chain: num(row.chain) ?? 0,
    workId: str(row.work_id),
    snoozedFrom: str(row.snoozed_from),
    ownerSet: num(row.owner_set) === null ? null : num(row.owner_set) === 1
  }
}

function messageOf(row: Row): BotMessageRow {
  return {
    seq: num(row.seq)!,
    id: row.id as string,
    botId: row.bot_id as string,
    at: row.at as string,
    author: row.author as BotMessageRow['author'],
    kind: row.kind as BotMessageKind,
    text: row.text as string,
    chips: json<BotChip[]>(row.chips_json) ?? [],
    askId: str(row.ask_id),
    error: json<BotError>(row.error_json),
    activationId: str(row.activation_id),
    attachments: json<BotMessageRow['attachments']>(row.attachments_json),
    clientRequestId: str(row.client_request_id),
    replyTo: str(row.reply_to),
    tell: str(row.tell) as BotMessageRow['tell'],
    tellAt: str(row.tell_at),
    toldAt: str(row.told_at),
    ...(str(row.owner_reaction) && str(row.owner_reaction_at) ? { ownerReaction: { emoji: row.owner_reaction as string, at: row.owner_reaction_at as string } } : {}),
    ...(str(row.question_id) ? { questionId: row.question_id as string } : {}),
    ...(cardsOf(row.cards_json) ? { cards: cardsOf(row.cards_json)! } : {})
  }
}

/** A message's kept cards: each read again as the bot's arguments are, so a damaged or unknown one is dropped. */
function cardsOf(value: unknown): BotCard[] | undefined {
  const kept = json<unknown[]>(value)
  if (!Array.isArray(kept)) return undefined
  const cards = kept.map(keptCardOf).filter((card): card is BotCard => card !== undefined)
  return cards.length ? cards : undefined
}

/** One of a bot's schedules (`bot_schedules`), the only place schedules live. */
export interface BotScheduleRow {
  id: string
  botId: string
  when: BotSchedule['when']
  prompt: string
  label: string
  createdBy: 'owner' | 'bot'
  createdAt: string
  removedAt: string | null
  /** When it was copied to the shared scheduled-job store, and the job it became (v5). */
  migratedAt: string | null
  migratedJobId: string | null
}

function scheduleOf(row: Row): BotScheduleRow {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    when: JSON.parse(row.when_json as string) as BotSchedule['when'],
    prompt: row.prompt as string,
    label: row.label as string,
    createdBy: row.created_by as BotScheduleRow['createdBy'],
    createdAt: row.created_at as string,
    removedAt: str(row.removed_at),
    migratedAt: str(row.migrated_at),
    migratedJobId: str(row.migrated_job_id)
  }
}

export interface BotGrantRow {
  botId: string
  digest: string
  manifest: BotManifest
  approvedAt: string
}

/**
 * What started an activation (`bot_activations.provenance`, v14). A chat turn: the owner's message (`owner_message`, keyed
 * `chat:`), an answer the owner tapped (`owner_tap`, `answer:`), the bot's first message (`first_message`, `create:`), a
 * wake (`wake`), a question's default answer (`question`), a thread's notice (`job`) or message (`threadmsg`), another
 * bot's message (`botmsg`), or a held call's result (`action_result`, `action:`). A run: work (`work`), a schedule
 * (`schedule`) or a run started by hand (`manual`). `unknown`: any other start.
 */
export type BotActivationProvenance =
  | 'owner_message' | 'owner_tap' | 'first_message' | 'wake' | 'question' | 'job' | 'threadmsg' | 'botmsg' | 'action_result'
  | 'work' | 'schedule' | 'manual'
  | 'unknown'

const PROVENANCES: ReadonlySet<string> = new Set<BotActivationProvenance>([
  'owner_message', 'owner_tap', 'first_message', 'wake', 'question', 'job', 'threadmsg', 'botmsg', 'action_result', 'work', 'schedule', 'manual', 'unknown'
])

/** The start of a chat turn's idempotency key, and the provenance it names. */
const CHAT_KEY_PROVENANCE: ReadonlyArray<readonly [string, BotActivationProvenance]> = [
  ['chat:', 'owner_message'], ['answer:', 'owner_tap'], ['create:', 'first_message'], ['wake:', 'wake'], ['question:', 'question'],
  ['job:', 'job'], [THREAD_MESSAGE_KEY_PREFIX, 'threadmsg'], ['botmsg:', 'botmsg'], ['action:', 'action_result']
]

/** The start of a chat turn Resume retried after a usage limit (`BotEngine.chatToRetry`). */
const RESUME_KEY = 'resume:'

/** What only the owner's own message or tap starts: never behind a `resume:`. */
const OWNER_PROVENANCES: ReadonlySet<BotActivationProvenance> = new Set(['owner_message', 'owner_tap'])

/**
 * The provenance of an activation from its lane, idempotency key and trigger: what a row written before v14 means, and
 * what a new row stores. A run: its trigger's kind. A chat turn: its key's start, also behind the `resume:` of the turns
 * Resume retried (`resume:wake:<id>`, `resume:resume:job:<id>`). A bare `resume:<id>` is the retry of another bot's
 * message (`chatToRetry` keeps no other start that way), so `botmsg`; so is `resume:chat:<id>` or `resume:answer:<id>`,
 * which no build writes and which never read as the owner's. The bot's first message is still told by its raw
 * `create:` key (`resume:create:<id>` is not one); this does not change that.
 */
export function deriveBotProvenance(input: { lane: BotLane; idempotencyKey: string; trigger?: { kind: string } }): BotActivationProvenance {
  if (input.lane === 'run') return runProvenance(input.trigger?.kind)
  if (input.lane !== 'chat') return 'unknown'
  let key = input.idempotencyKey
  let hadResumePrefix = false
  while (key.startsWith(RESUME_KEY)) { key = key.slice(RESUME_KEY.length); hadResumePrefix = true }
  // The owner's own starts never follow a `resume:` (their retries are `chat:resume:<id>`, `answer:resume:<id>`).
  const named = CHAT_KEY_PROVENANCE.find(([start, provenance]) => key.startsWith(start) && !(hadResumePrefix && OWNER_PROVENANCES.has(provenance)))
  if (named) return named[1]
  return hadResumePrefix ? 'botmsg' : 'unknown'
}

/** The provenance a new activation row stores: the one its writer names, or the one its lane, key and trigger give. */
function provenanceToWrite(row: { lane?: BotLane; idempotencyKey: string; trigger: { kind: string } }, provenance: BotActivationProvenance | undefined): BotActivationProvenance {
  return provenance ?? deriveBotProvenance({ lane: row.lane ?? 'run', idempotencyKey: row.idempotencyKey, trigger: row.trigger })
}

export interface BotActivationRow {
  id: string
  botId: string
  revision: string
  grantDigest: string
  trigger: BotActivationTrigger
  idempotencyKey: string
  status: BotActivationStatus
  threadId: string | null
  scratch: string | null
  autoRestarts: number
  result: string | null
  createdAt: string
  endedAt: string | null
  endReason: string | null
  /** `chat`: the owner's chat on the home thread; `run`: a run on its own thread. */
  lane: BotLane
  /** `set_depth`/`use_model` for this activation only (internal). */
  modelOverride: BotModelOverride | null
  /** The model changed for this activation: its next dispatch resolves it again. */
  reloadPending: boolean
  /** The model this activation runs on, resolved at its first dispatch (internal; never in a payload). */
  selection: ProviderSelection | null
  /**
   * A running activation waits for the internet (docs/bots.md, "No internet"): kept as its
   * `end_reason` while it runs, so `bots.db` needs no new column and older builds still read it.
   */
  offline: boolean
  /** What started it: stored since v14, derived from its key and trigger for an older row (`deriveBotProvenance`), `unknown` for a stored value this build does not know. */
  provenance: BotActivationProvenance
}

export interface BotDispatchRow {
  activationId: string
  n: number
  /**
   * `start` and `continue` are the activation's main dispatches; a `consult` and a `subagent` attach to one (`mainN`). A
   * subagent's turn is kept as a consult in `bots.db` (`SUBAGENT_DISPATCH`), so the database needs no new version and an
   * older build ends it at its start as it ends any consult its turn left.
   */
  kind: 'start' | 'continue' | 'consult' | 'subagent'
  mainN: number | null
  clientRequestId: string
  runId: string | null
  threadId: string
  /** `subagent`: what a subagent's turn runs as, on its every dispatch (`BotSubagentSpec`). */
  prompt: {
    text: string
    subagent?: BotSubagentSpec
    /** Stored updates are told only after model output or a completed dispatch. */
    workTold?: 'pending' | 'output' | 'completed'
    workWaitIds?: string[]
    workActionIds?: string[]
    workRefusalIds?: string[]
    /** Carried ids for replay; existing read/applied markers remain independent of confirmation. */
    /** `question`: one question's answer, as an older build carried it; `questions`: every answer the dispatch carried. */
    workDelivery?: { answers: string[]; notes: number[]; question?: string; questions?: string[] }
    /**
     * A chat turn's first dispatch: the queued notices it took in with its own input (`BotEngine.noticeBatchInTx`). They
     * stay queued while it runs, and end as `merged` when it ends done (`moveActivation`); else they run after it.
     */
    merged?: string[]
  }
  policyDigest: string
  deadlineMs: number | null
  prepaidMs: number | null
  usedMs: number | null
  startedAt: number | null
  /**
   * When the dispatch last made a call (wall clock; its start until it makes one): what a dispatch Mousse stopped while
   * it ran is charged up to, at the next start or as the profile closes.
   */
  checkpointAt: number | null
  exitAt: number | null
  endedAt: string | null
  outcome: string | null
  settledBy: 'run' | 'startup' | null
  /** How a continuation is sent (the run it continues, the owner's acknowledgement), so a resend matches it. */
  send: {
    continuationOfRunId?: string
    acknowledgeUncertain?: boolean
    /** A retry on another model after a usage limit. */
    usageRetry?: boolean
    /** A continuation after the previous dispatch reached its runtime's cap on model turns. */
    turnCap?: boolean
    /** A chat turn going on to answer the owner after its reply was the runtime's placeholder (at most once). */
    unanswered?: boolean
  }
}

export interface BotEscalationRow {
  id: string
  botId: string
  activationId: string
  dispatchN: number
  toolCallId: string | null
  kind: BotWallKind
  /** What is asked for: a permission, or an ask that grants nothing (`export_memory`). */
  permission: BotAskRequest
  reason: string
  status: BotEscalationStatus
  amount: number | null
  createdAt: string
  /** Asks never expire (null); only rows of older builds carry a time. */
  expiresAt: string | null
  answeredAt: string | null
  appliedAt: string | null
  /** `wall`: a chat turn waits for the answer; `ask`: a run carried on without it. */
  mode: BotAskMode
  /** The canonical JSON of what is asked for: one open ask per bot and fingerprint. */
  fingerprint: string
  title: string | null
  note: string | null
  /** The `bot_messages` row carrying the card. */
  messageId: string | null
  /** After Not now on a run ask: no new ask for the same permission before this time. */
  cooldownUntil: string | null
}

function escalationOf(row: Row): BotEscalationRow {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    activationId: row.activation_id as string,
    dispatchN: num(row.dispatch_n)!,
    toolCallId: str(row.tool_call_id),
    kind: row.kind as BotWallKind,
    permission: JSON.parse(row.permission_json as string) as BotAskRequest,
    reason: row.reason as string,
    status: row.status as BotEscalationStatus,
    amount: num(row.amount),
    createdAt: row.created_at as string,
    expiresAt: str(row.expires_at),
    answeredAt: str(row.answered_at),
    appliedAt: str(row.applied_at),
    mode: (str(row.mode) ?? 'wall') as BotAskMode,
    fingerprint: row.fingerprint as string,
    title: str(row.title),
    note: str(row.note),
    messageId: str(row.message_id),
    cooldownUntil: str(row.cooldown_until)
  }
}

/** A plan usage window a runtime reported with a turn (Claude Code, Codex): how much of it is used, and when it resets. */
export interface BotQuotaWindow {
  /** The window as the runtime names it (`five_hour`, `seven_day`, `primary`, `secondary`). */
  kind: string
  /** 0-100. */
  usedPercent: number
  /** Epoch seconds, when reported. */
  resetsAt?: number
}

export interface BotTurnUsageStart {
  activationId: string
  dispatchN: number
  botId: string
  lane: BotLane
  /** What started the turn: the chat's start key (`chat`, `answer`, `botmsg`, `create`...) or the run's trigger. */
  startedBy: string
  instanceId?: string
  model?: string
  /** The runtime context the turn runs in: today the activation (each chat activation starts from a cleared context). */
  contextGen: string
  freshContext: boolean
  startedAt: number
  /** Since the bot's previous request in this lane, when there was one. */
  gapMs?: number
  systemChars: number
  preambleChars: number
  promptChars: number
}

export interface BotTurnUsageRow extends BotTurnUsageStart {
  tools: number | null
  toolsChars: number | null
  reports: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  lastPrompt: number | null
  contextWindow: number | null
  cacheTtlMs: number | null
  lastRequestAt: number | null
  compactions: number
  quota: BotQuotaWindow[] | null
}

function turnUsageOf(row: Row): BotTurnUsageRow {
  return {
    activationId: row.activation_id as string,
    dispatchN: num(row.dispatch_n)!,
    botId: row.bot_id as string,
    lane: row.lane as BotLane,
    startedBy: row.started_by as string,
    ...(str(row.instance_id) ? { instanceId: str(row.instance_id)! } : {}),
    ...(str(row.model) ? { model: str(row.model)! } : {}),
    contextGen: row.context_gen as string,
    freshContext: num(row.fresh_context) === 1,
    startedAt: num(row.started_at)!,
    ...(num(row.gap_ms) !== null ? { gapMs: num(row.gap_ms)! } : {}),
    systemChars: num(row.system_chars)!,
    preambleChars: num(row.preamble_chars)!,
    promptChars: num(row.prompt_chars)!,
    tools: num(row.tools),
    toolsChars: num(row.tools_chars),
    reports: num(row.reports)!,
    input: num(row.input)!,
    output: num(row.output)!,
    cacheRead: num(row.cache_read)!,
    cacheWrite: num(row.cache_write)!,
    lastPrompt: num(row.last_prompt),
    contextWindow: num(row.context_window),
    cacheTtlMs: num(row.cache_ttl_ms),
    lastRequestAt: num(row.last_request_at),
    compactions: num(row.compactions)!,
    quota: json<BotQuotaWindow[]>(row.quota_json)
  }
}

export interface BotCountersRow {
  requests: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  activeMs: number
}

// Completed outcomes also recognize dispatches written before the explicit output marker existed.
const WORK_TOLD = "(COALESCE(json_extract(d.prompt_json, '$.workTold'), '') IN ('output', 'completed') OR (json_extract(d.prompt_json, '$.workTold') IS NULL AND d.outcome IS 'completed'))"

const hasWorkUpdates = (prompt: BotDispatchRow['prompt']): boolean => Boolean(
  prompt.workRefusalIds?.length || prompt.workActionIds?.length || prompt.workWaitIds?.length || prompt.workDelivery?.notes.length ||
  prompt.workDelivery?.answers.length || prompt.workDelivery?.question || prompt.workDelivery?.questions?.length
)

/**
 * Only prompt delivery uses confirmation. Existing read/applied markers keep their carried semantics. A row carried under
 * any of `members` and confirmed under none of them is unconfirmed: a question an older build carried as its single
 * `question` and a newer one confirmed in `questions` was told once.
 */
const unconfirmedDelivery = (table: string, ...members: Array<'notes' | 'answers' | 'question' | 'questions'>): string => {
  const items = (dispatch: string) => members.map((member) => `SELECT value FROM json_each(${dispatch}.prompt_json, '$.workDelivery.${member}')`).join(' UNION ALL ')
  return `
  EXISTS (SELECT 1 FROM bot_dispatches carried WHERE carried.activation_id = ${table}.activation_id AND ${table}.id IN (${items('carried')}))
  AND NOT EXISTS (SELECT 1 FROM bot_dispatches d WHERE d.activation_id = ${table}.activation_id AND ${table}.id IN (${items('d')}) AND ${WORK_TOLD})`
}

type Row = Record<string, unknown>

function jobOf(row: Row): BotJob {
  return {
    id: String(row.id),
    botId: String(row.bot_id),
    activationId: String(row.activation_id),
    threadId: String(row.thread_id),
    title: String(row.title),
    ...(typeof row.project === 'string' ? { project: row.project } : {}),
    request: String(row.request),
    askedBy: String(row.asked_by) as BotJobAsker,
    state: String(row.state) as BotJobState,
    ...(typeof row.line === 'string' ? { line: row.line } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.ended_at === 'string' ? { endedAt: row.ended_at } : {})
  }
}
type Param = string | number | null

/**
 * The chat rows the owner sees: every one but an event's line (`outOfSightRow`): a thread's message to the bot, kept
 * for its guard, and the lines older versions posted for a wake-up or a thread's notice. Those events are the bot's to
 * act on, not the owner's to read; only what the bot says shows.
 */
const SHOWN_MESSAGE = String.raw`NOT (kind = 'notice' AND id LIKE 'bm\_wake\_%' ESCAPE '\')`

/** Whether a chat row is one the owner never sees (`SHOWN_MESSAGE`): a notice whose id starts `bm_wake_`. */
export function outOfSightRow(kind: string, id: string): boolean {
  return kind === 'notice' && id.startsWith(WAKE_LINE_PREFIX)
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null)
const json = <T>(value: unknown): T | null => (typeof value === 'string' ? (JSON.parse(value) as T) : null)

function activationOf(row: Row): BotActivationRow {
  const lane = (str(row.lane) ?? 'run') as BotLane
  const trigger = JSON.parse(row.trigger_json as string) as BotActivationRow['trigger']
  const stored = str(row.provenance)
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    revision: row.revision as string,
    grantDigest: row.grant_digest as string,
    trigger,
    idempotencyKey: row.idempotency_key as string,
    status: row.status as BotActivationStatus,
    threadId: str(row.thread_id),
    scratch: str(row.scratch),
    autoRestarts: num(row.auto_restarts) ?? 0,
    result: str(row.result),
    createdAt: row.created_at as string,
    endedAt: str(row.ended_at),
    endReason: str(row.end_reason),
    lane,
    modelOverride: json<BotModelOverride>(row.model_override_json),
    reloadPending: num(row.reload_pending) === 1,
    selection: json<ProviderSelection>(row.selection_json),
    offline: row.status === 'running' && row.end_reason === BOT_OFFLINE_REASON,
    // NULL: a row written before v14, read from its lane, key and trigger. A value this build does not know (a newer
    // build's start) is `unknown`, never what its key or trigger would give: it gets no right a known start has.
    provenance: stored === null ? deriveBotProvenance({ lane, idempotencyKey: row.idempotency_key as string, trigger }) : PROVENANCES.has(stored) ? stored as BotActivationProvenance : 'unknown'
  }
}

/**
 * What a subagent of a bot's work runs as, kept with each of its dispatches: its title, its model in plain words, the
 * selection it runs on, and the pick the work named (checked again before each of its turns). Absent `pick`: the work's
 * own model.
 */
export interface BotSubagentSpec {
  title: string
  model: string
  selection: ProviderSelection
  pick?: BotModelPick & { instanceId: string }
  /** The work's tool call that started it: a repeat of the call starts nothing new. */
  call?: string
  /** When the work started it (wall-clock milliseconds): the bot's subagents are counted per day by it. */
  at?: number
  /** What it runs without, in the owner's words, because its entry holds that less tightly than the work's (`subagentHold`). */
  lacks?: string[]
}

/** A work subagent's turn (`bot_subagent_runs`): its lifecycle and result are the run database's delegation. */
export interface BotSubagentRunRow {
  activationId: string
  childRunId: string
  delegationId: string
  threadId: string
  /** The work's main dispatch it was started from. */
  mainN: number | null
  spec: BotSubagentSpec
  reservedAt: string
  startedAt: number | null
  usedMs: number | null
  chargedAt: string | null
  outcome: 'done' | 'failed' | 'stopped' | null
  why: string | null
  deliveredAt: string | null
  /**
   * When its work was told it ended: its running turn took the notice in, it read it (`subagent_result`, `subagent_wait`),
   * or a continuation of the work carried it. Null while delivered but untold, so a crash never loses the notice.
   */
  toldAt: string | null
}

function subagentRunOf(row: Row): BotSubagentRunRow {
  return {
    activationId: String(row.activation_id),
    childRunId: String(row.child_run_id),
    delegationId: String(row.delegation_id),
    threadId: String(row.thread_id),
    mainN: row.main_n === null ? null : Number(row.main_n),
    spec: JSON.parse(String(row.spec_json)) as BotSubagentSpec,
    reservedAt: String(row.reserved_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    usedMs: row.used_ms === null ? null : Number(row.used_ms),
    chargedAt: str(row.charged_at),
    outcome: row.outcome === 'done' || row.outcome === 'failed' || row.outcome === 'stopped' ? row.outcome : null,
    why: str(row.why),
    deliveredAt: str(row.delivered_at),
    toldAt: str(row.told_at)
  }
}

/** A subagent's dispatch id: `<activationId>:s<n>`; a consult's is `<activationId>:c<n>`. Both are `consult` in `bots.db`. */
const SUBAGENT_DISPATCH = /:s\d+$/

/** The key a subagent's thread is kept under in `bots.db`, as a context thread no definition can name. */
export const SUBAGENT_THREAD_KEY = '@subagent:'

/** A thread's role as the engine reads it: a context thread kept under a subagent's key is a subagent's. */
function roleOfRow(row: Row): 'home' | BotThreadRole {
  return row.role === 'context' && typeof row.key === 'string' && row.key.startsWith(SUBAGENT_THREAD_KEY) ? 'subagent' : row.role as 'home' | BotThreadRole
}

function dispatchOf(row: Row): BotDispatchRow {
  return {
    activationId: row.activation_id as string,
    n: num(row.n)!,
    kind: row.kind === 'consult' && SUBAGENT_DISPATCH.test(row.client_request_id as string) ? 'subagent' : row.kind as BotDispatchRow['kind'],
    mainN: num(row.main_n),
    clientRequestId: row.client_request_id as string,
    runId: str(row.run_id),
    threadId: row.thread_id as string,
    prompt: JSON.parse(row.prompt_json as string) as BotDispatchRow['prompt'],
    policyDigest: row.policy_digest as string,
    deadlineMs: num(row.deadline_ms),
    prepaidMs: num(row.prepaid_ms),
    usedMs: num(row.used_ms),
    startedAt: num(row.started_at),
    checkpointAt: num(row.checkpoint_at),
    exitAt: num(row.exit_at),
    endedAt: str(row.ended_at),
    outcome: str(row.outcome),
    settledBy: str(row.settled_by) as BotDispatchRow['settledBy'],
    send: typeof row.send_json === 'string' ? (JSON.parse(row.send_json) as BotDispatchRow['send']) : {}
  }
}

/**
 * The `bots.db` connection as seen inside `BotStore.db.transaction(…)`: what another module's
 * writes go through so they join the caller's transaction (`BotJournal.appendInTx`, Bot Phase 1 §7.1).
 */
export type BotStoreTx = Pick<ProfileDatabase, 'statement' | 'inTransaction'>

/** The profile's `bots.db`: typed reads and the writes the bot engine and its scopes make. */
export class BotStore {
  readonly db: ProfileDatabase
  /**
   * Told when what a bot's turns start with changes: its grant (approved, revoked, moved), its published revision (model,
   * instructions), a pause, or its deletion. The engine closes the process kept warm for the bot's chat then. Must not throw.
   */
  launchChanged?: (botId: string) => void

  constructor(options: { profileHome: string; clock?: () => number; fault?: ProfileDatabaseFault }) {
    this.db = new ProfileDatabase({ profileHome: options.profileHome, name: 'bots', ...(options.clock ? { clock: options.clock } : {}), ...(options.fault ? { fault: options.fault } : {}) })
    try {
      this.copyBeforeMigration()
      this.db.migrate(BOTS_MIGRATIONS)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * Before a migration of an existing database: `VACUUM INTO bots.db.pre-v<n>`, a consistent copy
   * of what the older build wrote (bot-context.md §3). The last two copies are kept.
   */
  private copyBeforeMigration(): void {
    const current = this.db.userVersion()
    if (current === 0 || current >= BOTS_DB_VERSION) return
    const copy = `${this.db.path}.pre-v${BOTS_DB_VERSION}`
    rmSync(copy, { force: true })
    this.db.database.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
    const prefix = `${this.db.path.slice(this.db.directory.length + 1)}.pre-v`
    const copies = readdirSync(this.db.directory)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .map((name) => ({ name, version: Number(name.slice(prefix.length)) }))
      .sort((a, b) => b.version - a.version)
    for (const old of copies.slice(KEPT_MIGRATION_COPIES)) rmSync(join(this.db.directory, old.name), { force: true })
  }

  /** `<profileHome>/bots`. */
  get directory(): string {
    return this.db.directory
  }

  now(): string {
    return new Date(this.db.clock()).toISOString()
  }

  close(): void {
    this.db.close()
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.statement(sql).get(...params) as Row | undefined
  }

  all(sql: string, ...params: Param[]): Row[] {
    return this.db.statement(sql).all(...params) as Row[]
  }

  /** Runs one statement; the number of rows it changed. */
  run(sql: string, ...params: Param[]): number {
    return Number(this.db.statement(sql).run(...params).changes)
  }

  // -- Registry --------------------------------------------------------------------------------

  registry(botId: string): BotRegistryRow | undefined {
    const row = this.get('SELECT * FROM bot_registry WHERE bot_id = ?', botId)
    return row ? registryOf(row) : undefined
  }

  /** Deleted bots whose purge is not done yet (`before`: deleted before that time only). */
  deletedRegistry(before?: string): BotRegistryRow[] {
    return (before === undefined
      ? this.all('SELECT * FROM bot_registry WHERE deleted_at IS NOT NULL AND cleaned_at IS NULL ORDER BY deleted_at, bot_id')
      : this.all('SELECT * FROM bot_registry WHERE deleted_at IS NOT NULL AND cleaned_at IS NULL AND deleted_at <= ? ORDER BY deleted_at, bot_id', before)).map(registryOf)
  }

  /** Pause (`reason`) or resume (null) a bot's schedules; a resume also clears the failure streak, unless `keepStreak`. */
  setPaused(botId: string, reason: BotPauseReason | null, until?: string, options: { keepStreak?: boolean } = {}): void {
    if (reason === null && options.keepStreak) this.run('UPDATE bot_registry SET paused_reason = NULL, paused_until = NULL WHERE bot_id = ?', botId)
    else if (reason === null) this.run('UPDATE bot_registry SET paused_reason = NULL, paused_until = NULL, failure_streak = 0 WHERE bot_id = ?', botId)
    else this.run('UPDATE bot_registry SET paused_reason = ?, paused_until = ? WHERE bot_id = ?', reason, until ?? null, botId)
    if (reason !== null) this.changedLaunch(botId)
  }

  private changedLaunch(botId: string): void {
    try {
      this.launchChanged?.(botId)
    } catch (error) {
      console.warn("a bot's launch change could not be passed on", { botId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Adds one failed run (or resets with 0); the streak after the change. */
  bumpFailureStreak(botId: string, reset = false): number {
    if (reset) this.run('UPDATE bot_registry SET failure_streak = 0 WHERE bot_id = ?', botId)
    else this.run('UPDATE bot_registry SET failure_streak = failure_streak + 1 WHERE bot_id = ?', botId)
    return num(this.get('SELECT failure_streak FROM bot_registry WHERE bot_id = ?', botId)?.failure_streak) ?? 0
  }

  setError(botId: string, error: BotStoredError | null): void {
    this.run('UPDATE bot_registry SET error_json = ? WHERE bot_id = ?', error ? JSON.stringify(error) : null, botId)
  }

  /** The owner has read up to `seq`; the marker never moves back. */
  setReadSeq(botId: string, seq: number): void {
    this.run('UPDATE bot_registry SET read_seq = MAX(read_seq, ?) WHERE bot_id = ?', seq, botId)
  }

  setModel(botId: string, model: BotRegistryRow['model']): void {
    this.run('UPDATE bot_registry SET model_json = ? WHERE bot_id = ?', model ? JSON.stringify(model) : null, botId)
  }

  /** A deleted bot's cleanup is done: a home thread the owner restores later is left alone. */
  markCleaned(botId: string): void {
    this.run('UPDATE bot_registry SET cleaned_at = ? WHERE bot_id = ? AND deleted_at IS NOT NULL AND cleaned_at IS NULL', this.now(), botId)
  }

  listRegistry(): BotRegistryRow[] {
    return this.all('SELECT bot_id FROM bot_registry WHERE deleted_at IS NULL ORDER BY created_at, bot_id').map((row) => this.registry(row.bot_id as string)!)
  }

  ensureRegistry(botId: string): void {
    this.run('INSERT INTO bot_registry(bot_id, created_at) VALUES(?, ?) ON CONFLICT(bot_id) DO NOTHING', botId, this.now())
  }

  /** Creation metadata shares the durable cursor namespace, so clearing memory cannot erase a request's identity. */
  recordCreation(botId: string, key: string, input: string): void {
    this.run('INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?)', botId, `cursor:${key}`, JSON.stringify(input))
  }

  botCreation(key: string): { botId: string; input: string } | undefined {
    const row = this.get('SELECT bot_id, value FROM bot_memory_state WHERE key = ?', `cursor:${key}`)
    return row ? { botId: row.bot_id as string, input: JSON.parse(row.value as string) as string } : undefined
  }

  unfinishedCreations(): Array<{ botId: string; key: string }> {
    return this.all(`SELECT s.bot_id, s.key FROM bot_memory_state s
      JOIN bot_registry b ON b.bot_id = s.bot_id AND b.deleted_at IS NULL
      WHERE substr(s.key, 1, 14) = 'cursor:create:'
      AND NOT EXISTS (SELECT 1 FROM bot_activations a WHERE a.idempotency_key = substr(s.key, 8))`)
      .map((row) => ({ botId: row.bot_id as string, key: (row.key as string).slice(7) }))
  }

  setPublished(botId: string, revision: string): void {
    this.run('UPDATE bot_registry SET revision = ? WHERE bot_id = ? AND deleted_at IS NULL', revision, botId)
    this.changedLaunch(botId)
  }

  setHomeThread(botId: string, threadId: string): void {
    this.run('UPDATE bot_registry SET home_thread_id = ? WHERE bot_id = ?', threadId, botId)
  }

  markDeleted(botId: string): void {
    this.run('UPDATE bot_registry SET deleted_at = ? WHERE bot_id = ? AND deleted_at IS NULL', this.now(), botId)
    this.changedLaunch(botId)
  }

  // -- Grants ----------------------------------------------------------------------------------

  /** The bot's active grant: the latest approval not revoked since. */
  activeGrant(botId: string): BotGrantRow | undefined {
    const row = this.get('SELECT * FROM bot_grants WHERE bot_id = ? AND revoked_at IS NULL ORDER BY grant_id DESC LIMIT 1', botId)
    return row ? { botId, digest: row.digest as string, manifest: JSON.parse(row.manifest_json as string) as BotManifest, approvedAt: row.approved_at as string } : undefined
  }

  /** The grant approved with `digest`, active or replaced since (its latest approval), or undefined. */
  grantByDigest(botId: string, digest: string): Pick<BotGrantRow, 'digest' | 'manifest'> | undefined {
    const row = this.get("SELECT digest, manifest_json FROM bot_grants WHERE bot_id = ? AND digest = ? AND (revoked_at IS NULL OR revoked_at NOT LIKE 'off:%') ORDER BY grant_id DESC LIMIT 1", botId, digest)
    return row ? { digest: row.digest as string, manifest: JSON.parse(row.manifest_json as string) as BotManifest } : undefined
  }

  /** Inactive grant snapshots: older builds exclude these through their existing revoked_at check. */
  disabledPermissions(botId: string): Array<{ id: string; manifest: BotManifest }> {
    return this.all("SELECT revoked_at, manifest_json FROM bot_grants WHERE bot_id = ? AND revoked_at LIKE 'off:%'", botId)
      .map((row) => ({ id: (row.revoked_at as string).slice(4), manifest: JSON.parse(row.manifest_json as string) as BotManifest }))
  }

  keepDisabledPermission(botId: string, id: string, manifest: BotManifest): void {
    this.forgetDisabledPermission(botId, id)
    this.run('INSERT INTO bot_grants(bot_id, digest, manifest_json, approved_at, revoked_at) VALUES(?, ?, ?, ?, ?)', botId, '', JSON.stringify(manifest), this.now(), `off:${id}`)
  }

  forgetDisabledPermission(botId: string, id: string): void {
    this.run('DELETE FROM bot_grants WHERE bot_id = ? AND revoked_at = ?', botId, `off:${id}`)
  }

  /** Records an approval, in canonical form; it replaces the earlier grant, if any. */
  approve(botId: string, digest: string, given: BotManifest): BotGrantRow {
    // One form for what is granted: what approval showed is exactly what later answers build on.
    const manifest = canonicalManifest(given)
    return this.db.transaction(() => {
      const at = this.now()
      this.run('UPDATE bot_grants SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL', at, botId)
      this.run('INSERT INTO bot_grants(bot_id, digest, manifest_json, approved_at) VALUES(?, ?, ?, ?)', botId, digest, JSON.stringify(manifest), at)
      heldCalls(this.db)?.grantChanged(botId)
      this.changedLaunch(botId)
      return { botId, digest, manifest, approvedAt: at }
    })
  }

  revoke(botId: string): boolean {
    return this.db.transaction(() => {
      const revoked = this.run('UPDATE bot_grants SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL', this.now(), botId) > 0
      if (revoked) heldCalls(this.db)?.grantChanged(botId)
      if (revoked) this.changedLaunch(botId)
      return revoked
    })
  }

  // -- Threads ---------------------------------------------------------------------------------

  /** A subagent's thread is kept as a context thread under `SUBAGENT_THREAD_KEY`, so `bots.db` needs no new version. */
  putThread(input: { threadId: string; botId: string; role: 'home' | BotThreadRole; key: string; activationId?: string }): void {
    const subagent = input.role === 'subagent'
    this.run(
      'INSERT INTO bot_threads(thread_id, bot_id, role, key, activation_id) VALUES(?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO NOTHING',
      input.threadId, input.botId, subagent ? 'context' : input.role, subagent ? `${SUBAGENT_THREAD_KEY}${input.key}` : input.key, input.activationId ?? null
    )
  }

  threadRole(threadId: string): 'home' | BotThreadRole | undefined {
    const row = this.get('SELECT role, key FROM bot_threads WHERE thread_id = ?', threadId)
    return row ? roleOfRow(row) : undefined
  }

  threadBot(threadId: string): string | undefined {
    return str(this.get('SELECT bot_id FROM bot_threads WHERE thread_id = ?', threadId)?.bot_id) ?? undefined
  }

  // -- Activations -----------------------------------------------------------------------------

  activation(id: string): BotActivationRow | undefined {
    const row = this.get('SELECT * FROM bot_activations WHERE id = ?', id)
    return row ? activationOf(row) : undefined
  }

  activationByKey(key: string): BotActivationRow | undefined {
    const row = this.get('SELECT * FROM bot_activations WHERE idempotency_key = ?', key)
    return row ? activationOf(row) : undefined
  }

  listActivations(botId?: string): BotActivationRow[] {
    return (botId
      ? this.all('SELECT * FROM bot_activations WHERE bot_id = ? ORDER BY created_at DESC, id', botId)
      : this.all('SELECT * FROM bot_activations ORDER BY created_at DESC, id')).map(activationOf)
  }

  /** Activations of a bot in `statuses`, oldest first. */
  activationsIn(botId: string, statuses: readonly BotActivationStatus[]): BotActivationRow[] {
    const marks = statuses.map(() => '?').join(', ')
    return this.all(`SELECT * FROM bot_activations WHERE bot_id = ? AND status IN (${marks}) ORDER BY created_at, id`, botId, ...statuses).map(activationOf)
  }

  /** Activations of a bot's lane in `statuses`, oldest first (two made in the same millisecond in the order they were made). */
  laneActivations(botId: string, lane: BotLane, statuses: readonly BotActivationStatus[]): BotActivationRow[] {
    const marks = statuses.map(() => '?').join(', ')
    return this.all(`SELECT * FROM bot_activations WHERE bot_id = ? AND lane = ? AND status IN (${marks}) ORDER BY created_at, rowid`, botId, lane, ...statuses).map(activationOf)
  }

  /** A lane's newest activation, in the order they were made (two made in the same millisecond keep it). */
  newestActivation(botId: string, lane: BotLane): BotActivationRow | undefined {
    const row = this.get('SELECT * FROM bot_activations WHERE bot_id = ? AND lane = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', botId, lane)
    return row ? activationOf(row) : undefined
  }

  /** The bot's most recent activation that ended, if any; a notice another turn took in (`merged`) never ran, and is not one. */
  lastEndedActivation(botId: string): BotActivationRow | undefined {
    const row = this.get("SELECT * FROM bot_activations WHERE bot_id = ? AND status IN ('done', 'failed', 'cancelled') AND end_reason IS NOT 'merged' ORDER BY ended_at DESC, created_at DESC LIMIT 1", botId)
    return row ? activationOf(row) : undefined
  }

  /** When each of the bot's schedules last ran to an end, and how that run ended, by schedule id. */
  lastScheduleRuns(botId: string): Map<string, { endedAt: string; status: 'done' | 'failed' | 'cancelled' }> {
    // SQLite gives a bare column the values of the row that holds MAX(): each schedule's latest ended run.
    const rows = this.all(
      `SELECT json_extract(trigger_json, '$.scheduleId') AS schedule_id, status, MAX(ended_at) AS ended_at FROM bot_activations
       WHERE bot_id = ? AND status IN ('done', 'failed', 'cancelled') AND ended_at IS NOT NULL AND json_extract(trigger_json, '$.kind') = 'schedule'
       GROUP BY schedule_id`,
      botId
    )
    return new Map(rows.filter((row) => typeof row.schedule_id === 'string').map((row) => [row.schedule_id as string, { endedAt: row.ended_at as string, status: row.status as 'done' | 'failed' | 'cancelled' }]))
  }

  /**
   * The owner's words of an ended chat turn move to the turn that answers them again (Resume after a usage limit): its
   * chat pack leaves them out of the recent chat, as they are its request.
   */
  moveOwnerRows(botId: string, from: string, to: string): void {
    this.run("UPDATE bot_messages SET activation_id = ? WHERE bot_id = ? AND activation_id = ? AND author = 'owner'", to, botId, from)
    // The journal is the memory store's table, absent where bots run without memory.
    if (this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_journal'"))
      this.run("UPDATE bot_journal SET activation_id = ? WHERE bot_id = ? AND activation_id = ? AND kind = 'owner_msg'", to, botId, from)
  }

  setActivationSelection(id: string, selection: ProviderSelection | null): void {
    this.run('UPDATE bot_activations SET selection_json = ?, reload_pending = 0 WHERE id = ?', selection ? JSON.stringify(selection) : null, id)
  }

  /** `set_depth`/`use_model` with scope `now`: this activation's next dispatch runs on the new choice. */
  setModelOverride(id: string, choice: BotModelOverride): void {
    this.run('UPDATE bot_activations SET model_override_json = ?, reload_pending = 1 WHERE id = ?', JSON.stringify(choice), id)
  }

  /** The next dispatch resolves the model again (a usage limit, or a reload). */
  markReload(id: string): void {
    this.run('UPDATE bot_activations SET reload_pending = 1 WHERE id = ?', id)
  }

  /**
   * `start.provenance`: what started it, when its lane, key and trigger do not say (`deriveBotProvenance` otherwise).
   * Apart from the row, so a row built by spreading another activation's (with a new key or lane) never carries that
   * one's provenance.
   */
  insertActivation(row: Pick<BotActivationRow, 'id' | 'botId' | 'revision' | 'grantDigest' | 'trigger' | 'idempotencyKey' | 'status' | 'createdAt'> & { lane?: BotLane }, limits: ActivationLimits, start: { provenance?: BotActivationProvenance } = {}): void {
    this.run(
      'INSERT INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, lane, provenance) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.botId, row.revision, row.grantDigest, JSON.stringify(row.trigger), row.idempotencyKey, row.status, row.createdAt, row.lane ?? 'run', provenanceToWrite(row, start.provenance)
    )
    this.run('INSERT INTO bot_counters(activation_id, limits_json) VALUES(?, ?)', row.id, JSON.stringify(limits))
    this.run('INSERT INTO bot_spend(activation_id) VALUES(?)', row.id)
  }

  /**
   * Another device's message continued a chat activation at its wall ("use your threads", `BotOwnerTurn`): the rest of
   * the turn is held to that device's limit too, the narrower of the two. Inside the caller's transaction; false for an
   * activation that is not a manual chat one.
   */
  narrowOwnerLimit(id: string, limit: PermissionMode): boolean {
    const row = this.activation(id)
    if (!row || row.lane !== 'chat' || row.trigger.kind !== 'manual') return false
    const held = row.trigger.owner?.limit
    const trigger = { ...row.trigger, owner: { limit: held ? narrowPermissionMode(held, limit) : limit } }
    return this.run('UPDATE bot_activations SET trigger_json = ? WHERE id = ?', JSON.stringify(trigger), id) > 0
  }

  /** A running activation waits for the internet, or no longer does. False when it is not running (or did not wait). */
  setOffline(id: string, offline: boolean): boolean {
    return offline
      ? this.run("UPDATE bot_activations SET end_reason = ? WHERE id = ? AND status = 'running'", BOT_OFFLINE_REASON, id) > 0
      : this.run("UPDATE bot_activations SET end_reason = NULL WHERE id = ? AND status = 'running' AND end_reason = ?", id, BOT_OFFLINE_REASON) > 0
  }

  /**
   * Compare-and-set of an activation's status; false when it was not in `from`. Only a running activation waits for the
   * internet. One that fails or is cancelled (a Stop, a failure, the bot deleted) withdraws the questions it asked and never
   * posted, in the same statement's transaction: no reply carries them now. Work that ends, however it ends, withdraws
   * the question it still waited on: nothing would carry on with its answer. A chat turn that ends done ends the queued
   * notices its first dispatch took in (`merged`) with it, in the same transaction: they were answered.
   */
  moveActivation(id: string, from: readonly BotActivationStatus[], to: BotActivationStatus, patch: { endReason?: string | null; result?: string | null; threadId?: string; scratch?: string } = {}): boolean {
    if (to === 'failed' || to === 'cancelled' || to === 'done') return this.db.transaction(() => {
      const moved = this.moveActivationRow(id, from, to, patch)
      if (moved && to !== 'done') this.withdrawUnpostedQuestions(id)
      if (moved && to === 'done') for (const merged of this.dispatch(id, 1)?.prompt.merged ?? []) this.moveActivation(merged, ['queued'], 'cancelled', { endReason: MERGED_END_REASON })
      if (moved) {
        this.withdrawWorkQuestions(id)
        heldCalls(this.db)?.endWork(id, to)
        const refusalPrefix = `cursor:action-refusal:${id}:`
        // And the requests `work_note` took (`noteWork`): ended work takes no note, so a retry needs no record.
        const notePrefix = `work-note-request:${id}:`
        this.run('DELETE FROM bot_memory_state WHERE key IN (?, ?) OR substr(key, 1, ?) = ? OR substr(key, 1, ?) = ?', `cursor:action-note:${id}`, `cursor:action-owner:${id}`, refusalPrefix.length, refusalPrefix, notePrefix.length, notePrefix)
        this.run("UPDATE bot_reminders SET status = 'cancelled', delivered_at = ? WHERE work_id = ? AND status = 'waiting'", this.now(), id)
      }
      return moved
    })
    return this.moveActivationRow(id, from, to, patch)
  }

  private moveActivationRow(id: string, from: readonly BotActivationStatus[], to: BotActivationStatus, patch: { endReason?: string | null; result?: string | null; threadId?: string; scratch?: string }): boolean {
    const marks = from.map(() => '?').join(', ')
    const ended = to === 'done' || to === 'failed' || to === 'cancelled'
    return this.run(
      `UPDATE bot_activations SET status = ?,
         end_reason = CASE WHEN ? THEN ? WHEN end_reason = ? AND ? != 'running' THEN NULL ELSE end_reason END,
         result = CASE WHEN ? THEN ? ELSE result END,
         thread_id = COALESCE(?, thread_id),
         scratch = COALESCE(?, scratch),
         ended_at = CASE WHEN ? THEN ? ELSE ended_at END
       WHERE id = ? AND status IN (${marks})`,
      to,
      patch.endReason !== undefined ? 1 : 0, patch.endReason ?? null, BOT_OFFLINE_REASON, to,
      patch.result !== undefined ? 1 : 0, patch.result ?? null,
      patch.threadId ?? null,
      patch.scratch ?? null,
      ended ? 1 : 0, ended ? this.now() : null,
      id, ...from
    ) > 0
  }

  deleteActivation(id: string): void {
    for (const table of ['bot_counters', 'bot_spend', 'bot_spend_reservations', 'bot_unknown_calls', 'bot_turn_usage', 'bot_dispatches', 'bot_subagent_runs'])
      this.run(`DELETE FROM ${table} WHERE activation_id = ?`, id)
    this.run('DELETE FROM bot_activations WHERE id = ?', id)
  }

  // -- Work subagents (v15) ----------------------------------------------------------------------

  /**
   * A work subagent's place on its work's counts and spend (`bot_subagent_runs`), written once per (work, child run):
   * a second write, from its turn or the startup pass, changes nothing. True when this call wrote it.
   */
  reserveSubagentRun(row: { activationId: string; childRunId: string; delegationId: string; threadId: string; mainN: number | null; spec: BotSubagentSpec }): boolean {
    return this.run(
      'INSERT OR IGNORE INTO bot_subagent_runs(activation_id, child_run_id, delegation_id, thread_id, main_n, spec_json, reserved_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      row.activationId, row.childRunId, row.delegationId, row.threadId, row.mainN, JSON.stringify(row.spec), this.now()
    ) > 0
  }

  subagentRun(activationId: string, childRunId: string): BotSubagentRunRow | undefined {
    const row = this.get('SELECT * FROM bot_subagent_runs WHERE activation_id = ? AND child_run_id = ?', activationId, childRunId)
    return row ? subagentRunOf(row) : undefined
  }

  /** The work subagent a child run belongs to, whichever work. */
  subagentRunByRun(childRunId: string): BotSubagentRunRow | undefined {
    const row = this.get('SELECT * FROM bot_subagent_runs WHERE child_run_id = ? LIMIT 1', childRunId)
    return row ? subagentRunOf(row) : undefined
  }

  /** Subagent turns that started and were never charged: the startup pass charges each once. */
  unchargedSubagentRuns(): BotSubagentRunRow[] {
    return this.all('SELECT * FROM bot_subagent_runs WHERE started_at IS NOT NULL AND charged_at IS NULL').map(subagentRunOf)
  }

  /** A work's subagent turns, oldest first. */
  subagentRuns(activationId: string): BotSubagentRunRow[] {
    return this.all('SELECT * FROM bot_subagent_runs WHERE activation_id = ? ORDER BY reserved_at, rowid', activationId).map(subagentRunOf)
  }

  /** Its turn began (wall-clock milliseconds): only the first start counts. */
  markSubagentStarted(activationId: string, childRunId: string, at: number): boolean {
    return this.run('UPDATE bot_subagent_runs SET started_at = ? WHERE activation_id = ? AND child_run_id = ? AND started_at IS NULL', at, activationId, childRunId) > 0
  }

  /**
   * Its running time counted in its work's (`bot_counters.active_ms`), exactly once: the row and the counter move in one
   * transaction, and only while it is not charged. A count, never a limit. True when this call charged it.
   */
  chargeSubagentRun(activationId: string, childRunId: string, usedMs: number): boolean {
    const used = Math.max(0, Math.ceil(usedMs))
    return this.db.transaction(() => {
      if (!this.run('UPDATE bot_subagent_runs SET used_ms = ?, charged_at = ? WHERE activation_id = ? AND child_run_id = ? AND charged_at IS NULL', used, this.now(), activationId, childRunId)) return false
      this.run('UPDATE bot_counters SET active_ms = active_ms + ? WHERE activation_id = ?', used, activationId)
      return true
    })
  }

  /**
   * Its end, as its work hears it, recorded once; true when this call recorded it (a repeat is recorded already). `told`:
   * its work needs no word of it (it stopped the subagent itself).
   */
  recordSubagentDelivery(activationId: string, childRunId: string, outcome: 'done' | 'failed' | 'stopped', why: string | null, told = false): boolean {
    const now = this.now()
    // A continuation may have told the work already, before the run database handed the end over: that stays told.
    return this.run('UPDATE bot_subagent_runs SET outcome = ?, why = ?, delivered_at = ?, told_at = COALESCE(told_at, ?) WHERE activation_id = ? AND child_run_id = ? AND delivered_at IS NULL', outcome, why, now, told ? now : null, activationId, childRunId) > 0
  }

  /** A work's subagent turns that ended and were recorded, but that it has not been told of yet, oldest first. */
  untoldSubagentRuns(activationId: string): BotSubagentRunRow[] {
    return this.all('SELECT * FROM bot_subagent_runs WHERE activation_id = ? AND delivered_at IS NOT NULL AND told_at IS NULL ORDER BY delivered_at, rowid', activationId).map(subagentRunOf)
  }

  /** Its work was told these subagent turns ended (`untoldSubagentRuns`). */
  markSubagentsTold(activationId: string, childRunIds: readonly string[]): void {
    if (!childRunIds.length) return
    const now = this.now()
    this.db.transaction(() => {
      for (const childRunId of childRunIds) this.run('UPDATE bot_subagent_runs SET told_at = ? WHERE activation_id = ? AND child_run_id = ? AND told_at IS NULL', now, activationId, childRunId)
    })
  }

  // -- Dispatches ------------------------------------------------------------------------------

  dispatch(activationId: string, n: number): BotDispatchRow | undefined {
    const row = this.get('SELECT * FROM bot_dispatches WHERE activation_id = ? AND n = ?', activationId, n)
    return row ? dispatchOf(row) : undefined
  }

  dispatches(activationId: string): BotDispatchRow[] {
    return this.all('SELECT * FROM bot_dispatches WHERE activation_id = ? ORDER BY n', activationId).map(dispatchOf)
  }

  dispatchByRequest(clientRequestId: string): BotDispatchRow | undefined {
    const row = this.get('SELECT * FROM bot_dispatches WHERE client_request_id = ?', clientRequestId)
    return row ? dispatchOf(row) : undefined
  }

  dispatchByRun(runId: string): BotDispatchRow | undefined {
    const row = this.get('SELECT * FROM bot_dispatches WHERE run_id = ?', runId)
    return row ? dispatchOf(row) : undefined
  }

  /** The dispatches whose run's end is not settled yet. */
  openDispatches(): BotDispatchRow[] {
    return this.all('SELECT * FROM bot_dispatches WHERE ended_at IS NULL ORDER BY activation_id, n').map(dispatchOf)
  }

  insertDispatch(row: Pick<BotDispatchRow, 'activationId' | 'n' | 'kind' | 'clientRequestId' | 'threadId' | 'prompt' | 'policyDigest'> & { mainN?: number; send?: BotDispatchRow['send'] }): void {
    const prompt = hasWorkUpdates(row.prompt) ? { ...row.prompt, workTold: row.prompt.workTold ?? 'pending' } : row.prompt
    this.run(
      'INSERT INTO bot_dispatches(activation_id, n, kind, main_n, client_request_id, thread_id, prompt_json, policy_digest, send_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.activationId, row.n, row.kind === 'subagent' ? 'consult' : row.kind, row.mainN ?? null, row.clientRequestId, row.threadId, JSON.stringify(prompt), row.policyDigest, row.send && Object.keys(row.send).length ? JSON.stringify(row.send) : null
    )
  }

  /** The next dispatch number of an activation (main and consult dispatches share one sequence). */
  nextDispatchN(activationId: string): number {
    return Number(this.get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM bot_dispatches WHERE activation_id = ?', activationId)?.n ?? 1)
  }

  /** The activation's latest main dispatch (`start` or `continue`). */
  lastMainDispatch(activationId: string): BotDispatchRow | undefined {
    const row = this.get("SELECT * FROM bot_dispatches WHERE activation_id = ? AND kind IN ('start', 'continue') ORDER BY n DESC LIMIT 1", activationId)
    return row ? dispatchOf(row) : undefined
  }

  /** A dispatch whose time is not settled yet made a call at `at` (it only moves forward). */
  checkpointDispatch(activationId: string, n: number, at: number): void {
    this.run('UPDATE bot_dispatches SET checkpoint_at = ? WHERE activation_id = ? AND n = ? AND settled_by IS NULL AND (checkpoint_at IS NULL OR checkpoint_at < ?)', at, activationId, n, at)
  }

  setDispatchRun(activationId: string, n: number, runId: string): void {
    this.run('UPDATE bot_dispatches SET run_id = ? WHERE activation_id = ? AND n = ? AND run_id IS NULL', runId, activationId, n)
  }

  // -- Counters --------------------------------------------------------------------------------

  counters(activationId: string): BotCountersRow & { limits: Record<string, number> } {
    const row = this.get('SELECT * FROM bot_counters WHERE activation_id = ?', activationId)
    if (!row) return { requests: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, activeMs: 0, limits: {} }
    return {
      requests: num(row.requests) ?? 0,
      toolCalls: num(row.tool_calls) ?? 0,
      inputTokens: num(row.input_tokens) ?? 0,
      outputTokens: num(row.output_tokens) ?? 0,
      activeMs: num(row.active_ms) ?? 0,
      limits: JSON.parse(row.limits_json as string) as Record<string, number>
    }
  }

  /**
   * What a runtime that reserves nothing reported its requests used (Claude Code, Codex, Antigravity): `requests` more
   * model requests, and their tokens and cost, added to the activation's counters and spend. A measurement only: it
   * checks no limit and never refuses, and a runtime that counts or settles through the scopes is never mirrored here.
   */
  recordObservedUsage(activationId: string, usage: { requests: number; input: number; output: number; usdMicros?: number }): void {
    const whole = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
    const input = whole(usage.input)
    const output = whole(usage.output)
    const usd = whole(usage.usdMicros)
    const requests = whole(usage.requests)
    if (!requests && !input && !output && !usd) return
    this.db.transaction(() => {
      this.run(
        'UPDATE bot_counters SET requests = requests + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE activation_id = ?',
        requests, input, output, activationId
      )
      if (input || output || usd)
        this.run(
          'UPDATE bot_spend SET committed_input = committed_input + ?, committed_output = committed_output + ?, committed_usd_micros = committed_usd_micros + ? WHERE activation_id = ?',
          input, output, usd, activationId
        )
    })
  }

  /**
   * One Mousse app or MCP tool call a runtime that counts none itself made (Claude Code, Codex, Antigravity), added to
   * the activation's tool calls. A measurement only: it checks no limit and never refuses.
   */
  recordObservedToolCall(activationId: string): void {
    this.run('UPDATE bot_counters SET tool_calls = tool_calls + 1 WHERE activation_id = ?', activationId)
  }

  // -- Turn usage (v12): what each main turn cost and carried ----------------------------------

  /** A main dispatch began: its row, before any usage is reported. A second start of the same dispatch changes nothing. */
  startTurnUsage(row: BotTurnUsageStart): void {
    this.run(
      `INSERT INTO bot_turn_usage(activation_id, dispatch_n, bot_id, lane, started_by, instance_id, model, context_gen, fresh_context, started_at, gap_ms, system_chars, preamble_chars, prompt_chars)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(activation_id, dispatch_n) DO NOTHING`,
      row.activationId, row.dispatchN, row.botId, row.lane, row.startedBy, row.instanceId ?? null, row.model ?? null, row.contextGen,
      row.freshContext ? 1 : 0, row.startedAt, row.gapMs ?? null, row.systemChars, row.preambleChars, row.promptChars
    )
  }

  /** One usage report of the turn's runtime (a request, or a whole turn where the runtime sums them), added to its row. */
  addTurnUsage(activationId: string, n: number, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; at: number }): void {
    const whole = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
    this.run(
      `UPDATE bot_turn_usage SET reports = reports + 1, input = input + ?, output = output + ?, cache_read = cache_read + ?, cache_write = cache_write + ?,
         last_request_at = MAX(COALESCE(last_request_at, 0), ?) WHERE activation_id = ? AND dispatch_n = ?`,
      whole(usage.input), whole(usage.output), whole(usage.cacheRead), whole(usage.cacheWrite), usage.at, activationId, n
    )
  }

  /**
   * What the runtime said of its context at the end of a request or turn: the prompt it last sent (input, cache read and
   * cache write together), its window, the cache lifetime it wrote, the model it really ran and the plan's usage windows.
   */
  turnContext(activationId: string, n: number, context: { lastPrompt?: number; contextWindow?: number; cacheTtlMs?: number; at?: number; model?: string; quota?: readonly BotQuotaWindow[] }): void {
    const positive = (value: number | undefined): number | null => (value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : null)
    const at = positive(context.at)
    this.run(
      `UPDATE bot_turn_usage SET last_prompt = COALESCE(?, last_prompt), context_window = COALESCE(?, context_window), cache_ttl_ms = COALESCE(?, cache_ttl_ms),
         last_request_at = CASE WHEN ? IS NULL THEN last_request_at ELSE MAX(COALESCE(last_request_at, 0), ?) END, model = COALESCE(?, model), quota_json = COALESCE(?, quota_json)
       WHERE activation_id = ? AND dispatch_n = ?`,
      positive(context.lastPrompt), positive(context.contextWindow), positive(context.cacheTtlMs), at, at,
      context.model ?? null, context.quota?.length ? JSON.stringify(context.quota) : null, activationId, n
    )
  }

  /** The Mousse tools the turn's runtime was offered: how many, and the characters of their names, descriptions and schemas. */
  turnTools(activationId: string, n: number, tools: number, chars: number): void {
    this.run('UPDATE bot_turn_usage SET tools = ?, tools_chars = ? WHERE activation_id = ? AND dispatch_n = ? AND tools IS NULL', tools, chars, activationId, n)
  }

  // -- Jobs (v13): the ledger of work a bot handed to its owner's threads ----------------------

  /**
   * A job handed to `threadId`. A thread that still works on an earlier job of the same bot takes the new message as
   * part of it: that row is kept (and touched), and no second one opens. A follow-up the bot did not hand off (no
   * turn: `activationId` empty, opened when the thread worked again) becomes this hand-off: its turn, request and asker
   * are this one's. Returns the job's row.
   */
  openJob(row: Pick<BotJob, 'id' | 'botId' | 'activationId' | 'threadId' | 'title' | 'request' | 'askedBy'> & { project?: string }): BotJob {
    return this.db.transaction(() => {
      const open = this.get('SELECT * FROM bot_jobs WHERE bot_id = ? AND thread_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', row.botId, row.threadId)
      const now = this.now()
      if (open && String(open.activation_id) === '' && row.activationId) {
        this.run('UPDATE bot_jobs SET updated_at = ?, title = ?, activation_id = ?, request = ?, asked_by = ? WHERE id = ?', now, row.title, row.activationId, row.request, row.askedBy, String(open.id))
        return this.job(String(open.id))!
      }
      if (open) {
        this.run('UPDATE bot_jobs SET updated_at = ?, title = ? WHERE id = ?', now, row.title, String(open.id))
        return jobOf({ ...open, updated_at: now, title: row.title })
      }
      this.run(
        `INSERT INTO bot_jobs(id, bot_id, activation_id, thread_id, title, project, request, asked_by, state, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        row.id, row.botId, row.activationId, row.threadId, row.title, row.project ?? null, row.request, row.askedBy, now, now
      )
      return this.job(row.id)!
    })
  }

  job(id: string): BotJob | undefined {
    const row = this.get('SELECT * FROM bot_jobs WHERE id = ?', id)
    return row ? jobOf(row) : undefined
  }

  /** The bot's jobs whose thread still works or waits for a person, oldest first. */
  openJobsOf(botId: string): BotJob[] {
    return this.all("SELECT * FROM bot_jobs WHERE bot_id = ? AND ended_at IS NULL AND state IN ('running', 'needs_input') ORDER BY created_at, rowid", botId).map(jobOf)
  }

  /** The jobs not ended on `threadId`, of any bot. */
  openJobsOn(threadId: string): BotJob[] {
    return this.all('SELECT * FROM bot_jobs WHERE thread_id = ? AND ended_at IS NULL ORDER BY created_at', threadId).map(jobOf)
  }

  /** The bot's newest job on `threadId`, ended or not. */
  latestJobOn(botId: string, threadId: string): BotJob | undefined {
    const row = this.get('SELECT * FROM bot_jobs WHERE bot_id = ? AND thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', botId, threadId)
    return row ? jobOf(row) : undefined
  }

  /** Every job not ended, oldest first: what the startup pass checks. */
  openJobs(limit = 500): BotJob[] {
    return this.all('SELECT * FROM bot_jobs WHERE ended_at IS NULL ORDER BY created_at LIMIT ?', limit).map(jobOf)
  }

  /** The bot's newest jobs, by when they last changed; `since`: only those changed after it. */
  recentJobs(botId: string, limit: number, since?: string): BotJob[] {
    return (since
      ? this.all('SELECT * FROM bot_jobs WHERE bot_id = ? AND updated_at > ? ORDER BY updated_at DESC, created_at DESC LIMIT ?', botId, since, limit)
      : this.all('SELECT * FROM bot_jobs WHERE bot_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?', botId, limit)).map(jobOf)
  }

  /**
   * The job moved from `from` to `state` (with its result line, when it has one); false when it was not in `from` any
   * more (another pass moved it first). An ending state keeps its end time; a notice is counted with `notice`.
   */
  moveJob(id: string, from: BotJobState, state: BotJobState, change: { line?: string; notice?: boolean } = {}): boolean {
    const now = this.now()
    return this.run(
      `UPDATE bot_jobs SET state = ?, line = COALESCE(?, line), updated_at = ?, ended_at = ?, notices = notices + ? WHERE id = ? AND state = ? AND ended_at IS NULL`,
      state, change.line ?? null, now, BOT_JOB_ENDED.has(state) ? now : null, change.notice ? 1 : 0, id, from
    ) > 0
  }

  /** The runtime compacted the turn's context. */
  turnCompacted(activationId: string, n: number): void {
    this.run('UPDATE bot_turn_usage SET compactions = compactions + 1 WHERE activation_id = ? AND dispatch_n = ?', activationId, n)
  }

  turnUsage(activationId: string, n: number): BotTurnUsageRow | undefined {
    const row = this.get('SELECT * FROM bot_turn_usage WHERE activation_id = ? AND dispatch_n = ?', activationId, n)
    return row ? turnUsageOf(row) : undefined
  }

  /** The bot's latest turn in `lane` that reached its model, other than `except` (the turn now starting). */
  lastTurnUsage(botId: string, lane: BotLane, except?: { activationId: string; n: number }): BotTurnUsageRow | undefined {
    const row = this.get(
      `SELECT * FROM bot_turn_usage WHERE bot_id = ? AND lane = ? AND last_request_at IS NOT NULL AND NOT (activation_id = ? AND dispatch_n = ?)
       ORDER BY last_request_at DESC LIMIT 1`,
      botId, lane, except?.activationId ?? '', except?.n ?? -1
    )
    return row ? turnUsageOf(row) : undefined
  }

  /** The bot's turns in `lane` that ran in the runtime context `contextGen` (a chat epoch), oldest first. */
  turnUsageOfContext(botId: string, lane: BotLane, contextGen: string): BotTurnUsageRow[] {
    return this.all('SELECT * FROM bot_turn_usage WHERE bot_id = ? AND lane = ? AND context_gen = ? ORDER BY started_at, dispatch_n', botId, lane, contextGen).map(turnUsageOf)
  }

  /** The bot's turns in `lane` since `since` (ms) that reported usage, oldest first. */
  turnUsageSince(botId: string, lane: BotLane, since: number): BotTurnUsageRow[] {
    return this.all('SELECT * FROM bot_turn_usage WHERE bot_id = ? AND lane = ? AND started_at >= ? AND reports > 0 ORDER BY started_at', botId, lane, since).map(turnUsageOf)
  }

  // -- Unknown calls ---------------------------------------------------------------------------

  unknownCalls(activationId: string): Array<{ runId: string; invocationId: string; tool: string; role: 'main' | 'consult'; acknowledged: boolean }> {
    return this.all('SELECT * FROM bot_unknown_calls WHERE activation_id = ? ORDER BY found_at, invocation_id', activationId).map((row) => ({
      runId: row.run_id as string,
      invocationId: row.invocation_id as string,
      tool: row.tool as string,
      role: row.role as 'main' | 'consult',
      acknowledged: row.acknowledged_at !== null
    }))
  }

  putUnknownCall(input: { activationId: string; runId: string; invocationId: string; tool: string; role: 'main' | 'consult' }): number {
    return this.run(
      'INSERT INTO bot_unknown_calls(activation_id, run_id, invocation_id, tool, role, found_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(activation_id, invocation_id) DO NOTHING',
      input.activationId, input.runId, input.invocationId, input.tool, input.role, this.now()
    )
  }

  dropUnknownCall(activationId: string, invocationId: string): number {
    return this.run('DELETE FROM bot_unknown_calls WHERE activation_id = ? AND invocation_id = ?', activationId, invocationId)
  }

  /** Acknowledges exactly the calls named (the ones the owner was shown). */
  acknowledgeUnknownCalls(activationId: string, invocationIds: readonly string[]): number {
    let changed = 0
    for (const id of invocationIds)
      changed += this.run('UPDATE bot_unknown_calls SET acknowledged_at = ? WHERE activation_id = ? AND invocation_id = ? AND acknowledged_at IS NULL', this.now(), activationId, id)
    return changed
  }

  // -- Escalations -----------------------------------------------------------------------------

  escalation(id: string): BotEscalationRow | undefined {
    const row = this.get('SELECT * FROM bot_escalations WHERE id = ?', id)
    return row ? escalationOf(row) : undefined
  }

  escalations(filter: { activationId?: string; status?: BotEscalationStatus; botId?: string } = {}): BotEscalationRow[] {
    const where: string[] = []
    const params: Param[] = []
    if (filter.activationId) { where.push('activation_id = ?'); params.push(filter.activationId) }
    if (filter.botId) { where.push('bot_id = ?'); params.push(filter.botId) }
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    // Asks raised in the same millisecond keep the order they were raised in.
    return this.all(`SELECT * FROM bot_escalations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`, ...params).map(escalationOf)
  }

  /**
   * The bot's Not nows to a fingerprint since the owner last allowed it, newest first: the asks the repeat guard reads.
   * Only those answered since the owner last wrote (`ownerLastWroteAt`; all of them when they never have): an older one
   * holds nothing, however few or many came after it.
   */
  deniedSinceAllowed(botId: string, fingerprint: string): BotEscalationRow[] {
    const rows = this.all("SELECT * FROM bot_escalations WHERE bot_id = ? AND fingerprint = ? AND status IN ('allowed_bot', 'allowed_once', 'denied') AND answered_at IS NOT NULL AND answered_at >= ? ORDER BY answered_at DESC, rowid DESC", botId, fingerprint, this.ownerLastWroteAt(botId)).map(escalationOf)
    const allowed = rows.findIndex((row) => row.status !== 'denied')
    return allowed < 0 ? rows : rows.slice(0, allowed)
  }

  /**
   * Writes an open ask; false when the bot already has an open ask with this fingerprint (there is
   * at most one per permission).
   */
  insertEscalation(row: Omit<BotEscalationRow, 'status' | 'amount' | 'answeredAt' | 'appliedAt' | 'cooldownUntil'>): boolean {
    return this.run(
      "INSERT INTO bot_escalations(id, bot_id, activation_id, dispatch_n, tool_call_id, kind, permission_json, reason, status, created_at, expires_at, mode, fingerprint, title, note, message_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      row.id, row.botId, row.activationId, row.dispatchN, row.toolCallId, row.kind, JSON.stringify(row.permission), row.reason, row.createdAt, row.expiresAt, row.mode, row.fingerprint, row.title, row.note, row.messageId
    ) > 0
  }

  /** The bot's open ask for a fingerprint, if any. */
  openAsk(botId: string, fingerprint: string): BotEscalationRow | undefined {
    const row = this.get("SELECT * FROM bot_escalations WHERE bot_id = ? AND fingerprint = ? AND status = 'open'", botId, fingerprint)
    return row ? escalationOf(row) : undefined
  }

  /** A Not now on a run ask whose cooldown has not passed at `now`, if any. */
  coolingAsk(botId: string, fingerprint: string, now: string): BotEscalationRow | undefined {
    const row = this.get("SELECT * FROM bot_escalations WHERE bot_id = ? AND fingerprint = ? AND status = 'denied' AND cooldown_until > ? ORDER BY cooldown_until DESC LIMIT 1", botId, fingerprint, now)
    return row ? escalationOf(row) : undefined
  }

  /** The last ask the owner allowed for a fingerprint (About's "granted at"). */
  allowedAsk(botId: string, fingerprint: string): BotEscalationRow | undefined {
    const row = this.get("SELECT * FROM bot_escalations WHERE bot_id = ? AND fingerprint = ? AND status IN ('allowed_bot', 'allowed_once') ORDER BY answered_at DESC LIMIT 1", botId, fingerprint)
    return row ? escalationOf(row) : undefined
  }

  /** A chat turn takes over a run's open ask as its wall: the card it already has stays the same ask. */
  moveAskToWall(id: string, activationId: string, dispatchN: number): void {
    this.run("UPDATE bot_escalations SET activation_id = ?, dispatch_n = ?, mode = 'wall', applied_at = NULL WHERE id = ? AND status = 'open'", activationId, dispatchN, id)
  }

  /** Work that ran out of room takes over the bot's open ask for that limit (a run's ask): its answer goes on with it. */
  moveAsk(id: string, activationId: string, dispatchN: number): void {
    this.run("UPDATE bot_escalations SET activation_id = ?, dispatch_n = ? WHERE id = ? AND status = 'open' AND mode = 'ask'", activationId, dispatchN, id)
  }

  setEscalationMessage(id: string, messageId: string): void {
    this.run('UPDATE bot_escalations SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, id)
  }

  /**
   * An ask in its current form (an older build's folder ask worded as the one file ask): what it
   * asks for, its fingerprint and its card's words. Only one open ask may hold a fingerprint.
   */
  reword(id: string, ask: { permission: BotAskRequest; fingerprint: string; title: string; note: string }): boolean {
    return this.run('UPDATE bot_escalations SET permission_json = ?, fingerprint = ?, title = ?, note = ? WHERE id = ?', JSON.stringify(ask.permission), ask.fingerprint, ask.title, ask.note, id) > 0
  }

  /**
   * Compare-and-set from `open`: false when it was already answered, expired or cancelled. A Not now keeps where the
   * owner had last written then, the grant it was said under and `given`, the key of what that grant gave (`denialOf`),
   * so a repeat of the ask is told apart from one they wrote about, or one under a grant that gives something else.
   */
  answerEscalation(id: string, status: Exclude<BotEscalationStatus, 'open'>, amount?: number, cooldownUntil?: string, given?: string): boolean {
    const moved = this.run("UPDATE bot_escalations SET status = ?, amount = ?, answered_at = ?, cooldown_until = ? WHERE id = ? AND status = 'open'", status, amount ?? null, this.now(), cooldownUntil ?? null, id) > 0
    const botId = moved && status === 'denied' ? this.get('SELECT bot_id FROM bot_escalations WHERE id = ?', id)?.bot_id : undefined
    if (typeof botId === 'string') {
      const denial = { seq: this.ownerLastWroteSeq(botId), grant: this.activeGrant(botId)?.digest ?? '', ...(given !== undefined ? { given } : {}) }
      this.run('INSERT OR REPLACE INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?)', botId, `ask-denied:${id}`, JSON.stringify(denial))
    }
    return moved
  }

  /**
   * Ends every open wall of an activation (it ended, expired, or was trashed). A run's asks stay
   * open for the owner, and so does one a chat turn took over from a run (its card was posted
   * elsewhere): it goes back to being a run's ask.
   */
  closeEscalations(activationId: string, status: 'expired' | 'cancelled'): number {
    this.run(
      "UPDATE bot_escalations SET mode = 'ask' WHERE activation_id = ? AND status = 'open' AND mode = 'wall' AND EXISTS (SELECT 1 FROM bot_messages m WHERE m.ask_id = bot_escalations.id AND (m.activation_id IS NULL OR m.activation_id <> bot_escalations.activation_id))",
      activationId
    )
    return this.run("UPDATE bot_escalations SET status = ?, answered_at = ? WHERE activation_id = ? AND status = 'open' AND mode = 'wall'", status, this.now(), activationId)
  }

  /** Withdraws an activation's open asks (its work ended under a grant that is gone). */
  withdrawActivationAsks(activationId: string): number {
    return this.run("UPDATE bot_escalations SET status = 'withdrawn', answered_at = ? WHERE activation_id = ? AND status = 'open'", this.now(), activationId)
  }

  /** Withdraws every open ask of a bot (it was deleted). */
  withdrawAsks(botId: string): number {
    return this.run("UPDATE bot_escalations SET status = 'withdrawn', answered_at = ? WHERE bot_id = ? AND status = 'open'", this.now(), botId)
  }

  /** The bot's open asks, oldest first. */
  openAsks(botId: string): BotEscalationRow[] {
    return this.escalations({ botId, status: 'open' })
  }

  /** The answered escalation whose continuation has not been applied yet. */
  pendingAnswer(activationId: string): BotEscalationRow | undefined {
    const row = this.get("SELECT * FROM bot_escalations WHERE activation_id = ? AND mode = 'wall' AND (status IN ('allowed_bot', 'allowed_once', 'denied') OR (status = 'withdrawn' AND json_extract(permission_json, '$.ask') = 'let_alone')) AND applied_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1", activationId)
    return row ? escalationOf(row) : undefined
  }

  /** Every answered wall of an activation whose continuation has not been applied yet, oldest first. */
  pendingAnswers(activationId: string): BotEscalationRow[] {
    return this.all("SELECT * FROM bot_escalations WHERE activation_id = ? AND mode = 'wall' AND (status IN ('allowed_bot', 'allowed_once', 'denied') OR (status = 'withdrawn' AND json_extract(permission_json, '$.ask') = 'let_alone')) AND applied_at IS NULL ORDER BY created_at, rowid", activationId).map(escalationOf)
  }

  markApplied(id: string): void {
    this.run('UPDATE bot_escalations SET applied_at = ? WHERE id = ? AND applied_at IS NULL', this.now(), id)
  }

  // -- Overlays and context generations --------------------------------------------------------

  overlays(activationId: string): Array<{ permission: BotPermissionRequest; amount: number | null }> {
    return this.all('SELECT * FROM bot_overlays WHERE activation_id = ? ORDER BY created_at, escalation_id', activationId).map((row) => ({
      permission: JSON.parse(row.permission_json as string) as BotPermissionRequest,
      amount: num(row.amount)
    }))
  }

  putOverlay(activationId: string, escalationId: string, permission: BotAskRequest, amount?: number): void {
    this.run(
      'INSERT INTO bot_overlays(activation_id, escalation_id, permission_json, amount, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      activationId, escalationId, JSON.stringify(permission), amount ?? null, this.now()
    )
  }

  contextGen(botId: string, key: string): number {
    return num(this.get('SELECT gen FROM bot_contexts WHERE bot_id = ? AND key = ?', botId, key)?.gen) ?? 1
  }

  bumpContextGen(botId: string, key: string): number {
    const next = this.contextGen(botId, key) + 1
    this.run('INSERT INTO bot_contexts(bot_id, key, gen) VALUES(?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET gen = excluded.gen', botId, key, next)
    return next
  }

  allThreads(): Array<{ threadId: string; botId: string; role: 'home' | BotThreadRole; key: string; activationId: string | null }> {
    return this.all('SELECT * FROM bot_threads').map((row) => ({ threadId: row.thread_id as string, botId: row.bot_id as string, role: roleOfRow(row), key: row.key as string, activationId: str(row.activation_id) }))
  }

  /**
   * The threads capture copies at startup (bot-context.md §4): those of bots not deleted (a
   * deleted bot's memory is not added to, and a purge may have removed it), each with the
   * activation and lane of the latest dispatch that ran on it (a home or context thread serves many).
   */
  captureThreads(): Array<{ threadId: string; botId: string; role: 'home' | BotThreadRole; activationId: string | null; lastActivation: { id: string; lane: BotLane } | null }> {
    return this.all(`SELECT t.*, a.id AS last_id, a.lane AS last_lane FROM bot_threads t
      JOIN bot_registry r ON r.bot_id = t.bot_id AND r.deleted_at IS NULL
      LEFT JOIN bot_activations a ON a.id = (SELECT d.activation_id FROM bot_dispatches d WHERE d.thread_id = t.thread_id ORDER BY d.rowid DESC LIMIT 1)`)
      .map((row) => ({
        threadId: row.thread_id as string,
        botId: row.bot_id as string,
        role: roleOfRow(row),
        activationId: str(row.activation_id),
        lastActivation: typeof row.last_id === 'string' ? { id: row.last_id, lane: row.last_lane === 'chat' ? 'chat' : 'run' } : null
      }))
  }

  dropThread(threadId: string): void {
    this.run('DELETE FROM bot_threads WHERE thread_id = ?', threadId)
  }

  /**
   * Forgets a context thread that went to the trash or is gone, and moves its key to the next
   * generation, in one transaction: a crash never loses the bump.
   */
  retireContextThread(threadId: string): void {
    this.db.transaction(() => {
      const row = this.get("SELECT bot_id, key FROM bot_threads WHERE thread_id = ? AND role = 'context'", threadId)
      if (!row) return
      const stored = row.key as string
      const at = stored.lastIndexOf(':')
      const key = at > 0 ? stored.slice(0, at) : stored
      const gen = at > 0 ? Number(stored.slice(at + 1)) || 1 : 1
      if (this.contextGen(row.bot_id as string, key) <= gen)
        this.run('INSERT INTO bot_contexts(bot_id, key, gen) VALUES(?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET gen = excluded.gen', row.bot_id as string, key, gen + 1)
      this.run('DELETE FROM bot_threads WHERE thread_id = ?', threadId)
    })
  }

  /** Every activation in `statuses`, oldest first. */
  activationsWith(statuses: readonly BotActivationStatus[]): BotActivationRow[] {
    const marks = statuses.map(() => '?').join(', ')
    return this.all(`SELECT * FROM bot_activations WHERE status IN (${marks}) ORDER BY created_at, id`, ...statuses).map(activationOf)
  }

  // -- Schedules (6d; moved to the shared store in v5) ---------------------------------------------

  /** When each schedule ran next, as the old bot scheduler kept it: the move keeps these times. */
  scheduleStates(botId: string): Array<{ scheduleId: string; spec: string; nextRunAt: string | null; lastSkipAt: string | null; lastSkipReason: string | null }> {
    return this.all('SELECT * FROM bot_schedule_state WHERE bot_id = ? ORDER BY schedule_id', botId).map((row) => ({
      scheduleId: row.schedule_id as string,
      spec: row.spec_json as string,
      nextRunAt: str(row.next_run_at),
      lastSkipAt: str(row.last_skip_at),
      lastSkipReason: str(row.last_skip_reason)
    }))
  }

  /**
   * Inserts an activation unless its idempotency key exists already; true when it was inserted.
   * A repeated schedule occurrence only finds the activation it made before.
   */
  insertActivationOnce(row: Parameters<BotStore['insertActivation']>[0], limits: ActivationLimits, start: { provenance?: BotActivationProvenance } = {}): boolean {
    const inserted = this.run(
      'INSERT OR IGNORE INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, lane, provenance) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.botId, row.revision, row.grantDigest, JSON.stringify(row.trigger), row.idempotencyKey, row.status, row.createdAt, row.lane ?? 'run', provenanceToWrite(row, start.provenance)
    )
    if (!inserted) return false
    this.run('INSERT INTO bot_counters(activation_id, limits_json) VALUES(?, ?)', row.id, JSON.stringify(limits))
    this.run('INSERT INTO bot_spend(activation_id) VALUES(?)', row.id)
    return true
  }

  setAutoRestarts(id: string, count: number): void {
    this.run('UPDATE bot_activations SET auto_restarts = ? WHERE id = ?', count, id)
  }

  setLimits(activationId: string, limits: ActivationLimits): void {
    this.run('UPDATE bot_counters SET limits_json = ? WHERE activation_id = ?', JSON.stringify(limits), activationId)
  }

  /**
   * Moves a bot's unfinished activations from one grant to its wider successor ("Allow for this bot"); with `only`, just
   * that activation, and the others on the old grant stay where they are.
   */
  regrant(botId: string, fromDigest: string, toDigest: string, revision: string, only?: string): void {
    // Their dispatches that have not started move too: `prepare` checks the dispatch's digest.
    this.run(`UPDATE bot_dispatches SET policy_digest = ? WHERE policy_digest = ? AND started_at IS NULL AND activation_id IN
      (SELECT id FROM bot_activations WHERE bot_id = ? AND grant_digest = ? AND status NOT IN ('done', 'failed', 'cancelled') AND (? IS NULL OR id = ?))`, toDigest, fromDigest, botId, fromDigest, only ?? null, only ?? null)
    this.run("UPDATE bot_activations SET grant_digest = ?, revision = ? WHERE bot_id = ? AND grant_digest = ? AND status NOT IN ('done', 'failed', 'cancelled') AND (? IS NULL OR id = ?)", toDigest, revision, botId, fromDigest, only ?? null, only ?? null)
    this.changedLaunch(botId)
  }

  // -- Chat (bot_messages) ----------------------------------------------------------------------

  /**
   * Inserts a chat row; inside the caller's transaction, so its journal row joins it. False when a
   * row with the same id or client request id exists already.
   */
  insertMessage(row: Omit<BotMessageRow, 'seq' | 'tell' | 'tellAt' | 'toldAt'>): boolean {
    return this.run(
      'INSERT INTO bot_messages(id, bot_id, at, author, kind, text, chips_json, ask_id, error_json, activation_id, attachments_json, client_request_id, reply_to, question_id, cards_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      row.id, row.botId, row.at, row.author, row.kind, row.text, JSON.stringify(row.chips), row.askId, row.error ? JSON.stringify(row.error) : null,
      row.activationId, row.attachments ? JSON.stringify(row.attachments) : null, row.clientRequestId, row.replyTo ?? null, row.questionId ?? null,
      row.cards?.length ? JSON.stringify(row.cards) : null
    ) > 0
  }

  message(id: string): BotMessageRow | undefined {
    const row = this.get('SELECT * FROM bot_messages WHERE id = ?', id)
    return row ? messageOf(row) : undefined
  }

  /** Sets the owner's reaction on a message (one per message: a new one replaces it), or removes it (`null`). */
  setOwnerReaction(messageId: string, emoji: string | null, at: string): boolean {
    return this.run('UPDATE bot_messages SET owner_reaction = ?, owner_reaction_at = ? WHERE id = ?', emoji, emoji === null ? null : at, messageId) > 0
  }

  /**
   * The bot's messages the owner reacted to after `since` (all without it), oldest reaction first, at most `limit`: the
   * oldest, so the reactions one turn could not take are the next turn's.
   */
  reactionsSince(botId: string, since: string | undefined, limit: number): BotMessageRow[] {
    const rows = since === undefined
      ? this.all('SELECT * FROM bot_messages WHERE bot_id = ? AND owner_reaction IS NOT NULL ORDER BY owner_reaction_at, seq LIMIT ?', botId, limit)
      : this.all('SELECT * FROM bot_messages WHERE bot_id = ? AND owner_reaction IS NOT NULL AND owner_reaction_at > ? ORDER BY owner_reaction_at, seq LIMIT ?', botId, since, limit)
    return rows.map(messageOf)
  }

  messageByRequest(clientRequestId: string): BotMessageRow | undefined {
    const row = this.get('SELECT * FROM bot_messages WHERE client_request_id = ?', clientRequestId)
    return row ? messageOf(row) : undefined
  }

  /** The newest message carrying an ask's card. */
  messageForAsk(askId: string): BotMessageRow | undefined {
    const row = this.get('SELECT * FROM bot_messages WHERE ask_id = ? ORDER BY seq DESC LIMIT 1', askId)
    return row ? messageOf(row) : undefined
  }

  /** Every message carrying an ask's card, oldest first. */
  messagesForAsk(askId: string): BotMessageRow[] {
    return this.all('SELECT * FROM bot_messages WHERE ask_id = ? ORDER BY seq', askId).map(messageOf)
  }

  /** A page of a bot's chat, oldest first: the `limit` rows before `beforeSeq` (the newest without it). */
  messages(botId: string, options: { beforeSeq?: number; limit: number }): BotMessageRow[] {
    const rows = options.beforeSeq === undefined
      ? this.all(`SELECT * FROM bot_messages WHERE bot_id = ? AND ${SHOWN_MESSAGE} ORDER BY seq DESC LIMIT ?`, botId, options.limit)
      : this.all(`SELECT * FROM bot_messages WHERE bot_id = ? AND seq < ? AND ${SHOWN_MESSAGE} ORDER BY seq DESC LIMIT ?`, botId, options.beforeSeq, options.limit)
    return rows.map(messageOf).reverse()
  }

  lastMessage(botId: string): BotMessageRow | undefined {
    const row = this.get(`SELECT * FROM bot_messages WHERE bot_id = ? AND ${SHOWN_MESSAGE} ORDER BY seq DESC LIMIT 1`, botId)
    return row ? messageOf(row) : undefined
  }

  /** The bot's latest message with text, for the preview of its row in the Bots list. */
  lastBotReply(botId: string): BotMessageRow | undefined {
    const row = this.get(`SELECT * FROM bot_messages WHERE bot_id = ? AND author = 'bot' AND COALESCE(text, '') != '' AND ${SHOWN_MESSAGE} ORDER BY seq DESC LIMIT 1`, botId)
    return row ? messageOf(row) : undefined
  }

  /** The bot's messages after the owner's read marker. */
  unread(botId: string, readSeq: number): number {
    return Number(this.get(`SELECT COUNT(*) AS n FROM bot_messages WHERE bot_id = ? AND author = 'bot' AND seq > ? AND ${SHOWN_MESSAGE}`, botId, readSeq)?.n ?? 0)
  }

  /** The 30-day purge: every row of a bot's asks, activations (with their dispatches, counts and spend), grants and context generations. */
  deleteBotRows(botId: string): void {
    for (const row of this.all('SELECT id FROM bot_activations WHERE bot_id = ?', botId)) {
      this.run('DELETE FROM bot_overlays WHERE activation_id = ?', row.id as string)
      this.deleteActivation(row.id as string)
    }
    this.run('DELETE FROM bot_escalations WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_grants WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_contexts WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_reminders WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_work_notes WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_questions WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_actions WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_jobs WHERE bot_id = ?', botId)
    this.run('UPDATE bot_registry SET model_json = NULL, error_json = NULL WHERE bot_id = ?', botId)
  }

  // -- Questions (bot_questions, v8): a bot's questions to its owner, with answers to tap --------------------------

  /** A new open question; its follow-up is timed once its bubble is shown (`setQuestionMessage`). */
  insertQuestion(row: Pick<BotQuestionRow, 'id' | 'botId' | 'activationId' | 'dispatchN' | 'lane' | 'spec' | 'createdAt'> & { follow?: BotQuestionFollow }): void {
    this.run(
      "INSERT INTO bot_questions(id, bot_id, activation_id, dispatch_n, lane, spec_json, follow_json, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      row.id, row.botId, row.activationId, row.dispatchN, row.lane, JSON.stringify(row.spec), JSON.stringify(row.follow ?? {}), row.createdAt
    )
  }

  question(id: string): BotQuestionRow | undefined {
    const row = this.get('SELECT * FROM bot_questions WHERE id = ?', id)
    return row ? questionOf(row) : undefined
  }

  /** An activation's questions, in the order it asked them. */
  activationQuestions(activationId: string): BotQuestionRow[] {
    return this.all('SELECT * FROM bot_questions WHERE activation_id = ? ORDER BY created_at, rowid', activationId).map(questionOf)
  }

  /**
   * How many questions a bot asked: in one activation, or since a time. One withdrawn before it was shown (its turn
   * stopped at a wall, and its continuation asks it again) is not counted.
   */
  countQuestions(botId: string, input: { activationId?: string; since?: string }): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM bot_questions WHERE bot_id = ? AND (? IS NULL OR activation_id = ?) AND created_at >= ? AND NOT (status = 'withdrawn' AND message_id IS NULL)",
      botId, input.activationId ?? null, input.activationId ?? null, input.since ?? '')?.n ?? 0)
  }

  /** How many of a bot's questions are open (a chat turn's still waiting for its reply included). */
  countOpenQuestions(botId: string): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM bot_questions WHERE bot_id = ? AND status = 'open'", botId)?.n ?? 0)
  }

  /** The bot's chat questions that are open and shown (their bubble is posted), oldest first. */
  openChatQuestions(botId: string): BotQuestionRow[] {
    return this.all("SELECT * FROM bot_questions WHERE bot_id = ? AND lane = 'chat' AND status = 'open' AND message_id IS NOT NULL ORDER BY created_at, rowid", botId).map(questionOf)
  }

  /** The bubble carrying a question is posted; `nextAt`: when its first follow-up is due (null: none). */
  setQuestionMessage(id: string, messageId: string, nextAt: string | null = null): void {
    this.run("UPDATE bot_questions SET message_id = ?, next_at = CASE WHEN status = 'open' THEN ? END WHERE id = ? AND message_id IS NULL", messageId, nextAt, id)
  }

  /** Every bot's open questions whose next follow-up is due at or before `at`, soonest first. */
  dueQuestions(at: string): BotQuestionRow[] {
    return this.all("SELECT * FROM bot_questions WHERE status = 'open' AND next_at IS NOT NULL AND next_at <= ? AND message_id IS NOT NULL ORDER BY next_at, rowid", at).map(questionOf)
  }

  /** The open question of any bot whose follow-up is due soonest. */
  nextQuestionDue(botId?: string): BotQuestionRow | undefined {
    const row = this.get(`SELECT * FROM bot_questions WHERE status = 'open' AND next_at IS NOT NULL AND message_id IS NOT NULL
      AND bot_id IN (SELECT bot_id FROM bot_registry WHERE deleted_at IS NULL)
      ${botId === undefined ? '' : 'AND bot_id = ?'} ORDER BY next_at, rowid LIMIT 1`, ...(botId === undefined ? [] : [botId]))
    return row ? questionOf(row) : undefined
  }

  /** An open question's follow-up moves to `nextAt` (the nudge budget, an owner's turn running); false when it is not open. */
  setQuestionNext(id: string, nextAt: string | null): boolean {
    return this.run("UPDATE bot_questions SET next_at = ? WHERE id = ? AND status = 'open'", nextAt, id) > 0
  }

  /** A nudge for an open question was posted, its `nudges`th (compare-and-set on the count before); `nextAt` the next one's time, or null. */
  recordNudge(id: string, nudges: number, nextAt: string | null): boolean {
    return this.run("UPDATE bot_questions SET nudges = ?, next_at = ? WHERE id = ? AND status = 'open' AND nudges = ?", nudges, nextAt, id, nudges - 1) > 0
  }

  /** When a bot's nudges were posted (its rows that carry a question and are not its bubble), since `since`. */
  nudgeTimes(botId: string, since: string): string[] {
    return this.all(`SELECT m.at FROM bot_messages m JOIN bot_questions q ON q.id = m.question_id
      WHERE m.bot_id = ? AND m.author = 'bot' AND m.id <> q.message_id AND m.at > ? ORDER BY m.at`, botId, since).map((row) => row.at as string)
  }

  /** Compare-and-set of an open question to `defaulted`: nobody answered in time, and the bot goes with its own default. */
  defaultQuestion(id: string, answer: BotQuestionAnswer): boolean {
    return this.run("UPDATE bot_questions SET status = 'defaulted', answer_json = ?, answered_at = ?, next_at = NULL WHERE id = ? AND status = 'open'", JSON.stringify(answer), this.now(), id) > 0
  }

  /**
   * The owner answered a question the bot had gone ahead on with its default (`late`, once): kept with the default, and
   * their message as the one that answered it, so Forget reaches it. False when it is not defaulted or already has one.
   */
  lateAnswer(id: string, late: BotQuestionLateAnswer, messageId: string): boolean {
    return this.run("UPDATE bot_questions SET answer_json = json_set(answer_json, '$.late', json(?)), answer_message = ? WHERE id = ? AND status = 'defaulted' AND json_extract(answer_json, '$.late') IS NULL",
      JSON.stringify(late), messageId, id) > 0
  }

  /**
   * A chat turn was told `line`, which quotes the question (an owner's late answer to its default): kept with the answer,
   * so forgetting the bubble finds that copy in that turn's request, prompts and captured rows.
   */
  recordQuestionCopy(questionId: string, activationId: string, line: string): void {
    this.run(`UPDATE bot_questions SET answer_json = json_set(answer_json, '$.copies',
      json_insert(COALESCE(json_extract(answer_json, '$.copies'), '[]'), '$[#]', json_object('activationId', ?, 'line', ?))) WHERE id = ? AND answer_json IS NOT NULL`, activationId, line, questionId)
  }

  /**
   * The chat's turn for a question's default was queued with `line` as its input: kept with the answer, as work's
   * answer line is (`markAnswerSent`), so forgetting the bubble finds that copy in that turn.
   */
  markDefaultSent(questionId: string, activationId: string, line: string): void {
    this.run("UPDATE bot_questions SET answer_json = json_set(answer_json, '$.sent', json_object('activationId', ?, 'line', ?)) WHERE id = ? AND status = 'defaulted'", activationId, line, questionId)
  }

  /** Every message about a question: its bubble, and the owner's message that answered it. */
  messagesForQuestion(questionId: string): BotMessageRow[] {
    return this.all('SELECT * FROM bot_messages WHERE question_id = ? ORDER BY seq', questionId).map(messageOf)
  }

  /**
   * Compare-and-set of a question to `answered` from `from` (open, or moved on: its buttons still answer it), with the
   * owner's message that answered it; false when it was in neither (answered meanwhile, or withdrawn).
   */
  answerQuestion(id: string, answer: BotQuestionAnswer, messageId: string, from: readonly BotQuestionStatus[] = ['open', 'moved_on']): boolean {
    const marks = from.map(() => '?').join(', ')
    return this.run(`UPDATE bot_questions SET status = 'answered', answer_json = ?, answer_message = ?, answered_at = ?, next_at = NULL WHERE id = ? AND status IN (${marks})`,
      JSON.stringify(answer), messageId, this.now(), id, ...from) > 0
  }

  /**
   * The owner wrote something else: the bot's open, shown chat questions are moved on; the ones moved. Not `answering`,
   * nor the questions the same turn asked with it (one batch, shown together): answering one leaves the others open, with
   * their follow-ups and defaults.
   */
  moveOnQuestions(botId: string, byMessage: string, answering?: Pick<BotQuestionRow, 'id' | 'activationId' | 'dispatchN'>): BotQuestionRow[] {
    const open = this.openChatQuestions(botId).filter((question) => !answering ||
      (question.id !== answering.id && !(question.activationId === answering.activationId && question.dispatchN === answering.dispatchN)))
    const at = this.now()
    return open.filter((question) => this.run("UPDATE bot_questions SET status = 'moved_on', answer_message = ?, answered_at = ?, next_at = NULL WHERE id = ? AND status = 'open'", byMessage, at, question.id) > 0)
  }

  /** An activation's questions it never posted are withdrawn (it ended without a reply, or stopped at a wall). */
  withdrawUnpostedQuestions(activationId: string): number {
    return this.run("UPDATE bot_questions SET status = 'withdrawn', answered_at = ?, next_at = NULL WHERE activation_id = ? AND status = 'open' AND message_id IS NULL", this.now(), activationId)
  }

  /**
   * The bot takes back its own open question (`question_withdraw`, issue #1446): compare-and-set on the question, the bot
   * and the activation that asked it, so no other bot's or other work's question is touched, and an answer that came
   * first is kept. Read at once: it is not one the owner forgot, and no continuation says to ask it again. False when it
   * was not this caller's open question.
   */
  withdrawOwnQuestion(id: string, botId: string, activationId: string): boolean {
    const at = this.now()
    return this.run("UPDATE bot_questions SET status = 'withdrawn', answered_at = ?, read_at = ?, next_at = NULL WHERE id = ? AND bot_id = ? AND activation_id = ? AND status = 'open'",
      at, at, id, botId, activationId) > 0
  }

  /** Every open or moved-on question of a bot is withdrawn (it was deleted). */
  withdrawQuestions(botId: string): number {
    return this.run("UPDATE bot_questions SET status = 'withdrawn', answered_at = ?, next_at = NULL WHERE bot_id = ? AND status IN ('open', 'moved_on')", this.now(), botId)
  }

  /**
   * Questions a chat turn asked and then stopped at a wall before showing (withdrawn, no bubble), that no continuation
   * told it of yet: the next one says to ask again.
   */
  questionsToAskAgain(activationId: string): BotQuestionRow[] {
    return this.all("SELECT * FROM bot_questions WHERE activation_id = ? AND lane = 'chat' AND status = 'withdrawn' AND message_id IS NULL AND read_at IS NULL ORDER BY created_at, rowid", activationId).map(questionOf)
  }

  /** A continuation told the turn about these questions. */
  /** Questions whose answer the work never read after all (a note it did not take): unread again, so it carries them. */
  markQuestionsUnread(ids: readonly string[]): void {
    for (const id of ids) this.run('UPDATE bot_questions SET read_at = NULL WHERE id = ?', id)
  }

  markQuestionsRead(ids: readonly string[]): void {
    const at = this.now()
    for (const id of ids) this.run('UPDATE bot_questions SET read_at = ? WHERE id = ? AND read_at IS NULL', at, id)
  }

  /** Open questions no reply will ever carry: never posted, of an activation that ended (Mousse stopped in between). */
  withdrawStrandedQuestions(): number {
    return this.run(`UPDATE bot_questions SET status = 'withdrawn', answered_at = ?, next_at = NULL WHERE status = 'open' AND message_id IS NULL
      AND activation_id IN (SELECT id FROM bot_activations WHERE status IN ('done', 'failed', 'cancelled'))`, this.now())
  }

  /** Work ended: the question it still waited on is withdrawn (its bubble then says it is no longer needed). */
  withdrawWorkQuestions(activationId: string): number {
    return this.run("UPDATE bot_questions SET status = 'withdrawn', answered_at = ?, next_at = NULL WHERE activation_id = ? AND lane = 'run' AND status = 'open'", this.now(), activationId)
  }

  /**
   * The question work asked and has not carried on from yet: open, or answered (by the owner, or with its default) with
   * the answer not yet sent to it (`read_at`). Work may ask several (issue #1363): an open one it waits on comes first,
   * then any other open one, then the newest answered one, so work never goes on while a question it waits on is open.
   */
  workQuestion(activationId: string): BotQuestionRow | undefined {
    const row = this.get(`SELECT * FROM bot_questions WHERE activation_id = ? AND lane = 'run' AND read_at IS NULL AND status IN ('open', 'answered', 'defaulted')
      ORDER BY CASE WHEN status = 'open' AND json_extract(spec_json, '$.wait') IS NOT 0 THEN 0 WHEN status = 'open' THEN 1 ELSE 2 END, created_at DESC, rowid DESC LIMIT 1`, activationId)
    return row ? questionOf(row) : undefined
  }

  /** Whether work still has a question open, whose answer it has not had (it waits for every one before it goes on). */
  workQuestionOpen(activationId: string): boolean {
    return Boolean(this.get("SELECT 1 FROM bot_questions WHERE activation_id = ? AND lane = 'run' AND status = 'open' LIMIT 1", activationId))
  }

  /**
   * A question work asked that the owner forgot before the work carried on with it (Forget withdrew it, unread): the work
   * has nothing to go on with. Only Forget withdraws a question of work that has not ended.
   */
  forgottenWorkQuestion(activationId: string): BotQuestionRow | undefined {
    const row = this.get("SELECT * FROM bot_questions WHERE activation_id = ? AND lane = 'run' AND status = 'withdrawn' AND read_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", activationId)
    return row ? questionOf(row) : undefined
  }

  /**
   * Work's answered question went out with dispatch `n`, as `line` in its prompt: read once, and the line kept with the
   * answer, so a forget finds that copy by the question, not by its words (`answer_json.sent`). With read=false,
   * only the copy is recorded here; the carrying dispatch start marks it read.
   */
  markAnswerSent(questionId: string, n: number, line: string, read = true): void {
    this.run("UPDATE bot_questions SET read_at = CASE WHEN ? THEN ? ELSE read_at END, answer_json = json_set(answer_json, '$.sent', json_object('n', ?, 'line', ?)) WHERE id = ? AND read_at IS NULL", read ? 1 : 0, this.now(), n, line, questionId)
  }

  /**
   * The bot's questions that work waits on now (the work is `blocked` with `question`), and the ones running work asked
   * without waiting (`wait: false`, issue #1372), still open: each needs the owner's answer. Oldest first.
   */
  waitingQuestions(botId: string): BotQuestionRow[] {
    return this.all(`SELECT q.* FROM bot_questions q JOIN bot_activations a ON a.id = q.activation_id WHERE q.bot_id = ? AND q.lane = 'run'
      AND q.status = 'open' AND q.message_id IS NOT NULL AND ((a.status = 'blocked' AND a.end_reason = 'question')
        OR (a.status = 'running' AND json_extract(q.spec_json, '$.wait') = 0)) ORDER BY q.created_at, q.rowid`, botId).map(questionOf)
  }

  /**
   * Work that waits on its question goes on once the run lane is free (`question` to `question_answered`), in the
   * caller's transaction; false when it does not wait on one now (it is still ending its turn, or it ended).
   */
  wakeWork(activationId: string): boolean {
    return this.run("UPDATE bot_activations SET end_reason = 'question_answered' WHERE id = ? AND status = 'blocked' AND end_reason = 'question'", activationId) > 0
  }

  // -- Reminders (bot_reminders, v6): a bot's one-off times; repeating ones are schedules in the shared store --------

  insertReminder(row: Omit<BotReminderRow, 'workId' | 'status' | 'deliveredAt' | 'messageId' | 'activationId' | 'wake' | 'event' | 'fired' | 'chain' | 'snoozedFrom' | 'ownerSet'> & Partial<Pick<BotReminderRow, 'wake' | 'event' | 'chain' | 'ownerSet' | 'snoozedFrom' | 'workId'>>): void {
    this.run(
      "INSERT INTO bot_reminders(id, bot_id, due_at, text, work_title, work_brief, reply_to, created_at, status, wake, event_json, chain, owner_set, snoozed_from, work_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)",
      row.id, row.botId, row.dueAt, row.text, row.work?.title ?? null, row.work?.brief ?? null, row.replyTo, row.createdAt,
      row.wake ? 1 : 0, row.event ? JSON.stringify(row.event) : null, row.chain ?? 0, row.ownerSet == null ? null : row.ownerSet ? 1 : 0, row.snoozedFrom ?? null, row.workId ?? null
    )
  }

  /** Latest wait, retained after delivery until its continuation is dispatched. */
  workWait(workId: string): BotReminderRow | undefined {
    const row = this.get('SELECT * FROM bot_reminders WHERE work_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', workId)
    return row ? reminderOf(row) : undefined
  }

  /** Delivery is not telling: only model output or completion of a carrying dispatch consumes it. */
  unreadWorkWaits(workId: string): BotReminderRow[] {
    return this.all(`SELECT r.* FROM bot_reminders r WHERE r.work_id = ? AND r.status = 'delivered'
      AND NOT EXISTS (SELECT 1 FROM bot_dispatches d, json_each(d.prompt_json, '$.workWaitIds') told
        WHERE d.activation_id = r.work_id AND ${WORK_TOLD} AND told.value = r.id)
      ORDER BY r.due_at, r.rowid`, workId).map(reminderOf)
  }

  /** Model output or completion consumes an outcome. Continuation admission restores running before this read; inactive terminal work has nobody to tell. */
  unreadWorkActions(workId: string): ActionRow[] {
    return this.all(`SELECT a.* FROM bot_actions a WHERE a.kind = 'mcp' AND a.activation_id = ? AND a.status NOT IN ('open', 'approved', 'running')
      AND EXISTS (SELECT 1 FROM bot_activations w WHERE w.id = a.activation_id AND w.status NOT IN ('done', 'failed', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM bot_dispatches d, json_each(d.prompt_json, '$.workActionIds') told
        WHERE d.activation_id = a.activation_id AND ${WORK_TOLD} AND told.value = a.id)
      ORDER BY COALESCE(a.ran_at, a.answered_at, a.created_at), a.rowid`, workId) as unknown as ActionRow[]
  }

  pruneWorkRefusals(): void {
    const prefix = 'cursor:action-refusal:'
    if (!this.get('SELECT 1 FROM bot_memory_state WHERE substr(key, 1, ?) = ? LIMIT 1', prefix.length, prefix)) return
    this.run(`DELETE FROM bot_memory_state AS s WHERE substr(s.key, 1, ?) = ? AND NOT EXISTS (
      SELECT 1 FROM bot_activations a WHERE a.bot_id = s.bot_id AND a.status NOT IN ('done', 'failed', 'cancelled')
      AND substr(s.key, 1, length(? || a.id || ':')) = ? || a.id || ':')`, prefix.length, prefix, prefix, prefix)
  }

  recordWorkRefusal(workId: string, botId: string, id: string, text: string): void {
    this.run('INSERT OR IGNORE INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?)', botId,
      `cursor:action-refusal:${workId}:${id}`, JSON.stringify({ at: this.now(), text }))
  }

  /** Mousse updates are neither owner notes nor a reason to start another turn. */
  unreadWorkRefusals(workId: string): Array<{ id: string; at: string; text: string }> {
    const prefix = `cursor:action-refusal:${workId}:`
    return this.all(`SELECT s.key, s.value FROM bot_memory_state s WHERE substr(s.key, 1, ?) = ?
      AND NOT EXISTS (SELECT 1 FROM bot_dispatches d, json_each(d.prompt_json, '$.workRefusalIds') told
        WHERE d.activation_id = ? AND ${WORK_TOLD} AND told.value = s.key) ORDER BY s.rowid`, prefix.length, prefix, workId)
      .map(row => ({ id: String(row.key), ...JSON.parse(String(row.value)) as { at: string; text: string } }))
  }

  /** Confirmation controls replay only; existing carried/read markers are not changed here. */
  confirmWorkDelivery(activationId: string, n: number, why: 'output' | 'completed'): void {
    const needsConfirmation = (dispatch: BotDispatchRow | undefined): boolean => Boolean(dispatch && dispatch.startedAt !== null &&
      dispatch.prompt.workTold !== 'output' && dispatch.prompt.workTold !== 'completed' && hasWorkUpdates(dispatch.prompt))
    // A chat turn or empty continuation costs a read, never BEGIN IMMEDIATE on its first output.
    if (!needsConfirmation(this.dispatch(activationId, n))) return
    this.db.transaction(() => {
      if (!needsConfirmation(this.dispatch(activationId, n))) return
      this.run("UPDATE bot_dispatches SET prompt_json = json_set(prompt_json, '$.workTold', ?) WHERE activation_id = ? AND n = ?", why, activationId, n)
      for (const id of this.dispatch(activationId, n)?.prompt.workRefusalIds ?? []) this.run('DELETE FROM bot_memory_state WHERE key = ?', id)
    })
  }

  /** Pending or carried-but-unconfirmed additions, used only to build the next work prompt. */
  unreadWorkAnswers(activationId: string): BotEscalationRow[] {
    return this.all(`SELECT * FROM bot_escalations WHERE activation_id = ? AND mode = 'wall'
      AND status IN ('allowed_bot', 'allowed_once', 'denied') AND (applied_at IS NULL OR (${unconfirmedDelivery('bot_escalations', 'answers')}))
      ORDER BY created_at, rowid`, activationId).map(escalationOf)
  }
  /**
   * Work's answered questions whose answers it has not had yet, oldest first: unread, or carried by a dispatch that never
   * confirmed it told the model (`workDelivery.questions`, or an older build's single `question`).
   */
  unreadWorkQuestions(activationId: string): BotQuestionRow[] {
    return this.all(`SELECT * FROM bot_questions WHERE activation_id = ? AND lane = 'run'
      AND status IN ('answered', 'defaulted') AND (read_at IS NULL OR (${unconfirmedDelivery('bot_questions', 'question', 'questions')}))
      ORDER BY created_at, rowid`, activationId).map(questionOf)
  }
  /** Notes in a started prompt may have reached the model even without confirmed output. */
  carriedWorkNoteIds(activationId: string): Set<number> {
    return new Set(this.all(`SELECT DISTINCT item.value AS id FROM bot_dispatches d,
      json_each(d.prompt_json, '$.workDelivery.notes') item
      WHERE d.activation_id = ? AND d.started_at IS NOT NULL`, activationId).map(row => num(row.id)!))
  }
  unreadWorkNotes(activationId: string): ReturnType<BotStore['pendingWorkNotes']> {
    return this.all(`SELECT id, text, at, from_message FROM bot_work_notes WHERE activation_id = ?
      AND (applied_at IS NULL OR (${unconfirmedDelivery('bot_work_notes', 'notes')})) ORDER BY id`, activationId)
      .map(row => ({ id: num(row.id)!, text: row.text as string, at: row.at as string, fromMessage: str(row.from_message) }))
  }

  /** When the owner last wrote to a bot (their newest message in its chat), or '' when they never have. */
  ownerLastWroteAt(botId: string): string {
    return str(this.get("SELECT MAX(at) AS at FROM bot_messages WHERE bot_id = ? AND author = 'owner'", botId)?.at) ?? ''
  }

  /**
   * The wakes a bot set at or after `since`, cancelled ones too, with their briefs and events (loop detection): its chat's
   * own (`workId` undefined), or the waits of one piece of work.
   */
  wakesSetSince(botId: string, since: string, workId?: string): Array<Pick<BotReminderRow, 'text' | 'event'>> {
    return this.all('SELECT * FROM bot_reminders WHERE bot_id = ? AND wake = 1 AND created_at >= ? AND work_id IS ?', botId, since, workId ?? null).map(reminderOf).map(({ text, event }) => ({ text, event }))
  }

  /**
   * Where the owner last wrote to a bot: the `seq` of their newest message in its chat, or 0 when they never have. `seq`
   * orders every chat's rows together, so what came after it is known even within one millisecond.
   */
  ownerLastWroteSeq(botId: string): number {
    return num(this.get("SELECT MAX(seq) AS seq FROM bot_messages WHERE bot_id = ? AND author = 'owner'", botId)?.seq) ?? 0
  }

  /**
   * Whether the owner wrote to a bot (a message, or a tapped answer) after they said Not now to `ask`: their newest row
   * comes after the one they had written last then (`answerEscalation`). An ask denied by an older build kept no row, so
   * its answer's time is compared instead. The repeat guard for asks (issue #1363).
   */
  ownerWroteSinceDenial(ask: Pick<BotEscalationRow, 'id' | 'botId' | 'answeredAt'>): boolean {
    const last = this.ownerLastWroteSeq(ask.botId)
    const kept = this.denialOf(ask)
    if (kept) return last > kept.seq
    return Boolean(ask.answeredAt && this.get("SELECT 1 FROM bot_messages WHERE bot_id = ? AND author = 'owner' AND seq = ? AND at > ?", ask.botId, last, ask.answeredAt))
  }

  /**
   * What a Not now to `ask` kept (`answerEscalation`): the `seq` of the owner's newest row then, the digest of the
   * grant it was said under (absent: kept by a build that wrote only the `seq`), and the key of what that grant gave
   * (absent: kept before it was written). Undefined when it kept nothing.
   */
  denialOf(ask: Pick<BotEscalationRow, 'id' | 'botId'>): { seq: number; grant?: string; given?: string } | undefined {
    const value = this.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', ask.botId, `ask-denied:${ask.id}`)?.value
    if (typeof value !== 'string') return undefined
    try {
      const kept = JSON.parse(value) as unknown
      if (typeof kept === 'number') return { seq: kept }
      if (kept && typeof kept === 'object' && typeof (kept as { seq?: unknown }).seq === 'number')
        return {
          seq: (kept as { seq: number }).seq,
          ...(typeof (kept as { grant?: unknown }).grant === 'string' ? { grant: (kept as { grant: string }).grant } : {}),
          ...(typeof (kept as { given?: unknown }).given === 'string' ? { given: (kept as { given: string }).given } : {})
        }
    } catch { /* unreadable: kept nothing */ }
    return undefined
  }

  /** How many messages from other bots reached bot `botId`'s chat after row `afterSeq` (the ping-pong guard). */
  botMessagesReceivedAfter(botId: string, afterSeq: number): number {
    return num(this.get("SELECT COUNT(*) AS n FROM bot_messages WHERE bot_id = ? AND substr(id, 1, 10) = 'bm_botmsg_' AND seq > ?", botId, afterSeq)?.n) ?? 0
  }

  /** How many of bot `botId`'s chat rows whose id starts with `prefix` came after row `afterSeq`. */
  chatRowsAfter(botId: string, prefix: string, afterSeq: number): number {
    return num(this.get('SELECT COUNT(*) AS n FROM bot_messages WHERE bot_id = ? AND substr(id, 1, ?) = ? AND seq > ?', botId, prefix.length, prefix, afterSeq)?.n) ?? 0
  }

  /**
   * Whether bot `botId`'s chat got a message from another bot reading exactly `text` (`botMessageRowText`: the sender's
   * name and the message) after row `afterSeq` (loop detection).
   */
  botMessageRowAfter(botId: string, text: string, afterSeq: number): boolean {
    return this.get("SELECT 1 AS hit FROM bot_messages WHERE bot_id = ? AND substr(id, 1, 10) = 'bm_botmsg_' AND text = ? AND seq > ? LIMIT 1", botId, text, afterSeq) !== undefined
  }

  /** Every bot's waiting wakes on an event that has not happened yet, oldest first. */
  waitingEventWakes(): BotReminderRow[] {
    return this.all("SELECT * FROM bot_reminders WHERE status = 'waiting' AND wake = 1 AND event_json IS NOT NULL AND fired_json IS NULL ORDER BY created_at, id").map(reminderOf)
  }

  /**
   * A waiting wake's event happened (or it ended without it): kept with the wake, which is now due at `dueAt`. False when
   * it was no longer waiting, or had fired already.
   */
  fireWake(id: string, fired: BotWakeFired, dueAt: string): boolean {
    return this.run("UPDATE bot_reminders SET fired_json = ?, due_at = ? WHERE id = ? AND status = 'waiting' AND wake = 1 AND fired_json IS NULL", JSON.stringify(fired), dueAt, id) > 0
  }

  messageForgotten(botId: string, messageId: string): boolean {
    return !!this.get('SELECT 1 FROM bot_journal WHERE bot_id = ? AND source_key = ? AND redacted_at IS NOT NULL', botId, `bm:${messageId}`)
  }

  reminderForMessage(botId: string, messageId: string): BotReminderRow | undefined {
    const row = this.get('SELECT * FROM bot_reminders WHERE bot_id = ? AND message_id = ?', botId, messageId)
    return row ? reminderOf(row) : undefined
  }

  snoozedCopy(botId: string, reminderId: string): BotReminderRow | undefined {
    const row = this.get("SELECT * FROM bot_reminders WHERE bot_id = ? AND snoozed_from = ? AND status != 'cancelled' LIMIT 1", botId, reminderId)
    return row ? reminderOf(row) : undefined
  }

  reminder(id: string): BotReminderRow | undefined {
    const row = this.get('SELECT * FROM bot_reminders WHERE id = ?', id)
    return row ? reminderOf(row) : undefined
  }

  /** A bot's reminders still to come, soonest first. */
  waitingReminders(botId: string): BotReminderRow[] {
    return this.all("SELECT * FROM bot_reminders WHERE bot_id = ? AND status = 'waiting' ORDER BY due_at, id", botId).map(reminderOf)
  }

  /** Every bot's reminders due at or before `at`, oldest first. */
  dueReminders(at: string): BotReminderRow[] {
    return this.all("SELECT * FROM bot_reminders WHERE status = 'waiting' AND due_at <= ? ORDER BY due_at, id", at).map(reminderOf)
  }

  /** The soonest reminder still to come, of any bot. */
  nextReminder(botId?: string): BotReminderRow | undefined {
    return this.nextReminders(botId, 1)[0]
  }

  /** The `limit` soonest reminders still to come, of any bot, soonest first. */
  nextReminders(botId: string | undefined, limit: number): BotReminderRow[] {
    return this.all(`SELECT * FROM bot_reminders WHERE status = 'waiting'
      AND bot_id IN (SELECT bot_id FROM bot_registry WHERE deleted_at IS NULL)
      AND (work_id IS NULL OR due_at > ? OR work_id IN (SELECT id FROM bot_activations WHERE status = 'blocked' AND end_reason = 'waiting'))
      ${botId === undefined ? '' : 'AND bot_id = ?'} ORDER BY due_at, id LIMIT ?`, this.now(), ...(botId === undefined ? [] : [botId]), limit).map(reminderOf)
  }

  /** Moves a waiting reminder on; false when it was not waiting (delivered or cancelled meanwhile). */
  settleReminder(id: string, status: 'delivered' | 'cancelled', result: { messageId?: string; activationId?: string } = {}): boolean {
    return this.run(
      "UPDATE bot_reminders SET status = ?, delivered_at = ?, message_id = ?, activation_id = ? WHERE id = ? AND status = 'waiting'",
      status, this.now(), result.messageId ?? null, result.activationId ?? null, id
    ) > 0
  }

  // -- Notes to work (bot_work_notes, v6): what the owner added while a piece of work ran -------------------------

  /** `fromMessage`: the owner's message the note came from, so forgetting that message removes the note too. */
  addWorkNote(activationId: string, botId: string, text: string, fromMessage?: string): void {
    this.run('INSERT INTO bot_work_notes(activation_id, bot_id, text, at, from_message) VALUES(?, ?, ?, ?, ?)', activationId, botId, text, this.now(), fromMessage ?? null)
  }

  /** The notes a piece of work has not been given yet, oldest first. */
  pendingWorkNotes(activationId: string): Array<{ id: number; text: string; at: string; fromMessage: string | null }> {
    return this.all('SELECT id, text, at, from_message FROM bot_work_notes WHERE activation_id = ? AND applied_at IS NULL ORDER BY id', activationId)
      .map((row) => ({ id: num(row.id)!, text: row.text as string, at: row.at as string, fromMessage: str(row.from_message) }))
  }

  /** The owner's messages `ids` of chat activation `from` belong to activation `to` now (inside the caller's transaction). */
  moveOwnerMessages(from: string, to: string, ids: readonly string[]): void {
    for (const id of ids) this.run("UPDATE bot_messages SET activation_id = ? WHERE id = ? AND activation_id = ? AND author = 'owner'", to, id, from)
  }

  /** Marks these notes consumed, inside the caller's transaction. */
  applyWorkNotes(ids: readonly number[]): void {
    const at = this.now()
    for (const id of ids) this.run('UPDATE bot_work_notes SET applied_at = ? WHERE id = ? AND applied_at IS NULL', at, id)
  }

  /** A deleted bot's reminders never fire. */
  cancelReminders(botId: string): number {
    return this.run("UPDATE bot_reminders SET status = 'cancelled', delivered_at = ? WHERE bot_id = ? AND status = 'waiting'", this.now(), botId)
  }

  deleteMessages(botId: string): void {
    this.db.transaction(() => {
      this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND key GLOB 'cursor:telling-legacy:*'", botId)
      this.run('DELETE FROM bot_messages WHERE bot_id = ?', botId)
    })
  }

  // -- Schedules (bot_schedules: where earlier builds kept them; the shared store holds them now) -------

  /** A bot's schedules that are not removed, oldest first, moved or not. */
  schedules(botId: string): BotScheduleRow[] {
    return this.all('SELECT * FROM bot_schedules WHERE bot_id = ? AND removed_at IS NULL ORDER BY created_at, id', botId).map(scheduleOf)
  }

  /** Every bot's schedules that are not removed and not moved to the shared store yet, oldest first. */
  unmigratedSchedules(): BotScheduleRow[] {
    return this.all('SELECT * FROM bot_schedules WHERE removed_at IS NULL AND migrated_at IS NULL ORDER BY bot_id, created_at, id').map(scheduleOf)
  }

  /** Every schedule removed, moved or not: one an older build removed after its move goes from the shared store too. */
  removedSchedules(): BotScheduleRow[] {
    return this.all('SELECT * FROM bot_schedules WHERE removed_at IS NOT NULL ORDER BY bot_id, created_at, id').map(scheduleOf)
  }

  /** Every schedule moved to the shared store, for `unmigrateBotSchedules`. */
  migratedSchedules(): BotScheduleRow[] {
    return this.all('SELECT * FROM bot_schedules WHERE migrated_at IS NOT NULL ORDER BY bot_id, created_at, id').map(scheduleOf)
  }

  /** Marks a schedule moved to the shared store, as `jobId`; the row itself stays. */
  markScheduleMigrated(botId: string, id: string, jobId: string, at: string): boolean {
    return this.run('UPDATE bot_schedules SET migrated_at = ?, migrated_job_id = ? WHERE bot_id = ? AND id = ? AND migrated_at IS NULL', at, jobId, botId, id) > 0
  }

  /** Undoes the mark (`unmigrateBotSchedules`): the row is a schedule of its bot again for a build that reads it. */
  clearScheduleMigrated(botId: string, id: string): boolean {
    return this.run('UPDATE bot_schedules SET migrated_at = NULL, migrated_job_id = NULL WHERE bot_id = ? AND id = ?', botId, id) > 0
  }

  /** Adds a schedule; false when its id exists already (a schedule moved by the v4 upgrade included). */
  putSchedule(row: Omit<BotScheduleRow, 'removedAt' | 'migratedAt' | 'migratedJobId'>): boolean {
    return this.run(
      'INSERT INTO bot_schedules(id, bot_id, when_json, prompt, label, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      row.id, row.botId, JSON.stringify(row.when), row.prompt, row.label, row.createdBy, row.createdAt
    ) > 0
  }

  deleteSchedules(botId: string): void {
    this.run('DELETE FROM bot_schedules WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_schedule_state WHERE bot_id = ?', botId)
  }

  /** The bot's threads, for the delete and the purge. */
  botThreads(botId: string): Array<{ threadId: string; role: 'home' | BotThreadRole; activationId: string | null }> {
    return this.all('SELECT * FROM bot_threads WHERE bot_id = ? ORDER BY role, thread_id', botId).map((row) => ({ threadId: row.thread_id as string, role: roleOfRow(row), activationId: str(row.activation_id) }))
  }
}
