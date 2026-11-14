import { useState } from 'react'
import type { BotChatQuestion } from '../../../shared/bots/personal/chat'
import { botGroupTime } from './messageGroups'

/**
 * A bot's question as a messenger's quick replies under its bubble (issue #1123), in the ask's look (`BotAskReplies`):
 * one button per answer (its detail on a second line), and "Other…", which puts the question above the composer to
 * answer in the owner's own words. A tap is the owner's reply; once the question is answered the chat shows a quiet line
 * instead (botChatShape.ts). A question the owner moved past keeps its buttons, quieter: a tap still answers it. One
 * the owner answered in the chat (the chat passed it on to the work that asked) or that is no longer needed (the work
 * that asked ended) says so in a quiet line under it. One the bot goes with a default on says what and when; once it
 * went with it, it says so and keeps its buttons, quieter, for a late answer. A nudge (Mousse's reminder of the
 * question) carries the buttons while the question waits, and nothing after: the question's own bubble says how it went.
 */
export function BotQuestionReplies({ question, onAnswer, onOther }: {
  question: BotChatQuestion
  /** Sends the tap; true once it went through. */
  onAnswer(choice: string): Promise<boolean>
  onOther(): void
}) {
  const [sending, setSending] = useState<string | undefined>()
  const waiting = question.status === 'open' || question.status === 'moved_on'
  if (question.nudge && !waiting) return null
  if (question.status === 'answered' && question.by === 'chat')
    return <p className="bot-question-settled">{question.answer ? `Answered in chat: ${question.answer}` : 'Answered in chat'}</p>
  if (question.status === 'withdrawn') return <p className="bot-question-settled">No longer needed</p>
  const defaulted = question.status === 'defaulted'
  const went = defaulted ? (question.answer ? `went with ${question.answer}` : 'went ahead') : ''
  if (defaulted && question.late) return <p className="bot-question-settled">{`${went.charAt(0).toUpperCase()}${went.slice(1)} · you said ${question.late}`}</p>
  if (!waiting && !defaulted) return null
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
  const goesAt = question.status === 'open' && question.default && question.defaultAt ? botGroupTime(question.defaultAt) : ''
  return <div className={`bot-ask-replies bot-question-replies${detailed ? ' has-details' : ''}`} data-status={question.status}>
    {defaulted && <p className="bot-question-settled">{`No answer · ${went}`}</p>}
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
    {goesAt && <p className="bot-question-settled">{`Goes with ${question.default} at ${goesAt} if you don't answer`}</p>}
  </div>
}
