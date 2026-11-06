import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileDatabase, type Migration, type ProfileDatabaseFault } from '../../run/db/ProfileDatabase'
import type { BotActivationStatus, BotActivationTrigger, BotLane, BotManifest, BotModelChoice, BotSchedule } from '../../../shared/bots/personal/definition'
import { canonicalManifest } from '../../../shared/bots/personal/manifest'
import type { ActivationLimits } from './scopes'
import type { BotThreadRole } from '../../../shared/bots/personal/authority'
import type { BotAskMode, BotAskRequest, BotEscalationStatus, BotPermissionRequest, BotWallKind } from '../../../shared/bots/personal/escalation'
import type { BotChip, BotError, BotMessageKind } from '../../../shared/bots/personal/chat'
import type { ProviderSelection } from '../../../shared/harness/types'
import { BOT_MEMORY_SCHEMA_SQL } from '../memory/schema'

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
  }
]

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
  /** The last resolved selection (internal; never in a UI payload). */
  model: { selection: ProviderSelection; activationId: string } | null
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
  attachments: Array<{ name: string; path: string }> | null
  clientRequestId: string | null
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
    clientRequestId: str(row.client_request_id)
  }
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
    removedAt: str(row.removed_at)
  }
}

export interface BotGrantRow {
  botId: string
  digest: string
  manifest: BotManifest
  approvedAt: string
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
  modelOverride: BotModelChoice | null
  /** The model changed for this activation: its next dispatch resolves it again. */
  reloadPending: boolean
  /** The model this activation runs on, resolved at its first dispatch (internal; never in a payload). */
  selection: ProviderSelection | null
}

export interface BotDispatchRow {
  activationId: string
  n: number
  kind: 'start' | 'continue' | 'consult'
  mainN: number | null
  clientRequestId: string
  runId: string | null
  threadId: string
  prompt: { text: string }
  policyDigest: string
  deadlineMs: number | null
  prepaidMs: number | null
  usedMs: number | null
  startedAt: number | null
  exitAt: number | null
  endedAt: string | null
  outcome: string | null
  settledBy: 'run' | 'startup' | null
  /** How a continuation is sent (the run it continues, the owner's acknowledgement), so a resend matches it. */
  send: { continuationOfRunId?: string; acknowledgeUncertain?: boolean; /** A retry on another model after a usage limit. */ usageRetry?: boolean }
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

export interface BotCountersRow {
  requests: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  activeMs: number
}

type Row = Record<string, unknown>
type Param = string | number | null

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null)
const json = <T>(value: unknown): T | null => (typeof value === 'string' ? (JSON.parse(value) as T) : null)

function activationOf(row: Row): BotActivationRow {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    revision: row.revision as string,
    grantDigest: row.grant_digest as string,
    trigger: JSON.parse(row.trigger_json as string) as BotActivationRow['trigger'],
    idempotencyKey: row.idempotency_key as string,
    status: row.status as BotActivationStatus,
    threadId: str(row.thread_id),
    scratch: str(row.scratch),
    autoRestarts: num(row.auto_restarts) ?? 0,
    result: str(row.result),
    createdAt: row.created_at as string,
    endedAt: str(row.ended_at),
    endReason: str(row.end_reason),
    lane: (str(row.lane) ?? 'run') as BotLane,
    modelOverride: json<BotModelChoice>(row.model_override_json),
    reloadPending: num(row.reload_pending) === 1,
    selection: json<ProviderSelection>(row.selection_json)
  }
}

function dispatchOf(row: Row): BotDispatchRow {
  return {
    activationId: row.activation_id as string,
    n: num(row.n)!,
    kind: row.kind as BotDispatchRow['kind'],
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

  /** Pause (`reason`) or resume (null) a bot's schedules; a resume also clears the failure streak. */
  setPaused(botId: string, reason: BotPauseReason | null, until?: string): void {
    if (reason === null) this.run('UPDATE bot_registry SET paused_reason = NULL, paused_until = NULL, failure_streak = 0 WHERE bot_id = ?', botId)
    else this.run('UPDATE bot_registry SET paused_reason = ?, paused_until = ? WHERE bot_id = ?', reason, until ?? null, botId)
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

  setPublished(botId: string, revision: string): void {
    this.run('UPDATE bot_registry SET revision = ? WHERE bot_id = ? AND deleted_at IS NULL', revision, botId)
  }

  setHomeThread(botId: string, threadId: string): void {
    this.run('UPDATE bot_registry SET home_thread_id = ? WHERE bot_id = ?', threadId, botId)
  }

  markDeleted(botId: string): void {
    this.run('UPDATE bot_registry SET deleted_at = ? WHERE bot_id = ? AND deleted_at IS NULL', this.now(), botId)
  }

  // -- Grants ----------------------------------------------------------------------------------

  /** The bot's active grant: the latest approval not revoked since. */
  activeGrant(botId: string): BotGrantRow | undefined {
    const row = this.get('SELECT * FROM bot_grants WHERE bot_id = ? AND revoked_at IS NULL ORDER BY grant_id DESC LIMIT 1', botId)
    return row ? { botId, digest: row.digest as string, manifest: JSON.parse(row.manifest_json as string) as BotManifest, approvedAt: row.approved_at as string } : undefined
  }

  /** Records an approval, in canonical form; it replaces the earlier grant, if any. */
  approve(botId: string, digest: string, given: BotManifest): BotGrantRow {
    // One form for what is granted: what approval showed is exactly what later answers build on.
    const manifest = canonicalManifest(given)
    return this.db.transaction(() => {
      const at = this.now()
      this.run('UPDATE bot_grants SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL', at, botId)
      this.run('INSERT INTO bot_grants(bot_id, digest, manifest_json, approved_at) VALUES(?, ?, ?, ?)', botId, digest, JSON.stringify(manifest), at)
      return { botId, digest, manifest, approvedAt: at }
    })
  }

  revoke(botId: string): boolean {
    return this.run('UPDATE bot_grants SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL', this.now(), botId) > 0
  }

  // -- Threads ---------------------------------------------------------------------------------

  putThread(input: { threadId: string; botId: string; role: 'home' | BotThreadRole; key: string; activationId?: string }): void {
    this.run(
      'INSERT INTO bot_threads(thread_id, bot_id, role, key, activation_id) VALUES(?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO NOTHING',
      input.threadId, input.botId, input.role, input.key, input.activationId ?? null
    )
  }

  threadRole(threadId: string): 'home' | BotThreadRole | undefined {
    return (str(this.get('SELECT role FROM bot_threads WHERE thread_id = ?', threadId)?.role) ?? undefined) as 'home' | BotThreadRole | undefined
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

  /** Activations of a bot's lane in `statuses`, oldest first. */
  laneActivations(botId: string, lane: BotLane, statuses: readonly BotActivationStatus[]): BotActivationRow[] {
    const marks = statuses.map(() => '?').join(', ')
    return this.all(`SELECT * FROM bot_activations WHERE bot_id = ? AND lane = ? AND status IN (${marks}) ORDER BY created_at, id`, botId, lane, ...statuses).map(activationOf)
  }

  /** The bot's most recent activation that ended, if any. */
  lastEndedActivation(botId: string): BotActivationRow | undefined {
    const row = this.get("SELECT * FROM bot_activations WHERE bot_id = ? AND status IN ('done', 'failed', 'cancelled') ORDER BY ended_at DESC, created_at DESC LIMIT 1", botId)
    return row ? activationOf(row) : undefined
  }

  setActivationSelection(id: string, selection: ProviderSelection | null): void {
    this.run('UPDATE bot_activations SET selection_json = ?, reload_pending = 0 WHERE id = ?', selection ? JSON.stringify(selection) : null, id)
  }

  /** `set_depth`/`use_model` with scope `now`: this activation's next dispatch runs on the new choice. */
  setModelOverride(id: string, choice: BotModelChoice): void {
    this.run('UPDATE bot_activations SET model_override_json = ?, reload_pending = 1 WHERE id = ?', JSON.stringify(choice), id)
  }

  /** The next dispatch resolves the model again (a usage limit, or a reload). */
  markReload(id: string): void {
    this.run('UPDATE bot_activations SET reload_pending = 1 WHERE id = ?', id)
  }

  insertActivation(row: Pick<BotActivationRow, 'id' | 'botId' | 'revision' | 'grantDigest' | 'trigger' | 'idempotencyKey' | 'status' | 'createdAt'> & { lane?: BotLane }, limits: ActivationLimits): void {
    this.run(
      'INSERT INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, lane) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.botId, row.revision, row.grantDigest, JSON.stringify(row.trigger), row.idempotencyKey, row.status, row.createdAt, row.lane ?? 'run'
    )
    this.run('INSERT INTO bot_counters(activation_id, limits_json) VALUES(?, ?)', row.id, JSON.stringify(limits))
    this.run('INSERT INTO bot_spend(activation_id) VALUES(?)', row.id)
  }

  /** Compare-and-set of an activation's status; false when it was not in `from`. */
  moveActivation(id: string, from: readonly BotActivationStatus[], to: BotActivationStatus, patch: { endReason?: string | null; result?: string | null; threadId?: string; scratch?: string } = {}): boolean {
    const marks = from.map(() => '?').join(', ')
    const ended = to === 'done' || to === 'failed' || to === 'cancelled'
    return this.run(
      `UPDATE bot_activations SET status = ?,
         end_reason = CASE WHEN ? THEN ? ELSE end_reason END,
         result = CASE WHEN ? THEN ? ELSE result END,
         thread_id = COALESCE(?, thread_id),
         scratch = COALESCE(?, scratch),
         ended_at = CASE WHEN ? THEN ? ELSE ended_at END
       WHERE id = ? AND status IN (${marks})`,
      to,
      patch.endReason !== undefined ? 1 : 0, patch.endReason ?? null,
      patch.result !== undefined ? 1 : 0, patch.result ?? null,
      patch.threadId ?? null,
      patch.scratch ?? null,
      ended ? 1 : 0, ended ? this.now() : null,
      id, ...from
    ) > 0
  }

  deleteActivation(id: string): void {
    for (const table of ['bot_counters', 'bot_spend', 'bot_spend_reservations', 'bot_unknown_calls', 'bot_dispatches'])
      this.run(`DELETE FROM ${table} WHERE activation_id = ?`, id)
    this.run('DELETE FROM bot_activations WHERE id = ?', id)
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
    this.run(
      'INSERT INTO bot_dispatches(activation_id, n, kind, main_n, client_request_id, thread_id, prompt_json, policy_digest, send_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.activationId, row.n, row.kind, row.mainN ?? null, row.clientRequestId, row.threadId, JSON.stringify(row.prompt), row.policyDigest, row.send && Object.keys(row.send).length ? JSON.stringify(row.send) : null
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
    return this.all(`SELECT * FROM bot_escalations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`, ...params).map(escalationOf)
  }

  /** The walls an activation hit (a run's refused asks never count: they don't stop it). */
  countEscalations(activationId: string): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM bot_escalations WHERE activation_id = ? AND mode = 'wall'", activationId)?.n ?? 0)
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

  setEscalationMessage(id: string, messageId: string): void {
    this.run('UPDATE bot_escalations SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, id)
  }

  /** Compare-and-set from `open`: false when it was already answered, expired or cancelled. */
  answerEscalation(id: string, status: Exclude<BotEscalationStatus, 'open'>, amount?: number, cooldownUntil?: string): boolean {
    return this.run("UPDATE bot_escalations SET status = ?, amount = ?, answered_at = ?, cooldown_until = ? WHERE id = ? AND status = 'open'", status, amount ?? null, this.now(), cooldownUntil ?? null, id) > 0
  }

  /** Ends every open escalation of an activation (it ended, expired, or was trashed); a run's asks stay open for the owner. */
  closeEscalations(activationId: string, status: 'expired' | 'cancelled'): number {
    return this.run("UPDATE bot_escalations SET status = ?, answered_at = ? WHERE activation_id = ? AND status = 'open' AND mode = 'wall'", status, this.now(), activationId)
  }

  /** Withdraws every open ask of a bot (it was deleted). */
  withdrawAsks(botId: string): number {
    return this.run("UPDATE bot_escalations SET status = 'withdrawn', answered_at = ? WHERE bot_id = ? AND status = 'open'", this.now(), botId)
  }

  /** The bot's open asks, oldest first. */
  openAsks(botId: string): BotEscalationRow[] {
    return this.escalations({ botId, status: 'open' })
  }

  /** The answered escalation whose continuation has not been sent yet. */
  pendingAnswer(activationId: string): BotEscalationRow | undefined {
    const row = this.get("SELECT * FROM bot_escalations WHERE activation_id = ? AND mode = 'wall' AND status IN ('allowed_bot', 'allowed_once', 'denied') AND applied_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1", activationId)
    return row ? escalationOf(row) : undefined
  }

  /** Every answered wall of an activation whose continuation has not been sent yet, oldest first. */
  pendingAnswers(activationId: string): BotEscalationRow[] {
    return this.all("SELECT * FROM bot_escalations WHERE activation_id = ? AND mode = 'wall' AND status IN ('allowed_bot', 'allowed_once', 'denied') AND applied_at IS NULL ORDER BY created_at, id", activationId).map(escalationOf)
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
    return this.all('SELECT * FROM bot_threads').map((row) => ({ threadId: row.thread_id as string, botId: row.bot_id as string, role: row.role as 'home' | BotThreadRole, key: row.key as string, activationId: str(row.activation_id) }))
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

  // -- Schedules (6d) -----------------------------------------------------------------------------

  scheduleStates(botId: string): Array<{ scheduleId: string; spec: string; nextRunAt: string | null; lastSkipAt: string | null; lastSkipReason: string | null }> {
    return this.all('SELECT * FROM bot_schedule_state WHERE bot_id = ? ORDER BY schedule_id', botId).map((row) => ({
      scheduleId: row.schedule_id as string,
      spec: row.spec_json as string,
      nextRunAt: str(row.next_run_at),
      lastSkipAt: str(row.last_skip_at),
      lastSkipReason: str(row.last_skip_reason)
    }))
  }

  /** The occurrence a schedule last skipped and why; null once an occurrence runs again. */
  setScheduleSkip(botId: string, scheduleId: string, reason: string | null, at: string | null): void {
    this.run('UPDATE bot_schedule_state SET last_skip_reason = ?, last_skip_at = ? WHERE bot_id = ? AND schedule_id = ?', reason, at, botId, scheduleId)
  }

  putScheduleState(botId: string, scheduleId: string, spec: string, nextRunAt: string | null): void {
    this.run(
      'INSERT INTO bot_schedule_state(bot_id, schedule_id, spec_json, next_run_at) VALUES(?, ?, ?, ?) ON CONFLICT(bot_id, schedule_id) DO UPDATE SET spec_json = excluded.spec_json, next_run_at = excluded.next_run_at',
      botId, scheduleId, spec, nextRunAt
    )
  }

  dropScheduleState(botId: string, scheduleId?: string): void {
    if (scheduleId === undefined) this.run('DELETE FROM bot_schedule_state WHERE bot_id = ?', botId)
    else this.run('DELETE FROM bot_schedule_state WHERE bot_id = ? AND schedule_id = ?', botId, scheduleId)
  }

  /**
   * Inserts an activation unless its idempotency key exists already; true when it was inserted.
   * A repeated schedule occurrence only finds the activation it made before.
   */
  insertActivationOnce(row: Parameters<BotStore['insertActivation']>[0], limits: ActivationLimits): boolean {
    const inserted = this.run(
      'INSERT OR IGNORE INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at, lane) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.botId, row.revision, row.grantDigest, JSON.stringify(row.trigger), row.idempotencyKey, row.status, row.createdAt, row.lane ?? 'run'
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

  /** Moves a bot's unfinished activations from one grant to its wider successor ("Allow for this bot"). */
  regrant(botId: string, fromDigest: string, toDigest: string, revision: string): void {
    this.run("UPDATE bot_activations SET grant_digest = ?, revision = ? WHERE bot_id = ? AND grant_digest = ? AND status NOT IN ('done', 'failed', 'cancelled')", toDigest, revision, botId, fromDigest)
  }

  // -- Chat (bot_messages) ----------------------------------------------------------------------

  /**
   * Inserts a chat row; inside the caller's transaction, so its journal row joins it. False when a
   * row with the same id or client request id exists already.
   */
  insertMessage(row: Omit<BotMessageRow, 'seq'>): boolean {
    return this.run(
      'INSERT INTO bot_messages(id, bot_id, at, author, kind, text, chips_json, ask_id, error_json, activation_id, attachments_json, client_request_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      row.id, row.botId, row.at, row.author, row.kind, row.text, JSON.stringify(row.chips), row.askId, row.error ? JSON.stringify(row.error) : null,
      row.activationId, row.attachments ? JSON.stringify(row.attachments) : null, row.clientRequestId
    ) > 0
  }

  message(id: string): BotMessageRow | undefined {
    const row = this.get('SELECT * FROM bot_messages WHERE id = ?', id)
    return row ? messageOf(row) : undefined
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
      ? this.all('SELECT * FROM bot_messages WHERE bot_id = ? ORDER BY seq DESC LIMIT ?', botId, options.limit)
      : this.all('SELECT * FROM bot_messages WHERE bot_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', botId, options.beforeSeq, options.limit)
    return rows.map(messageOf).reverse()
  }

  lastMessage(botId: string): BotMessageRow | undefined {
    const row = this.get('SELECT * FROM bot_messages WHERE bot_id = ? ORDER BY seq DESC LIMIT 1', botId)
    return row ? messageOf(row) : undefined
  }

  /** The bot's messages after the owner's read marker. */
  unread(botId: string, readSeq: number): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM bot_messages WHERE bot_id = ? AND author = 'bot' AND seq > ?", botId, readSeq)?.n ?? 0)
  }

  deleteMessages(botId: string): void {
    this.run('DELETE FROM bot_messages WHERE bot_id = ?', botId)
  }

  // -- Schedules (bot_schedules) ----------------------------------------------------------------

  /** A bot's schedules that are not removed, oldest first. */
  schedules(botId: string): BotScheduleRow[] {
    return this.all('SELECT * FROM bot_schedules WHERE bot_id = ? AND removed_at IS NULL ORDER BY created_at, id', botId).map(scheduleOf)
  }

  schedule(botId: string, id: string): BotScheduleRow | undefined {
    const row = this.get('SELECT * FROM bot_schedules WHERE bot_id = ? AND id = ?', botId, id)
    return row ? scheduleOf(row) : undefined
  }

  /** Adds a schedule; false when its id exists already (a schedule moved by the v4 upgrade included). */
  putSchedule(row: Omit<BotScheduleRow, 'removedAt'>): boolean {
    return this.run(
      'INSERT INTO bot_schedules(id, bot_id, when_json, prompt, label, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      row.id, row.botId, JSON.stringify(row.when), row.prompt, row.label, row.createdBy, row.createdAt
    ) > 0
  }

  removeSchedule(botId: string, id: string): boolean {
    return this.run('UPDATE bot_schedules SET removed_at = ? WHERE bot_id = ? AND id = ? AND removed_at IS NULL', this.now(), botId, id) > 0
  }

  deleteSchedules(botId: string): void {
    this.run('DELETE FROM bot_schedules WHERE bot_id = ?', botId)
    this.run('DELETE FROM bot_schedule_state WHERE bot_id = ?', botId)
  }

  /** The bot's threads, for the delete and the purge. */
  botThreads(botId: string): Array<{ threadId: string; role: 'home' | BotThreadRole; activationId: string | null }> {
    return this.all('SELECT * FROM bot_threads WHERE bot_id = ? ORDER BY role, thread_id', botId).map((row) => ({ threadId: row.thread_id as string, role: row.role as 'home' | BotThreadRole, activationId: str(row.activation_id) }))
  }
}
