import { EventEmitter } from 'events'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'

const QUESTION_TIMEOUT_MS = 10 * 60 * 1000

interface PendingRequest {
  questions: PendingUserQuestions['questions']
  resolve: (answers: UserQuestionAnswers) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class UserQuestionService extends EventEmitter {
  private pending = new Map<string, PendingRequest>()

  requestAnswers(questions: PendingUserQuestions['questions']): Promise<UserQuestionAnswers> {
    const requestId = crypto.randomUUID()

    return new Promise<UserQuestionAnswers>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('User did not answer in time.'))
      }, QUESTION_TIMEOUT_MS)

      this.pending.set(requestId, { questions, resolve, reject, timer })
      this.emit('pending', { requestId, questions } satisfies PendingUserQuestions)
    })
  }

  submitAnswers(requestId: string, answers: UserQuestionAnswers): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(answers)
    return true
  }

  dismiss(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.reject(new Error('User dismissed the questions.'))
    return true
  }
}

export const userQuestionService = new UserQuestionService()
