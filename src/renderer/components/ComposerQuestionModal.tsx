import { useState } from 'react'
import { X } from 'lucide-react'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../shared/types'

interface ComposerQuestionModalProps {
  pending: PendingUserQuestions
  onSubmit: (answers: UserQuestionAnswers) => void
  onDismiss: () => void
}

export function ComposerQuestionModal({ pending, onSubmit, onDismiss }: ComposerQuestionModalProps) {
  const [answers, setAnswers] = useState<UserQuestionAnswers>(() => {
    const initial: UserQuestionAnswers = {}
    for (const question of pending.questions) {
      initial[question.id] = question.allowMultiple ? [] : ''
    }
    return initial
  })

  const canSubmit = pending.questions.every((question) => {
    const value = answers[question.id]
    if (question.allowMultiple) {
      return Array.isArray(value) && value.length > 0
    }
    return typeof value === 'string' && value.trim().length > 0
  })

  const toggleOption = (questionId: string, optionId: string, allowMultiple?: boolean) => {
    setAnswers((current) => {
      if (allowMultiple) {
        const existing = Array.isArray(current[questionId]) ? [...current[questionId]] : []
        const index = existing.indexOf(optionId)
        if (index >= 0) {
          existing.splice(index, 1)
        } else {
          existing.push(optionId)
        }
        return { ...current, [questionId]: existing }
      }
      return { ...current, [questionId]: optionId }
    })
  }

  return (
    <div className="composer-question-modal" role="dialog" aria-label="Planner questions">
      <div className="composer-question-modal-header">
        <span className="composer-question-modal-title">A few questions before planning</span>
        <button
          type="button"
          className="composer-question-modal-close"
          aria-label="Dismiss questions"
          onClick={onDismiss}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="composer-question-modal-body">
        {pending.questions.map((question) => (
          <div key={question.id} className="composer-question-block">
            <p className="composer-question-prompt">{question.prompt}</p>
            <div className="composer-question-options">
              {question.options.map((option) => {
                const value = answers[question.id]
                const selected = question.allowMultiple
                  ? Array.isArray(value) && value.includes(option.id)
                  : value === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`composer-question-option${selected ? ' selected' : ''}`}
                    onClick={() => toggleOption(question.id, option.id, question.allowMultiple)}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="composer-question-modal-footer">
        <button type="button" className="composer-question-dismiss" onClick={onDismiss}>
          Skip
        </button>
        <button
          type="button"
          className="composer-question-submit"
          disabled={!canSubmit}
          onClick={() => onSubmit(answers)}
        >
          Continue
        </button>
      </div>
    </div>
  )
}
