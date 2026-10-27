import type { PermissionAction } from '../../shared/permissionMode'
import type { UserQuestionAnswers } from '../../shared/types'
import { canAnswerApproval, type Answerer, type ApprovalRefusal, type LineageLookup } from './approvalRights'
import { int, json, str, type Row } from './db/rows'
import type { EffectOutbox } from './EffectOutbox'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'

/**
 * Saved approval requests (SPEC §17): a provider's, the Pi agent's or a Mousse tool's request to
 * run a command, change files or use a tool. A request is a row in the Run Engine database with a
 * thread event for every change, so it survives a client reconnect and a daemon restart, any client
 * can answer it, and two answers race safely: `settle` is the one place a request is answered.
 */

export type ApprovalStatus = 'pending' | 'answered' | 'cancelled'

/**
 * How an answer reaches the agent. `live`: the provider's callback is waiting in this process.
 * `continue`: the run that asked is gone (the daemon restarted), so an answer starts a continue turn.
 */
export type ApprovalAnswerPath = 'live' | 'continue'

export type ApprovalDecision = 'allow' | 'reject'

/** Why a request was closed without an answer. */
export type ApprovalCancelReason = 'stopped' | 'steered' | 'turn_ended' | 'withdrawn' | 'thread_deleted' | 'timed_out'

/** One answer option and the decision it means, whatever id the provider gave it. */
export interface ApprovalOption {
  id: string
  label: string
  decision: ApprovalDecision
  scope?: 'once' | 'always'
}

export interface ApprovalQuestion {
  id: string
  prompt: string
  options: ApprovalOption[]
  allowMultiple?: boolean
}

/** Who answered, as stored (an agent's permission mode is not kept). */
export type AnsweredBy =
  | { kind: 'user'; via?: 'gui' | 'cli' | 'bridge' | 'internal' }
  | { kind: 'agent'; threadId: string; runId: string }

export interface ApprovalRecord {
  requestId: string
  threadId: string
  runId: string | null
  instanceId: string
  provider: string
  action: PermissionAction
  permissionKey: string
  fingerprint: string | null
  questions: ApprovalQuestion[]
  reason: string | null
  answerPath: ApprovalAnswerPath
  uncertain: boolean
  uncertainTools: string[] | null
  status: ApprovalStatus
  answers: UserQuestionAnswers | null
  decision: ApprovalDecision | null
  decisionScope: 'once' | 'always' | null
  feedback: string | null
  answeredBy: AnsweredBy | null
  cancelReason: string | null
  continuationRunId: string | null
  grantConsumedAt: string | null
  deliveredAt: string | null
  createdAt: string
  settledAt: string | null
}

export type NewApproval = Pick<ApprovalRecord, 'requestId' | 'threadId' | 'instanceId' | 'provider' | 'action' | 'permissionKey' | 'questions'> &
  Partial<Pick<ApprovalRecord, 'runId' | 'fingerprint' | 'reason' | 'answerPath'>>

/** The answers of one dead run are all in: the continue turn that delivers them is due. */
export interface ContinuationDue {
  threadId: string
  runId: string
  requestIds: string[]
  /** The run was `uncertain`: the continuation needs the acknowledgement. */
  uncertain: boolean
}

export type SettleOutcome =
  | { ok: true; decision: ApprovalDecision; scope?: 'once' | 'always'; record: ApprovalRecord; continuationDue?: ContinuationDue }
  | {
      ok: false
      reason: 'unknown' | 'already_answered' | 'cancelled' | ApprovalRefusal
      /** `already_answered`: who won, and what they decided. */
      answeredBy?: AnsweredBy
      decision?: ApprovalDecision
      cancelReason?: string
    }

/** What a send that denies the thread's saved approvals did (`ThreadApprovals.settleForSend`). */
export type SendSettlement =
  | { refused: true }
  | { refused?: false; requestIds: string[]; denied: string[] }

export interface BootRecovery {
  /** Pending requests whose run died: answering them now continues the thread. */
  continued: string[]
  /** Pending requests with no run that could continue: closed. */
  cancelled: string[]
  /** Answered requests whose answer never reached the provider before the process died. */
  undelivered: string[]
}

/** The answer map that picks `decision` on the question's own option ids; empty when it has none. */
export function answersFor(questions: readonly ApprovalQuestion[], decision: ApprovalDecision): UserQuestionAnswers {
  const question = questions[0]
  const option = question?.options.find((candidate) => candidate.decision === decision && candidate.scope !== 'always')
  return question && option ? { [question.id]: option.id } : {}
}

/** The decision a set of answers means: an option nobody offered reads as a rejection. */
export function meaningOf(questions: readonly ApprovalQuestion[], answers: UserQuestionAnswers): { decision: ApprovalDecision; scope?: 'once' | 'always' } {
  const question = questions[0]
  const raw = question ? answers[question.id] : undefined
  const chosen = Array.isArray(raw) ? raw[0] : raw
  const option = question?.options.find((candidate) => candidate.id === chosen)
  if (!option) return { decision: 'reject' }
  return { decision: option.decision, ...(option.scope ? { scope: option.scope } : {}) }
}

function feedbackOf(answers: UserQuestionAnswers): string | null {
  const raw = answers.feedback
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text ? text.slice(0, 2000) : null
}

/**
 * A custom answer typed into the card instead of picking an option ("no, use pnpm"): it is no option, so
 * the request is rejected, and the text is the reason the agent is given.
 */
function customAnswerOf(questions: readonly ApprovalQuestion[], answers: UserQuestionAnswers): string | null {
  const question = questions[0]
  const raw = question ? answers[question.id] : undefined
  const chosen = typeof raw === 'string' ? raw.trim() : ''
  if (!question || !chosen || question.options.some((option) => option.id === chosen)) return null
  return chosen.slice(0, 2000)
}

function toRecord(row: Row): ApprovalRecord {
  return {
    requestId: String(row.request_id),
    threadId: String(row.thread_id),
    runId: str(row.run_id),
    instanceId: String(row.instance_id),
    provider: String(row.provider),
    action: row.action as PermissionAction,
    permissionKey: String(row.permission_key),
    fingerprint: str(row.fingerprint),
    questions: json<ApprovalQuestion[]>(row.questions) ?? [],
    reason: str(row.reason),
    answerPath: row.answer_path as ApprovalAnswerPath,
    uncertain: int(row.uncertain) === 1,
    uncertainTools: json<string[]>(row.uncertain_tools),
    status: row.status as ApprovalStatus,
    answers: json<UserQuestionAnswers>(row.answers),
    decision: str(row.decision) as ApprovalDecision | null,
    decisionScope: str(row.decision_scope) as 'once' | 'always' | null,
    feedback: str(row.feedback),
    answeredBy: json<AnsweredBy>(row.answered_by),
    cancelReason: str(row.cancel_reason),
    continuationRunId: str(row.continuation_run_id),
    grantConsumedAt: str(row.grant_consumed_at),
    deliveredAt: str(row.delivered_at),
    createdAt: String(row.created_at),
    settledAt: str(row.settled_at)
  }
}

function storedAnswerer(answerer: Answerer): AnsweredBy {
  return answerer.kind === 'user'
    ? { kind: 'user', ...(answerer.via ? { via: answerer.via } : {}) }
    : { kind: 'agent', threadId: answerer.threadId, runId: answerer.runId }
}

const now = (store: RunStore): string => new Date(store.db.clock()).toISOString()

function select(store: RunStore, where: string, ...params: Array<string | number>): ApprovalRecord[] {
  return store.db.statement(`SELECT * FROM approval_requests WHERE ${where} ORDER BY created_at, rowid`).all(...params).map(toRecord)
}

function event(store: RunStore, type: string, record: ApprovalRecord, payload: Record<string, unknown> = {}): void {
  store.appendEvent({ threadId: record.threadId, runId: record.runId, type, payload: { requestId: record.requestId, ...payload } })
}

/**
 * Closes pending requests that match `where` without an answer. Joins the caller's transaction
 * (the terminal write of the run that asked). Returns the closed requests.
 */
export function cancelApprovalRows(store: RunStore, where: string, params: Array<string | number>, reason: ApprovalCancelReason): ApprovalRecord[] {
  return store.db.transaction(() => {
    const at = now(store)
    const closed: ApprovalRecord[] = []
    for (const row of select(store, `status = 'pending' AND ${where}`, ...params)) {
      const result = store.db
        .statement("UPDATE approval_requests SET status = 'cancelled', cancel_reason = ?, settled_at = ? WHERE request_id = ? AND status = 'pending'")
        .run(reason, at, row.requestId)
      if (Number(result.changes) !== 1) continue
      const next = { ...row, status: 'cancelled' as const, cancelReason: reason, settledAt: at }
      event(store, 'approval.cancelled', next, { reason })
      closed.push(next)
    }
    return closed
  })
}

export class ThreadApprovals {
  constructor(
    private readonly store: RunStore,
    private readonly deps: { outbox: EffectOutbox; lineage: LineageLookup }
  ) {}

  /** Saves a new request (`pending`) and records `approval.pending`. */
  create(input: NewApproval): ApprovalRecord {
    return this.db.transaction(() => {
      const record: ApprovalRecord = {
        requestId: input.requestId,
        threadId: input.threadId,
        runId: input.runId ?? null,
        instanceId: input.instanceId,
        provider: input.provider,
        action: input.action,
        permissionKey: input.permissionKey,
        fingerprint: input.fingerprint ?? null,
        questions: input.questions,
        reason: input.reason ?? null,
        answerPath: input.answerPath ?? 'live',
        uncertain: false,
        uncertainTools: null,
        status: 'pending',
        answers: null,
        decision: null,
        decisionScope: null,
        feedback: null,
        answeredBy: null,
        cancelReason: null,
        continuationRunId: null,
        grantConsumedAt: null,
        deliveredAt: null,
        createdAt: now(this.store),
        settledAt: null
      }
      this.db
        .statement(
          `INSERT INTO approval_requests(request_id, thread_id, run_id, instance_id, provider, action, permission_key,
             fingerprint, questions, reason, answer_path, uncertain, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`
        )
        .run(
          record.requestId, record.threadId, record.runId, record.instanceId, record.provider, record.action,
          record.permissionKey, record.fingerprint, stableStringify(record.questions), record.reason,
          record.answerPath, record.createdAt
        )
      event(this.store, 'approval.pending', record, { action: record.action, permissionKey: record.permissionKey, answerPath: record.answerPath })
      return record
    })
  }

  /** A request in any status. */
  get(requestId: string): ApprovalRecord | null {
    const row = this.db.statement('SELECT * FROM approval_requests WHERE request_id = ?').get(requestId)
    return row ? toRecord(row) : null
  }

  listPending(threadId?: string): ApprovalRecord[] {
    return threadId === undefined ? select(this.store, "status = 'pending'") : select(this.store, "status = 'pending' AND thread_id = ?", threadId)
  }

  listPendingForRun(runId: string): ApprovalRecord[] {
    return select(this.store, "status = 'pending' AND run_id = ?", runId)
  }

  /** Answered requests whose answer has not reached its provider or been handed to a run yet. */
  listUndelivered(): ApprovalRecord[] {
    return select(this.store, "status = 'answered' AND delivered_at IS NULL")
  }

  /** The requests a run was started to deliver (a continue turn, or a message that denied them). */
  listDeliveredToRun(runId: string): ApprovalRecord[] {
    return select(this.store, 'continuation_run_id = ?', runId)
  }

  /** How many requests a dead run left that still wait for the user, and how many of those are answered. */
  progress(record: ApprovalRecord): { answered: number; total: number } | null {
    if (record.answerPath !== 'continue' || !record.runId) return null
    const rows = select(this.store, "run_id = ? AND answer_path = 'continue' AND (status = 'pending' OR (status = 'answered' AND delivered_at IS NULL))", record.runId)
    return { answered: rows.filter((row) => row.status === 'answered').length, total: rows.length }
  }

  /**
   * Answers a request: the only place one is settled. One transaction checks who may answer
   * (`canAnswerApproval`), maps the chosen option to its declared decision, settles the row if it
   * is still pending, and records the thread event. For a `live` request it also writes the
   * `request.respond` effect that delivers the answer to the waiting provider, so a crash can never
   * lose a committed answer (`enqueueDelivery: false` leaves delivery to the caller).
   *
   * The loser of a race learns who won. For a `continue` request, `continuationDue` is set once every
   * request of its dead run is answered: the caller admits the continue turn that carries them.
   */
  settle(requestId: string, answers: UserQuestionAnswers, answeredBy: Answerer, options: { enqueueDelivery?: boolean } = {}): SettleOutcome {
    return this.db.transaction(() => {
      const row = this.get(requestId)
      if (!row) return { ok: false, reason: 'unknown' }
      return this.settleRow(row, answers, answeredBy, options.enqueueDelivery === true)
    })
  }

  private settleRow(row: ApprovalRecord, answers: UserQuestionAnswers, answeredBy: Answerer, enqueueDelivery: boolean): SettleOutcome {
    if (row.status === 'answered')
      return { ok: false, reason: 'already_answered', ...(row.answeredBy ? { answeredBy: row.answeredBy } : {}), ...(row.decision ? { decision: row.decision } : {}) }
    if (row.status === 'cancelled') return { ok: false, reason: 'cancelled', ...(row.cancelReason ? { cancelReason: row.cancelReason } : {}) }
    const meaning = meaningOf(row.questions, answers)
    const rights = canAnswerApproval({ threadId: row.threadId, action: row.action, permissionKey: row.permissionKey }, answeredBy, meaning, this.deps.lineage)
    if (!rights.ok) return { ok: false, reason: rights.code }
    const at = now(this.store)
    const feedback = feedbackOf(answers) ?? customAnswerOf(row.questions, answers)
    // The provider reads the reason from `feedback`, whether it came as a field or as a typed answer.
    if (feedback && answers.feedback === undefined) answers = { ...answers, feedback }
    const who = storedAnswerer(answeredBy)
    const result = this.db
      .statement(
        `UPDATE approval_requests SET status = 'answered', answers = ?, decision = ?, decision_scope = ?, feedback = ?,
           answered_by = ?, settled_at = ? WHERE request_id = ? AND status = 'pending'`
      )
      .run(stableStringify(answers), meaning.decision, meaning.scope ?? null, feedback, stableStringify(who), at, row.requestId)
    if (Number(result.changes) !== 1) {
      // Another answer committed first: report it.
      const current = this.get(row.requestId)
      return current && current.status !== 'pending' ? this.settleRow(current, answers, answeredBy, enqueueDelivery) : { ok: false, reason: 'unknown' }
    }
    const record: ApprovalRecord = { ...row, status: 'answered', answers, decision: meaning.decision, decisionScope: meaning.scope ?? null, feedback, answeredBy: who, settledAt: at }
    event(this.store, 'approval.answered', record, { decision: meaning.decision, ...(meaning.scope ? { scope: meaning.scope } : {}), answeredBy: who, answerPath: row.answerPath })
    if (row.answerPath === 'live') {
      if (enqueueDelivery) this.deps.outbox.enqueue({ threadId: row.threadId, runId: row.runId, kind: 'request.respond', payload: { requestId: row.requestId } })
      return { ok: true, decision: meaning.decision, ...(meaning.scope ? { scope: meaning.scope } : {}), record }
    }
    const due = this.continuationDue(record)
    return { ok: true, decision: meaning.decision, ...(meaning.scope ? { scope: meaning.scope } : {}), record, ...(due ? { continuationDue: due } : {}) }
  }

  /** The continue turn of a dead run, once none of its requests is still pending. */
  private continuationDue(record: ApprovalRecord): ContinuationDue | null {
    if (!record.runId) return null
    if (this.listPendingForRun(record.runId).length) return null
    const rows = select(this.store, "run_id = ? AND status = 'answered' AND delivered_at IS NULL AND answer_path = 'continue'", record.runId)
    if (!rows.length) return null
    return { threadId: record.threadId, runId: record.runId, requestIds: rows.map((row) => row.requestId), uncertain: rows.some((row) => row.uncertain) }
  }

  /**
   * A message sent while approvals wait denies them with the message as the reason (SPEC §17.3),
   * inside the send's own admission transaction. The thread's whole delivery group is settled: every
   * pending request, and the answered requests of a dead run that no turn has been given yet. The
   * caller binds the returned ids to the message's run (`bindDelivery`).
   *
   * Nothing is settled when the sender may not answer one of them (an agent that cannot deny
   * cannot answer): the group stays as it was and the message queues.
   */
  settleForSend(threadId: string, send: { feedback?: string; answeredBy: Answerer }): SendSettlement {
    return this.db.transaction(() => {
      const pending = this.listPending(threadId)
      for (const row of pending) {
        const rights = canAnswerApproval({ threadId: row.threadId, action: row.action, permissionKey: row.permissionKey }, send.answeredBy, { decision: 'reject' }, this.deps.lineage)
        if (!rights.ok) return { refused: true }
      }
      const denied: string[] = []
      for (const row of pending) {
        const answers: UserQuestionAnswers = { ...answersFor(row.questions, 'reject'), ...(send.feedback ? { feedback: send.feedback } : {}) }
        const outcome = this.settleRow(row, answers, send.answeredBy, false)
        if (outcome.ok) denied.push(row.requestId)
      }
      const waiting = select(this.store, "thread_id = ? AND status = 'answered' AND delivered_at IS NULL AND answer_path = 'continue'", threadId)
      const requestIds = [...new Set([...denied, ...waiting.map((row) => row.requestId)])]
      return { requestIds, denied }
    })
  }

  /**
   * Hands answered requests to the run that delivers them: the continue turn, or the message that
   * denied them. A request already given to a run is left alone. Joins the admitting transaction.
   */
  bindDelivery(requestIds: readonly string[], runId: string): void {
    this.db.transaction(() => {
      const at = now(this.store)
      for (const requestId of requestIds) {
        const result = this.db
          .statement("UPDATE approval_requests SET continuation_run_id = ?, delivered_at = ? WHERE request_id = ? AND status = 'answered' AND delivered_at IS NULL")
          .run(runId, at, requestId)
        if (Number(result.changes) !== 1) continue
        const record = this.get(requestId)
        if (record) event(this.store, 'approval.delivered', record, { runId })
      }
    })
  }

  /** The answer reached its waiting provider. */
  markDelivered(requestId: string): void {
    this.db.transaction(() => {
      const result = this.db
        .statement("UPDATE approval_requests SET delivered_at = ? WHERE request_id = ? AND status = 'answered' AND delivered_at IS NULL")
        .run(now(this.store), requestId)
      if (Number(result.changes) !== 1) return
      const record = this.get(requestId)
      if (record) event(this.store, 'approval.delivered', record, {})
    })
  }

  cancel(requestId: string, reason: ApprovalCancelReason): boolean {
    return cancelApprovalRows(this.store, 'request_id = ?', [requestId], reason).length === 1
  }

  cancelForThread(threadId: string, reason: ApprovalCancelReason): ApprovalRecord[] {
    return cancelApprovalRows(this.store, 'thread_id = ?', [threadId], reason)
  }

  cancelForRun(runId: string, reason: ApprovalCancelReason): ApprovalRecord[] {
    return cancelApprovalRows(this.store, 'run_id = ?', [runId], reason)
  }

  /**
   * Boot (SPEC §17.6): whatever waited for a provider in the dead process can only continue the
   * thread now. A pending request of a run the crash cut off turns `continue`; one the crash left
   * `uncertain` records which tools may already have run. A request whose run cannot be continued
   * is closed. An answer that never reached its provider becomes `continue` too and is reported.
   */
  recoverOnBoot(uncertainTools: ReadonlyMap<string, string[]>): BootRecovery {
    return this.db.transaction(() => {
      const report: BootRecovery = { continued: [], cancelled: [], undelivered: [] }
      const rows = select(this.store, "status = 'pending' OR (status = 'answered' AND delivered_at IS NULL AND answer_path = 'live')")
      const at = now(this.store)
      for (const row of rows) {
        const run = row.runId ? this.store.getRun(row.runId) : null
        const resumable = run !== null && (run.status === 'interrupted' || run.status === 'uncertain')
        if (!resumable) {
          if (row.status === 'pending') {
            cancelApprovalRows(this.store, 'request_id = ?', [row.requestId], 'turn_ended')
            report.cancelled.push(row.requestId)
          } else {
            // Nothing can continue this run: the answer has nobody to be delivered to.
            this.db.statement('UPDATE approval_requests SET delivered_at = ? WHERE request_id = ?').run(at, row.requestId)
          }
          continue
        }
        const tools = run.status === 'uncertain' ? [...new Set(uncertainTools.get(run.runId) ?? [])] : null
        this.db
          .statement("UPDATE approval_requests SET answer_path = 'continue', uncertain = ?, uncertain_tools = ? WHERE request_id = ?")
          .run(run.status === 'uncertain' ? 1 : 0, tools ? stableStringify(tools) : null, row.requestId)
        event(this.store, 'approval.continue', row, { uncertain: run.status === 'uncertain', ...(tools ? { tools } : {}) })
        if (row.status === 'pending') report.continued.push(row.requestId)
        else report.undelivered.push(row.requestId)
      }
      // Answered requests that were already `continue` before this boot and never started their turn.
      for (const row of select(this.store, "status = 'answered' AND delivered_at IS NULL AND answer_path = 'continue'"))
        if (!report.undelivered.includes(row.requestId)) report.undelivered.push(row.requestId)
      return report
    })
  }

  /**
   * One-shot continuation grant (SPEC §17.5): the user's approval after a restart authorizes the
   * same action, once, inside the run that was started to deliver it. Consumed by the first request
   * with the same fingerprint in that run; never usable by a later run. A request without a
   * fingerprint is never granted.
   */
  consumeContinuationGrant(threadId: string, runId: string, fingerprint: string | null): boolean {
    if (!fingerprint) return false
    return this.db.transaction(() => {
      const at = now(this.store)
      const row = this.db
        .statement(
          `SELECT request_id FROM approval_requests WHERE thread_id = ? AND continuation_run_id = ? AND fingerprint = ?
             AND decision = 'allow' AND grant_consumed_at IS NULL ORDER BY created_at, rowid LIMIT 1`
        )
        .get(threadId, runId, fingerprint)
      if (!row) return false
      const result = this.db
        .statement('UPDATE approval_requests SET grant_consumed_at = ? WHERE request_id = ? AND grant_consumed_at IS NULL')
        .run(at, String(row.request_id))
      if (Number(result.changes) !== 1) return false
      const record = this.get(String(row.request_id))
      if (record) event(this.store, 'approval.grant_consumed', record, { runId })
      return true
    })
  }

  private get db() {
    return this.store.db
  }
}
