import { useEffect, useState } from 'react'
import type { BotChatMessage, BotSnoozeChoice } from '../../../shared/bots/personal/chat'
import { BotQuestionReplies } from './BotQuestionReplies'
import { botDayLabel, botGroupTime } from './messageGroups'

/** A text reminder shares the question's quick replies and settled line. No owner message is sent. */
export function BotReminderReplies({ reminder, onSnooze }: {
  reminder: NonNullable<BotChatMessage['reminder']>
  onSnooze(choice: BotSnoozeChoice): Promise<boolean>
}) {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    if (!reminder.expiresAt) return
    const remaining = Date.parse(reminder.expiresAt) - Date.now()
    setExpired(remaining <= 0)
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [reminder.expiresAt])
  if (expired) return null
  if (reminder.snoozedUntil) {
    const due = reminder.snoozedUntil
    const day = new Date(due).toDateString() === new Date().toDateString() ? '' : `${botDayLabel(due)} `
    return <p className="bot-question-settled" role="note">Snoozed until {day}{botGroupTime(due)}</p>
  }
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const choices = [
    { label: 'In 10 min', choice: '10m' },
    { label: 'In 1 hour', choice: '1h' },
    { label: `Tomorrow ${botGroupTime(tomorrow.toISOString())}`, choice: 'tomorrow' }
  ] as const
  return <BotQuestionReplies question={{ questionId: 'snooze', status: 'open', choices: choices.map(({ label }) => ({ label })), other: false }}
    onAnswer={(label) => onSnooze(choices.find((item) => item.label === label)!.choice)} onOther={() => {}} />
}
