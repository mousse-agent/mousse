import { randomUUID } from 'node:crypto'
import { ProfileDatabase, type Migration } from '../run/db/ProfileDatabase'
import {
  isRunLevel,
  runReportNotice,
  tuningText,
  TUNING_IN_PROMPT,
  type AutomationInbox,
  type InboxAssignee,
  type InboxCounts,
  type InboxItem,
  type InboxItemKind,
  type InboxRun,
  type InboxRunState,
  type RunLevel,
  type RunModelUsage,
  type TuningNote
} from '../../shared/automationInbox'

/**
 * The Automations inbox in the daemon (`automations/automations.db`): one row per run of an automation, from the
 * moment the scheduler claims it until it ends, with the report its agent gave (`run_report`), the tokens and known
 * cost of its turn, and the Needs you queue: unresolved items (a `needs_you` report, a failed run, an open approval or
 * question on the run's thread), each assigned to the person or to the automation's bot. Opening a run never changes
 * the queue; only Resolve (and Undo), or answering the approval or question where it was asked, does. Tuning notes
 * (calibration given on a run) and what an automation was made from live here too.
 */

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE runs(
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        number INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        project_id TEXT,
        bot_id TEXT,
        activation_id TEXT,
        thread_id TEXT,
        engine_run_id TEXT,
        assignee TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        state TEXT NOT NULL,
        until TEXT,
        level TEXT,
        summary TEXT,
        reported_at TEXT,
        error TEXT,
        usage TEXT NOT NULL DEFAULT '[]',
        UNIQUE(job_id, occurrence_key)
      ) STRICT;
      CREATE INDEX runs_thread ON runs(thread_id);
      CREATE INDEX runs_engine ON runs(engine_run_id);
      CREATE INDEX runs_activation ON runs(activation_id);
      CREATE INDEX runs_started ON runs(started_at);
      CREATE TABLE items(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        assignee TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolve_batch INTEGER,
        UNIQUE(run_id, kind, ref)
      ) STRICT;
      CREATE INDEX items_open ON items(resolved_at);
      CREATE TABLE tuning(
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        run_number INTEGER,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX tuning_job ON tuning(job_id, created_at);
      CREATE TABLE meta(
        job_id TEXT PRIMARY KEY,
        origin_thread_id TEXT,
        context TEXT
      ) STRICT;
    `
  }
]

/** How many runs the inbox lists, newest first; runs with an open item are always listed. */
const LIST_LIMIT = 400
const MAX_SUMMARY = 300

type Row = Record<string, unknown>

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

function assigneeKey(assignee: InboxAssignee): string {
  return assignee.kind === 'bot' ? `bot:${assignee.botId}` : 'person'
}

function assigneeOf(key: string): InboxAssignee {
  return key.startsWith('bot:') ? { kind: 'bot', botId: key.slice('bot:'.length) } : { kind: 'person' }
}

function usageOf(raw: unknown): RunModelUsage[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]')) as unknown
    return Array.isArray(parsed) ? (parsed as RunModelUsage[]) : []
  } catch {
    return []
  }
}

export interface RunBegin {
  jobId: string
  jobName: string
  occurrenceKey: string
  projectId?: string
  /** The automation's Who is this bot: its runs' items are the bot's to resolve. */
  botId?: string
  activationId?: string
  threadId?: string
  state?: Extract<InboxRunState, 'queued' | 'running'>
}

export interface RunFinish {
  jobId: string
  occurrenceKey: string
  jobName?: string
  failed: boolean
  /** The agent said `[SILENT]`: with no report, the run is quiet. */
  silent?: boolean
  error?: string
  threadId?: string
}

/** Why `run_report` was refused, in the words the agent reads. */
export class RunReportError extends Error {}

export interface AutomationRunsOptions {
  profileHome: string
  clock?: () => number
}

export class AutomationRuns {
  readonly db: ProfileDatabase
  private readonly listeners = new Set<() => void>()
  private readonly clock: () => number

  constructor(options: AutomationRunsOptions) {
    this.clock = options.clock ?? Date.now
    this.db = new ProfileDatabase({ profileHome: options.profileHome, name: 'automations', clock: this.clock })
    this.db.migrate(MIGRATIONS)
  }

  close(): void {
    this.db.close()
  }

  /** Called after every change (the page and the project dots read again). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener never breaks the ledger.
      }
    }
  }

  private now(): string {
    return new Date(this.clock()).toISOString()
  }

  private row(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.statement(sql).get(...params) as Row | undefined
  }

  private rows(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.statement(sql).all(...params) as Row[]
  }

  private run(sql: string, ...params: Array<string | number | null>): void {
    this.db.statement(sql).run(...params)
  }

  // ── A run's life ────────────────────────────────────────────────────────────────────────────────

  /**
   * A claimed occurrence: its row, made once per occurrence (a retry of the same claim finds it). A run held by a
   * usage limit that starts again is that same run, not a new one.
   */
  begin(input: RunBegin): InboxRun {
    const id = this.db.transaction(() => {
      const existing = this.row('SELECT id FROM runs WHERE job_id = ? AND occurrence_key = ?', input.jobId, input.occurrenceKey)
      if (existing) {
        this.run(
          `UPDATE runs SET state = CASE WHEN ended_at IS NULL THEN ? ELSE state END, until = NULL,
             thread_id = COALESCE(?, thread_id), activation_id = COALESCE(?, activation_id) WHERE id = ?`,
          input.state ?? 'running', input.threadId ?? null, input.activationId ?? null, String(existing.id)
        )
        return String(existing.id)
      }
      const held = this.row(`SELECT id FROM runs WHERE job_id = ? AND state = 'paused_usage' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, input.jobId)
      if (held) {
        this.run(
          `UPDATE runs SET occurrence_key = ?, state = ?, until = NULL, thread_id = COALESCE(?, thread_id), activation_id = COALESCE(?, activation_id) WHERE id = ?`,
          input.occurrenceKey, input.state ?? 'running', input.threadId ?? null, input.activationId ?? null, String(held.id)
        )
        return String(held.id)
      }
      const number = Number(this.row('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM runs WHERE job_id = ?', input.jobId)?.next ?? 1)
      const runId = `run_${randomUUID()}`
      this.run(
        `INSERT INTO runs(id, job_id, job_name, number, occurrence_key, project_id, bot_id, activation_id, thread_id, assignee, started_at, state)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId, input.jobId, input.jobName, number, input.occurrenceKey, input.projectId ?? null, input.botId ?? null,
        input.activationId ?? null, input.threadId ?? null, assigneeKey(input.botId ? { kind: 'bot', botId: input.botId } : { kind: 'person' }),
        this.now(), input.state ?? 'running'
      )
      return runId
    })
    this.changed()
    return this.get(id)!
  }

  /** What became known about a live run: its thread, its engine run, that it waits (behind a thread, or a usage limit). */
  update(jobId: string, occurrenceKey: string, patch: { threadId?: string; engineRunId?: string; state?: InboxRunState; until?: string }): void {
    const row = this.row('SELECT id, ended_at FROM runs WHERE job_id = ? AND occurrence_key = ?', jobId, occurrenceKey)
    if (!row) return
    this.run(
      `UPDATE runs SET thread_id = COALESCE(?, thread_id), engine_run_id = COALESCE(?, engine_run_id),
         state = CASE WHEN ended_at IS NULL AND ? IS NOT NULL THEN ? ELSE state END,
         until = CASE WHEN ? IS NOT NULL THEN ? ELSE until END WHERE id = ?`,
      patch.threadId ?? null, patch.engineRunId ?? null, patch.state ?? null, patch.state ?? null, patch.until ?? null, patch.until ?? null, String(row.id)
    )
    this.changed()
  }

  /**
   * The run ended: done or failed. With no report, a `[SILENT]` reply is quiet and anything else is No report. A
   * failed run is a Needs you item; a `needs_you` report is one too. Made when it was never begun (a run refused
   * before its turn).
   */
  finish(input: RunFinish & { projectId?: string; botId?: string }): InboxRun {
    const id = this.db.transaction(() => {
      let row = this.row('SELECT * FROM runs WHERE job_id = ? AND occurrence_key = ?', input.jobId, input.occurrenceKey)
      if (!row) {
        this.begin({ jobId: input.jobId, jobName: input.jobName ?? input.jobId, occurrenceKey: input.occurrenceKey, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.botId ? { botId: input.botId } : {}), ...(input.threadId ? { threadId: input.threadId } : {}) })
        row = this.row('SELECT * FROM runs WHERE job_id = ? AND occurrence_key = ?', input.jobId, input.occurrenceKey)!
      }
      const runId = String(row.id)
      const level = str(row.level) ?? (input.silent && !input.failed ? 'quiet' : null)
      this.run(
        `UPDATE runs SET state = ?, ended_at = COALESCE(ended_at, ?), until = NULL, level = ?, error = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?`,
        input.failed ? 'failed' : 'done', this.now(), level, input.failed ? (input.error ?? 'Failed') : null, input.threadId ?? null, runId
      )
      if (input.failed) this.ensureItem(runId, 'failed', '', assigneeOf(String(row.assignee)))
      this.syncReportItem(runId)
      return runId
    })
    this.changed()
    return this.get(id)!
  }

  /** A bot's activations, as the bot engine reports them: a run's state follows its activation, and its end finishes it. */
  syncBotRuns(jobId: string, runs: ReadonlyArray<{ id: string; status: string; at: string; endedAt?: string; endReason?: string; threadId?: string }>): void {
    let touched = false
    for (const activation of runs) {
      const row = this.row('SELECT id, occurrence_key, state, ended_at, thread_id FROM runs WHERE job_id = ? AND activation_id = ?', jobId, activation.id)
      if (!row) continue
      if (activation.threadId && activation.threadId !== str(row.thread_id)) {
        this.run('UPDATE runs SET thread_id = ? WHERE id = ?', activation.threadId, String(row.id))
        touched = true
      }
      if (row.ended_at) continue
      const status = activation.status
      if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'blocked') {
        const failed = status !== 'done'
        this.finish({ jobId, occurrenceKey: String(row.occurrence_key), failed, ...(failed ? { error: activation.endReason ? activation.endReason.replace(/_/g, ' ') : status === 'blocked' ? 'Stopped at a missing permission' : 'Failed' } : {}), ...(activation.threadId ? { threadId: activation.threadId } : {}) })
        continue
      }
      const state: InboxRunState = status === 'queued' ? 'queued' : status === 'paused' ? 'paused_usage' : 'running'
      if (state !== row.state) {
        this.run('UPDATE runs SET state = ? WHERE id = ?', state, String(row.id))
        touched = true
      }
    }
    if (touched) this.changed()
  }

  // ── run_report ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The live run a caller's turn belongs to: the run its engine run is, else the live run on its thread (or the bot
   * activation's). Undefined when the caller is not in an automation run that is still going.
   */
  liveRunFor(caller: { threadId: string; runId?: string; activationId?: string }): InboxRun | undefined {
    const row = (caller.runId ? this.row('SELECT id FROM runs WHERE engine_run_id = ? AND ended_at IS NULL', caller.runId) : undefined)
      ?? (caller.activationId ? this.row('SELECT id FROM runs WHERE activation_id = ? AND ended_at IS NULL', caller.activationId) : undefined)
      ?? this.row('SELECT id FROM runs WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', caller.threadId)
    return row ? this.get(String(row.id)) : undefined
  }

  /** `run_report`: the run's level and one line. At most one report per run; a second call replaces the first. */
  report(caller: { threadId: string; runId?: string; activationId?: string }, level: unknown, summary: unknown): InboxRun {
    if (!isRunLevel(level)) throw new RunReportError('level is quiet, fyi, look or needs_you')
    if (typeof summary !== 'string' || !summary.trim()) throw new RunReportError('summary is one short line saying why')
    const run = this.liveRunFor(caller)
    if (!run) throw new RunReportError('This thread has no automation run going now; run_report is for an automation\'s own run.')
    const line = summary.trim().split(/\r?\n/).find((part) => part.trim())!.trim().slice(0, MAX_SUMMARY)
    this.db.transaction(() => {
      this.run('UPDATE runs SET level = ?, summary = ?, reported_at = ? WHERE id = ?', level, line, this.now(), run.id)
      this.syncReportItem(run.id)
    })
    this.changed()
    return this.get(run.id)!
  }

  /**
   * A `needs_you` report is an open item; a later report of another level takes back the item it made, unless the
   * person already resolved it. Only an ended run's report counts: a live run joins the queue when it ends.
   */
  private syncReportItem(runId: string): void {
    const row = this.row('SELECT level, ended_at, assignee FROM runs WHERE id = ?', runId)
    if (!row?.ended_at) return
    if (row.level === 'needs_you') this.ensureItem(runId, 'needs_you', '', assigneeOf(String(row.assignee)))
    else this.run(`DELETE FROM items WHERE run_id = ? AND kind = 'needs_you' AND resolved_at IS NULL`, runId)
  }

  // ── Usage ───────────────────────────────────────────────────────────────────────────────────────

  /** One request's usage on a run's turn, added to its model's line. A thread with no live run is not counted. */
  addUsage(caller: { threadId: string; runId?: string }, usage: RunModelUsage): boolean {
    const row = (caller.runId ? this.row('SELECT id, usage FROM runs WHERE engine_run_id = ?', caller.runId) : undefined)
      ?? this.row('SELECT id, usage FROM runs WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', caller.threadId)
    if (!row) return false
    const lines = usageOf(row.usage)
    const line = lines.find((entry) => entry.model === usage.model && entry.provider === usage.provider)
    if (line) {
      line.input += usage.input
      line.output += usage.output
      line.cacheRead += usage.cacheRead
      line.cacheWrite += usage.cacheWrite
      if (usage.costUsd !== undefined) line.costUsd = (line.costUsd ?? 0) + usage.costUsd
    } else {
      lines.push({ model: usage.model, ...(usage.provider ? { provider: usage.provider } : {}), input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) })
    }
    this.run('UPDATE runs SET usage = ? WHERE id = ?', JSON.stringify(lines), String(row.id))
    return true
  }

  // ── The Needs you queue ─────────────────────────────────────────────────────────────────────────

  private ensureItem(runId: string, kind: InboxItemKind, ref: string, assignee: InboxAssignee): void {
    this.run(
      `INSERT INTO items(id, run_id, kind, ref, assignee, created_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, kind, ref) DO NOTHING`,
      `item_${randomUUID()}`, runId, kind, ref, assigneeKey(assignee), this.now()
    )
  }

  /**
   * An approval or a question opened on a thread: an item of the run going on it, assigned to the person (they answer
   * it). Nothing when the thread has no live automation run.
   */
  openAsk(threadId: string, requestId: string, kind: 'approval' | 'ask'): boolean {
    const row = this.row('SELECT id FROM runs WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', threadId)
    if (!row) return false
    this.ensureItem(String(row.id), kind, requestId, { kind: 'person' })
    this.changed()
    return true
  }

  /** It was answered where it was asked (or it closed): its item is resolved. */
  closeAsk(requestId: string): boolean {
    const open = this.rows(`SELECT id FROM items WHERE ref = ? AND kind IN ('approval', 'ask') AND resolved_at IS NULL`, requestId)
    if (!open.length) return false
    this.run(`UPDATE items SET resolved_at = ?, resolved_by = 'answered' WHERE ref = ? AND kind IN ('approval', 'ask') AND resolved_at IS NULL`, this.now(), requestId)
    this.changed()
    return true
  }

  /** Resolve: every open item of the run. One Undo takes back this one Resolve. Opening a run never calls this. */
  resolve(runId: string): number {
    const count = this.db.transaction(() => {
      const open = this.rows('SELECT id FROM items WHERE run_id = ? AND resolved_at IS NULL', runId)
      if (!open.length) return 0
      const batch = Number(this.row('SELECT COALESCE(MAX(resolve_batch), 0) + 1 AS next FROM items')?.next ?? 1)
      this.run(`UPDATE items SET resolved_at = ?, resolved_by = 'person', resolve_batch = ? WHERE run_id = ? AND resolved_at IS NULL`, this.now(), batch, runId)
      return open.length
    })
    if (count) this.changed()
    return count
  }

  /** Undo: the person's last Resolve is taken back; its items are open again. Returns the run, or undefined. */
  undo(): string | undefined {
    const runId = this.db.transaction(() => {
      const last = this.row(`SELECT resolve_batch, run_id FROM items WHERE resolved_by = 'person' AND resolve_batch IS NOT NULL ORDER BY resolve_batch DESC LIMIT 1`)
      if (!last) return undefined
      this.run('UPDATE items SET resolved_at = NULL, resolved_by = NULL, resolve_batch = NULL WHERE resolve_batch = ?', Number(last.resolve_batch))
      return String(last.run_id)
    })
    if (runId) this.changed()
    return runId
  }

  private lastResolved(): { runId: string; jobName: string } | undefined {
    const row = this.row(`SELECT items.run_id AS run_id, runs.job_name AS job_name FROM items JOIN runs ON runs.id = items.run_id WHERE items.resolved_by = 'person' AND items.resolve_batch IS NOT NULL ORDER BY items.resolve_batch DESC LIMIT 1`)
    return row ? { runId: String(row.run_id), jobName: String(row.job_name) } : undefined
  }

  // ── Tuning ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Too noisy / Should have told me on a run: a dated note on its automation, which the next runs' first message
   * carries. Given again on the same run, it is taken back. Returns the note, or undefined when it was taken back.
   */
  calibrate(runId: string, kind: TuningNote['kind']): TuningNote | undefined {
    const run = this.get(runId)
    if (!run) throw new RunReportError(`No run ${runId}.`)
    const existing = this.row('SELECT id FROM tuning WHERE run_id = ? AND kind = ?', runId, kind)
    if (existing) {
      this.run('DELETE FROM tuning WHERE id = ?', String(existing.id))
      this.changed()
      return undefined
    }
    const note: TuningNote = { id: `tune_${randomUUID()}`, jobId: run.jobId, kind, runId, runNumber: run.number, text: tuningText(kind, run), createdAt: this.now() }
    this.run('INSERT INTO tuning(id, job_id, kind, run_id, run_number, text, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)', note.id, note.jobId, note.kind, runId, run.number, note.text, note.createdAt)
    this.changed()
    return note
  }

  /** Remove in Manage: the next run's first message no longer has it. */
  removeTuning(noteId: string): boolean {
    const row = this.row('SELECT id FROM tuning WHERE id = ?', noteId)
    if (!row) return false
    this.run('DELETE FROM tuning WHERE id = ?', noteId)
    this.changed()
    return true
  }

  tuning(jobId?: string): TuningNote[] {
    const rows = jobId ? this.rows('SELECT * FROM tuning WHERE job_id = ? ORDER BY created_at DESC', jobId) : this.rows('SELECT * FROM tuning ORDER BY created_at DESC')
    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      kind: row.kind === 'missed' ? 'missed' : 'noisy',
      ...(str(row.run_id) ? { runId: String(row.run_id) } : {}),
      ...(typeof row.run_number === 'number' ? { runNumber: row.run_number } : {}),
      text: String(row.text),
      createdAt: String(row.created_at)
    }))
  }

  /** The hidden first message of a run of this automation: the levels, its context, its newest Tuning notes. */
  notice(jobId: string, name?: string): string {
    let context: string | undefined
    let tuning: TuningNote[] = []
    try {
      context = this.meta(jobId)?.context
      tuning = this.tuning(jobId).slice(0, TUNING_IN_PROMPT)
    } catch {
      // Without them the run still knows the levels.
    }
    return runReportNotice({ ...(name ? { name } : {}), ...(context ? { context } : {}), tuning })
  }

  // ── What an automation was made from ────────────────────────────────────────────────────────────

  meta(jobId: string): { originThreadId?: string; context?: string } | undefined {
    const row = this.row('SELECT * FROM meta WHERE job_id = ?', jobId)
    if (!row) return undefined
    return { ...(str(row.origin_thread_id) ? { originThreadId: String(row.origin_thread_id) } : {}), ...(str(row.context) ? { context: String(row.context) } : {}) }
  }

  setMeta(jobId: string, meta: { originThreadId?: string; context?: string }): void {
    this.run(
      'INSERT INTO meta(job_id, origin_thread_id, context) VALUES(?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET origin_thread_id = excluded.origin_thread_id, context = excluded.context',
      jobId, meta.originThreadId ?? null, meta.context ?? null
    )
    this.changed()
  }

  moveMeta(fromJobId: string, toJobId: string): void {
    const meta = this.meta(fromJobId)
    if (!meta) return
    this.db.transaction(() => {
      this.run('DELETE FROM meta WHERE job_id = ?', fromJobId)
      this.setMeta(toJobId, meta)
    })
  }

  /** A deleted automation: its notes and meta go; its runs (and their threads) stay in the inbox's history. */
  forgetAutomation(jobId: string): void {
    this.db.transaction(() => {
      this.run('DELETE FROM tuning WHERE job_id = ?', jobId)
      this.run('DELETE FROM meta WHERE job_id = ?', jobId)
      // Nothing of a deleted automation waits for anyone.
      this.run(`UPDATE items SET resolved_at = ?, resolved_by = 'answered' WHERE resolved_at IS NULL AND run_id IN (SELECT id FROM runs WHERE job_id = ?)`, this.now(), jobId)
    })
    this.changed()
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────────

  get(runId: string): InboxRun | undefined {
    const row = this.row('SELECT * FROM runs WHERE id = ?', runId)
    return row ? this.runOf(row, this.itemsOf([runId]).get(runId) ?? []) : undefined
  }

  private itemsOf(runIds: readonly string[]): Map<string, InboxItem[]> {
    const map = new Map<string, InboxItem[]>()
    if (!runIds.length) return map
    const wanted = new Set(runIds)
    // Read all items of the listed runs: few per run.
    const rows = runIds.length > 200 ? this.rows('SELECT * FROM items ORDER BY created_at') : this.rows(`SELECT * FROM items WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY created_at`, ...runIds)
    for (const row of rows) {
      const runId = String(row.run_id)
      if (!wanted.has(runId)) continue
      const item: InboxItem = {
        id: String(row.id),
        runId,
        kind: String(row.kind) as InboxItemKind,
        assignee: assigneeOf(String(row.assignee)),
        createdAt: String(row.created_at),
        ...(str(row.resolved_at) ? { resolvedAt: String(row.resolved_at) } : {}),
        ...(row.resolved_by === 'person' || row.resolved_by === 'answered' ? { resolvedBy: row.resolved_by } : {})
      }
      map.set(runId, [...(map.get(runId) ?? []), item])
    }
    return map
  }

  private runOf(row: Row, items: InboxItem[]): InboxRun {
    const level = isRunLevel(row.level) ? (row.level as RunLevel) : undefined
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      jobName: String(row.job_name),
      number: Number(row.number),
      ...(str(row.project_id) ? { projectId: String(row.project_id) } : {}),
      ...(str(row.thread_id) ? { threadId: String(row.thread_id) } : {}),
      ...(str(row.bot_id) ? { botId: String(row.bot_id) } : {}),
      startedAt: String(row.started_at),
      ...(str(row.ended_at) ? { endedAt: String(row.ended_at) } : {}),
      state: String(row.state) as InboxRunState,
      ...(str(row.until) ? { until: String(row.until) } : {}),
      ...(level ? { level } : {}),
      ...(str(row.summary) ? { summary: String(row.summary) } : {}),
      ...(str(row.error) ? { error: String(row.error) } : {}),
      usage: usageOf(row.usage),
      items
    }
  }

  /** The month key and the first instant of this month, in this computer's clock. */
  private month(): { key: string; since: string; label: string } {
    const now = new Date(this.clock())
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    return { key, since: start.toISOString(), label: `API keys · ${now.toLocaleDateString('en-GB', { month: 'short' })}` }
  }

  /** The inbox: the newest runs (and every run with an open item), the Tuning notes, meta and this month's usage. */
  list(options: { limit?: number } = {}): AutomationInbox {
    const limit = Math.max(1, Math.min(options.limit ?? LIST_LIMIT, 2_000))
    const newest = this.rows('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit)
    const seen = new Set(newest.map((row) => String(row.id)))
    const waiting = this.rows('SELECT runs.* FROM runs JOIN items ON items.run_id = runs.id WHERE items.resolved_at IS NULL').filter((row) => {
      if (seen.has(String(row.id))) return false
      seen.add(String(row.id))
      return true
    })
    const rows = [...newest, ...waiting]
    const items = this.itemsOf(rows.map((row) => String(row.id)))
    const runs = rows.map((row) => this.runOf(row, items.get(String(row.id)) ?? [])).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    const month = this.month()
    const byJob: AutomationInbox['month']['byJob'] = {}
    for (const row of this.rows('SELECT job_id, usage FROM runs WHERE started_at >= ?', month.since)) {
      const entry = (byJob[String(row.job_id)] ??= { tokens: 0, costUsd: 0 })
      for (const line of usageOf(row.usage)) {
        entry.tokens += line.input + line.output
        entry.costUsd += line.costUsd ?? 0
      }
    }
    const meta = this.rows('SELECT * FROM meta').map((row) => ({
      jobId: String(row.job_id),
      ...(str(row.origin_thread_id) ? { originThreadId: String(row.origin_thread_id) } : {}),
      ...(str(row.context) ? { context: String(row.context) } : {})
    }))
    const undo = this.lastResolved()
    return { runs, tuning: this.tuning(), meta, month: { key: month.key, label: month.label, byJob }, ...(undo ? { undo } : {}), generatedAt: this.now() }
  }

  /** The project dots: unresolved items assigned to the person, by the project of their run. */
  counts(): InboxCounts {
    const rows = this.rows(`SELECT runs.project_id AS project_id, COUNT(DISTINCT runs.id) AS n FROM items JOIN runs ON runs.id = items.run_id
      WHERE items.resolved_at IS NULL AND items.assignee = 'person' GROUP BY runs.project_id`)
    const byProject: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      const n = Number(row.n)
      total += n
      if (str(row.project_id)) byProject[String(row.project_id)] = n
    }
    return { byProject, total }
  }
}
