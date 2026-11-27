import type { AnsweredQuestion, PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'
import type { AnsweredBy } from './ThreadApprovals'
import { json, str, type Row } from './db/rows'
import { Inbox } from './Inbox'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { InboxRecord } from './types'

/**
 * Questions an agent asked without waiting (`question_ask` with `wait: false`). The agent keeps working while the question
 * is open; the answer reaches it later through the thread's inbox: a steer into the turn that is running, or a turn of
 * its own when none is. A question is a row in the Run Engine database, so it stays answerable after a restart, and the
 * answer and its inbox row are written in one transaction, so an answer is never lost between the two.
 *
 * - `open`: waiting for the person;
 * - `answered`: answered (`answers`), and its inbox row is written;
 * - `dismissed`: the person closed it without answering; the agent is told the same way;
 * - `withdrawn`: the agent no longer needs it;
 * - `closed`: the thread was stopped, archived or deleted (`close_reason`).
 */
export type OpenQuestionStatus = 'open' | 'answered' | 'dismissed' | 'withdrawn' | 'closed'

export type OpenQuestionCloseReason = 'stopped' | 'archived' | 'thread_deleted'

export interface OpenQuestionRecord {
  requestId: string
  threadId: string
  /** The run that asked. */
  runId: string | null
  questions: PendingUserQuestions['questions']
  status: OpenQuestionStatus
  answers: UserQuestionAnswers | null
  answeredBy: AnsweredBy | null
  closeReason: string | null
  /** The inbox row that carries the answer or the dismissal to the agent. */
  inboxId: string | null
  createdAt: string
  settledAt: string | null
}

/** What the inbox row of an answered or dismissed open question carries (a `reconcile_notice`). */
export interface QuestionAnswerPayload {
  kind: 'question_answer'
  requestId: string
  /** Each question's id, in the order asked. */
  questionIds: string[]
  /** The answers as the transcript shows them, in the same order (option labels, the reply typed). */
  answered: AnsweredQuestion[]
  /** The person closed the question without answering. */
  dismissed?: true
}

/** Whether an inbox row carries the answer to an open question. */
export function isQuestionAnswerRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return row.kind === 'reconcile_notice' && (row.payload as { kind?: unknown } | null)?.kind === 'question_answer'
}

export type OpenQuestionSettle =
  | { ok: true; record: OpenQuestionRecord }
  | { ok: false; reason: 'unknown' | 'already_answered' | 'cancelled'; record?: OpenQuestionRecord }

export class OpenQuestions {
  private readonly inbox: Inbox

  constructor(private readonly store: RunStore) {
    this.inbox = new Inbox(store)
  }

  create(input: { requestId: string; threadId: string; runId?: string | null; questions: PendingUserQuestions['questions'] }): OpenQuestionRecord {
    return this.db.transaction(() => {
      const record: OpenQuestionRecord = {
        requestId: input.requestId,
        threadId: input.threadId,
        runId: input.runId ?? null,
        questions: input.questions,
        status: 'open',
        answers: null,
        answeredBy: null,
        closeReason: null,
        inboxId: null,
        createdAt: this.now(),
        settledAt: null
      }
      this.db
        .statement(`INSERT INTO open_questions(request_id, thread_id, run_id, questions, status, created_at) VALUES(?, ?, ?, ?, 'open', ?)`)
        .run(record.requestId, record.threadId, record.runId, stableStringify(record.questions), record.createdAt)
      this.event('question.open', record)
      return record
    })
  }

  get(requestId: string): OpenQuestionRecord | null {
    const row = this.db.statement('SELECT * FROM open_questions WHERE request_id = ?').get(requestId)
    return row ? toRecord(row) : null
  }

  /** The questions still open, oldest first; of one thread when it is named. */
  listOpen(threadId?: string): OpenQuestionRecord[] {
    const rows = threadId
      ? this.db.statement("SELECT * FROM open_questions WHERE status = 'open' AND thread_id = ? ORDER BY created_at, rowid").all(threadId)
      : this.db.statement("SELECT * FROM open_questions WHERE status = 'open' ORDER BY created_at, rowid").all()
    return rows.map(toRecord)
  }

  /**
   * The person answers: the question is answered and the inbox row that carries the answer to the agent is written, in
   * one transaction. Of two answers one wins; the other learns the question was already answered (or closed).
   */
  answer(requestId: string, answers: UserQuestionAnswers, answeredBy: AnsweredBy, answered: AnsweredQuestion[]): OpenQuestionSettle {
    return this.settle(requestId, 'answered', answeredBy, answers, answered)
  }

  /** The person closes the question without answering: the agent is told, as for an answer. */
  dismiss(requestId: string, answeredBy: AnsweredBy): OpenQuestionSettle {
    return this.settle(requestId, 'dismissed', answeredBy, null, null)
  }

  /** The agent of the thread that asked no longer needs the question. False when it was not open there. */
  withdraw(requestId: string, threadId: string): OpenQuestionRecord | null {
    return this.db.transaction(() => {
      const at = this.now()
      const result = this.db
        .statement("UPDATE open_questions SET status = 'withdrawn', settled_at = ? WHERE request_id = ? AND thread_id = ? AND status = 'open'")
        .run(at, requestId, threadId)
      if (Number(result.changes) !== 1) return null
      const record = this.get(requestId)!
      this.event('question.withdrawn', record)
      return record
    })
  }

  /** Closes every open question of the thread (a Stop, an archive, a delete). Returns the questions closed. */
  closeForThread(threadId: string, reason: OpenQuestionCloseReason): OpenQuestionRecord[] {
    return this.db.transaction(() => {
      const at = this.now()
      const closed: OpenQuestionRecord[] = []
      for (const open of this.listOpen(threadId)) {
        const result = this.db
          .statement("UPDATE open_questions SET status = 'closed', close_reason = ?, settled_at = ? WHERE request_id = ? AND status = 'open'")
          .run(reason, at, open.requestId)
        if (Number(result.changes) !== 1) continue
        const record = this.get(open.requestId)!
        this.event('question.closed', record, { reason })
        closed.push(record)
      }
      return closed
    })
  }

  /** A deleted thread's questions and answers go with it. */
  deleteForThread(threadId: string): void {
    this.db.statement('DELETE FROM open_questions WHERE thread_id = ?').run(threadId)
  }

  private settle(requestId: string, status: 'answered' | 'dismissed', answeredBy: AnsweredBy, answers: UserQuestionAnswers | null, answered: AnsweredQuestion[] | null): OpenQuestionSettle {
    return this.db.transaction((): OpenQuestionSettle => {
      const current = this.get(requestId)
      if (!current) return { ok: false, reason: 'unknown' }
      if (current.status !== 'open') return { ok: false, reason: current.status === 'answered' || current.status === 'dismissed' ? 'already_answered' : 'cancelled', record: current }
      const payload: QuestionAnswerPayload = {
        kind: 'question_answer',
        requestId,
        questionIds: current.questions.map((question) => question.id),
        answered: answered ?? current.questions.map((question) => ({ prompt: question.prompt, chosen: [] })),
        ...(status === 'dismissed' ? { dismissed: true as const } : {})
      }
      const row = this.inbox.append({ threadId: current.threadId, runId: current.runId, kind: 'reconcile_notice', payload })
      const result = this.db
        .statement('UPDATE open_questions SET status = ?, answers = ?, answered_by = ?, inbox_id = ?, settled_at = ? WHERE request_id = ? AND status = \'open\'')
        .run(status, answers ? stableStringify(answers) : null, stableStringify(answeredBy), row.inboxId, this.now(), requestId)
      if (Number(result.changes) !== 1) throw new Error(`open question ${requestId} changed while it was answered`)
      const record = this.get(requestId)!
      this.event(status === 'answered' ? 'question.answered' : 'question.dismissed', record, { inboxId: row.inboxId })
      return { ok: true, record }
    })
  }

  private event(type: string, record: OpenQuestionRecord, payload: Record<string, unknown> = {}): void {
    this.store.appendEvent({ threadId: record.threadId, runId: record.runId, type, payload: { requestId: record.requestId, status: record.status, ...payload } })
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }

  private get db() {
    return this.store.db
  }
}

function toRecord(row: Row): OpenQuestionRecord {
  return {
    requestId: String(row.request_id),
    threadId: String(row.thread_id),
    runId: str(row.run_id),
    questions: json<PendingUserQuestions['questions']>(row.questions) ?? [],
    status: row.status as OpenQuestionStatus,
    answers: json<UserQuestionAnswers>(row.answers),
    answeredBy: json<AnsweredBy>(row.answered_by),
    closeReason: str(row.close_reason),
    inboxId: str(row.inbox_id),
    createdAt: String(row.created_at),
    settledAt: str(row.settled_at)
  }
}
