import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { Check, IconMessageCircleQuestion } from '../lib/icons'
import { ALWAYS_OPTION_NOTE } from '../../shared/permissionKeys'
import type { PendingApprovalInfo, PendingUserQuestions, QuestionAnswerOutcome, UserQuestion, UserQuestionAnswers } from '../../shared/types'

interface ComposerQuestionModalProps {
  pending: PendingUserQuestions
  onSubmit: (answers: UserQuestionAnswers) => void
  onDismiss: () => void
  /** Filled with the handle the composer uses to answer the shown question. */
  handleRef?: Ref<QuestionCardHandle | null>
  /** Whether a message from the composer would answer the last open question (and so submit), each time that changes. */
  onComposerSubmitsChange?: (submits: boolean) => void
}

/** How long a picked single choice stays visible before the next question slides in. */
export const AUTO_ADVANCE_MS = 250

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

/** The composer's hint while an approval request waits: a message is also an answer. */
export const APPROVAL_COMPOSER_PLACEHOLDER = 'Type to deny and redirect'

/** The composer's hint while the agent's questions are open above it. */
export const QUESTION_COMPOSER_PLACEHOLDER = 'Or reply in your own words'

/**
 * What sending from the composer does while questions are open: the message answers the question the
 * card shows, and submits all the answers when that was the last one without an answer. A message with
 * images cannot be an answer; then the questions are skipped and the message is sent.
 */
export function questionComposerSend(hasImages: boolean, submits: boolean): { answers: boolean; label: string } {
  if (hasImages) return { answers: false, label: 'Skip questions and send' }
  return { answers: true, label: submits ? 'Answer and submit' : 'Answer this question' }
}

/** The card's state after a message from the composer answers the question at `step`, as if typed into its "Other…" field. */
export function answerWithMessage(
  questions: UserQuestion[],
  step: number,
  answers: UserQuestionAnswers,
  customs: Record<string, string>,
  message: string
): { answers: UserQuestionAnswers; customs: Record<string, string>; complete: boolean } {
  const question = questions[step]
  if (!question) return { answers, customs, complete: false }
  const nextCustoms = { ...customs, [question.id]: message }
  // Single choice: the typed answer replaces a picked option, as "Other…" does. Several: it joins the picks.
  const nextAnswers = question.allowMultiple ? answers : { ...answers, [question.id]: '' }
  const complete = questions.every((each) => isQuestionAnswered(each, nextAnswers[each.id], nextCustoms[each.id]))
  return { answers: nextAnswers, customs: nextCustoms, complete }
}

/** Lets the composer answer the question the card shows. */
export interface QuestionCardHandle {
  /**
   * Answers the shown question with `message`. When every question then has an answer, returns all of them
   * for the caller to submit; otherwise the card moves on to the next unanswered question and returns null.
   */
  answerWithMessage: (message: string) => UserQuestionAnswers | null
}

/** What a loser of an answer race is told; null when the answer was taken (or there is nothing to say). */
export function describeAnswerOutcome(outcome: QuestionAnswerOutcome | undefined): string | null {
  if (!outcome || outcome.ok) return null
  if (outcome.reason === 'already_answered') {
    const decided = outcome.decision === 'allow' ? 'approved' : outcome.decision === 'reject' ? 'denied' : 'decided'
    const by = outcome.answeredBy
    const via = by?.kind === 'agent' ? 'an agent' : by?.via === 'cli' ? 'the CLI' : by?.via === 'bridge' ? 'a remote device' : by?.via === 'gui' ? 'the app' : 'another client'
    return `Already answered: ${decided} from ${via}.`
  }
  if (outcome.reason === 'cancelled') return 'This approval request was closed before it was answered.'
  return null
}

/** The lines under a saved approval request's prompt: why it asks, and what answering it does after a restart. */
export function approvalNotes(approval: PendingApprovalInfo): string[] {
  const notes: string[] = []
  if (approval.reason) notes.push(approval.reason)
  if (approval.answerPath === 'continue') {
    const tools = approval.uncertainTools?.length ? approval.uncertainTools.join(', ') : 'a tool'
    notes.push(approval.uncertain
      ? `The agent's process ended; ${tools} may already have run. Approve or deny to continue the thread.`
      : "The agent's process ended. Approve or deny to continue the thread.")
    if (approval.total && approval.total > 1) notes.push(`${approval.answered ?? 0} of ${approval.total} answered. The thread continues once all are.`)
    notes.push('Sending a message denies the pending approvals with your message as the reason.')
  }
  return notes
}

/** The dialog's label: "Question", or how many there are ("3 questions"). The dots show the position. */
export function questionDialogLabel(total: number): string {
  return total > 1 ? `${total} questions` : 'Question'
}

/**
 * Where to go after a question is answered: the next unanswered one after `from`, else the first
 * unanswered one before it, else the last question (where Submit is).
 */
export function nextUnansweredStep(answered: boolean[], from: number): number {
  for (let index = from + 1; index < answered.length; index++) if (!answered[index]) return index
  for (let index = 0; index < from; index++) if (!answered[index]) return index
  return Math.max(answered.length - 1, 0)
}

function initAnswers(questions: UserQuestion[]): UserQuestionAnswers {
  const initial: UserQuestionAnswers = {}
  for (const question of questions) {
    initial[question.id] = question.allowMultiple ? [] : ''
  }
  return initial
}

/** A free-text answer offered as the last row: "Other…" until chosen, then a text field. */
export interface QuestionOtherChoice {
  open: boolean
  value: string
  onOpen: () => void
  onClose: () => void
  onChange: (value: string) => void
  onEnter: () => void
}

/**
 * The choices of one question: full-width rows with a radio (one answer) or a checkbox (several);
 * a filled row and indicator mark what is selected. One Tab stop: arrow keys move between rows,
 * Enter or Space picks, Tab goes on to the footer.
 */
export function QuestionOptionList({ options, value, allowMultiple, onToggle, other, label }: {
  options: UserQuestion['options']
  value: string | string[] | undefined
  allowMultiple?: boolean
  onToggle: (optionId: string) => void
  other?: QuestionOtherChoice
  label?: string
}) {
  const isSelected = (optionId: string) =>
    allowMultiple ? Array.isArray(value) && value.includes(optionId) : value === optionId
  const count = options.length + (other ? 1 : 0)
  const firstSelected = other?.open && !allowMultiple
    ? options.length
    : options.findIndex((option) => isSelected(option.id))
  const [rover, setRover] = useState(firstSelected >= 0 ? firstSelected : 0)
  const tabStop = Math.min(rover, Math.max(count - 1, 0))
  const role = allowMultiple ? 'checkbox' : 'radio'

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.composer-question-choice'))
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    event.preventDefault()
    rows[(at + step + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      className="composer-question-options"
      role={allowMultiple ? 'group' : 'radiogroup'}
      aria-label={label}
      onKeyDown={moveFocus}
    >
      {options.map((option, index) => {
        const selected = isSelected(option.id)
        return (
          <button
            key={option.id}
            type="button"
            role={role}
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            className={`composer-question-option composer-question-choice${selected ? ' selected' : ''}`}
            onFocus={() => setRover(index)}
            onClick={() => onToggle(option.id)}
          >
            <QuestionIndicator kind={role} checked={selected} />
            <span className="composer-question-option-label">{option.label}</span>
          </button>
        )
      })}
      {other && (other.open ? (
        <div className="composer-question-option composer-question-other selected">
          <span
            className="composer-question-other-toggle"
            role={role}
            aria-checked="true"
            aria-label="Other"
            onClick={allowMultiple ? other.onClose : undefined}
          >
            <QuestionIndicator kind={role} checked />
          </span>
          <input
            type="text"
            autoFocus
            value={other.value}
            tabIndex={tabStop === options.length ? 0 : -1}
            className="composer-question-other-input composer-question-choice"
            aria-label="Other answer"
            placeholder="Type your answer"
            onFocus={() => setRover(options.length)}
            onChange={(event) => other.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                other.onEnter()
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          role={role}
          aria-checked={false}
          tabIndex={tabStop === options.length ? 0 : -1}
          className="composer-question-option composer-question-choice"
          onFocus={() => setRover(options.length)}
          onClick={other.onOpen}
        >
          <QuestionIndicator kind={role} checked={false} />
          <span className="composer-question-option-label">Other…</span>
        </button>
      ))}
    </div>
  )
}

function QuestionIndicator({ kind, checked }: { kind: 'radio' | 'checkbox'; checked: boolean }) {
  return (
    <span className={`composer-question-indicator is-${kind}${checked ? ' is-checked' : ''}`} aria-hidden="true">
      {kind === 'checkbox' && checked && <Check size={11} strokeWidth={2.6} />}
    </span>
  )
}

export function ComposerQuestionModal({ pending, onSubmit, onDismiss, handleRef, onComposerSubmitsChange }: ComposerQuestionModalProps) {
  const total = pending.questions.length
  const [step, setStep] = useState(0)
  // Which way the current question slid in: 1 from the right, -1 from the left, 0 not at all.
  const [direction, setDirection] = useState(0)
  const [answers, setAnswers] = useState<UserQuestionAnswers>(() => initAnswers(pending.questions))
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const advanceTimer = useRef<number | undefined>(undefined)
  // Where focus goes after moving between questions: the new question's choices, or its dot.
  const moved = useRef<'choices' | 'dot' | null>(null)

  const cancelAdvance = () => {
    if (advanceTimer.current !== undefined) window.clearTimeout(advanceTimer.current)
    advanceTimer.current = undefined
  }

  // Fresh request -> reset wizard state (initializer alone only runs on mount).
  useEffect(() => {
    cancelAdvance()
    setStep(0)
    setDirection(0)
    setAnswers(initAnswers(pending.questions))
    setCustoms({})
    setOtherOpen({})
  }, [pending.requestId])

  useEffect(() => cancelAdvance, [])

  const clampedStep = Math.min(step, Math.max(total - 1, 0))

  // A message from the composer answers the shown question, as its "Other…" text, then the card moves
  // on to the next unanswered question; focus stays in the composer for the next answer.
  useImperativeHandle(handleRef, () => ({
    answerWithMessage: (message: string) => {
      cancelAdvance()
      const next = answerWithMessage(pending.questions, clampedStep, answers, customs, message)
      const question = pending.questions[clampedStep]
      setAnswers(next.answers)
      setCustoms(next.customs)
      if (next.complete) return resolveQuestionAnswers(pending.questions, next.answers, next.customs)
      // Going back shows the message in that question's "Other…" field (it slides out now, so nothing takes focus).
      if (question) setOtherOpen((current) => ({ ...current, [question.id]: true }))
      const answeredNow = pending.questions.map((each) => isQuestionAnswered(each, next.answers[each.id], next.customs[each.id]))
      const target = nextUnansweredStep(answeredNow, clampedStep)
      if (target !== clampedStep) {
        setDirection(target > clampedStep ? 1 : -1)
        setStep(target)
      }
      return null
    }
  }))

  // Whether the shown question is the only one left without an answer: then a message from the composer submits.
  const composerSubmits = pending.questions.every((question, index) =>
    index === clampedStep || isQuestionAnswered(question, answers[question.id], customs[question.id]))
  const onComposerSubmitsChangeRef = useRef(onComposerSubmitsChange)
  onComposerSubmitsChangeRef.current = onComposerSubmitsChange
  useEffect(() => {
    onComposerSubmitsChangeRef.current?.(composerSubmits)
  }, [composerSubmits])

  // After moving between questions, focus follows to the new question's choices.
  useEffect(() => {
    const target = moved.current
    if (!target) return
    moved.current = null
    const selector = target === 'dot' ? '.composer-question-dot.is-current' : '.composer-question-choice[tabindex="0"]'
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus()
  }, [clampedStep])

  const active = pending.questions[clampedStep]
  if (!active) return null

  const answered = (question: UserQuestion, current = answers, currentCustoms = customs): boolean =>
    isQuestionAnswered(question, current[question.id], currentCustoms[question.id])
  const isLast = clampedStep >= total - 1
  // An empty answer is never sent: Submit waits until every question has one.
  const allAnswered = pending.questions.every((question) => answered(question))

  const goTo = (index: number, focus: 'choices' | 'dot' = 'choices') => {
    cancelAdvance()
    const target = Math.max(0, Math.min(index, total - 1))
    if (target === clampedStep) return
    moved.current = focus
    setDirection(target > clampedStep ? 1 : -1)
    setStep(target)
  }

  const goToNextUnanswered = (current: UserQuestionAnswers, currentCustoms: Record<string, string>) => {
    goTo(nextUnansweredStep(pending.questions.map((question) => answered(question, current, currentCustoms)), clampedStep))
  }

  const submit = () => {
    if (!allAnswered) return
    cancelAdvance()
    onSubmit(resolveQuestionAnswers(pending.questions, answers, customs))
  }

  const toggleOption = (question: UserQuestion, optionId: string) => {
    if (question.allowMultiple) {
      const existing = Array.isArray(answers[question.id]) ? [...answers[question.id]] : []
      const index = existing.indexOf(optionId)
      if (index >= 0) existing.splice(index, 1)
      else existing.push(optionId)
      setAnswers({ ...answers, [question.id]: existing })
      return
    }
    // Single choice: picking an option closes "Other", then the next question slides in.
    const nextAnswers = { ...answers, [question.id]: optionId }
    const nextCustoms = customs[question.id] ? { ...customs, [question.id]: '' } : customs
    setAnswers(nextAnswers)
    setCustoms(nextCustoms)
    setOtherOpen((current) => (current[question.id] ? { ...current, [question.id]: false } : current))
    if (isLast) return
    cancelAdvance()
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = undefined
      goToNextUnanswered(nextAnswers, nextCustoms)
    }, AUTO_ADVANCE_MS)
  }

  const openOther = (question: UserQuestion) => {
    cancelAdvance()
    setOtherOpen((current) => ({ ...current, [question.id]: true }))
    // Single choice: "Other" replaces the picked option.
    if (!question.allowMultiple) setAnswers((current) => (current[question.id] ? { ...current, [question.id]: '' } : current))
  }

  const closeOther = (question: UserQuestion) => {
    setOtherOpen((current) => ({ ...current, [question.id]: false }))
    setCustoms((current) => ({ ...current, [question.id]: '' }))
  }

  const advance = () => {
    if (!answered(active)) return
    if (isLast) submit()
    else goToNextUnanswered(answers, customs)
  }

  const value = answers[active.id]
  const label = questionDialogLabel(total)
  const otherUsed = Boolean(otherOpen[active.id]) && (customs[active.id] ?? '').trim().length > 0
  // A single choice moves on by itself; several choices or a typed answer need Next.
  const showNext = !isLast && answered(active) && (Boolean(active.allowMultiple) || otherUsed)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    cancelAdvance()
    onDismiss()
  }

  return (
    <div ref={rootRef} className="composer-question-modal" role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      <div className="composer-question-modal-header">
        <h3 className="composer-question-modal-title">
          <IconMessageCircleQuestion size={15} aria-hidden="true" />
          {label}
        </h3>
        {total > 1 && (
          <div
            className="composer-question-dots"
            role="tablist"
            aria-label="Questions"
            onKeyDown={(event) => {
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!offset) return
              event.preventDefault()
              goTo(clampedStep + offset, 'dot')
            }}
          >
            {pending.questions.map((question, index) => {
              const done = answered(question)
              const current = index === clampedStep
              return (
                <button
                  key={question.id}
                  type="button"
                  role="tab"
                  tabIndex={current ? 0 : -1}
                  aria-selected={current}
                  aria-label={`Question ${index + 1} of ${total}${done ? ', answered' : ''}`}
                  title={`Question ${index + 1}`}
                  className={`composer-question-dot${current ? ' is-current' : ''}${done ? ' is-answered' : ''}`}
                  onClick={() => goTo(index)}
                />
              )
            })}
          </div>
        )}
      </div>
      <div className="composer-question-modal-body">
        <div
          key={active.id}
          className={`composer-question-slide${direction > 0 ? ' from-next' : direction < 0 ? ' from-previous' : ''}`}
          role="tabpanel"
          aria-label={total > 1 ? `Question ${clampedStep + 1} of ${total}` : undefined}
        >
          <p className={`composer-question-prompt${pending.approval ? ' composer-question-prompt--approval' : ''}`}>{active.prompt}</p>
          {pending.approval && approvalNotes(pending.approval).map((note) => (
            <p key={note} className="composer-question-reason">{note}</p>
          ))}
          {pending.approval && active.options.some((option) => option.scope === 'always') && (
            <p className="composer-question-reason">{ALWAYS_OPTION_NOTE}</p>
          )}
          <QuestionOptionList
            options={active.options}
            value={value}
            allowMultiple={active.allowMultiple}
            label={active.prompt}
            onToggle={(optionId) => toggleOption(active, optionId)}
            other={{
              open: Boolean(otherOpen[active.id]),
              value: customs[active.id] ?? '',
              onOpen: () => openOther(active),
              onClose: () => closeOther(active),
              onChange: (text) => setCustoms((current) => ({ ...current, [active.id]: text })),
              onEnter: advance
            }}
          />
        </div>
      </div>
      <div className="composer-question-modal-footer">
        <button type="button" className="composer-question-btn is-quiet" onClick={() => { cancelAdvance(); onDismiss() }}>
          Skip
        </button>
        <span className="composer-question-footer-end">
          {isLast && !allAnswered && total > 1 && <span className="composer-question-hint">Answer all to submit</span>}
          {clampedStep > 0 && (
            <button type="button" className="composer-question-btn" onClick={() => goTo(clampedStep - 1)}>
              Back
            </button>
          )}
          {showNext && (
            <button type="button" className="composer-question-btn" onClick={advance}>
              Next
            </button>
          )}
          {isLast && (
            <button type="button" className="composer-question-btn is-primary" disabled={!allAnswered} onClick={submit}>
              Submit
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
