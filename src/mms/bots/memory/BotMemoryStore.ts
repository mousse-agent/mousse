import { heldCalls } from '../actions/lifecycle'
import { requestJournalRows } from './requestFrames'
import { createHash } from 'node:crypto'
import type { ProfileDatabase } from '../../run/db/ProfileDatabase'
import type { BotLane } from '../../../shared/bots/personal/definition'
import {
  BOT_CHAT_TURN_END_KEY,
  BOT_JOURNAL_KINDS,
  BOT_MEMORY_CAPS,
  BOT_MEMORY_READ_PAGE_TOKENS,
  BOT_MEMORY_SEARCH_LIMIT,
  MAX_BOT_JOURNAL_TOOL_TEXT_BYTES,
  MAX_BOT_MEMORY_READ_AROUND,
  MAX_BOT_MEMORY_SEARCH_LIMIT,
  MAX_BOT_MEMORY_TEXT_CHARS,
  estimateTokens,
  memoryGauge,
  memoryRef,
  memoryToolOf,
  parseMemoryRef,
  type BotJournalKind,
  type BotJournalWho,
  type BotMemoryEntry,
  type BotMemoryForgetResult,
  type BotMemoryHit,
  type BotMemoryKind,
  type BotMemoryListing,
  type BotMemoryRow,
  type BotMemorySaveResult,
  type BotMemorySearchInput,
  type BotMemorySearchKind,
  type BotMemorySearchStats,
  type BotMemoryStatus,
  type BotMemoryWrittenIn
} from '../../../shared/bots/personal/memory'
import type { BotJournalInput, BotStoreTx } from '../seams'
import { CHAT_DIGEST_KEY, type ChatDigest, type ChatSummaryState, chatFingerprint, foldChatSummary, staleDigests } from './chatSummary'
import { shortChipText } from '../../../shared/bots/personal/chips'
import { classifyMemorySearchText, guardMemoryText, maskMemoryCredentials, relativeDateRefusal } from './guard'
import { agoLabel, coreGauge, cut, dayLabel, runNotesGauge, usedTokens, zonedDayBound } from './render'

/**
 * The bot memory store (docs/plans/bot-context.md §3, §6–§8) over `bots.db`: the journal (append,
 * capture upserts, redaction), FTS5 search and paging, versioned memory entries with their caps,
 * forget, the state rows, and the integrity check and rebuild of both indexes. It is the only
 * reader and writer of the memory tables; each write runs in one `bots.db` transaction.
 */

/**
 * A bot's chat reply is one of its thread's messages too, which capture copies (`<threadId>:<messageId>`). Its chat row
 * (`bm:<id>`) names that message (`BotJournalInput.standsFor`) and stands for it: the copy is never journaled, whichever
 * of the two is written first. The state key below records the pairing; it outlives a Forget of the chat row, so a
 * transcript copied again never brings the forgotten words back. Only that message is paired: the lines a turn said
 * between its steps are messages of their own, whatever their words.
 */
const REPLY_COPY_KEY = 'reply_copy:'

/** The `bots.db` connection the store works on (`BotStore.db`). */
export type BotMemoryDb = Pick<ProfileDatabase, 'statement' | 'inTransaction' | 'transaction' | 'database'>

/** Capture or a journal write failed: the dispatch fails, and the bot is stuck until it can save again. */
export class BotJournalError extends Error {
  readonly code = 'bot_journal_failed'
  constructor(override readonly cause: unknown) {
    super("I can't save my work. Free some disk space.")
    this.name = 'BotJournalError'
  }
}

/** One journal row as the store reads it. */
export interface BotJournalRow {
  seq: number
  botId: string
  at: string
  kind: BotJournalKind
  lane: BotLane | null
  activationId: string | null
  threadId: string | null
  sourceKey: string
  who: BotJournalWho
  external: boolean
  text: string
  json: Record<string, unknown> | null
  redactedAt: string | null
}

/** One stored memory version. */
export interface BotMemoryVersion {
  id: string
  version: number
  botId: string
  kind: BotMemoryKind
  text: string | null
  textHash: string
  learnedAt: string
  validFrom: string | null
  expiresAt: string | null
  writtenIn: BotMemoryWrittenIn
  sourceSeq: number | null
  status: BotMemoryStatus
  reason: string | null
}

export interface BotMemorySave {
  /** Where the save comes from: a run's save is always a run note. */
  lane: BotLane | 'owner_ui'
  kind: 'owner' | 'note'
  text: string
  replaces?: string
  merges?: string[]
  validFrom?: string
  expiresAt?: string
  activationId?: string
}

export interface BotMemoryForget {
  /** The entry, by `m12` (any version names the whole entry). */
  id?: string
  /** Journal rows to redact (`j123`); memory refs here forget those entries too. */
  refs?: string[]
  by: 'chat' | 'owner_ui'
  activationId?: string
}

export interface BotMemoryStoreOptions {
  db: BotMemoryDb
  /** Milliseconds since the epoch. */
  clock?: () => number
  /** The owner's time zone, for dates in refusals and tombstones. */
  timeZone?: () => string | undefined
  /**
   * Blanks the text of the `bot_messages` row a redacted journal row (`bm:<id>`) mirrors, in the
   * same transaction. Default: an `UPDATE bot_messages`, when that table exists.
   */
  redactMessage?: (tx: BotStoreTx, botId: string, messageId: string, text: string) => void
  /** Checks both FTS indexes at open and rebuilds a broken one (default true). */
  checkIndexes?: boolean
  log?: (message: string, error?: unknown) => void
}

type Row = Record<string, unknown>
type Param = string | number | null

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null)
const KINDS: ReadonlySet<string> = new Set(BOT_JOURNAL_KINDS)
const WHO: ReadonlySet<string> = new Set(['owner', 'bot', 'tool', 'mousse'])
const TOOL_KINDS: ReadonlySet<string> = new Set(['tool_call', 'tool_result'])

/** A redacted row's exact copies are redacted too, from this length on. */
const MIN_COPY_CHARS = 24

/** Kinds no search, read or window returns: a model change names models; the other two restate memory. */
const HIDDEN_KINDS = "'model_change','memory_op','redaction'"

const SEARCH_KIND_SQL: Record<Exclude<BotMemorySearchKind, 'memory'>, string> = {
  chat: "(j.kind IN ('owner_msg','bot_msg','ask','answer','notice') AND COALESCE(j.lane, 'chat') = 'chat')",
  run: "(j.kind IN ('run_start','run_report','run_end') OR (j.lane = 'run' AND j.kind IN ('bot_msg','ask','answer','notice')))",
  tool: "(j.kind IN ('tool_call','tool_result'))"
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function journalRowOf(row: Row): BotJournalRow {
  return {
    seq: num(row.seq)!,
    botId: row.bot_id as string,
    at: row.at as string,
    kind: row.kind as BotJournalKind,
    lane: str(row.lane) as BotLane | null,
    activationId: str(row.activation_id),
    threadId: str(row.thread_id),
    sourceKey: row.source_key as string,
    who: row.who as BotJournalWho,
    external: num(row.external) === 1,
    text: row.text as string,
    json: parseJson(row.json),
    redactedAt: str(row.redacted_at)
  }
}

function versionOf(row: Row): BotMemoryVersion {
  return {
    id: row.id as string,
    version: num(row.version)!,
    botId: row.bot_id as string,
    kind: row.kind as BotMemoryKind,
    text: str(row.text),
    textHash: row.text_hash as string,
    learnedAt: row.learned_at as string,
    validFrom: str(row.valid_from),
    expiresAt: str(row.expires_at),
    writtenIn: row.written_in as BotMemoryWrittenIn,
    sourceSeq: num(row.source_seq),
    status: row.status as BotMemoryStatus,
    reason: str(row.reason)
  }
}

export function entryOf(version: BotMemoryVersion): BotMemoryEntry {
  return {
    id: version.id,
    version: version.version,
    ref: memoryRef(version.id, version.version),
    kind: version.kind,
    text: version.text,
    since: version.validFrom ?? version.learnedAt,
    ...(version.expiresAt ? { until: version.expiresAt } : {}),
    learnedAt: version.learnedAt,
    by: version.writtenIn === 'run' ? 'a run' : version.writtenIn === 'dream' ? 'cleanup' : 'you said',
    ...(version.reason?.startsWith('merged into ') ? { absorbedBy: version.reason.slice(12) } : {}),
    status: version.status
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The hash a memory text is known by: the same words in another case or spacing are the same fact. */
export function memoryTextHash(text: string): string {
  return sha256(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?;,]+$/u, '').trim())
}

/**
 * Head and tail of a text within `maxBytes` of UTF-8, with a marker saying how much was cut.
 * Owner and bot messages are never cut; tool rows are (bot-context.md §3).
 */
export function boundText(text: string, maxBytes = MAX_BOT_JOURNAL_TOOL_TEXT_BYTES): { text: string; cut: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { text, cut: false, bytes }
  const half = Math.floor((maxBytes - 40) / 2)
  const buffer = Buffer.from(text)
  // Decoding a cut buffer turns a split character into U+FFFD; trim those.
  const head = buffer.subarray(0, half).toString('utf8').replace(/\uFFFD+$/u, '')
  const tail = buffer.subarray(bytes - half).toString('utf8').replace(/^\uFFFD+/u, '')
  return { text: `${head}\n…[${bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes cut]…\n${tail}`, cut: true, bytes }
}

/** Words of a query as FTS5 phrases: no operator, column filter or quote of the caller reaches MATCH. */
export function ftsTerms(query: string): string[] {
  const words = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(words.map((word) => word.toLowerCase()))].slice(0, 16).map((word) => `"${word.replace(/"/g, '""')}"`)
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export class BotMemoryStore {
  readonly db: BotMemoryDb
  readonly clock: () => number
  private readonly timeZone: () => string | undefined
  private readonly redactMessage: NonNullable<BotMemoryStoreOptions['redactMessage']>
  private readonly log: NonNullable<BotMemoryStoreOptions['log']>

  constructor(options: BotMemoryStoreOptions) {
    this.db = options.db
    // Connection-local only: no persistent schema, data or database-version change.
    let lastQuery = ''
    let queryTerms: string[] = []
    this.db.database.function('bot_memory_search_class', { deterministic: true }, (text, query, allWords) => {
      if (typeof text !== 'string' || typeof query !== 'string') return 0
      if (query !== lastQuery) {
        lastQuery = query
        queryTerms = query.split('\n')
      }
      return classifyMemorySearchText(text, queryTerms, allWords === 1)
    })
    this.clock = options.clock ?? Date.now
    this.timeZone = options.timeZone ?? (() => undefined)
    this.log = options.log ?? (() => {})
    this.redactMessage = options.redactMessage ?? defaultRedactMessage
    // Profile-wide repair, deliberately separate from the bots.db schema version.
    this.write(() => {
      const key = 'request_frames_external_v1'
      if (this.getState('', key)) return
      this.run(`UPDATE bot_journal SET external = 1 WHERE kind IN ('notice', 'run_start')
        AND (instr(text, '[output]') > 0 OR instr(text, '[data from ') > 0 OR instr(text, '[Message from the bot "') > 0)`)
      this.setState('', key, true)
    })
    this.write(() => {
      const key = 'reply_copies_v1'
      if (this.getState('', key)) return
      this.pairLegacyReplies()
      this.setState('', key, true)
    })
    if (options.checkIndexes !== false) this.checkIndexes()
  }

  now(): string {
    return new Date(this.clock()).toISOString()
  }

  zone(): string | undefined {
    return this.timeZone()
  }

  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.statement(sql).get(...params) as Row | undefined
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.statement(sql).all(...params) as Row[]
  }

  private run(sql: string, ...params: Param[]): number {
    return Number(this.db.statement(sql).run(...params).changes)
  }

  /** Runs `work` in one transaction; a failed write becomes `BotJournalError`. */
  write<T>(work: () => T): T {
    try {
      return this.db.transaction(work)
    } catch (error) {
      throw error instanceof BotJournalError ? error : new BotJournalError(error)
    }
  }

  // -- Journal ---------------------------------------------------------------------------------

  /**
   * Writes one journal row on `tx`, the caller's `bots.db` transaction. Idempotent on
   * `(botId, sourceKey)`: a second write of the same key adds nothing. Returns the row's seq, or
   * undefined when it already existed.
   */
  appendInTx(tx: BotStoreTx, row: BotJournalInput, at?: string): number | undefined {
    if (!KINDS.has(row.kind)) throw new BotJournalError(new Error(`Unknown journal kind ${row.kind}`))
    if (!WHO.has(row.who)) throw new BotJournalError(new Error(`Unknown journal author ${row.who}`))
    const when = at ?? this.now()
    const json: Record<string, unknown> = row.json && typeof row.json === 'object' && !Array.isArray(row.json)
      ? { v: 1, ...(row.json as Record<string, unknown>) }
      : row.json === undefined ? {} : { v: 1, value: row.json }
    let text = row.text
    if (TOOL_KINDS.has(row.kind)) {
      const bounded = boundText(text)
      if (bounded.cut) Object.assign(json, { v: 1, sha256: sha256(text), bytes: bounded.bytes, cut: true })
      text = bounded.text
    }
    const keys = typeof json.tool === 'string' ? json.tool : ''
    try {
      const inserted = tx.statement(`INSERT INTO bot_journal(bot_id, at, kind, lane, activation_id, thread_id, source_key, who, external, text, keys, json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id, source_key) DO NOTHING RETURNING seq`).get(
        row.botId, when, row.kind, row.lane ?? null, row.activationId ?? null, row.threadId ?? null, row.sourceKey, row.who,
        row.external ? 1 : 0, text, keys, Object.keys(json).length ? JSON.stringify(json) : null
      ) as Row | undefined
      if (inserted && row.kind === 'owner_msg')
        tx.statement(`INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, 'last_owner_msg_at', ?)
          ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value WHERE excluded.value > bot_memory_state.value`).run(row.botId, when)
      // A chat reply that is a thread's message: the chat row stands for it from now on, and a copy capture already
      // wrote goes, so the history, search and an export hold the reply once.
      if (inserted && row.standsFor) this.pairReplyInTx(tx, row.botId, row.sourceKey, row.standsFor)
      return inserted ? num(inserted.seq)! : undefined
    } catch (error) {
      throw new BotJournalError(error)
    }
  }

  /**
   * Journals written before chat rows named their message hold each chat reply twice: its chat row, and the copy of its
   * thread's message. Once per profile, each chat row is paired with an unpaired copy of exactly its words in its own
   * activation (an indexed lookup each), as if it had named it. A chat row holding more than the copy's words (the cards
   * it carries) is left with its copy: a line said between steps may begin the same way, and is a message of its own.
   */
  private pairLegacyReplies(): void {
    const paired = new Set<number>()
    const replies = this.all(`SELECT bot_id, activation_id, source_key, text FROM bot_journal
      WHERE kind = 'bot_msg' AND lane = 'chat' AND substr(source_key, 1, 3) = 'bm:' AND activation_id IS NOT NULL AND redacted_at IS NULL ORDER BY seq`)
    for (const reply of replies) {
      const copy = this.all(`SELECT seq, source_key FROM bot_journal WHERE activation_id = ? AND bot_id = ? AND kind = 'bot_msg' AND lane = 'chat'
        AND substr(source_key, 1, 3) <> 'bm:' AND redacted_at IS NULL AND text = ? ORDER BY seq`, reply.activation_id as string, reply.bot_id as string, reply.text as string)
        .find((row) => !paired.has(num(row.seq)!))
      if (!copy) continue
      paired.add(num(copy.seq)!)
      this.pairReplyInTx(this.db, reply.bot_id as string, reply.source_key as string, copy.source_key as string)
    }
  }

  /** `standsFor`'s copy is the chat row `reply`: recorded for capture (`putCaptured`), and an unredacted copy goes. */
  private pairReplyInTx(tx: BotStoreTx, botId: string, reply: string, standsFor: string): void {
    tx.statement('INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?) ON CONFLICT(bot_id, key) DO NOTHING')
      .run(botId, `${REPLY_COPY_KEY}${standsFor}`, JSON.stringify(reply))
    tx.statement('DELETE FROM bot_journal WHERE bot_id = ? AND source_key = ? AND redacted_at IS NULL').run(botId, standsFor)
  }

  /** Writes one journal row in its own transaction. */
  append(row: BotJournalInput, at?: string): number | undefined {
    return this.write(() => this.appendInTx(this.db, row, at))
  }

  /**
   * Writes a row copied from a bot thread (capture), inside the caller's transaction. A row first
   * copied while unsettled (`partial`) is replaced by its final form; a settled or redacted row
   * never changes.
   */
  putCaptured(row: BotJournalInput & { at: string }, partial: boolean): void {
    const existing = this.get('SELECT seq, json, redacted_at FROM bot_journal WHERE bot_id = ? AND source_key = ?', row.botId, row.sourceKey)
    const json = { ...((row.json as Record<string, unknown> | undefined) ?? {}), sha256: sha256(row.text), ...(partial ? { partial: true } : {}) }
    if (!existing) {
      // A chat reply's message: its chat row stands for it (`REPLY_COPY_KEY`), forgotten or not.
      if (row.kind === 'bot_msg' && this.get('SELECT 1 FROM bot_memory_state WHERE bot_id = ? AND key = ?', row.botId, `${REPLY_COPY_KEY}${row.sourceKey}`)) return
      for (const part of row.kind === 'notice' ? requestJournalRows({ ...row, json }) : [{ ...row, json }])
        this.appendInTx(this.db, part, row.at)
      return
    }
    const stored = parseJson(existing.json)
    if (existing.redacted_at || !stored?.partial || stored.sha256 === json.sha256 && partial) return
    const bounded = TOOL_KINDS.has(row.kind) ? boundText(row.text) : { text: row.text, cut: false, bytes: 0 }
    const final = { v: 1, ...json, ...(bounded.cut ? { bytes: bounded.bytes, cut: true } : {}) }
    try {
      this.run('UPDATE bot_journal SET text = ?, json = ?, external = ? WHERE seq = ?', bounded.text, JSON.stringify(final), row.external ? 1 : 0, num(existing.seq)!)
    } catch (error) {
      throw new BotJournalError(error)
    }
  }

  journalRow(botId: string, seq: number): BotJournalRow | undefined {
    const row = this.get('SELECT * FROM bot_journal WHERE bot_id = ? AND seq = ?', botId, seq)
    return row ? journalRowOf(row) : undefined
  }

  /** The journal provenance of a chat message, including service lines shown with a bot author. */
  journalMessage(botId: string, messageId: string): BotJournalRow | undefined {
    const row = this.get('SELECT * FROM bot_journal WHERE bot_id = ? AND source_key = ?', botId, `bm:${messageId}`)
    return row ? journalRowOf(row) : undefined
  }

  /** Searchable messages, without loading their text or counting tool and bookkeeping rows. */
  messageHistory(botId: string): { count: number; since?: string } {
    const row = this.get(`SELECT COUNT(*) AS n, MIN(at) AS since FROM bot_journal
      WHERE bot_id = ? AND kind IN ('owner_msg', 'bot_msg', 'run_report') AND redacted_at IS NULL`, botId)!
    return { count: num(row.n) ?? 0, ...(typeof row.since === 'string' ? { since: row.since } : {}) }
  }

  /** Every journal row of a bot, oldest first (export). */
  journal(botId: string): BotJournalRow[] {
    return this.all('SELECT * FROM bot_journal WHERE bot_id = ? ORDER BY seq', botId).map(journalRowOf)
  }

  /**
   * The chat rows the verbatim window carries (owner messages, bot replies, run reports, and the line a chat turn left
   * when it failed, was interrupted or was stopped), from `fromSeq`.
   */
  windowRows(botId: string, fromSeq: number): BotJournalRow[] {
    return this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND seq >= ? AND (
        (kind IN ('owner_msg','bot_msg','run_report') AND source_key LIKE 'bm:%')
        OR (kind = 'notice' AND (substr(source_key, 1, ?) = ? OR substr(source_key, 1, 13) = 'bm:bm_action_'))
      ) ORDER BY seq`, botId, fromSeq, BOT_CHAT_TURN_END_KEY.length, BOT_CHAT_TURN_END_KEY).map(journalRowOf)
  }

  /** Run reports, newest first: of the runs of `scheduleId`, or of any run when it is absent. */
  runReports(botId: string, input: { scheduleId?: string; excludeActivationId?: string; limit: number }): BotJournalRow[] {
    const exclude = input.excludeActivationId ?? ''
    if (input.scheduleId === undefined)
      return this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'run_report' AND COALESCE(activation_id, '') <> ?
        ORDER BY seq DESC LIMIT ?`, botId, exclude, input.limit).map(journalRowOf)
    return this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'run_report' AND COALESCE(activation_id, '') <> ?
      AND activation_id IN (SELECT activation_id FROM bot_journal WHERE bot_id = ? AND kind = 'run_start'
        AND json_extract(json, '$.scheduleId') = ? AND activation_id IS NOT NULL)
      ORDER BY seq DESC LIMIT ?`, botId, exclude, botId, input.scheduleId, input.limit).map(journalRowOf)
  }

  /** The latest `run_start` of a schedule (or of any run), other than `excludeActivationId`'s. */
  lastRunStart(botId: string, input: { scheduleId?: string; excludeActivationId?: string }): BotJournalRow | undefined {
    const exclude = input.excludeActivationId ?? ''
    const row = input.scheduleId === undefined
      ? this.get(`SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'run_start' AND COALESCE(activation_id, '') <> ? ORDER BY seq DESC LIMIT 1`, botId, exclude)
      : this.get(`SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'run_start' AND COALESCE(activation_id, '') <> ?
          AND json_extract(json, '$.scheduleId') = ? ORDER BY seq DESC LIMIT 1`, botId, exclude, input.scheduleId)
    return row ? journalRowOf(row) : undefined
  }

  /** Owner messages, newest first: after `afterSeq`, or at or before `atOrBefore`, or the latest. */
  ownerMessages(botId: string, input: { afterSeq?: number; atOrBefore?: string; limit: number }): BotJournalRow[] {
    if (input.afterSeq !== undefined)
      return this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' AND seq > ? ORDER BY seq DESC LIMIT ?", botId, input.afterSeq, input.limit).map(journalRowOf)
    if (input.atOrBefore !== undefined)
      return this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' AND at <= ? ORDER BY seq DESC LIMIT ?", botId, input.atOrBefore, input.limit).map(journalRowOf)
    return this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' ORDER BY seq DESC LIMIT ?", botId, input.limit).map(journalRowOf)
  }

  /**
   * One activation's owner messages after `afterSeq`, oldest first, and whether that activation
   * tried a `memory_save` or saved anything after it: what the missed-wish fallback reads.
   */
  activationSince(botId: string, activationId: string, afterSeq: number): { owner: BotJournalRow[]; saved: boolean } {
    const owner = this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND activation_id = ? AND kind = 'owner_msg' AND seq > ? AND redacted_at IS NULL ORDER BY seq LIMIT 20",
      botId, activationId, afterSeq).map(journalRowOf)
    const saved = this.get(`SELECT 1 FROM bot_journal WHERE bot_id = ? AND activation_id = ? AND seq > ? AND (
      (kind = 'tool_call' AND json_extract(json, '$.tool') = 'memory_save') OR (kind = 'memory_op' AND json_extract(json, '$.op') = 'save')) LIMIT 1`,
    botId, activationId, afterSeq) !== undefined
    return { owner, saved }
  }

  /** The bot's latest journal seq (0 without rows). */
  lastSeq(botId: string): number {
    return num(this.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM bot_journal WHERE bot_id = ?', botId)?.seq) ?? 0
  }

  lastOfKind(botId: string, kind: BotJournalKind): BotJournalRow | undefined {
    const row = this.get('SELECT * FROM bot_journal WHERE bot_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1', botId, kind)
    return row ? journalRowOf(row) : undefined
  }

  /** The bot's journal rows of `kind` after `afterSeq`, oldest first. */
  rowsOfKindAfter(botId: string, kind: BotJournalKind, afterSeq: number): BotJournalRow[] {
    return this.all('SELECT * FROM bot_journal WHERE bot_id = ? AND kind = ? AND seq > ? ORDER BY seq', botId, kind, afterSeq).map(journalRowOf)
  }

  // -- Search and read ---------------------------------------------------------------------------

  /**
   * `memory_search` (bot-context.md §6): ordinary memory hits first, then ordinary journal rows,
   * in full-index FTS relevance order. Credential-bearing survivors follow by recency, never by
   * raw relevance. Every word must match first;
   * when that finds too few, any word may. No query: the latest by date.
   */
  search(botId: string, input: BotMemorySearchInput): BotMemoryHit[] {
    const now = this.clock()
    this.expireMemories(botId)
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? BOT_MEMORY_SEARCH_LIMIT)), MAX_BOT_MEMORY_SEARCH_LIMIT)
    const kinds = new Set<BotMemorySearchKind>(input.kinds?.length ? input.kinds : ['chat', 'run', 'tool', 'memory'])
    // A bare date is the owner's day, in their zone (the times the bot reads are in it too); as `until` it includes that day.
    const since = (input.since && zonedDayBound(input.since, this.zone())) ?? isoOrUndefined(input.since) ?? ''
    const until = (input.until && zonedDayBound(input.until, this.zone(), true)) ?? isoOrUndefined(input.until) ?? '9999'
    const terms = ftsTerms(input.query ?? '')
    const journalKinds = (['chat', 'run', 'tool'] as const).filter((kind) => kinds.has(kind)).map((kind) => SEARCH_KIND_SQL[kind])
    const hits: BotMemoryHit[] = []
    const seen = new Set<string>()
    // The same text twice (a reply as the chat row and as the copied thread row) is one hit.
    const push = (hit: BotMemoryHit, text: unknown) => {
      const key = `t:${sha256(typeof text === 'string' ? text.trim() : '')}`
      if (hits.length >= limit || seen.has(key) || seen.has(hit.ref)) return
      seen.add(key)
      seen.add(hit.ref)
      hits.push(hit)
    }
    // FTS snippets can cut a credential or insert highlights inside it. Mask the full text
    // first; when it contains a secret, use that safe text rather than the raw FTS excerpt.
    const snippet = (row: Row, fallback: (text: string) => string): string => {
      const text = row.text as string
      const masked = maskMemoryCredentials(text)
      return masked === text ? str(row.snip) ?? fallback(text) : cut(masked, 240)
    }
    const memoryHit = (row: Row): BotMemoryHit => ({
      ref: memoryRef(row.id as string, num(row.version)!),
      at: row.learned_at as string,
      ago: agoLabel(row.learned_at as string, now),
      kind: `memory:${row.kind as string}${row.status === 'expired' ? ' (expired)' : ''}`,
      who: row.written_in === 'run' ? 'bot' : 'owner',
      snippet: snippet(row, (text) => text)
    })
    const journalHit = (row: Row): BotMemoryHit => ({
      ref: `j${num(row.seq)!}`,
      at: row.at as string,
      ago: agoLabel(row.at as string, now),
      // A digest of the chat is a notice row of its own key: the hit says what it is.
      kind: String(row.source_key).startsWith(CHAT_DIGEST_KEY) ? 'chat digest' : row.kind as string,
      who: row.who as string,
      snippet: snippet(row, (text) => cut(text, 240))
    })
    const journalWhere = `j.bot_id = ? AND j.redacted_at IS NULL AND j.kind NOT IN (${HIDDEN_KINDS}) AND (${journalKinds.join(' OR ')}) AND j.at >= ? AND j.at <= ?`
    if (!terms.length) {
      if (kinds.has('memory'))
        for (const row of this.all(`SELECT * FROM bot_memories WHERE bot_id = ? AND status IN ('active','expired') AND learned_at >= ? AND learned_at <= ?
          ORDER BY learned_at DESC, row_id DESC LIMIT ?`, botId, since, until, limit)) push(memoryHit(row), row.text)
      if (journalKinds.length)
        for (const row of this.all(`SELECT * FROM bot_journal j WHERE ${journalWhere} ORDER BY j.seq DESC LIMIT ?`, botId, since, until, limit * 2))
          push(journalHit(row), row.text)
      return hits
    }
    // Classify each raw match once before sorting, so hidden matches cannot change
    // which ordinary rows reach the iterator or its stopping condition.
    const query = terms.map((term) => term.slice(1, -1)).join('\n')
    const candidates = (memory: boolean, allWords: boolean): { ordinary: Row[]; guarded: Row[] } => {
      const match = terms.join(allWords ? ' AND ' : ' OR ')
      const ordinary: Row[] = []
      const guarded: Row[] = []
      const unique = new Set<string>()
      const rows = memory
        ? this.db.statement(`WITH classified AS MATERIALIZED (
          SELECT m.*, snippet(bot_memories_fts, 0, '«', '»', '…', 16) AS snip, bm25(bot_memories_fts) AS score,
            bot_memory_search_class(m.text, ?, ?) AS search_class
          FROM bot_memories_fts JOIN bot_memories m ON m.row_id = bot_memories_fts.rowid
          WHERE bot_memories_fts MATCH ? AND m.bot_id = ? AND m.status IN ('active','expired') AND m.learned_at >= ? AND m.learned_at <= ?
        ) SELECT * FROM classified WHERE search_class > 0
          ORDER BY search_class, CASE WHEN search_class = 1 THEN score ELSE 0 END, learned_at DESC, row_id DESC`)
          .iterate(query, allWords ? 1 : 0, match, botId, since, until)
        : this.db.statement(`WITH classified AS MATERIALIZED (
          SELECT j.*, snippet(bot_journal_fts, 0, '«', '»', '…', 16) AS snip, bm25(bot_journal_fts) AS score,
            bot_memory_search_class(j.text, ?, ?) AS search_class
          FROM bot_journal_fts JOIN bot_journal j ON j.seq = bot_journal_fts.rowid
          WHERE bot_journal_fts MATCH ? AND ${journalWhere}
        ) SELECT * FROM classified WHERE search_class > 0
          ORDER BY search_class, CASE WHEN search_class = 1 THEN score ELSE 0 END, seq DESC`)
          .iterate(query, allWords ? 1 : 0, match, botId, since, until)
      try {
        for (const entry of rows) {
          const row = entry as Row
          const text = row.text as string
          const masked = num(row.search_class) === 2
          const ref = memory ? memoryRef(row.id as string, num(row.version)!) : `j${num(row.seq)!}`
          const key = `t:${sha256(text.trim())}`
          if (seen.has(ref) || seen.has(key)) continue
          if (unique.has(key)) continue
          unique.add(key)
          if (masked) guarded.push(row)
          else ordinary.push(row)
          // SQLite emits all ordinary rows before guarded rows, which are already by
          // date. No cutoff depends on how many hidden-only raw matches there were.
          if (ordinary.length + guarded.length >= limit - hits.length) break
        }
        return { ordinary, guarded }
      } finally {
        rows.return?.()
      }
    }
    for (const allWords of terms.length > 1 ? [true, false] : [true]) {
      if (hits.length >= limit) break
      const deferred: Array<{ row: Row; memory: boolean }> = []
      for (const memory of [true, false]) {
        if (hits.length >= limit) break
        if (memory ? !kinds.has('memory') : !journalKinds.length) continue
        const result = candidates(memory, allWords)
        for (const row of result.ordinary) push(memory ? memoryHit(row) : journalHit(row), row.text)
        deferred.push(...result.guarded.map((row) => ({ row, memory })))
      }
      deferred.sort((a, b) => String(b.memory ? b.row.learned_at : b.row.at).localeCompare(String(a.memory ? a.row.learned_at : a.row.at)) ||
        num(b.row[b.memory ? 'row_id' : 'seq'])! - num(a.row[a.memory ? 'row_id' : 'seq'])!)
      for (const { row, memory } of deferred) push(memory ? memoryHit(row) : journalHit(row), row.text)
    }
    return hits
  }

  /**
   * `memory_read`: rows around a hit (`j123`, at most 20 each side), a memory entry's versions
   * (`m12`), or one activation's rows page by page. A page holds about 8k tokens at most; a
   * redacted row shows its tombstone.
   */
  read(botId: string, input: { ref: string; before?: number; after?: number } | { activationId: string; cursor?: string }): { rows: BotMemoryRow[]; cursor?: string; guidance?: string } | { error: string } {
    const budget = BOT_MEMORY_READ_PAGE_TOKENS * 4
    const rowOf = (row: BotJournalRow, max: number): BotMemoryRow => {
      const text = maskMemoryCredentials(row.text)
      return {
        ref: `j${row.seq}`,
        at: row.at,
        kind: row.kind,
        who: row.who,
        text: text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more characters: read j${row.seq} alone]` : text
      }
    }
    if ('activationId' in input) {
      const after = input.cursor ? Number(/^j(\d+)$/.exec(input.cursor)?.[1] ?? NaN) : 0
      if (!Number.isFinite(after)) return { error: 'That cursor is not one memory_read gave.' }
      const rows = this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND activation_id = ? AND seq > ? AND kind NOT IN (${HIDDEN_KINDS})
        ORDER BY seq LIMIT 200`, botId, input.activationId, after).map(journalRowOf)
      const page: BotMemoryRow[] = []
      let used = 0
      for (const row of rows) {
        const shown = rowOf(row, Math.max(2_000, budget - used))
        if (page.length && used + shown.text.length > budget) return { rows: page, cursor: page[page.length - 1]!.ref }
        page.push(shown)
        used += shown.text.length
      }
      return rows.length === 200 ? { rows: page, cursor: page[page.length - 1]!.ref } : { rows: page }
    }
    const memory = parseMemoryRef(input.ref)
    if (memory) {
      const versions = this.versions(botId, memory.id)
      if (!versions.length) return { error: `There is no memory entry ${input.ref}.` }
      const guidance = this.copyAdvice(botId, versions.at(-1)!)
      return {
        ...(guidance ? { guidance } : {}),
        rows: versions.map((version) => ({
          ref: memoryRef(version.id, version.version),
          at: version.learnedAt,
          kind: `memory:${version.kind} (${version.status}${version.reason?.startsWith('merged into ') ? `, ${version.reason}` : ''})`,
          who: version.writtenIn === 'run' ? 'bot' : 'owner',
          text: maskMemoryCredentials(version.text ?? '[removed at your request]')
        }))
      }
    }
    const seq = Number(/^j(\d+)$/.exec(input.ref.trim())?.[1] ?? NaN)
    const hit = Number.isFinite(seq) ? this.journalRow(botId, seq) : undefined
    if (!hit || hit.kind === 'model_change') return { error: `There is no row ${input.ref}.` }
    const around = (n: number | undefined) => Math.min(Math.max(0, Math.floor(n ?? 3)), MAX_BOT_MEMORY_READ_AROUND)
    const before = this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND seq < ? AND kind NOT IN (${HIDDEN_KINDS}) ORDER BY seq DESC LIMIT ?`,
      botId, seq, around(input.before)).map(journalRowOf).reverse()
    const after = this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND seq > ? AND kind NOT IN (${HIDDEN_KINDS}) ORDER BY seq LIMIT ?`,
      botId, seq, around(input.after)).map(journalRowOf)
    const neighbours = before.length + after.length
    // The hit gets half the page; its neighbours share the rest.
    const each = neighbours ? Math.max(400, Math.floor(budget / 2 / neighbours)) : budget
    return { rows: [...before.map((row) => rowOf(row, each)), rowOf(hit, neighbours ? budget / 2 : budget), ...after.map((row) => rowOf(row, each))] }
  }

  // -- Memory entries ---------------------------------------------------------------------------

  /** Same retirement representation as memory_save.merges, including the Forget links. */
  private absorb(botId: string, entry: BotMemoryVersion, absorbedBy: string): void {
    this.run("UPDATE bot_memories SET status = 'superseded', reason = ? WHERE bot_id = ? AND id = ? AND status = 'active'", `merged into ${absorbedBy}`, botId, entry.id)
    this.run(`INSERT INTO bot_memories(id, version, bot_id, kind, text, text_hash, learned_at, valid_from, expires_at, written_in, source_seq, status, reason)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'superseded', ?)`,
    entry.id, entry.version + 1, botId, entry.kind, entry.text, entry.textHash, entry.learnedAt,
    entry.validFrom, entry.expiresAt, entry.writtenIn, entry.sourceSeq, `merged into ${absorbedBy}`)
  }

  /** A copy points to the version that absorbed it; later corrections keep that identity. */
  private copyAdvice(botId: string, entry: BotMemoryVersion): string | undefined {
    if (entry.status !== 'superseded' || !entry.reason?.startsWith('merged into ')) return undefined
    const ref = parseMemoryRef(entry.reason.slice(12))
    if (!ref) return undefined
    const absorbedInto = this.get('SELECT text_hash FROM bot_memories WHERE bot_id = ? AND id = ? AND version = ?', botId, ref.id, ref.version ?? 1)
    if (absorbedInto?.text_hash !== entry.textHash) return undefined
    const kept = this.current(botId, ref.id)
    if (!kept || (kept.status !== 'active' && kept.status !== 'expired')) return undefined
    const target = memoryRef(kept.id, kept.version)
    return `${entry.id} was put away as a copy of ${target}. To change these words, replace ${target}.`
  }

  /** Exact hashes only. Both chat and run packs load all three kinds in full. */
  tidyDuplicates(botId: string, canTidy?: () => boolean): number {
    const rows = this.all(`SELECT m.* FROM bot_memories m JOIN (
      SELECT text_hash FROM bot_memories WHERE bot_id = ? AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?) GROUP BY text_hash HAVING COUNT(*) > 1
    ) duplicates ON duplicates.text_hash = m.text_hash
    WHERE m.bot_id = ? AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)`,
    botId, this.now(), botId, this.now()).map(versionOf)
    // The activity guard and retirement stay synchronous, so refs cannot change mid-turn.
    if (!rows.length || (canTidy && !canTidy())) return 0
    const rank = { owner: 0, note: 1, run_note: 2 }
    rows.sort((a, b) => rank[a.kind] - rank[b.kind]
      || Number(b.writtenIn === 'owner_ui') - Number(a.writtenIn === 'owner_ui') || a.learnedAt.localeCompare(b.learnedAt)
      || Number(a.id.slice(1)) - Number(b.id.slice(1)))
    const kept = new Map<string, BotMemoryVersion>()
    const retired: Array<{ entry: BotMemoryVersion; into: string }> = []
    for (const entry of rows) {
      const winner = kept.get(entry.textHash)
      if (!winner) { kept.set(entry.textHash, entry); continue }
      if (winner.validFrom && (!entry.validFrom || winner.validFrom > entry.validFrom)) continue
      if (winner.expiresAt && (!entry.expiresAt || winner.expiresAt < entry.expiresAt)) continue
      retired.push({ entry, into: memoryRef(winner.id, winner.version) })
    }
    if (!retired.length) return 0
    return this.write(() => {
      for (const { entry, into } of retired) this.absorb(botId, entry, into)
      const refs = retired.map(({ entry, into }) => ({ ref: memoryRef(entry.id, entry.version), into }))
      this.appendInTx(this.db, {
        botId, kind: 'memory_op', who: 'mousse',
        sourceKey: `tidy:${refs.map(({ ref }) => ref).join(':')}`,
        text: `put away · ${refs.map(({ ref, into }) => `${ref} merged into ${into}`).join(', ')}`,
        json: { op: 'tidy', merges: refs }
      })
      this.dropPacks(botId)
      return retired.length
    })
  }

  /** Moves entries whose `expires_at` passed to `expired`: out of the pack, still listed and searchable. */
  expireMemories(botId: string): void {
    const now = this.now()
    if (this.get("SELECT 1 FROM bot_memories WHERE bot_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 1", botId, now))
      this.write(() => this.run("UPDATE bot_memories SET status = 'expired', reason = 'expired' WHERE bot_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", botId, now))
  }

  versions(botId: string, id: string): BotMemoryVersion[] {
    return this.all('SELECT * FROM bot_memories WHERE bot_id = ? AND id = ? ORDER BY version', botId, id).map(versionOf)
  }

  private current(botId: string, id: string): BotMemoryVersion | undefined {
    const row = this.get('SELECT * FROM bot_memories WHERE bot_id = ? AND id = ? ORDER BY version DESC LIMIT 1', botId, id)
    return row ? versionOf(row) : undefined
  }

  /** The active entries, first learned first: corrections keep their place in every pack. */
  active(botId: string): BotMemoryEntry[] {
    return this.all("SELECT current.* FROM bot_memories current JOIN bot_memories first ON first.bot_id = current.bot_id AND first.id = current.id AND first.version = 1 WHERE current.bot_id = ? AND current.status = 'active' ORDER BY first.learned_at, first.row_id", botId).map((row) => entryOf(versionOf(row)))
  }

  /** `memory_list` / `bots.memory.list`: current entries (active and expired), or every version with `history`. */
  list(botId: string, history = false): BotMemoryListing {
    this.expireMemories(botId)
    const rows = history
      ? this.all('SELECT * FROM bot_memories WHERE bot_id = ? ORDER BY CAST(substr(id, 2) AS INTEGER), version', botId)
      : this.all("SELECT * FROM bot_memories WHERE bot_id = ? AND status IN ('active','expired') ORDER BY learned_at, row_id", botId)
    const active = this.active(botId)
    return { entries: rows.map((row) => entryOf(versionOf(row))), gauge: `${coreGauge(active)} · ${runNotesGauge(active)}` }
  }

  /** The gauge a lane's saves are held to. */
  gauge(botId: string, lane: BotMemorySave['lane']): string {
    const active = this.active(botId)
    return lane === 'run' ? runNotesGauge(active) : coreGauge(active)
  }

  /**
   * The journal row that justified a save: in the chat, the owner's latest message of this
   * activation (else the latest at all); in a run, the run's latest row.
   */
  private sourceSeq(botId: string, lane: BotMemorySave['lane'], activationId?: string): number | null {
    const latestOwner = () => this.get("SELECT seq FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' ORDER BY seq DESC LIMIT 1", botId)
    const row = !activationId
      ? latestOwner()
      : lane === 'run'
        ? this.get('SELECT seq FROM bot_journal WHERE bot_id = ? AND activation_id = ? ORDER BY seq DESC LIMIT 1', botId, activationId)
        : this.get("SELECT seq FROM bot_journal WHERE bot_id = ? AND kind = 'owner_msg' AND activation_id = ? ORDER BY seq DESC LIMIT 1", botId, activationId) ?? latestOwner()
    return row ? num(row.seq) : null
  }

  /**
   * `memory_save` (bot-context.md §7): the lane rules, the guard, absolute dates, the caps, and
   * supersede, never overwrite. A run's save is always a run note and may replace only run notes.
   * Saving the text of an active entry again returns that entry; a forgotten text is refused.
   */
  save(botId: string, input: BotMemorySave): BotMemorySaveResult {
    const text = input.text.trim().replace(/\s+/g, ' ')
    if (!text) return { error: 'refused', reason: 'There is nothing to save.' }
    if (text.length > MAX_BOT_MEMORY_TEXT_CHARS) return { error: 'refused', reason: `Keep each entry under ${MAX_BOT_MEMORY_TEXT_CHARS} characters: split it, or say it shorter.` }
    const guard = guardMemoryText(text)
    if (!guard.ok) return { error: 'refused', reason: guard.message }
    const relative = relativeDateRefusal(text, this.clock(), this.zone())
    if (relative) return { error: 'refused', reason: relative }
    const validFrom = isoOrUndefined(input.validFrom)
    const expiresAt = isoOrUndefined(input.expiresAt)
    if ((input.validFrom && !validFrom) || (input.expiresAt && !expiresAt))
      return { error: 'refused', reason: 'validFrom and expiresAt must be dates, like 2026-11-12.' }
    if (expiresAt && expiresAt <= this.now()) return { error: 'refused', reason: 'That end date has already passed.' }
    const kind: BotMemoryKind = input.lane === 'run' ? 'run_note' : input.kind === 'owner' ? 'owner' : 'note'
    const writtenIn: BotMemoryWrittenIn = input.lane === 'owner_ui' ? 'owner_ui' : input.lane
    const hash = memoryTextHash(text)
    this.expireMemories(botId)
    return this.write((): BotMemorySaveResult => {
      if (input.lane !== 'owner_ui' && this.get("SELECT 1 FROM bot_memories WHERE bot_id = ? AND text_hash = ? AND status = 'forgotten' LIMIT 1", botId, hash))
        return { error: 'refused', reason: 'The owner asked me to forget this. Save it again only if the owner tells it to you again.' }
      let replaced: BotMemoryVersion | undefined
      if (input.replaces !== undefined) {
        const ref = parseMemoryRef(input.replaces)
        replaced = ref ? this.current(botId, ref.id) : undefined
        if (!ref || !replaced) return { error: 'refused', reason: `There is no memory entry ${input.replaces}.` }
        const advice = this.copyAdvice(botId, replaced)
        if (advice) return { error: 'refused', reason: advice }
        if (replaced.status === 'forgotten') return { error: 'refused', reason: `${ref.id} was forgotten: save a new entry instead.` }
        if (input.lane === 'run' && replaced.kind !== 'run_note') return { error: 'refused', reason: 'A run or a turn you started yourself can only replace run notes. Ask the owner in the chat.' }
        if ((ref.version ?? 1) !== replaced.version)
          return { error: 'stale', current: { id: replaced.id, version: replaced.version, ref: memoryRef(replaced.id, replaced.version), text: replaced.text ?? '', ...(replaced.reason?.startsWith('merged into ') ? { absorbedBy: replaced.reason.slice(12) } : {}) } }
      }
      const absorbed = new Map<string, BotMemoryVersion>()
      for (const value of input.merges ?? []) {
        const ref = parseMemoryRef(value)
        const entry = ref ? this.current(botId, ref.id) : undefined
        if (!ref || !entry) return { error: 'refused', reason: `There is no memory entry ${value}.` }
        const advice = this.copyAdvice(botId, entry)
        if (advice) return { error: 'refused', reason: advice }
        if ((ref.version ?? 1) !== entry.version)
          return { error: 'stale', current: { id: entry.id, version: entry.version, ref: memoryRef(entry.id, entry.version), text: entry.text ?? '', ...(entry.reason?.startsWith('merged into ') ? { absorbedBy: entry.reason.slice(12) } : {}) } }
        if (entry.status !== 'active') return { error: 'refused', reason: entry.reason?.startsWith('merged into ') ? `${value} was ${entry.reason}. Read that entry instead.` : `${value} is not an active memory entry.` }
        if (input.lane === 'run' && (entry.kind !== 'run_note' || entry.writtenIn === 'owner_ui'))
          return { error: 'refused', reason: 'A run or a turn you started yourself can only absorb run notes that the owner has not edited. Ask the owner in the chat.' }
        if (entry.kind !== kind) return { error: 'refused', reason: 'Absorbed entries must be of the same kind as the saved entry.' }
        if (entry.id !== replaced?.id) absorbed.set(entry.id, entry)
      }
      const duplicates = this.all("SELECT * FROM bot_memories WHERE bot_id = ? AND text_hash = ? AND status = 'active'", botId, hash)
      const outside = duplicates.find((entry) => entry.id !== replaced?.id && !absorbed.has(entry.id as string))
      if (outside && input.merges?.length) {
        const entry = versionOf(outside)
        return { error: 'refused', reason: `That text is already active as ${memoryRef(entry.id, entry.version)}.` }
      }
      const duplicate = duplicates.find((entry) => entry.kind === kind)
      if (duplicate && !replaced && !absorbed.size) {
        const version = versionOf(duplicate)
        return { id: version.id, version: version.version, ref: memoryRef(version.id, version.version), gauge: this.gauge(botId, input.lane) }
      }
      const active = this.active(botId)
      const others = active.filter((entry) => entry.kind === kind && entry.id !== replaced?.id && !absorbed.has(entry.id))
      if (usedTokens(others) + estimateTokens(text) > BOT_MEMORY_CAPS[kind])
        return {
          error: 'over_cap',
          gauge: memoryGauge(kind === 'run_note' ? 'run notes' : kind === 'owner' ? 'owner' : 'notes', usedTokens(active.filter((entry) => entry.kind === kind)), BOT_MEMORY_CAPS[kind]),
          core: active.filter((entry) => entry.kind === kind).map((entry) => ({ id: entry.id, ref: entry.ref, text: entry.text ?? '' }))
        }
      const at = this.now()
      const id = replaced?.id ?? `m${num(this.get('SELECT COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) + 1 AS next FROM bot_memories WHERE bot_id = ?', botId)!.next)!}`
      const version = (replaced?.version ?? 0) + 1
      if (replaced) this.run("UPDATE bot_memories SET status = 'superseded', reason = 'replaced' WHERE bot_id = ? AND id = ? AND status IN ('active','expired')", botId, id)
      this.run(`INSERT INTO bot_memories(id, version, bot_id, kind, text, text_hash, learned_at, valid_from, expires_at, written_in, source_seq, status)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      id, version, botId, kind, text, hash, at, validFrom ?? null, expiresAt ?? null, writtenIn, this.sourceSeq(botId, input.lane, input.activationId))
      const absorbedBy = memoryRef(id, version)
      for (const entry of absorbed.values()) {
        this.absorb(botId, entry, absorbedBy)
      }
      this.appendInTx(this.db, {
        botId,
        kind: 'memory_op',
        ...(input.lane === 'owner_ui' ? {} : { lane: input.lane }),
        ...(input.activationId ? { activationId: input.activationId } : {}),
        sourceKey: `mem:${id}:v${version}`,
        who: input.lane === 'owner_ui' ? 'owner' : 'bot',
        text: `remembered · ${text}`,
        json: { op: 'save', memId: id, version, kind, ...(absorbed.size ? { merges: [...absorbed.values()].map((entry) => memoryRef(entry.id, entry.version)) } : {}), ...(replaced ? { replaces: memoryRef(replaced.id, replaced.version) } : {}) }
      }, at)
      // The next dispatch of every activation, a resumed one too, carries the new entry.
      this.dropPacks(botId)
      return {
        id, version, ref: memoryRef(id, version), gauge: this.gauge(botId, input.lane),
        ...(absorbed.size ? { absorbed: [...absorbed.values()].map((entry) => ({ ref: memoryRef(entry.id, entry.version), text: entry.text ?? '' })) } : {})
      }
    })
  }

  /**
   * Forget (bot-context.md §8): the entry becomes a tombstone (text gone, hash kept, so it is not
   * learned again); cited journal rows, and rows of exactly the same text, are redacted with their
   * FTS rows; memory versions citing a redacted row are tombstoned; the mirrored `bot_messages` text
   * is blanked; the entry's `memory_op` rows are redacted; the chat summary and the frozen packs
   * lose it too. The reason is not stored: it often restates what was forgotten.
   */
  forget(botId: string, input: BotMemoryForget): BotMemoryForgetResult | { error: string; holders?: BotMemoryEntry[] } {
    const ids = new Set<string>()
    const seqs = new Set<number>()
    for (const value of [...(input.id === undefined ? [] : [input.id]), ...(input.refs ?? [])]) {
      const memory = parseMemoryRef(value)
      const journal = /^j(\d{1,15})$/.exec(value.trim())
      if (memory) {
        if (!this.current(botId, memory.id)) return { error: `There is no memory entry ${value}.` }
        ids.add(memory.id)
      } else if (journal && this.journalRow(botId, Number(journal[1]))) seqs.add(Number(journal[1]))
      else return { error: journal ? `There is no row ${value}.` : `${value} is not a ref like j123 or m12.` }
    }
    if (!ids.size && !seqs.size) return { error: 'Say which entry (id) or rows (refs) to forget.' }
    return this.write(() => {
      const at = this.now()
      const tombstone = `[removed at your request · ${dayLabel(at, this.zone())}]`
      const redacted: string[] = []
      const redactedSeqs = new Set<number>()
      const forgottenTexts: string[] = []
      const redact = (row: BotJournalRow) => {
        if (row.redactedAt || redactedSeqs.has(row.seq)) return
        forgottenTexts.push(row.text)
        this.run("UPDATE bot_journal SET text = ?, keys = '', json = NULL, redacted_at = ? WHERE seq = ?", tombstone, at, row.seq)
        // Treat review copies as cited rows too, so folds/digests sourced only from them are invalidated.
        if (/^bm:bm_action_[a-zA-Z0-9-]+$/.test(row.sourceKey)) {
          const statusPrefix = `${row.sourceKey}:status:`
          const copies = this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND redacted_at IS NULL
            AND (source_key IN (?, ?) OR substr(source_key, 1, ?) = ?)`,
          botId, `${row.sourceKey}_n1`, `${row.sourceKey}_n2`, statusPrefix.length, statusPrefix).map(journalRowOf)
          for (const copy of copies) redact(copy)
        }
        if (row.sourceKey.startsWith('bm:')) this.redactMessage(this.db, botId, row.sourceKey.slice(3), tombstone)
        redacted.push(`j${row.seq}`)
        redactedSeqs.add(row.seq)
      }
      // Rows that hold `text`: the same words inside another row (the owner's message in the thread's
      // prompt row, with its attached files or a run's report line). Short texts like "yes" are not copies.
      const copiesOf = (text: string, except?: number): BotJournalRow[] => text.trim().length < MIN_COPY_CHARS ? []
        : this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND seq <> ? AND redacted_at IS NULL AND kind <> 'redaction' AND instr(text, ?) > 0`, botId, except ?? 0, text.trim())
          .map(journalRowOf)
      // The cited rows and their copies first: a memory citing any of them goes too.
      const cited = new Set(seqs)
      for (const seq of seqs) {
        const row = this.journalRow(botId, seq)!
        const copies = row.redactedAt ? [] : copiesOf(row.text, seq)
        for (const copy of copies) cited.add(copy.seq)
      }
      for (const seq of cited)
        for (const memory of this.all('SELECT DISTINCT id FROM bot_memories WHERE bot_id = ? AND source_seq = ?', botId, seq)) ids.add(memory.id as string)
      // Require upward holders through every historical version. Downward retirement
      // only follows current superseded entries: put-back co-sources belong to the owner again.
      const upward = new Map<string, Set<string>>()
      const downward = new Map<string, Set<string>>()
      const current = new Map<string, BotMemoryVersion | undefined>()
      const entry = (id: string) => {
        if (!current.has(id)) current.set(id, this.current(botId, id))
        return current.get(id)
      }
      const connect = (links: Map<string, Set<string>>, from: string, to: string) => {
        if (!links.has(from)) links.set(from, new Set())
        links.get(from)!.add(to)
      }
      for (const row of this.all("SELECT DISTINCT id, reason FROM bot_memories WHERE bot_id = ? AND reason LIKE 'merged into %'", botId)) {
        const target = parseMemoryRef((row.reason as string).slice(12))
        if (!target) continue
        const id = row.id as string
        connect(upward, id, target.id)
        const latest = entry(id)
        if (latest?.status === 'superseded' && latest.reason?.startsWith('merged into ')
          && parseMemoryRef(latest.reason.slice(12))?.id === target.id)
          connect(downward, target.id, id)
      }
      const required = new Set(ids)
      for (const id of required)
        for (const holder of upward.get(id) ?? []) required.add(holder)
      const holders = [...required].map(entry)
        .filter((value): value is BotMemoryVersion => !!value && (value.status === 'active' || value.status === 'expired'))
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      if (holders.some((value) => !ids.has(value.id))) {
        const refs = holders.map((value) => memoryRef(value.id, value.version)).join(', ')
        const advice = [...ids].map((id) => entry(id)).filter((value): value is BotMemoryVersion => !!value)
          .map((value) => this.copyAdvice(botId, value)).filter(Boolean).join(' ')
        return { error: `${advice ? `${advice} ` : ''}This memory is held by ${refs}, including earlier versions. Name all these entries together in one Forget in the chat, then save again what should stay.`, holders: holders.map(entryOf) }
      }
      for (const id of ids)
        for (const absorbed of downward.get(id) ?? []) ids.add(absorbed)
      for (const seq of cited) redact(this.journalRow(botId, seq)!)
      for (const id of ids) {
        // Every version's words go from wherever they were copied: rows that hold them (a memory call
        // captured with its text by an older build) and the chip of the message that saved them.
        const texts = this.all('SELECT text FROM bot_memories WHERE bot_id = ? AND id = ? AND text IS NOT NULL', botId, id).map((row) => row.text as string)
        // source_seq is approximate. It can identify a short exact copy, but never justifies
        // removing an unrelated owner message or run prompt, or copies of that whole prompt.
        for (const source of this.all('SELECT DISTINCT source_seq FROM bot_memories WHERE bot_id = ? AND id = ? AND source_seq IS NOT NULL', botId, id)) {
          const row = this.journalRow(botId, num(source.source_seq)!)
          if (row && texts.some((text) => text.trim() && row.text.includes(text.trim()))) redact(row)
        }
        this.run("UPDATE bot_memories SET text = NULL, status = 'forgotten', reason = 'forgotten' WHERE bot_id = ? AND id = ?", botId, id)
        for (const op of this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'memory_op' AND json_extract(json, '$.memId') = ?", botId, id))
          redact(journalRowOf(op))
        forgottenTexts.push(...texts)
        for (const text of texts) {
          copiesOf(text).forEach(redact)
          this.memoryCallsOf(botId, id, text).forEach(redact)
          this.dropChip(botId, shortChipText(text))
        }
      }
      const progressRows = this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND json_extract(json, '$.op') = 'progress' AND redacted_at IS NULL", botId).map(journalRowOf)
      const matches = (text: string) => [...text.matchAll(/\bj(\d+)\b/g)].some((match) => redactedSeqs.has(Number(match[1])))
        || forgottenTexts.some((forgotten) => forgotten.trim().length >= MIN_COPY_CHARS && text.includes(forgotten.trim().replace(/\s+/g, ' ')))
      // All versions matter: the latest value may no longer cite what an older note still holds.
      for (const row of progressRows) if (matches(row.text) || redactedSeqs.has(row.seq)) redact(row)
      for (const row of this.all("SELECT key, value FROM bot_memory_state WHERE bot_id = ? AND (key LIKE 'progress:%' OR key LIKE 'progress_pending:%')", botId)) {
        const progress = parseJson(row.value) as { text?: string; seq?: number } | undefined
        if (!progress?.text) continue
        if (matches(progress.text) || (progress.seq !== undefined && redactedSeqs.has(progress.seq))) {
          this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, row.key as string)
          if (progress.seq !== undefined) {
            const source = this.journalRow(botId, progress.seq)
            if (source) redact(source)
          }
        }
      }
      // An open item that came from a redacted row, or says what was forgotten, goes with it, and so do the rows that
      // repeat its words (the call that listed it).
      for (const row of this.all("SELECT key, value FROM bot_memory_state WHERE bot_id = ? AND key >= 'item:' AND key < 'item;'", botId)) {
        const item = parseJson(row.value) as { text?: string; note?: string; links?: string[]; source?: number } | undefined
        if (!item) continue
        const words = [item.text, item.note, ...(Array.isArray(item.links) ? item.links : [])].filter((part): part is string => typeof part === 'string' && Boolean(part))
        if (!(typeof item.source === 'number' && redactedSeqs.has(item.source)) && !matches(words.join('\n'))) continue
        this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, row.key as string)
        if (item.text) copiesOf(item.text).forEach(redact)
      }
      this.dropForgotten(botId, redactedSeqs, { holds: matches, redact })
      const memIds = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      const removed = [...memIds, ...redacted]
      this.appendInTx(this.db, {
        botId,
        kind: 'redaction',
        ...(input.by === 'chat' ? { lane: 'chat' as const } : {}),
        ...(input.activationId ? { activationId: input.activationId } : {}),
        sourceKey: `redact:${at}:${sha256(removed.join(','))}`,
        who: input.by === 'owner_ui' ? 'owner' : 'bot',
        text: `Removed ${removed.join(', ')} at the owner's request.`,
        json: { op: 'forget', memIds, refs: redacted }
      }, at)
      return { ...(memIds.length ? { forgotten: memIds.join(', ') } : {}), redacted }
    })
  }

  /**
   * Captured memory calls about a forgotten entry: a save of its text, or a call naming it
   * (`replaces`, `id`). Capture keeps only the refs of a memory call now; an older build kept its input.
   */
  private memoryCallsOf(botId: string, id: string, text: string): BotJournalRow[] {
    const hash = memoryTextHash(text)
    const named = (value: unknown) => typeof value === 'string' && parseMemoryRef(value)?.id === id
    return this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'tool_call' AND redacted_at IS NULL AND text LIKE '%memory\\_%' ESCAPE '\\'", botId)
      .map(journalRowOf)
      .filter((row) => {
        if (!memoryToolOf(typeof row.json?.tool === 'string' ? row.json.tool : '')) return false
        const input = row.json?.input && typeof row.json.input === 'object' ? row.json.input as Record<string, unknown> : {}
        if (typeof input.text === 'string' && memoryTextHash(input.text) === hash) return true
        return named(input.replaces) || named(input.id) || (Array.isArray(input.refs) && input.refs.some(named))
      })
  }

  /**
   * The "remembered · <text>" chip of a forgotten entry becomes "remembered something", on its chat
   * row (`bot_messages.chips_json`) and on that row's journal copy (`bm:<id>`).
   */
  private dropChip(botId: string, highlight: string): void {
    const scrub = (chips: unknown): unknown[] | undefined => {
      if (!Array.isArray(chips)) return undefined
      let changed = false
      const next = chips.map((chip) => {
        const value = chip as { icon?: unknown; highlight?: unknown; title?: unknown }
        if (value?.icon !== 'memory') return chip
        const matches = value.highlight === highlight
          || (typeof value.highlight === 'string' && value.highlight.startsWith(`${highlight} · put away `))
          || (typeof value.title === 'string' && value.title.split('\n').includes(highlight))
        if (!matches) return chip
        changed = true
        return { icon: 'memory', text: 'remembered something' }
      })
      return changed ? next : undefined
    }
    for (const row of this.all("SELECT seq, json FROM bot_journal WHERE bot_id = ? AND source_key LIKE 'bm:%' AND json LIKE '%\"memory\"%'", botId)) {
      const json = parseJson(row.json)
      const chips = scrub(json?.chips)
      if (json && chips) this.run('UPDATE bot_journal SET json = ? WHERE seq = ?', JSON.stringify({ ...json, chips }), num(row.seq)!)
    }
    scrubMessageChips(this.db, botId, scrub)
  }

  /**
   * After a forget, in its transaction: a digest that used a redacted row or holds forgotten words is marked to be
   * written again (its row in the journal is redacted, and it shows the deterministic lines of what is left until then),
   * the chat summary's lines are folded again from the rows left when one of them came from a redacted row, a digest
   * being prepared is dropped, and every frozen pack is dropped (each may carry a forgotten entry or row), so the
   * activation's next dispatch builds its pack from what is left.
   */
  private dropForgotten(botId: string, redacted: ReadonlySet<number>, forgotten: { holds: (text: string) => boolean; redact: (row: BotJournalRow) => void }): void {
    let summary = this.getState<ChatSummaryState>(botId, 'chat_summary')
    if (summary?.digests?.length) {
      const result = staleDigests(summary, {
        fingerprintOf: (digest) => chatFingerprint(this.digestRows(botId, digest)),
        holdsForgotten: forgotten.holds,
        rowsOf: (digest) => this.digestRows(botId, digest)
      }, this.zone(), this.now())
      for (const digest of result.stale) {
        const row = digest.seq === undefined ? undefined : this.journalRow(botId, digest.seq)
        if (row) forgotten.redact(row)
      }
      if (result.stale.length) {
        this.setState(botId, 'chat_summary', result.state)
        summary = result.state
      }
    }
    const sources = summary?.sources
    // A line of unknown source (a summary from before sources were kept) may come from any folded row.
    const stale = summary && [...redacted].some((seq) => seq <= summary!.throughSeq && (!sources || sources.includes(seq) || sources.includes(0)))
    if (summary && stale) {
      const folded = this.windowRows(botId, 0).filter((row) => row.seq <= summary!.throughSeq)
      this.setState(botId, 'chat_summary', { ...foldChatSummary(folded, { lines: [], ...(summary.digests ? { digests: summary.digests } : {}) }, this.zone(), this.now()), throughSeq: summary.throughSeq })
    }
    // A digest being written may have read what was forgotten: it is dropped, and asked for again from what is left.
    this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND key = 'chat_digest_pending'", botId)
    this.dropPacks(botId)
    // Privacy beats the cache: the chat's runtime conversation may hold what was forgotten, so its epoch ends now and the
    // next chat turn starts from a cleared context (docs/plans/bot-context.md §14).
    this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND key = 'chat_epoch'", botId)
  }

  /** The chat rows a digest summarised (`windowRows` of its range), as they are now. */
  digestRows(botId: string, digest: Pick<ChatDigest, 'fromSeq' | 'throughSeq'>): BotJournalRow[] {
    return this.windowRows(botId, digest.fromSeq).filter((row) => row.seq <= digest.throughSeq)
  }

  /** Drops every frozen pack of the bot: each activation's next dispatch builds its pack again. */
  private dropPacks(botId: string): void {
    this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND substr(key, 1, 5) = 'pack:'", botId)
  }

  stageProgress(botId: string, scheduleId: string, activationId: string, text: string): void {
    this.write(() => this.setState(botId, `progress_pending:${activationId}`, { scheduleId, text: text.trim().replace(/\s+/g, ' ') }))
  }

  finishProgress(botId: string, activationId: string, done: boolean): void {
    this.write(() => {
      const key = `progress_pending:${activationId}`
      const pending = this.getState<{ scheduleId: string; text: string }>(botId, key)
      if (pending && done) this.saveProgress(botId, pending.scheduleId, activationId, pending.text)
      this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, key)
    })
  }

  /** A schedule's own cursor. Kept outside AutomationRuns so Forget reaches every copy. */
  saveProgress(botId: string, scheduleId: string, activationId: string, text: string): void {
    text = text.trim().replace(/\s+/g, ' ')
    this.write(() => {
      const seq = this.appendInTx(this.db, {
        botId, kind: 'notice', lane: 'run', activationId,
        sourceKey: `progress:${scheduleId}:${activationId}:${sha256(text)}`,
        who: 'bot', text, json: { op: 'progress', scheduleId, writtenIn: 'run' }
      }, this.now())
      this.setState(botId, `progress:${scheduleId}`, { text, seq })
      this.dropPacks(botId)
    })
  }

  progress(botId: string, scheduleId: string): string | undefined {
    return this.getState<{ text: string }>(botId, `progress:${scheduleId}`)?.text
  }

  /** Shared scheduler deletion covers the bot, the owner and removing all of a bot's schedules. */
  removeProgressForJob(jobId: string): void {
    this.write(() => {
      const rows = this.all("SELECT bot_id, key FROM bot_memory_state WHERE (key LIKE 'progress:%' AND bot_id || '--' || substr(key, 10) = ?) OR (key LIKE 'progress_pending:%' AND bot_id || '--' || json_extract(value, '$.scheduleId') = ?) OR key = ? OR (key LIKE 'schedule-said:%' AND bot_id || '--' || substr(key, 15) = ?)", jobId, jobId, `schedule-ended:${jobId}`, jobId)
      for (const row of rows) {
        this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', row.bot_id as string, row.key as string)
        this.dropPacks(row.bot_id as string)
      }
    })
  }

  // -- State -----------------------------------------------------------------------------------

  getState<T>(botId: string, key: string): T | undefined {
    const row = this.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, key)
    if (!row) return undefined
    try {
      return JSON.parse(row.value as string) as T
    } catch {
      return row.value as T
    }
  }

  setState(botId: string, key: string, value: unknown): void {
    this.run('INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value',
      botId, key, JSON.stringify(value))
  }

  deleteState(botId: string, key: string): void {
    this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, key)
  }

  /** Keeps the newest `keep` state rows (by their `at`) whose key starts with `prefix`: the frozen packs. */
  pruneState(botId: string, prefix: string, keep: number): void {
    const rows = this.all("SELECT key, value FROM bot_memory_state WHERE bot_id = ? AND substr(key, 1, ?) = ?", botId, prefix.length, prefix)
    const at = (value: unknown) => str(parseJson(value)?.at) ?? ''
    rows.sort((a, b) => at(b.value).localeCompare(at(a.value)))
    for (const row of rows.slice(keep)) this.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, row.key as string)
  }

  /**
   * Counts one search in `search_stats` (bot-context.md §6), or none (`search` absent); `readless`
   * moves the count of turns with three or more searches and no read. Local only; a failure is
   * logged, never raised.
   */
  noteSearch(botId: string, search: { query: string; hits: number } | undefined, readless: -1 | 0 | 1): void {
    if (!search && !readless) return
    try {
      this.write(() => {
        const stats = this.getState<BotMemorySearchStats>(botId, 'search_stats') ?? { searches: 0, zeroHits: 0, readlessTurns: 0, recentMisses: [] }
        stats.readlessTurns = Math.max(0, stats.readlessTurns + readless)
        if (search) {
          stats.searches += 1
          if (!search.hits) {
            stats.zeroHits += 1
            stats.recentMisses = [...stats.recentMisses, { at: this.now(), query: search.query.slice(0, 200) }].slice(-20)
          }
        }
        this.setState(botId, 'search_stats', stats)
      })
    } catch (error) {
      this.log('bot memory: search stats not saved', error)
    }
  }

  // -- Indexes, purge --------------------------------------------------------------------------

  /** At open: an FTS index that fails its integrity check is rebuilt. Returns the indexes rebuilt. */
  checkIndexes(): string[] {
    const rebuilt: string[] = []
    try {
      this.db.statement("INSERT INTO bot_journal_fts(bot_journal_fts, rank) VALUES('integrity-check', 1)").run()
    } catch (error) {
      this.log('bot memory: the journal index failed its check; rebuilding it', error)
      this.rebuildJournalIndex()
      rebuilt.push('bot_journal_fts')
    }
    let healthy: boolean
    try {
      this.db.statement("INSERT INTO bot_memories_fts(bot_memories_fts) VALUES('integrity-check')").run()
      healthy = num(this.get('SELECT count(*) AS n FROM bot_memories_fts')!.n) === num(this.get('SELECT count(*) AS n FROM bot_memories WHERE text IS NOT NULL')!.n)
    } catch {
      healthy = false
    }
    if (!healthy) {
      this.log('bot memory: the memory index failed its check; rebuilding it')
      this.rebuildMemoryIndex()
      rebuilt.push('bot_memories_fts')
    }
    return rebuilt
  }

  private rebuildJournalIndex(): void {
    this.write(() => this.db.statement("INSERT INTO bot_journal_fts(bot_journal_fts) VALUES('rebuild')").run())
  }

  private rebuildMemoryIndex(): void {
    this.write(() => {
      this.run('DELETE FROM bot_memories_fts')
      this.run('INSERT INTO bot_memories_fts(rowid, text, bot_id, mem_id) SELECT row_id, text, bot_id, id FROM bot_memories WHERE text IS NOT NULL')
    })
  }

  /** Rebuilds both derived indexes from their rows. FTS5 rebuilds a whole table, so this covers every bot. */
  reindex(): void {
    this.rebuildJournalIndex()
    this.rebuildMemoryIndex()
  }

  /** Removes every memory-table row of one bot, and nothing of another (the 30-day purge). */
  purge(botId: string): void {
    this.write(() => {
      this.run('DELETE FROM bot_journal WHERE bot_id = ?', botId)
      this.run('DELETE FROM bot_memories WHERE bot_id = ?', botId)
      this.run('DELETE FROM bot_memory_state WHERE bot_id = ?', botId)
    })
  }

  /**
   * A fresh start for the bot's memory, in one transaction: every journal row (with its search rows, by trigger) and the
   * memory state go, but the capture cursors (`cursor:<threadId>`), so capture never copies the bot's threads in again.
   * `BotStore` also writes `cursor:create:<clientRequestId>` records, not capture cursors; `cursor:` keeps them here too.
   * `keepSaved` (`bots.memory.wipe` with `keep: 'saved'`): the owner's entries and the bot's notes stay as they are,
   * forgotten ones as tombstones; only entries that are run notes now go, every version. Schedule delivery markers
   * also stay with keepSaved, until their shared job is removed. Without it every entry goes.
   * Returns how many current entries went. Entries never need the journal rows they came from (`source_seq`).
   */
  wipe(botId: string, keepSaved: boolean): number {
    return this.write(() => {
      let removed: number
      if (keepSaved) {
        // Entries whose newest version is a run note: a run note the owner edited into a note is a note now, and stays.
        const runNotes = this.all(`SELECT m.id, m.status FROM bot_memories m WHERE m.bot_id = ? AND m.kind = 'run_note'
          AND m.version = (SELECT MAX(version) FROM bot_memories WHERE bot_id = m.bot_id AND id = m.id)`, botId)
          .filter((row) => row.status !== 'forgotten').map((row) => row.id as string)
        removed = runNotes.length
        for (const id of runNotes) this.run('DELETE FROM bot_memories WHERE bot_id = ? AND id = ?', botId, id)
      } else {
        removed = num(this.get("SELECT COUNT(DISTINCT id) AS n FROM bot_memories WHERE bot_id = ? AND status IN ('active','expired')", botId)?.n) ?? 0
        this.run('DELETE FROM bot_memories WHERE bot_id = ?', botId)
      }
      this.run('DELETE FROM bot_journal WHERE bot_id = ?', botId)
      this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND key <> 'asks-first:introduced' AND substr(key, 1, 7) <> 'cursor:' AND (? = 0 OR (key NOT LIKE 'schedule-said:%' AND key NOT LIKE 'schedule-ended:%' AND key NOT LIKE 'pagecheck:%'))", botId, keepSaved ? 1 : 0)
      return removed
    })
  }

  /** Whether capture must mask tool arguments of this work, including after its action settled. */
  hasStoredActions(activationId: string): boolean {
    return Boolean(this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_actions'")
      && this.get('SELECT 1 FROM bot_actions WHERE activation_id = ? LIMIT 1', activationId))
  }

  storedActionDigests(activationId: string): ReadonlySet<string> {
    if (!this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_actions'")) return new Set()
    return new Set(this.all('SELECT args_digest FROM bot_actions WHERE activation_id = ?', activationId).map(row => String(row.args_digest)))
  }

  /** Export the masked call record, never the exact executable arguments. */
  actions(botId: string): Array<Record<string, unknown>> {
    if (!this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_actions'")) return []
    return this.all(`SELECT id, call_key, bot_id, activation_id, lane, kind, target_json,
      args_json, NULL AS args_digest, binding_json, NULL AS place_json, card_json,
      CASE WHEN json_valid(bot_note) THEN CASE WHEN json_type(bot_note, '$.digests') = 'object' AND json_type(bot_note, '$.keys') = 'array' THEN NULL ELSE bot_note END ELSE bot_note END AS bot_note, status, result_json,
      message_id, next_at, nudges, expires_at, answered_at, answered_device, created_at, ran_at
      FROM bot_actions WHERE bot_id = ? ORDER BY created_at, rowid`, botId)
  }

  /** Every memory version of a bot, in write order (export). */
  allVersions(botId: string): BotMemoryVersion[] {
    return this.all('SELECT * FROM bot_memories WHERE bot_id = ? ORDER BY row_id', botId).map(versionOf)
  }

  /**
   * Every question a bot asked its owner, oldest first (export): what it asked, its answers, where it stands and the
   * answer given, as `bots.db` keeps them (Forget's redactions included). None where `bots.db` has no questions table.
   */
  questions(botId: string): Array<Record<string, unknown>> {
    if (!this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_questions'")) return []
    return this.all('SELECT id, activation_id, lane, spec_json, status, answer_json, answer_message, answered_at, message_id, created_at FROM bot_questions WHERE bot_id = ? ORDER BY created_at, rowid', botId)
      .map((row) => ({
        id: row.id,
        activationId: row.activation_id,
        lane: row.lane,
        ...(parseJson(row.spec_json) ?? {}),
        status: row.status,
        ...(row.answer_json ? { answer: parseJson(row.answer_json) } : {}),
        ...(row.answer_message ? { answerMessage: row.answer_message } : {}),
        ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
        ...(row.message_id ? { messageId: row.message_id } : {}),
        createdAt: row.created_at
      }))
  }
}

/** Rewrites the chips of a bot's chat rows that `scrub` changes (when `bot_messages` exists). */
function scrubMessageChips(tx: BotStoreTx, botId: string, scrub: (chips: unknown) => unknown[] | undefined): void {
  if (!tx.statement("SELECT 1 FROM pragma_table_info('bot_messages') WHERE name = 'chips_json'").get()) return
  for (const row of tx.statement("SELECT id, chips_json FROM bot_messages WHERE bot_id = ? AND chips_json LIKE '%\"memory\"%'").all(botId) as Row[]) {
    let chips: unknown
    try {
      chips = JSON.parse(row.chips_json as string)
    } catch {
      continue
    }
    const next = scrub(chips)
    if (next) tx.statement('UPDATE bot_messages SET chips_json = ? WHERE id = ? AND bot_id = ?').run(JSON.stringify(next), row.id as string, botId)
  }
}

/**
 * A forgotten question's bubble (`message_id`) or answer (`answer_message`), as copied elsewhere (issue #1123): the line
 * that carried the answer to its work (`answer_json.sent`, which names it exactly) goes from that work's dispatch prompts
 * and the journal rows captured from its thread, the rest of each left as it was; the chat's `question_answer` call that
 * passed the answer on goes, and with the bubble, the work's `ask_owner` call that asked it. Each is found by the
 * question's id and its activation, never by how long its words are. A default's line (the bot went with its own choice)
 * quotes the question, so it goes with the bubble: work's from its thread, a chat question's from the chat turn it
 * queued (`sent.activationId`), its request included. An owner's late answer to a default wrote no such line, but the chat
 * turn it started was told, quoting the question and the default (`answer_json.copies`): those go with the bubble too.
 */
function redactQuestionCopies(tx: BotStoreTx, has: (table: string) => boolean, botId: string, question: { id: string; activation_id: string; status: string; spec_json: string; answer_json: string | null; message_id: string | null; answer_message: string | null }, messageId: string, text: string): void {
  const answer = parseJson(question.answer_json)
  const sentOf = answer?.sent as { line?: unknown; activationId?: unknown } | undefined
  const lateOnly = question.status === 'defaulted' && question.message_id !== messageId
  // A line that quoted the question, and the activation it went to: its prompts, its request and its captured rows.
  const lines: Array<{ line: string; activationId: string }> = []
  if (!lateOnly && typeof sentOf?.line === 'string' && sentOf.line)
    lines.push({ line: sentOf.line, activationId: typeof sentOf.activationId === 'string' && sentOf.activationId ? sentOf.activationId : question.activation_id })
  if (question.message_id === messageId && Array.isArray(answer?.copies))
    for (const copy of answer.copies as Array<{ line?: unknown; activationId?: unknown }>)
      if (typeof copy?.line === 'string' && copy.line && typeof copy.activationId === 'string' && copy.activationId) lines.push({ line: copy.line, activationId: copy.activationId })
  for (const { line, activationId } of lines) {
    if (has('bot_dispatches'))
      tx.statement("UPDATE bot_dispatches SET prompt_json = json_set(prompt_json, '$.text', replace(json_extract(prompt_json, '$.text'), ?, ?)) WHERE activation_id = ? AND instr(json_extract(prompt_json, '$.text'), ?) > 0")
        .run(line, text, activationId, line)
    if (activationId !== question.activation_id && has('bot_activations'))
      tx.statement("UPDATE bot_activations SET trigger_json = json_set(trigger_json, '$.input', replace(json_extract(trigger_json, '$.input'), ?, ?)) WHERE id = ? AND instr(json_extract(trigger_json, '$.input'), ?) > 0")
        .run(line, text, activationId, line)
    if (has('bot_journal')) tx.statement('UPDATE bot_journal SET text = replace(text, ?, ?) WHERE bot_id = ? AND activation_id = ? AND instr(text, ?) > 0').run(line, text, botId, activationId, line)
  }
  if (!has('bot_journal')) return
  // A call of Mousse's tool `tool`, as each runtime names it: bare (Pi), or `mcp__<server>__<tool>` (Claude Code, Codex).
  const redactCalls = (tool: string, where: string, ...params: string[]) =>
    tx.statement(`UPDATE bot_journal SET text = ?, keys = '', json = NULL, redacted_at = COALESCE(redacted_at, ?) WHERE bot_id = ? AND kind = 'tool_call' AND redacted_at IS NULL
      AND (json_extract(json, '$.tool') = ? OR substr(json_extract(json, '$.tool'), -length(?)) = ?) AND ${where}`).run(text, new Date().toISOString(), botId, tool, `__${tool}`, `__${tool}`, ...params)
  if (question.answer_message === messageId) redactCalls('question_answer', "json_extract(json, '$.input.questionId') = ?", question.id)
  const asked = parseJson(question.spec_json)?.question
  if (question.message_id === messageId && typeof asked === 'string') redactCalls('ask_owner', "activation_id = ? AND json_extract(json, '$.input.question') = ?", question.activation_id, asked)
}

function defaultRedactMessage(tx: BotStoreTx, botId: string, messageId: string, text: string): void {
  heldCalls(tx)?.forgetMessage(botId, messageId)
  const has = (table: string) => Boolean(tx.statement("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
  if (!has('bot_messages')) return
  tx.statement('UPDATE bot_messages SET text = ? WHERE id = ? AND bot_id = ?').run(text, messageId, botId)
  // Nor its cards (issue #1123), with the pictures a gallery of them added to its files: found by the message, not by how
  // its words read. The pictures themselves stay in the bot's files folder.
  if (tx.statement("SELECT 1 FROM pragma_table_info('bot_messages') WHERE name = 'cards_json'").get()) {
    const row = tx.statement('SELECT attachments_json FROM bot_messages WHERE id = ? AND bot_id = ? AND cards_json IS NOT NULL').get(messageId, botId) as { attachments_json: string | null } | undefined
    if (row) {
      let files: unknown = []
      try {
        files = row.attachments_json ? JSON.parse(row.attachments_json) : []
      } catch {
        files = []
      }
      const kept = Array.isArray(files) ? (files as Array<{ card?: unknown } | null>).filter((file) => !file?.card) : []
      tx.statement('UPDATE bot_messages SET cards_json = NULL, attachments_json = ? WHERE id = ? AND bot_id = ?').run(kept.length ? JSON.stringify(kept) : null, messageId, botId)
    }
  }
  // A forgotten message keeps neither a reaction nor its legacy notification receipt.
  const reactions = Boolean(tx.statement("SELECT 1 FROM pragma_table_info('bot_messages') WHERE name = 'owner_reaction'").get())
  const clearMessageState = (id: string) => {
    if (has('bot_memory_state')) tx.statement('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?').run(botId, `cursor:telling-legacy:${id}`)
    if (reactions) tx.statement('UPDATE bot_messages SET owner_reaction = NULL, owner_reaction_at = NULL WHERE id = ? AND bot_id = ?').run(id, botId)
  }
  clearMessageState(messageId)
  // A held draft can quote even a one-word owner message. Drop the whole draft by its turn,
  // before removing other copies, rather than guessing from the length of the quoted text.
  if (has('bot_memory_state')) tx.statement(`DELETE FROM bot_memory_state WHERE bot_id = ? AND key IN
    (SELECT 'draft:' || activation_id FROM bot_messages WHERE bot_id = ? AND id = ? AND author = 'owner')`).run(botId, botId, messageId)
  // What the forgotten message asked for keeps no copy of its words (docs/plans/bot-always-free.md): a reminder it set
  // is cancelled and its text removed, and work it started keeps neither its brief nor the notes passed to it.
  const redactJournal = (sourceKey: string) => {
    if (has('bot_journal')) tx.statement("UPDATE bot_journal SET text = ?, keys = '', json = NULL, redacted_at = COALESCE(redacted_at, ?) WHERE bot_id = ? AND source_key = ?").run(text, new Date().toISOString(), botId, sourceKey)
  }
  if (has('bot_reminders')) {
    tx.statement("UPDATE bot_reminders SET text = ?, work_title = NULL, work_brief = NULL, status = CASE WHEN status = 'waiting' THEN 'cancelled' ELSE status END WHERE bot_id = ? AND reply_to = ?").run(text, botId, messageId)
    // A reminder already said keeps no copy in its message either.
    const said = tx.statement('SELECT message_id FROM bot_reminders WHERE bot_id = ? AND reply_to = ? AND message_id IS NOT NULL').all(botId, messageId) as Array<{ message_id: string }>
    for (const row of said) {
      tx.statement('UPDATE bot_messages SET text = ? WHERE id = ? AND bot_id = ?').run(text, row.message_id, botId)
      clearMessageState(row.message_id)
      redactJournal(`bm:${row.message_id}`)
    }
  }
  // A question the forgotten message carried keeps no copy of its words or answers, and no longer waits for an answer; an
  // answer the forgotten message gave keeps no copy either (issue #1123).
  if (has('bot_questions')) {
    // First, while the question and its answer are still whole: the copies its work and the chat made of them, found by
    // the question, not by its words (an answer may be as short as "Flat B").
    const touched = tx.statement('SELECT id, activation_id, status, spec_json, answer_json, message_id, answer_message FROM bot_questions WHERE bot_id = ? AND (message_id = ? OR answer_message = ?)')
      .all(botId, messageId, messageId) as Array<{ id: string; activation_id: string; status: string; spec_json: string; answer_json: string | null; message_id: string | null; answer_message: string | null }>
    for (const question of touched) redactQuestionCopies(tx, has, botId, question, messageId, text)
    // The copy of that line kept with the answer quotes the question too: it goes with the bubble.
    tx.statement("UPDATE bot_questions SET answer_json = json_remove(answer_json, '$.sent', '$.copies') WHERE bot_id = ? AND message_id = ? AND answer_json IS NOT NULL").run(botId, messageId)
    // A default is one of the question's choices: its label goes with the bubble, from the follow-up and the answer.
    tx.statement("UPDATE bot_questions SET follow_json = json_remove(follow_json, '$.default') WHERE bot_id = ? AND message_id = ?").run(botId, messageId)
    tx.statement("UPDATE bot_questions SET answer_json = json_set(json_remove(answer_json, '$.choice'), '$.redacted', json('true')) WHERE bot_id = ? AND message_id = ? AND json_extract(answer_json, '$.by') = 'default'").run(botId, messageId)
    // Work that waits on the forgotten question, or has its answer (or its default) still to read, has nothing to go on
    // with: the question is withdrawn, with no follow-up, and the engine ends that work with a line (`settleStrandedWork`).
    tx.statement(`UPDATE bot_questions SET spec_json = json_object('question', ?, 'choices', json('[]'), 'other', json('false')), next_at = NULL,
      status = CASE WHEN status IN ('open', 'moved_on') OR (lane = 'run' AND status IN ('answered', 'defaulted') AND read_at IS NULL) THEN 'withdrawn' ELSE status END WHERE bot_id = ? AND message_id = ?`).run(text, botId, messageId)
    // An answer work has not read yet is taken back: the question is open again, and its work waits for an answer again.
    if (has('bot_activations')) tx.statement(`UPDATE bot_activations SET end_reason = 'question' WHERE status = 'blocked' AND end_reason = 'question_answered'
      AND id IN (SELECT activation_id FROM bot_questions WHERE bot_id = ? AND answer_message = ? AND lane = 'run' AND status = 'answered' AND read_at IS NULL)`).run(botId, messageId)
    tx.statement("UPDATE bot_questions SET status = 'open', answer_json = NULL, answer_message = NULL, answered_at = NULL, next_at = NULL WHERE bot_id = ? AND answer_message = ? AND lane = 'run' AND status = 'answered' AND read_at IS NULL").run(botId, messageId)
    // The owner's late answer to a question the bot went on with its default for: it goes, and the default stays.
    tx.statement("UPDATE bot_questions SET answer_json = json_remove(answer_json, '$.late'), answer_message = NULL WHERE bot_id = ? AND answer_message = ? AND status = 'defaulted'").run(botId, messageId)
    tx.statement("UPDATE bot_questions SET answer_json = CASE WHEN json_extract(answer_json, '$.tapped') OR json_extract(answer_json, '$.choice') IS NOT NULL THEN json_object('by', json_extract(answer_json, '$.by'), 'tapped', json('true'), 'redacted', json('true')) ELSE json_object('by', json_extract(answer_json, '$.by'), 'redacted', json('true')) END WHERE bot_id = ? AND answer_message = ? AND answer_json IS NOT NULL").run(botId, messageId)
  }
  // A note the forgotten message passed to work: gone from the note, from the prompt that carried it, and from the rows
  // captured from that work's thread (a note reaches running work as a steer), found by the message and the work, never
  // by how long its words are: a note may carry an answer as short as "Flat B".
  if (has('bot_work_notes')) {
    const notes = tx.statement('SELECT activation_id, text FROM bot_work_notes WHERE bot_id = ? AND from_message = ?').all(botId, messageId) as Array<{ activation_id: string; text: string }>
    for (const note of notes) {
      if (has('bot_dispatches') && note.text.trim())
        tx.statement("UPDATE bot_dispatches SET prompt_json = json_set(prompt_json, '$.text', replace(json_extract(prompt_json, '$.text'), ?, ?)) WHERE activation_id = ?").run(note.text, text, note.activation_id)
      if (has('bot_journal') && note.text.trim())
        tx.statement('UPDATE bot_journal SET text = replace(text, ?, ?) WHERE bot_id = ? AND activation_id = ? AND instr(text, ?) > 0').run(note.text, text, botId, note.activation_id, note.text)
      tx.statement('UPDATE bot_work_notes SET text = ? WHERE bot_id = ? AND from_message = ?').run(text, botId, messageId)
    }
  }
  if (has('bot_activations')) {
    const work = tx.statement("SELECT id, status FROM bot_activations WHERE bot_id = ? AND json_extract(trigger_json, '$.kind') = 'work' AND json_extract(trigger_json, '$.replyTo') = ?").all(botId, messageId) as Array<{ id: string; status: string }>
    for (const row of work) {
      tx.statement("UPDATE bot_activations SET trigger_json = json_set(trigger_json, '$.input', ?, '$.title', ?) WHERE id = ?").run(text, text, row.id)
      // Work that has not started never runs on a removed request.
      if (row.status === 'queued') tx.statement("UPDATE bot_activations SET status = 'cancelled', end_reason = 'forgotten', ended_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), row.id)
      if (has('bot_work_notes')) tx.statement('UPDATE bot_work_notes SET text = ? WHERE activation_id = ?').run(text, row.id)
      if (has('bot_dispatches')) tx.statement("UPDATE bot_dispatches SET prompt_json = json_set(prompt_json, '$.text', ?) WHERE activation_id = ?").run(text, row.id)
      redactJournal(`act:${row.id}:start`)
    }
  }
}
