import { useState } from 'react'
import type { BotChatQuestion } from '../../../shared/bots/personal/chat'

/**
 * A bot's question as a messenger's quick replies under its bubble (issue #1123), in the ask's look (`BotAskReplies`):
 * one button per answer (its detail on a second line), and "Other…", which puts the question above the composer to
 * answer in the owner's own words. A tap is the owner's reply; once the question is answered the chat shows a quiet line
 * instead (botChatShape.ts). A question the owner moved past keeps its buttons, quieter: a tap still answers it.
 */
export function BotQuestionReplies({ question, onAnswer, onOther }: {
  question: BotChatQuestion
  /** Sends the tap; true once it went through. */
  onAnswer(choice: string): Promise<boolean>
  onOther(): void
}) {
  const [sending, setSending] = useState<string | undefined>()
  if (question.status !== 'open' && question.status !== 'moved_on') return null
  const tap = async (choice: string) => {
    if (sending !== undefined) return
    setSending(choice)
    try {
      // A tap that went through leaves the buttons off until the question comes back answered.
      if (!(await onAnswer(choice))) setSending(undefined)
    } catch {
      setSending(undefined)
    }
  }
  const detailed = question.choices.some((choice) => choice.detail)
  return <div className={`bot-ask-replies bot-question-replies${detailed ? ' has-details' : ''}`} data-status={question.status}>
    <div className="bot-ask-buttons" role="group" aria-label="Answers">
      {question.choices.map((choice) => (
        <button key={choice.label} type="button" disabled={sending !== undefined} aria-pressed={sending === choice.label || undefined}
          title={choice.detail} onClick={() => void tap(choice.label)}>
          <span className="bot-question-label">{choice.label}</span>
          {choice.detail && <span className="bot-question-detail">{choice.detail}</span>}
        </button>
      ))}
      {question.other && <button type="button" className="bot-question-other" disabled={sending !== undefined} onClick={onOther}>Other…</button>}
    </div>
  </div>
}
