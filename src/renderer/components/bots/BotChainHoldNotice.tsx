import { useEffect, useState } from 'react'
import { MessagesSquare } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useBotsStore } from '../../stores/botsStore'
import { useComposerNotice, type ComposerNoticeProps } from '../ComposerNotice'
import type { BotChainHoldView } from '../../../shared/bots/personal/chat'

type BotChainHoldAnswer = 'continue' | 'stop'

/** What waits: "a message to Scout", "2 messages to Scout and Ledger and a wake-up". */
export function botChainHoldWhat(hold: BotChainHoldView): string {
  const messages = hold.held - hold.wakes
  const parts: string[] = []
  if (messages > 0) {
    const names = hold.to.length <= 2 ? hold.to.join(' and ') : `${hold.to.slice(0, 2).join(', ')} and ${hold.to.length - 2} more`
    parts.push(`${messages === 1 ? 'a message' : `${messages} messages`}${names ? ` to ${names}` : ''}`)
  }
  if (hold.wakes > 0) parts.push(hold.wakes === 1 ? 'a wake-up' : `${hold.wakes} wake-ups`)
  return parts.join(' and ')
}

export function botChainHoldNotice(input: {
  hold: BotChainHoldView
  botName: string
  busy: BotChainHoldAnswer | null
  error: string | null
  onAnswer: (answer: BotChainHoldAnswer) => void
  onDismissError: () => void
}): ComposerNoticeProps {
  const { hold, botName, busy, error, onAnswer, onDismissError } = input
  const blocked = busy !== null
  const line = `Bots paused · ${hold.held} waiting`
  const what = botChainHoldWhat(hold)
  const tooltip = `${botName} kept going with other bots without you. Continue sends ${what} and lets them go on; Stop drops it and ${botName} is told.`
  return {
    tone: error ? 'error' : 'warning',
    priority: 'approval',
    ...(error ? {} : { icon: <MessagesSquare size={14} strokeWidth={2} aria-hidden="true" /> }),
    label: 'Bot messages held',
    title: error ?? line,
    shortTitle: error ? undefined : 'Bots paused',
    ...(error ? {} : { detail: what }),
    tooltip: error ? `${line}. ${tooltip}` : tooltip,
    actions: [
      { label: busy === 'continue' ? 'Continuing…' : 'Continue', primary: true, title: 'Send what waits and let the bots go on', blocked, busy: busy === 'continue', onClick: () => onAnswer('continue') },
      { label: busy === 'stop' ? 'Stopping…' : 'Stop', title: `Drop what waits; ${botName} is told`, blocked, busy: busy === 'stop', onClick: () => onAnswer('stop') }
    ],
    ...(error ? { onDismiss: onDismissError } : {})
  }
}

/**
 * What a bot holds past the limit between bots (issue #1443), as its chat composer's notice: nothing waiting is sent or
 * set until the owner answers here.
 */
export function BotChainHoldNotice({ botId, botName, hold }: { botId: string; botName: string; hold?: BotChainHoldView }) {
  const [busy, setBusy] = useState<BotChainHoldAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Another bot or batch starts clean.
  useEffect(() => { setBusy(null); setError(null) }, [botId, hold?.holdId])
  const answer = async (choice: BotChainHoldAnswer) => {
    if (!hold || busy) return
    setBusy(choice)
    setError(null)
    try { await useBotsStore.getState().answerChainHold(botId, hold.holdId, choice) }
    catch (failure) { setError(ipcErrorLine(failure) || 'The held messages could not be changed.') }
    finally { setBusy(null) }
  }
  useComposerNotice(hold ? botChainHoldNotice({ hold, botName, busy, error, onAnswer: (choice) => void answer(choice), onDismissError: () => setError(null) }) : null)
  return null
}
