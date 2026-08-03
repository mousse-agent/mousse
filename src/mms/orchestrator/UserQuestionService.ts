/**
 * Daemon-owned pending user questions (not Electron-local).
 * Requests are keyed by requestId and scoped to threadId for snapshot/resubscribe.
 */

import { EventEmitter } from 'events'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'

const QUESTION_TIMEOUT_MS = 10 * 60 * 1000

interface PendingRequest {
  threadId: string
  questions: PendingUserQuestions['questions']
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
  /** True after this process started; questions never survive process death. */
  readonly survivesDaemonRestart = false

  requestAnswers(
    questions: PendingUserQuestions['questions'],
    threadId = '__unbound__'
  ): Promise<UserQuestionAnswers> {
    const requestId = crypto.randomUUID()

    return new Promise<UserQuestionAnswers>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.emit('cleared', { requestId, threadId })
        reject(new Error('User did not answer in time.'))
      }, QUESTION_TIMEOUT_MS)

      this.pending.set(requestId, { threadId, questions, resolve, reject, timer })
      this.emit('pending', {
        requestId,
        threadId,
        questions
      } satisfies PendingUserQuestions & { threadId: string })
    })
  }

  submitAnswers(requestId: string, answers: UserQuestionAnswers): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(answers)
    this.emit('cleared', { requestId, threadId: pending.threadId })
    return true
  }

  dismiss(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.reject(new Error('User dismissed the questions.'))
    this.emit('cleared', { requestId, threadId: pending.threadId })
    return true
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

  getPending(requestId: string): (PendingUserQuestions & { threadId: string }) | null {
    const p = this.pending.get(requestId)
    if (!p) return null
    return { requestId, threadId: p.threadId, questions: p.questions }
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
