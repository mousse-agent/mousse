/**
 * Daemon-owned pending user questions (not Electron-local).
 * Requests are keyed by requestId and scoped to threadId for snapshot/resubscribe.
 */

import { EventEmitter } from 'events'
import type { PermissionAction } from '../../shared/permissionMode'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'
import {
  canAnswerApproval,
  type Answerer,
  type ApprovalRefusal,
  type LineageLookup
} from '../run/approvalRights'

const QUESTION_TIMEOUT_MS = 10 * 60 * 1000

/** Option ids/labels treated as the default rejection when preempted by a new chat message. */
const DEFAULT_REJECT_OPTION = /reject|decline|cancel|dismiss|skip|\bno\b/i

/** What an approval option means, whatever id the provider gave it. */
export interface ApprovalOptionMeaning {
  id: string
  decision: 'allow' | 'reject'
  scope?: 'once' | 'always'
}

/**
 * Marks a question as a provider's approval request (a tool, a command, a file change) rather than
 * a question for the user. An approval is settled only when `canAnswerApproval` allows the answerer,
 * and the chosen option id is mapped to its declared decision here, so provider-facing ids (`allow`,
 * `permission`, `write`, an ACP option id) never reach policy logic.
 */
export interface ApprovalTag {
  action: PermissionAction
  permissionKey: string
  options: ApprovalOptionMeaning[]
}

export type SettleResult =
  | { ok: true; decision?: 'allow' | 'reject' }
  | { ok: false; reason: 'unknown' | 'answerer_required' | ApprovalRefusal }

interface PendingRequest {
  threadId: string
  questions: PendingUserQuestions['questions']
  approval?: ApprovalTag
  resolve: (answers: UserQuestionAnswers) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Pending questions are **process-memory only**.
 * Daemon restart drops all pending descriptors; waiters die with the process.
 * Snapshots after restart report zero pending and never claim answerable orphan callbacks.
 */
export class UserQuestionService extends EventEmitter {
  private pending = new Map<string, PendingRequest>()
  private stopped = false
  private lineage: LineageLookup = () => null
  /** True after this process started; questions never survive process death. */
  readonly survivesDaemonRestart = false

  /**
   * Where `canAnswerApproval` finds a thread's parent. Without a source no agent may answer an
   * approval: only the user can.
   */
  setLineageSource(lookup: LineageLookup): void {
    this.lineage = lookup
  }

  /**
   * `options.timeoutMs` overrides the 10-minute default (the Mousse MCP `ask_user` waits up to an
   * hour); an aborted `options.signal` dismisses the request (its caller's run ended).
   * `options.approval` marks a provider's approval request (see `ApprovalTag`).
   */
  requestAnswers(
    questions: PendingUserQuestions['questions'],
    threadId = '__unbound__',
    options: { timeoutMs?: number; signal?: AbortSignal; approval?: ApprovalTag } = {}
  ): Promise<UserQuestionAnswers> {
    if (this.stopped) return Promise.reject(Object.assign(new Error('Profile questions are stopped'), { code: 'profile_draining' }))
    if (options.signal?.aborted) return Promise.reject(new Error('User did not answer before the run ended.'))
    const requestId = crypto.randomUUID()

    return new Promise<UserQuestionAnswers>((resolveAnswers, rejectAnswers) => {
      const signal = options.signal
      const onAbort = (): void => { this.dismiss(requestId) }
      const resolve = (answers: UserQuestionAnswers): void => {
        signal?.removeEventListener('abort', onAbort)
        resolveAnswers(answers)
      }
      const reject = (error: Error): void => {
        signal?.removeEventListener('abort', onAbort)
        rejectAnswers(error)
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.emit('cleared', { requestId, threadId })
        reject(new Error('User did not answer in time.'))
      }, options.timeoutMs ?? QUESTION_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(requestId, { threadId, questions, ...(options.approval ? { approval: options.approval } : {}), resolve, reject, timer })
      this.emit('pending', {
        requestId,
        threadId,
        questions
      } satisfies PendingUserQuestions & { threadId: string })
    })
  }

  /**
   * Settles a request with `answers`. An approval is settled only when `canAnswerApproval` allows
   * `answeredBy`; the loser of a refusal learns why and the request stays pending. Any other
   * question is settled for whoever answers.
   */
  settle(requestId: string, answers: UserQuestionAnswers, answeredBy?: Answerer): SettleResult {
    const pending = this.pending.get(requestId)
    if (!pending) return { ok: false, reason: 'unknown' }
    let decision: 'allow' | 'reject' | undefined
    if (pending.approval) {
      // An approval is never settled for an unnamed answerer: nothing here may skip the rule.
      if (!answeredBy) return { ok: false, reason: 'answerer_required' }
      const meaning = this.approvalMeaning(pending, answers)
      decision = meaning.decision
      const rights = canAnswerApproval(
        { threadId: pending.threadId, action: pending.approval.action, permissionKey: pending.approval.permissionKey },
        answeredBy,
        meaning,
        this.lineage
      )
      if (!rights.ok) return { ok: false, reason: rights.code }
    }

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(answers)
    this.emit('cleared', { requestId, threadId: pending.threadId })
    return { ok: true, ...(decision ? { decision } : {}) }
  }

  /** `settle` for callers that only need to know whether the request was settled. */
  submitAnswers(requestId: string, answers: UserQuestionAnswers, answeredBy?: Answerer): boolean {
    return this.settle(requestId, answers, answeredBy).ok
  }

  /**
   * Dismisses a request. A dismissal by an answerer counts as a rejection and goes through the same
   * rule as an answer; without `answeredBy` it is the service's own (the provider withdrew the
   * request, a run ended, the profile shut down).
   */
  dismiss(requestId: string, answeredBy?: Answerer): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    if (pending.approval && answeredBy) {
      const rights = canAnswerApproval(
        { threadId: pending.threadId, action: pending.approval.action, permissionKey: pending.approval.permissionKey },
        answeredBy,
        { decision: 'reject' },
        this.lineage
      )
      if (!rights.ok) return false
    }

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.reject(new Error('User dismissed the questions.'))
    this.emit('cleared', { requestId, threadId: pending.threadId })
    return true
  }

  /** The decision a set of answers means for an approval: an unknown option reads as a rejection. */
  private approvalMeaning(pending: PendingRequest, answers: UserQuestionAnswers): { decision: 'allow' | 'reject'; scope?: 'once' | 'always' } {
    const approval = pending.approval!
    const questionId = pending.questions[0]?.id
    const raw = questionId === undefined ? undefined : answers[questionId]
    const chosen = Array.isArray(raw) ? raw[0] : raw
    const option = approval.options.find((candidate) => candidate.id === chosen)
    if (!option) return { decision: 'reject' }
    return { decision: option.decision, ...(option.scope ? { scope: option.scope } : {}) }
  }

  listPendingForThread(threadId: string): Array<PendingUserQuestions & { threadId: string }> {
    const out: Array<PendingUserQuestions & { threadId: string }> = []
    for (const [requestId, p] of this.pending) {
      if (p.threadId === threadId) {
        out.push({ requestId, threadId, questions: p.questions })
      }
    }
    return out
  }

  listAllPending(): Array<PendingUserQuestions & { threadId: string }> {
    const out: Array<PendingUserQuestions & { threadId: string }> = []
    for (const [requestId, p] of this.pending) {
      out.push({ requestId, threadId: p.threadId, questions: p.questions })
    }
    return out
  }

  shutdown(): void {
    this.stopped = true
    for (const [requestId, pending] of [...this.pending]) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(new DOMException('Profile shutdown interrupted the question', 'AbortError'))
      this.emit('cleared', { requestId, threadId: pending.threadId, reason: 'profile-shutdown' })
    }
  }

  getPending(requestId: string): (PendingUserQuestions & { threadId: string }) | null {
    const p = this.pending.get(requestId)
    if (!p) return null
    return { requestId, threadId: p.threadId, questions: p.questions }
  }

  /**
   * Default rejection for a pending question set: prefer an explicit `reject`
   * option (quick-action approval contract), else any reject-like option
   * (reject/decline/cancel/dismiss/skip/no). Returns null when no question
   * offers a reject-like option — the caller should dismiss instead.
   */
  buildDefaultRejectionAnswers(
    questions: PendingUserQuestions['questions']
  ): UserQuestionAnswers | null {
    const resolved: UserQuestionAnswers = {}
    for (const question of questions) {
      const options = question.options ?? []
      const match =
        options.find((option) => option.id === 'reject') ??
        options.find(
          (option) =>
            DEFAULT_REJECT_OPTION.test(option.id) || DEFAULT_REJECT_OPTION.test(option.label)
        )
      if (!match) return null
      resolved[question.id] = question.allowMultiple ? [match.id] : match.id
    }
    return resolved
  }

  /**
   * Auto-reject every pending question for a thread with its default answer.
   * Used when a new chat message preempts a turn blocked on ask_user / plan
   * ask / quick-action approval: the fresh message must not strand behind an
   * unanswered prompt. Falls back to dismiss when a question has no
   * reject-like option (dismissal also unblocks the tool loop as rejection).
   *
   * An approval is rejected on behalf of `actor` (the sender): one the actor may not answer stays
   * pending and is counted in `refused`, so an agent that may not answer cannot deny either.
   * Without an actor the sender is the user.
   */
  autoRejectPendingForThread(threadId: string, actor: Answerer = { kind: 'user' }): { answered: number; dismissed: number; refused: number } {
    let answered = 0
    let dismissed = 0
    let refused = 0
    for (const pending of this.listPendingForThread(threadId)) {
      const answers = this.buildDefaultRejectionAnswers(pending.questions)
      if (answers) {
        const settled = this.settle(pending.requestId, answers, actor)
        if (settled.ok) {
          answered += 1
          continue
        }
        if (settled.reason !== 'unknown') {
          refused += 1
          continue
        }
      } else if (this.dismiss(pending.requestId, actor)) {
        dismissed += 1
      } else if (this.pending.has(pending.requestId)) {
        refused += 1
      }
    }
    return { answered, dismissed, refused }
  }

  dismissAllForThread(threadId: string): void {
    for (const [requestId, p] of [...this.pending]) {
      if (p.threadId === threadId) {
        this.dismiss(requestId)
      }
    }
  }

  /**
   * Daemon restart recovery: reject any in-memory pending (should already be empty
   * in a new process). Explicit no-op that documents the invariant for callers/tests.
   */
  markInterruptedByDaemonRestart(): {
    cleared: number
    survivesDaemonRestart: false
  } {
    const n = this.pending.size
    for (const [requestId, p] of [...this.pending]) {
      clearTimeout(p.timer)
      this.pending.delete(requestId)
      p.reject(new Error('Daemon restarted; pending question interrupted and is not answerable.'))
      this.emit('cleared', {
        requestId,
        threadId: p.threadId,
        reason: 'daemon-restart'
      })
    }
    return { cleared: n, survivesDaemonRestart: false }
  }
}

/**
 * Process-wide default used by LlmClient / tools when no service is injected.
 * Daemon wires the same instance into ThreadRuntimeManager + protocol.
 */
export const userQuestionService = new UserQuestionService()
