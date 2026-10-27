/**
 * Daemon-owned pending user questions (not Electron-local).
 * Requests are keyed by requestId and scoped to threadId for snapshot/resubscribe.
 *
 * Two kinds live here, side by side. A plain question (`ask_user`, a plan question, a quick action)
 * is process memory only: it dies with the daemon and times out. A provider's, the Pi agent's or a
 * Mousse tool's approval request (an `ApprovalTag`) is saved in the Run Engine database once the
 * profile binds `ThreadApprovals`: it survives a reconnect and a daemon restart, any client can
 * answer it, and it has no timeout while a person is in the chat (SPEC §17). Without a store, an
 * approval behaves as a plain question.
 */

import { EventEmitter } from 'events'
import { redactSecrets } from '../../shared/errors'
import type { RunPolicy, TurnOrigin } from '../../shared/harness/types'
import { ALWAYS_OPTION_ID, ALWAYS_OPTION_LABEL } from '../../shared/permissionKeys'
import type { PermissionAction, PermissionMode } from '../../shared/permissionMode'
import type { PendingApprovalInfo, PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'
import {
  canAnswerApproval,
  type Answerer,
  type ApprovalRefusal,
  type LineageLookup
} from '../run/approvalRights'
import { approvalFingerprint } from '../run/approvalFingerprint'
import {
  answersFor,
  type AnsweredBy,
  type ApprovalCancelReason,
  type ApprovalQuestion,
  type ApprovalRecord,
  type ContinuationDue,
  type ThreadApprovals
} from '../run/ThreadApprovals'

const QUESTION_TIMEOUT_MS = 10 * 60 * 1000

/** The most characters of an approval prompt that are saved. */
const SAVED_PROMPT_CHARS = 4500

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
  /**
   * The call as the provider made it. It becomes the request's fingerprint, which is what lets an
   * approval given after a restart authorize the same action once (SPEC §17.5). Without it, or with an
   * input that has no stable shape, the request has no fingerprint and no grant.
   */
  tool?: { name: string; input: unknown; cwd?: string }
  /** Why the provider asks, when that is not obvious (Claude Code's own safety check under Full access). */
  reason?: string
}

/** What the profile knows about the run that is asking, found by the thread it runs on. */
export interface ApprovalContext {
  runId: string | null
  instanceId: string
  provider: string
  origin: TurnOrigin
  /** The permission mode the run asks under (its binding's effective mode): what a standing rule is granted and checked against. */
  permissionMode: PermissionMode
  /** The run's approvals policy: a standing rule only answers where the run asks (`ask`). */
  approvals: RunPolicy['approvals']
}

export type SettleResult =
  | { ok: true; decision?: 'allow' | 'reject' }
  | {
      ok: false
      reason: 'unknown' | 'answerer_required' | 'already_answered' | 'cancelled' | ApprovalRefusal
      /** `already_answered`: who answered first and what they decided. */
      answeredBy?: AnsweredBy
      decision?: 'allow' | 'reject'
      cancelReason?: string
    }

/** A request in any status (the Bridge's ownership check, the answer's loser). */
export interface RequestView {
  requestId: string
  threadId: string
  questions: PendingUserQuestions['questions']
  status: 'pending' | 'answered' | 'cancelled'
  approval?: PendingApprovalInfo
  decision?: 'allow' | 'reject'
  answeredBy?: AnsweredBy
  cancelReason?: string
}

interface PendingRequest {
  threadId: string
  questions: PendingUserQuestions['questions']
  approval?: ApprovalTag
  /** Saved in the Run Engine database: its row, not this entry, says whether it is still pending. */
  durable: boolean
  resolve: (answers: UserQuestionAnswers) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** A saved request that was settled while its provider callback still waits for the answer. */
interface SettledWaiter {
  threadId: string
  resolve: (answers: UserQuestionAnswers) => void
  reject: (error: Error) => void
}

/** The hooks the profile binds to the saved-approval store (`setApprovalStore`). */
export interface ApprovalBinding {
  store: ThreadApprovals
  /** The run that is asking on a thread, found at request time. */
  context(threadId: string): ApprovalContext | null
  /** Whether answers are delivered through a `request.respond` effect (else directly). */
  effectDelivery(): boolean
  /** Every request of a dead run is answered: the continue turn that carries the answers is due. */
  continuationDue(due: ContinuationDue, answeredBy: Answerer): void
}

function cancelMessage(reason: string): string {
  return reason === 'timed_out' ? 'User did not answer in time.' : `The approval request was closed (${reason}).`
}

/**
 * Pending plain questions are **process-memory only**: a daemon restart drops them and their waiters
 * die with the process. Saved approval requests stay in the database; after a restart they are
 * answered by starting a continue turn, never by claiming a callback that no longer exists.
 */
export class UserQuestionService extends EventEmitter {
  private pending = new Map<string, PendingRequest>()
  private settledWaiters = new Map<string, SettledWaiter>()
  private stopped = false
  private lineage: LineageLookup = () => null
  private binding: ApprovalBinding | null = null
  /** True after this process started; plain questions never survive process death. */
  readonly survivesDaemonRestart = false

  /**
   * Where `canAnswerApproval` finds a thread's parent. Without a source no agent may answer an
   * approval: only the user can.
   */
  setLineageSource(lookup: LineageLookup): void {
    this.lineage = lookup
  }

  /**
   * Saves approval requests in `binding.store` from now on. `null` returns to plain in-memory
   * approvals. The service of a profile is bound once its Run Engine exists.
   */
  setApprovalStore(binding: ApprovalBinding | null): void {
    this.binding = binding
  }

  /** The store approvals are saved in, or null. */
  get approvalStore(): ThreadApprovals | null {
    return this.binding?.store ?? null
  }

  /**
   * `options.timeoutMs` overrides the default: 10 minutes for a plain question (the Mousse MCP
   * `ask_user` waits up to an hour), and for a saved approval none while a person runs the turn, 10
   * minutes for an unattended origin (a workflow, a bot, a scheduled job, a definition run). An aborted
   * `options.signal` dismisses the request (its caller's run ended).
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
    const binding = options.approval && threadId !== '__unbound__' ? this.binding : null
    const context = binding ? this.contextOf(binding, threadId) : null
    let record: ApprovalRecord | null = null
    // What the card shows and what the request means; "Always for this thread" is added only to a saved request.
    let shown = { questions, approval: options.approval }
    if (binding && options.approval) {
      const approval = options.approval
      const fingerprint = approval.tool
        ? approvalFingerprint({
            instanceId: context?.instanceId ?? '',
            ...(approval.tool.cwd ? { cwd: approval.tool.cwd } : {}),
            permissionKey: approval.permissionKey,
            toolName: approval.tool.name,
            input: approval.tool.input
          })
        : null
      // An approval the user gave after a restart authorizes this same action, once, in the run that
      // was started to deliver it: answered without asking, and only then.
      if (context?.runId && fingerprint && binding.store.consumeContinuationGrant(threadId, context.runId, fingerprint)) {
        const allow = approval.options.find((option) => option.decision === 'allow' && option.scope !== 'always')
        const first = questions[0]
        if (allow && first) return Promise.resolve({ [first.id]: allow.id })
      }
      // A standing rule of this thread answers the exact request it was made for, and nothing else: the
      // fingerprint must match (so a request without one never does), the run must be one that asks, and
      // a check the provider will not let Mousse skip (`reason`) always asks. The rule only removes the
      // ask the mode would have made.
      const eligible = Boolean(context?.runId && fingerprint && !approval.reason && context.approvals === 'ask')
      if (eligible && context && fingerprint) {
        try {
          const rule = binding.store.matchRule(threadId, approval.permissionKey, fingerprint, context.permissionMode)
          const allow = approval.options.find((option) => option.decision === 'allow' && option.scope !== 'always')
          const first = questions[0]
          if (rule && allow && first) {
            binding.store.noteRuleApplied(threadId, context.runId, rule)
            return Promise.resolve({ [first.id]: allow.id })
          }
        } catch (error) {
          // A rule that cannot be read or recorded answers nothing: the user is asked.
          console.warn('an approval rule could not be checked; asking instead', { threadId, error: error instanceof Error ? error.message : String(error) })
        }
      }
      // The same exact-request condition decides whether "Always for this thread" is offered, and it needs a
      // way to answer the provider with its own once-only option.
      const once = approval.options.find((option) => option.decision === 'allow' && option.scope !== 'always')
      const first = questions[0]
      const offerAlways = eligible && once !== undefined && first !== undefined && !first.options?.some((option) => option.id === ALWAYS_OPTION_ID)
      if (offerAlways) shown = withAlwaysOption(questions, approval)
      try {
        record = binding.store.create({
          requestId,
          threadId,
          runId: context?.runId ?? null,
          instanceId: context?.instanceId ?? '',
          provider: context?.provider ?? '',
          action: approval.action,
          permissionKey: approval.permissionKey,
          fingerprint,
          reason: approval.reason ?? null,
          permissionMode: context?.permissionMode ?? null,
          questions: storedQuestions(shown.questions, shown.approval!.options)
        })
      } catch (error) {
        shown = { questions, approval: options.approval }
        // An approval that cannot be saved still has to be answerable: it falls back to memory.
        console.warn('approval request could not be saved; keeping it in memory', { threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const durable = record !== null
    // A person in the chat can take as long as they need; nobody watches an unattended run.
    const timeoutMs = options.timeoutMs ?? (durable ? (context && context.origin !== 'interactive' ? QUESTION_TIMEOUT_MS : undefined) : QUESTION_TIMEOUT_MS)

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
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (durable) {
          this.closeDurable(requestId, 'timed_out')
          return
        }
        this.pending.delete(requestId)
        this.emit('cleared', { requestId, threadId })
        reject(new Error('User did not answer in time.'))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(requestId, {
        threadId,
        questions: shown.questions,
        ...(shown.approval ? { approval: shown.approval } : {}),
        durable,
        resolve,
        reject,
        ...(timer ? { timer } : {})
      })
      // One `pending` event per request: a client that resubscribes reads the snapshot, not a replay.
      this.emit('pending', record ? this.viewOf(record) : ({ requestId, threadId, questions: shown.questions } satisfies PendingUserQuestions & { threadId: string }))
    })
  }

  /**
   * Settles a request with `answers`. An approval is settled only when `canAnswerApproval` allows
   * `answeredBy`; the loser of a refusal learns why and the request stays pending. Any other
   * question is settled for whoever answers. A saved approval is settled by one database
   * transaction: of two answers one wins and the other learns who did.
   *
   * `options.continuation: false` leaves the continue turn of a restarted run to the caller (a send
   * that denies approvals starts its own run).
   */
  settle(requestId: string, answers: UserQuestionAnswers, answeredBy?: Answerer, options: { continuation?: boolean } = {}): SettleResult {
    const pending = this.pending.get(requestId)
    if ((pending?.durable || (!pending && this.binding))) return this.settleSaved(requestId, answers, answeredBy, options)
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

    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(answers)
    this.emit('cleared', { requestId, threadId: pending.threadId })
    return { ok: true, ...(decision ? { decision } : {}) }
  }

  private settleSaved(requestId: string, answers: UserQuestionAnswers, answeredBy: Answerer | undefined, options: { continuation?: boolean }): SettleResult {
    const binding = this.binding!
    if (!answeredBy) return { ok: false, reason: 'answerer_required' }
    const outcome = binding.store.settle(requestId, answers, answeredBy, { enqueueDelivery: binding.effectDelivery() })
    if (!outcome.ok) {
      // A request another answer already closed no longer waits here either.
      if (outcome.reason === 'already_answered' || outcome.reason === 'cancelled') this.reconcileRequest(requestId)
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.answeredBy ? { answeredBy: outcome.answeredBy } : {}),
        ...(outcome.decision ? { decision: outcome.decision } : {}),
        ...(outcome.cancelReason ? { cancelReason: outcome.cancelReason } : {})
      }
    }
    const waiting = this.pending.get(requestId)
    if (waiting) {
      if (waiting.timer) clearTimeout(waiting.timer)
      this.pending.delete(requestId)
      // The provider callback keeps waiting for the answer's delivery, not for the user.
      this.settledWaiters.set(requestId, { threadId: waiting.threadId, resolve: waiting.resolve, reject: waiting.reject })
    }
    this.emit('cleared', { requestId, threadId: outcome.record.threadId })
    // Without a worker nothing would run the `request.respond` effect: deliver here.
    if (outcome.record.answerPath === 'live' && !binding.effectDelivery()) this.deliver(requestId)
    if (outcome.continuationDue && options.continuation !== false) binding.continuationDue(outcome.continuationDue, answeredBy)
    return { ok: true, decision: outcome.decision }
  }

  /** `settle` for callers that only need to know whether the request was settled. */
  submitAnswers(requestId: string, answers: UserQuestionAnswers, answeredBy?: Answerer): boolean {
    return this.settle(requestId, answers, answeredBy).ok
  }

  /**
   * The `request.respond` effect: hands a settled saved request's answer to the provider callback
   * that waits for it in this process. At most once (the waiter is the guard); a request whose waiter
   * is gone (the process died and came back) is the continue path's, never delivered here.
   */
  deliver(requestId: string): boolean {
    const waiter = this.settledWaiters.get(requestId)
    if (!waiter) return false
    this.settledWaiters.delete(requestId)
    const row = this.binding?.store.get(requestId) ?? null
    if (!row || row.status !== 'answered') {
      waiter.reject(new Error(cancelMessage(row?.cancelReason ?? 'withdrawn')))
      return false
    }
    waiter.resolve(row.answers ?? {})
    this.binding?.store.markDelivered(requestId)
    return true
  }

  /**
   * Brings the callbacks of `threadId` in line with what the database says after a write the service
   * did not make itself (a send that denied the thread's approvals inside its admission, a run
   * that ended): a request settled meanwhile is delivered or closed. Returns how many callbacks were
   * answered (a denial the provider must now act on).
   */
  reconcileThread(threadId: string): number {
    let answered = 0
    for (const [requestId, request] of [...this.pending]) {
      if (request.threadId === threadId && request.durable && this.reconcileRequest(requestId) === 'answered') answered += 1
    }
    for (const [requestId, waiter] of [...this.settledWaiters]) {
      if (waiter.threadId === threadId && this.deliver(requestId)) answered += 1
    }
    return answered
  }

  /** A request settled by someone else: its card goes and its callback gets the outcome. */
  private reconcileRequest(requestId: string): 'answered' | 'cancelled' | 'pending' | 'unknown' {
    const request = this.pending.get(requestId)
    const row = this.binding?.store.get(requestId) ?? null
    if (!row) return 'unknown'
    if (row.status === 'pending') return 'pending'
    // Only a callback still waiting as pending was settled behind this service's back; one that is
    // already waiting for its delivery is the `request.respond` effect's.
    if (request?.durable) {
      if (request.timer) clearTimeout(request.timer)
      this.pending.delete(requestId)
      this.settledWaiters.set(requestId, { threadId: request.threadId, resolve: request.resolve, reject: request.reject })
      this.emit('cleared', { requestId, threadId: request.threadId })
      this.deliver(requestId)
    }
    return row.status
  }

  /**
   * A saved request was closed without an answer (its run ended, the thread was deleted): drops its
   * card and its callback. Idempotent.
   */
  approvalClosed(requestId: string, reason: string): void {
    const request = this.pending.get(requestId)
    if (!request?.durable) return
    if (request.timer) clearTimeout(request.timer)
    this.pending.delete(requestId)
    this.emit('cleared', { requestId, threadId: request.threadId })
    request.reject(new Error(cancelMessage(reason)))
  }

  /** Closes a saved request without an answer and wakes its callback with a rejection. */
  private closeDurable(requestId: string, reason: ApprovalCancelReason): boolean {
    if (this.stopped && reason !== 'timed_out') return false
    const closed = this.binding?.store.cancel(requestId, reason) ?? false
    const request = this.pending.get(requestId)
    if (!closed && !request?.durable) return false
    this.approvalClosed(requestId, reason)
    return closed
  }

  /**
   * Dismisses a request. A dismissal by an answerer counts as a rejection and goes through the same
   * rule as an answer; without `answeredBy` it is the service's own (the provider withdrew the
   * request, a run ended, the profile shut down) and closes a saved request with `reason`.
   */
  dismiss(requestId: string, answeredBy?: Answerer, reason: ApprovalCancelReason = 'withdrawn'): boolean {
    const pending = this.pending.get(requestId)
    const saved = pending?.durable || (!pending && this.binding?.store.get(requestId)?.status === 'pending')
    if (saved) {
      if (!answeredBy) {
        // The profile is stopping: every provider callback is being torn down, which is no withdrawal.
        // The request stays pending, so the next boot can offer it as a continue request.
        if (this.stopped) return false
        return this.closeDurable(requestId, reason)
      }
      const row = this.binding!.store.get(requestId)
      return this.settleSaved(requestId, row ? answersFor(row.questions, 'reject') : {}, answeredBy, {}).ok
    }
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

    if (pending.timer) clearTimeout(pending.timer)
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

  /** The view of a saved request that clients show: each option names the decision it means, so a client never guesses from labels. */
  private viewOf(record: ApprovalRecord): PendingUserQuestions & { threadId: string } {
    const progress = this.binding?.store.progress(record)
    return {
      requestId: record.requestId,
      threadId: record.threadId,
      questions: record.questions.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        options: question.options.map((option) => ({ id: option.id, label: option.label, decision: option.decision, ...(option.scope ? { scope: option.scope } : {}) })),
        ...(question.allowMultiple ? { allowMultiple: question.allowMultiple } : {})
      })),
      approval: {
        ...(record.reason ? { reason: record.reason } : {}),
        answerPath: record.answerPath,
        ...(record.uncertain ? { uncertain: true, uncertainTools: record.uncertainTools ?? [] } : {}),
        ...(progress ? { answered: progress.answered, total: progress.total } : {})
      }
    }
  }

  private contextOf(binding: ApprovalBinding, threadId: string): ApprovalContext | null {
    try {
      return binding.context(threadId)
    } catch {
      return null
    }
  }

  listPendingForThread(threadId: string): Array<PendingUserQuestions & { threadId: string }> {
    const out: Array<PendingUserQuestions & { threadId: string }> = []
    for (const [requestId, p] of this.pending) {
      if (p.threadId === threadId && !p.durable) {
        out.push({ requestId, threadId, questions: p.questions })
      }
    }
    return [...this.savedPending(threadId), ...out]
  }

  listAllPending(): Array<PendingUserQuestions & { threadId: string }> {
    const out: Array<PendingUserQuestions & { threadId: string }> = []
    for (const [requestId, p] of this.pending) {
      if (!p.durable) out.push({ requestId, threadId: p.threadId, questions: p.questions })
    }
    return [...this.savedPending(), ...out]
  }

  private savedPending(threadId?: string): Array<PendingUserQuestions & { threadId: string }> {
    if (!this.binding) return []
    try {
      return this.binding.store.listPending(threadId).map((record) => this.viewOf(record))
    } catch (error) {
      console.warn('saved approval requests could not be read', { error: error instanceof Error ? error.message : String(error) })
      return []
    }
  }

  /**
   * Profile stop: plain questions end here; every waiting callback is released. A saved approval
   * request is left in the database exactly as it is (still pending), so the next boot can offer its
   * answer as a continue turn.
   */
  shutdown(): void {
    this.stopped = true
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(new DOMException('Profile shutdown interrupted the question', 'AbortError'))
      this.emit('cleared', { requestId, threadId: pending.threadId, reason: 'profile-shutdown' })
    }
    for (const [requestId, waiter] of [...this.settledWaiters]) {
      this.settledWaiters.delete(requestId)
      waiter.reject(new DOMException('Profile shutdown interrupted the question', 'AbortError'))
    }
  }

  /** A request that is pending: a waiting callback, or a saved request in any state that still waits for an answer. */
  getPending(requestId: string): (PendingUserQuestions & { threadId: string }) | null {
    const p = this.pending.get(requestId)
    if (p && !p.durable) return { requestId, threadId: p.threadId, questions: p.questions }
    const record = this.binding?.store.get(requestId)
    if (!record || record.status !== 'pending') return null
    return this.viewOf(record)
  }

  /** A request in any status, or null when nobody ever asked it. */
  getRequest(requestId: string): RequestView | null {
    const p = this.pending.get(requestId)
    if (p && !p.durable) return { requestId, threadId: p.threadId, questions: p.questions, status: 'pending' }
    const record = this.binding?.store.get(requestId)
    if (!record) return null
    const view = this.viewOf(record)
    return {
      requestId,
      threadId: record.threadId,
      questions: view.questions,
      status: record.status,
      ...(view.approval ? { approval: view.approval } : {}),
      ...(record.decision ? { decision: record.decision } : {}),
      ...(record.answeredBy ? { answeredBy: record.answeredBy } : {}),
      ...(record.cancelReason ? { cancelReason: record.cancelReason } : {})
    }
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
   * Without an actor the sender is the user. Saved approvals are denied by the send itself, inside
   * its admission; this only reaches the ones that send left alone.
   */
  autoRejectPendingForThread(threadId: string, actor: Answerer = { kind: 'user' }): { answered: number; dismissed: number; refused: number } {
    let answered = 0
    let dismissed = 0
    let refused = 0
    for (const pending of this.listPendingForThread(threadId)) {
      const answers = this.buildDefaultRejectionAnswers(pending.questions)
      if (answers) {
        const settled = this.settle(pending.requestId, answers, actor, { continuation: false })
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

  /** The provider's own end of every request on the thread (Stop, a steer restart, a turn that ended). */
  dismissAllForThread(threadId: string, reason: ApprovalCancelReason = 'withdrawn'): void {
    for (const [requestId, p] of [...this.pending]) {
      if (p.threadId === threadId) {
        this.dismiss(requestId, undefined, reason)
      }
    }
  }

  /**
   * Daemon restart recovery: reject any in-memory pending (should already be empty
   * in a new process). Explicit no-op that documents the invariant for callers/tests. Saved
   * approval requests stay as they are.
   */
  markInterruptedByDaemonRestart(): {
    cleared: number
    survivesDaemonRestart: false
  } {
    const n = this.pending.size
    for (const [requestId, p] of [...this.pending]) {
      if (p.timer) clearTimeout(p.timer)
      this.pending.delete(requestId)
      p.reject(new Error('Daemon restarted; pending question interrupted and is not answerable.'))
      this.emit('cleared', {
        requestId,
        threadId: p.threadId,
        reason: 'daemon-restart'
      })
    }
    for (const [requestId, waiter] of [...this.settledWaiters]) {
      this.settledWaiters.delete(requestId)
      waiter.reject(new Error('Daemon restarted; pending question interrupted and is not answerable.'))
    }
    return { cleared: n, survivesDaemonRestart: false }
  }
}

/**
 * The request with "Always for this thread" added after the option that allows once. The option is
 * Mousse's: when it is chosen the provider is answered with its own once-only option (`ThreadApprovals`),
 * and the rule is recorded in the same transaction.
 */
function withAlwaysOption(questions: PendingUserQuestions['questions'], approval: ApprovalTag): { questions: PendingUserQuestions['questions']; approval: ApprovalTag } {
  const [first, ...rest] = questions
  if (!first) return { questions, approval }
  const options = first.options ?? []
  const at = options.findIndex((option) => approval.options.some((meaning) => meaning.id === option.id && meaning.decision === 'allow' && meaning.scope !== 'always')) + 1
  return {
    questions: [{ ...first, options: [...options.slice(0, at), { id: ALWAYS_OPTION_ID, label: ALWAYS_OPTION_LABEL }, ...options.slice(at)] }, ...rest],
    approval: { ...approval, options: [...approval.options, { id: ALWAYS_OPTION_ID, decision: 'allow', scope: 'always' }] }
  }
}

/** The questions as saved: each option of the first carries the decision it means (fail closed: unlisted ones reject). */
function storedQuestions(questions: PendingUserQuestions['questions'], meanings: readonly ApprovalOptionMeaning[]): ApprovalQuestion[] {
  return questions.map((question, index) => ({
    id: question.id,
    // The profile database keeps a bounded preview without credentials, not the raw command text.
    prompt: redactSecrets(question.prompt).slice(0, SAVED_PROMPT_CHARS),
    ...(question.allowMultiple ? { allowMultiple: question.allowMultiple } : {}),
    options: (question.options ?? []).map((option) => {
      const meaning = index === 0 ? meanings.find((candidate) => candidate.id === option.id) : undefined
      return {
        id: option.id,
        label: option.label,
        decision: meaning?.decision ?? 'reject',
        ...(meaning?.scope ? { scope: meaning.scope } : {})
      }
    })
  }))
}

/**
 * Process-wide default used by LlmClient / tools when no service is injected.
 * Daemon wires the same instance into ThreadRuntimeManager + protocol.
 */
export const userQuestionService = new UserQuestionService()
