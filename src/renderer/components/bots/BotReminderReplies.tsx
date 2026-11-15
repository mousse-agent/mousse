import type { BotChatMessage, BotSnoozeChoice } from '../../../shared/bots/personal/chat'
import { BotQuestionReplies } from './BotQuestionReplies'

const choices = [
  { label: 'In 10 min', choice: '10m' },
  { label: 'In 1 hour', choice: '1h' },
  { label: 'Tomorrow 9:00', choice: 'tomorrow' }
] as const

/** A text reminder shares the question's quick replies and settled line. No owner message is sent. */
export function BotReminderReplies({ reminder, onSnooze }: {
  reminder: NonNullable<BotChatMessage['reminder']>
  onSnooze(choice: BotSnoozeChoice): Promise<boolean>
}) {
  if (reminder.snoozedUntil) return <p className="bot-question-settled" role="note">{reminder.snoozedLabel}</p>
  return <BotQuestionReplies question={{ questionId: 'snooze', status: 'open', choices: choices.map(({ label }) => ({ label })), other: false }}
    onAnswer={(label) => onSnooze(choices.find((item) => item.label === label)!.choice)} onOther={() => {}} />
}
