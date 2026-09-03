import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { PendingUserQuestions, UserQuestion, UserQuestionAnswers } from '../../shared/types'

interface ComposerQuestionModalProps {
  pending: PendingUserQuestions
  onSubmit: (answers: UserQuestionAnswers) => void
  onDismiss: () => void
}

export function isQuestionAnswered(
  question: UserQuestion,
  answer: string | string[] | undefined,
  custom: string | undefined
): boolean {
  if (custom && custom.trim().length > 0) return true
  if (question.allowMultiple) {
    return Array.isArray(answer) && answer.length > 0
  }
  return typeof answer === 'string' && answer.trim().length > 0
}

/** Merge option selections with per-question custom answers into submit payload. */
export function resolveQuestionAnswers(
  questions: UserQuestion[],
  answers: UserQuestionAnswers,
  customs: Record<string, string>
): UserQuestionAnswers {
  const resolved: UserQuestionAnswers = {}
  for (const question of questions) {
    const custom = (customs[question.id] ?? '').trim()
    if (question.allowMultiple) {
      const selected = Array.isArray(answers[question.id]) ? [...answers[question.id]] : []
      if (custom) selected.push(custom)
      resolved[question.id] = selected
    } else {
      resolved[question.id] = custom || (typeof answers[question.id] === 'string' ? answers[question.id] : '')
    }
  }
  return resolved
}

function initAnswers(questions: UserQuestion[]): UserQuestionAnswers {
  const initial: UserQuestionAnswers = {}
  for (const question of questions) {
    initial[question.id] = question.allowMultiple ? [] : ''
  }
  return initial
}

export function ComposerQuestionModal({ pending, onSubmit, onDismiss }: ComposerQuestionModalProps) {
  const total = pending.questions.length
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<UserQuestionAnswers>(() => initAnswers(pending.questions))
  const [customs, setCustoms] = useState<Record<string, string>>({})

  // Fresh request -> reset wizard state (initializer alone only runs on mount).
  useEffect(() => {
    setStep(0)
    setAnswers(initAnswers(pending.questions))
    setCustoms({})
  }, [pending.requestId])

  const active = pending.questions[Math.min(step, Math.max(total - 1, 0))]
  if (!active) return null
  const clampedStep = Math.min(step, Math.max(total - 1, 0))

  const answered = (question: UserQuestion): boolean =>
    isQuestionAnswered(question, answers[question.id], customs[question.id])
  const isLast = clampedStep >= total - 1

  const toggleOption = (questionId: string, optionId: string, allowMultiple?: boolean) => {
    if (allowMultiple) {
      setAnswers((current) => {
        const existing = Array.isArray(current[questionId]) ? [...current[questionId]] : []
        const index = existing.indexOf(optionId)
        if (index >= 0) {
          existing.splice(index, 1)
        } else {
          existing.push(optionId)
        }
        return { ...current, [questionId]: existing }
      })
      return
    }
    // Single-select: picking an option clears the custom answer.
    setAnswers((current) => ({ ...current, [questionId]: optionId }))
    setCustoms((current) => (current[questionId] ? { ...current, [questionId]: '' } : current))
  }

  const setCustom = (questionId: string, value: string, allowMultiple?: boolean) => {
    setCustoms((current) => ({ ...current, [questionId]: value }))
    if (!allowMultiple && value.trim().length > 0) {
      // Single-select: a custom answer replaces the picked option.
      setAnswers((current) =>
        current[questionId] ? { ...current, [questionId]: '' } : current
      )
    }
  }

  const goTo = (index: number) => {
    setStep(Math.max(0, Math.min(index, total - 1)))
  }

  const handleNext = () => {
    if (isLast) {
      onSubmit(resolveQuestionAnswers(pending.questions, answers, customs))
      return
    }
    goTo(clampedStep + 1)
  }

  const value = answers[active.id]
  const customValue = customs[active.id] ?? ''

  return (
    <div className="composer-question-modal" role="dialog" aria-label="Assistant questions">
      <div className="composer-question-modal-header">
        <span className="composer-question-modal-title">Q:</span>
        {total > 1 && (
          <div className="composer-question-steps" role="tablist" aria-label="Question navigator">
            {pending.questions.map((question, index) => {
              const done = answered(question)
              const current = index === clampedStep
              return (
                <button
                  key={question.id}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  aria-label={`Question ${index + 1}${done ? ' (answered)' : ''}`}
                  className={`composer-question-step${current ? ' active' : ''}${done ? ' answered' : ''}`}
                  onClick={() => goTo(index)}
                >
                </button>
              )
            })}
          </div>
        )}
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
        <div key={active.id} className="composer-question-block">
          <p className="composer-question-prompt">{active.prompt}</p>
          <div className="composer-question-options">
            {active.options.map((option) => {
              const selected = active.allowMultiple
                ? Array.isArray(value) && value.includes(option.id)
                : value === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`composer-question-option${selected ? ' selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => toggleOption(active.id, option.id, active.allowMultiple)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
          <input
            type="text"
            value={customValue}
            onChange={(event) => setCustom(active.id, event.target.value, active.allowMultiple)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleNext()
              }
            }}
            placeholder="Or type a custom answer…"
            aria-label={`Custom answer for question ${clampedStep + 1}`}
            className="composer-question-custom"
          />
        </div>
      </div>
      <div className="composer-question-modal-footer">
        <button
          type="button"
          className="composer-question-dismiss"
          disabled={clampedStep === 0}
          onClick={() => goTo(clampedStep - 1)}
        >
          Back
        </button>
        <button
          type="button"
          className="composer-question-submit"
          onClick={handleNext}
        >
          {isLast ? 'Submit' : 'Next'}
        </button>
      </div>
    </div>
  )
}
