import { createHash } from 'node:crypto'
import type { ProfileDatabase } from '../../run/db/ProfileDatabase'
import type { BotLane } from '../../../shared/bots/personal/definition'
import {
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
import { type ChatSummaryState, foldChatSummary } from './chatSummary'
import { guardMemoryText, relativeDateRefusal } from './guard'
import { agoLabel, coreGauge, cut, dayLabel, runNotesGauge, usedTokens } from './render'

/**
 * The bot memory store (docs/plans/bot-context.md §3, §6–§8) over `bots.db`: the journal (append,
 * capture upserts, redaction), FTS5 search and paging, versioned memory entries with their caps,
 * forget, the state rows, and the integrity check and rebuild of both indexes. It is the only
 * reader and writer of the memory tables; each write runs in one `bots.db` transaction.
 */

/** The `bots.db` connection the store works on (`BotStore.db`). */
export type BotMemoryDb = Pick<ProfileDatabase, 'statement' | 'inTransaction' | 'transaction'>

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
    this.clock = options.clock ?? Date.now
    this.timeZone = options.timeZone ?? (() => undefined)
    this.log = options.log ?? (() => {})
    this.redactMessage = options.redactMessage ?? defaultRedactMessage
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
      return inserted ? num(inserted.seq)! : undefined
    } catch (error) {
      throw new BotJournalError(error)
    }
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
      this.appendInTx(this.db, { ...row, json }, row.at)
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

  /** Every journal row of a bot, oldest first (export). */
  journal(botId: string): BotJournalRow[] {
    return this.all('SELECT * FROM bot_journal WHERE bot_id = ? ORDER BY seq', botId).map(journalRowOf)
  }

  /** The chat rows the verbatim window carries (owner messages, bot replies, run reports), from `fromSeq`. */
  windowRows(botId: string, fromSeq: number): BotJournalRow[] {
    return this.all(`SELECT * FROM bot_journal WHERE bot_id = ? AND seq >= ? AND kind IN ('owner_msg','bot_msg','run_report')
      AND source_key LIKE 'bm:%' ORDER BY seq`, botId, fromSeq).map(journalRowOf)
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

  lastOfKind(botId: string, kind: BotJournalKind): BotJournalRow | undefined {
    const row = this.get('SELECT * FROM bot_journal WHERE bot_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1', botId, kind)
    return row ? journalRowOf(row) : undefined
  }

  // -- Search and read ---------------------------------------------------------------------------

  /**
   * `memory_search` (bot-context.md §6): memory hits first, then journal rows, each ranked by bm25
   * with recency breaking ties, filtered to the bot before the limit. Every word must match first;
   * when that finds too few, any word may. No query: the latest by date.
   */
  search(botId: string, input: BotMemorySearchInput): BotMemoryHit[] {
    const now = this.clock()
    this.expireMemories(botId)
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? BOT_MEMORY_SEARCH_LIMIT)), MAX_BOT_MEMORY_SEARCH_LIMIT)
    const kinds = new Set<BotMemorySearchKind>(input.kinds?.length ? input.kinds : ['chat', 'run', 'tool', 'memory'])
    const since = isoOrUndefined(input.since) ?? ''
    // A bare date as `until` includes that day.
    const until = isoOrUndefined(input.until && /^\d{4}-\d{2}-\d{2}$/.test(input.until.trim()) ? `${input.until.trim()}T23:59:59.999Z` : input.until) ?? '9999'
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
    const memoryHit = (row: Row): BotMemoryHit => ({
      ref: memoryRef(row.id as string, num(row.version)!),
      at: row.learned_at as string,
      ago: agoLabel(row.learned_at as string, now),
      kind: `memory:${row.kind as string}${row.status === 'expired' ? ' (expired)' : ''}`,
      who: row.written_in === 'run' ? 'bot' : 'owner',
      snippet: str(row.snip) ?? (row.text as string)
    })
    const journalHit = (row: Row): BotMemoryHit => ({
      ref: `j${num(row.seq)!}`,
      at: row.at as string,
      ago: agoLabel(row.at as string, now),
      kind: row.kind as string,
      who: row.who as string,
      snippet: str(row.snip) ?? cut(row.text as string, 240)
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
    for (const match of terms.length > 1 ? [terms.join(' AND '), terms.join(' OR ')] : [terms[0]!]) {
      if (hits.length >= limit) break
      if (kinds.has('memory'))
        for (const row of this.all(`SELECT m.*, snippet(bot_memories_fts, 0, '«', '»', '…', 16) AS snip, bm25(bot_memories_fts) AS score
          FROM bot_memories_fts JOIN bot_memories m ON m.row_id = bot_memories_fts.rowid
          WHERE bot_memories_fts MATCH ? AND m.bot_id = ? AND m.status IN ('active','expired') AND m.learned_at >= ? AND m.learned_at <= ?
          ORDER BY score, m.learned_at DESC LIMIT ?`, match, botId, since, until, limit)) push(memoryHit(row), row.text)
      if (journalKinds.length)
        for (const row of this.all(`SELECT j.*, snippet(bot_journal_fts, 0, '«', '»', '…', 16) AS snip, bm25(bot_journal_fts) AS score
          FROM bot_journal_fts JOIN bot_journal j ON j.seq = bot_journal_fts.rowid
          WHERE bot_journal_fts MATCH ? AND ${journalWhere} ORDER BY score, j.seq DESC LIMIT ?`, match, botId, since, until, limit * 2))
          push(journalHit(row), row.text)
    }
    return hits
  }

  /**
   * `memory_read`: rows around a hit (`j123`, at most 20 each side), a memory entry's versions
   * (`m12`), or one activation's rows page by page. A page holds about 8k tokens at most; a
   * redacted row shows its tombstone.
   */
  read(botId: string, input: { ref: string; before?: number; after?: number } | { activationId: string; cursor?: string }): { rows: BotMemoryRow[]; cursor?: string } | { error: string } {
    const budget = BOT_MEMORY_READ_PAGE_TOKENS * 4
    const rowOf = (row: BotJournalRow, max: number): BotMemoryRow => ({
      ref: `j${row.seq}`,
      at: row.at,
      kind: row.kind,
      who: row.who,
      text: row.text.length > max ? `${row.text.slice(0, max)}\n…[${row.text.length - max} more characters: read j${row.seq} alone]` : row.text
    })
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
      return {
        rows: versions.map((version) => ({
          ref: memoryRef(version.id, version.version),
          at: version.learnedAt,
          kind: `memory:${version.kind} (${version.status})`,
          who: version.writtenIn === 'run' ? 'bot' : 'owner',
          text: version.text ?? '[removed at your request]'
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

  /** The active entries, oldest first: what every pack injects. */
  active(botId: string): BotMemoryEntry[] {
    return this.all("SELECT * FROM bot_memories WHERE bot_id = ? AND status = 'active' ORDER BY learned_at, row_id", botId).map((row) => entryOf(versionOf(row)))
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
        if (replaced.status === 'forgotten') return { error: 'refused', reason: `${ref.id} was forgotten: save a new entry instead.` }
        if (input.lane === 'run' && replaced.kind !== 'run_note') return { error: 'refused', reason: 'A run can only replace its own run notes. Ask the owner in the chat.' }
        if ((ref.version ?? 1) !== replaced.version)
          return { error: 'stale', current: { id: replaced.id, version: replaced.version, ref: memoryRef(replaced.id, replaced.version), text: replaced.text ?? '' } }
      }
      const duplicate = this.get("SELECT * FROM bot_memories WHERE bot_id = ? AND text_hash = ? AND status = 'active' AND kind = ? LIMIT 1", botId, hash, kind)
      if (duplicate && !replaced) {
        const version = versionOf(duplicate)
        return { id: version.id, version: version.version, ref: memoryRef(version.id, version.version), gauge: this.gauge(botId, input.lane) }
      }
      const active = this.active(botId)
      const others = active.filter((entry) => entry.kind === kind && entry.id !== replaced?.id)
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
      this.appendInTx(this.db, {
        botId,
        kind: 'memory_op',
        ...(input.lane === 'owner_ui' ? {} : { lane: input.lane }),
        ...(input.activationId ? { activationId: input.activationId } : {}),
        sourceKey: `mem:${id}:v${version}`,
        who: input.lane === 'owner_ui' ? 'owner' : 'bot',
        text: `remembered · ${text}`,
        json: { op: 'save', memId: id, version, kind, ...(replaced ? { replaces: memoryRef(replaced.id, replaced.version) } : {}) }
      }, at)
      return { id, version, ref: memoryRef(id, version), gauge: this.gauge(botId, input.lane) }
    })
  }

  /**
   * Forget (bot-context.md §8): the entry becomes a tombstone (text gone, hash kept, so it is not
   * learned again); cited journal rows, and rows of exactly the same text, are redacted with their
   * FTS rows; memory versions citing a redacted row are tombstoned; the mirrored `bot_messages` text
   * is blanked; the entry's `memory_op` rows are redacted; the chat summary and the frozen packs
   * lose it too. The reason is not stored: it often restates what was forgotten.
   */
  forget(botId: string, input: BotMemoryForget): BotMemoryForgetResult | { error: string } {
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
      const redact = (row: BotJournalRow) => {
        if (row.redactedAt || redactedSeqs.has(row.seq)) return
        this.run("UPDATE bot_journal SET text = ?, keys = '', json = NULL, redacted_at = ? WHERE seq = ?", tombstone, at, row.seq)
        if (row.sourceKey.startsWith('bm:')) this.redactMessage(this.db, botId, row.sourceKey.slice(3), tombstone)
        redacted.push(`j${row.seq}`)
        redactedSeqs.add(row.seq)
      }
      // The cited rows and their copies first: a memory citing any of them goes too.
      const cited = new Set(seqs)
      for (const seq of seqs) {
        const row = this.journalRow(botId, seq)!
        // Copies of the same words (the owner's message as the thread's prompt row); short texts like "yes" are not copies.
        const copies = row.redactedAt || row.text.trim().length < MIN_COPY_CHARS ? []
          : this.all('SELECT * FROM bot_journal WHERE bot_id = ? AND text = ? AND seq <> ? AND redacted_at IS NULL', botId, row.text, seq).map(journalRowOf)
        redact(row)
        copies.forEach(redact)
        for (const copy of copies) cited.add(copy.seq)
      }
      for (const seq of cited)
        for (const memory of this.all('SELECT DISTINCT id FROM bot_memories WHERE bot_id = ? AND source_seq = ?', botId, seq)) ids.add(memory.id as string)
      for (const id of ids) {
        this.run("UPDATE bot_memories SET text = NULL, status = 'forgotten', reason = 'forgotten' WHERE bot_id = ? AND id = ?", botId, id)
        for (const op of this.all("SELECT * FROM bot_journal WHERE bot_id = ? AND kind = 'memory_op' AND json_extract(json, '$.memId') = ?", botId, id))
          redact(journalRowOf(op))
      }
      this.dropForgotten(botId, redactedSeqs)
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
   * After a forget, in its transaction: the chat summary is folded again from the rows left when
   * one of its lines came from a redacted row, and every frozen pack is dropped (each may carry a
   * forgotten entry or row), so the activation's next dispatch builds its pack from what is left.
   */
  private dropForgotten(botId: string, redacted: ReadonlySet<number>): void {
    const summary = this.getState<ChatSummaryState>(botId, 'chat_summary')
    const sources = summary?.sources
    // A line of unknown source (a summary from before sources were kept) may come from any folded row.
    const stale = summary && [...redacted].some((seq) => seq <= summary.throughSeq && (!sources || sources.includes(seq) || sources.includes(0)))
    if (summary && stale) {
      const folded = this.windowRows(botId, 0).filter((row) => row.seq <= summary.throughSeq)
      this.setState(botId, 'chat_summary', { ...foldChatSummary(folded, undefined, this.zone(), this.now()), throughSeq: summary.throughSeq })
    }
    this.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND substr(key, 1, 5) = 'pack:'", botId)
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

  /** Every memory version of a bot, in write order (export). */
  allVersions(botId: string): BotMemoryVersion[] {
    return this.all('SELECT * FROM bot_memories WHERE bot_id = ? ORDER BY row_id', botId).map(versionOf)
  }
}

function defaultRedactMessage(tx: BotStoreTx, botId: string, messageId: string, text: string): void {
  if (!tx.statement("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_messages'").get()) return
  tx.statement('UPDATE bot_messages SET text = ? WHERE id = ? AND bot_id = ?').run(text, messageId, botId)
}
